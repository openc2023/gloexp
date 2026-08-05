/* expv7 — 实时摄像头拍照（getUserMedia），用于面单图片上传/条码识别的"拍照"入口。
   file input 的 capture 属性在不少手机浏览器上并不保证真的调起相机（只是一个"提示"，
   浏览器可以忽略、退化成普通文件选择器），所以优先用 getUserMedia 直接请求摄像头画面，
   在页面内实时预览、点拍摄按钮出片。
   但 getUserMedia 要求"安全上下文"（HTTPS 或 localhost）——部署在局域网 http:// 地址下时，
   浏览器会直接拒绝、连权限弹窗都不会出现。这种情况下自动退回 file input + capture 方案
   （不保证 100% 直开相机，但至少能弹出选图/拍照，不会像 getUserMedia 那样完全静默失败）。
   页面需要一份 #camera-modal 结构（结构相同、直接复制），只挂载一次监听。 */
const CameraCapture = (function () {
  let stream = null;
  let onCaptureCb = null;
  // 拍出来的照片存到面单图片、条码识别也从这张图上做——太大的画布在部分手机浏览器上
  // toBlob 会失败或产出损坏文件（这也是"拍的照片打不开"的常见原因），这里封顶到一个
  // 既够清楚辨认条码、又不容易触发手机内存问题的尺寸。
  const CAPTURE_MAX_DIM = 2600;

  // 摄像头预览时后台跑一个轻量实时识别循环，让用户在按下拍摄之前就能看到"识别到了
  // 没有"，不用盲拍。实时主链路对齐已经验证效果很好的测试页：Code128、1280 全画面、
  // 8 帧容错窗口和 6.5 秒结果锁定；同时保留连续两帧快速确认。面单上除了快递单号，
  // 往往还有分拣码/路由码/商家内部码，因此其他一维格式只在 Code128 连续失败后低频尝试。
  // 一帧可能同时解出好几个有效条码，每个候选都要独立计票，且解码器返回的顺序不代表
  // 哪个是真正的快递单号。所以这里对每个候选文本分别维护"滑动窗口累计次数"和
  // "连续命中次数"，同时满足其一即可视为该候选已确认；如果同一时刻有不止一个候选
  // 都被确认了，不擅自二选一，交给用户点选。
  const SCAN_DELAY_MS = 430; // 每轮完成后再等待，不让低端手机堆积解码任务
  const VOTE_WINDOW_SIZE = 8; // 与高准确率测试页一致
  const VOTES_TO_CONFIRM = 3; // 窗口内累计出现够这么多次也算确认（容忍偶尔漏帧）
  const CONSECUTIVE_TO_CONFIRM = 2; // 连续命中够这么多帧，不用等满窗口也能提前确认
  const CANDIDATE_MISS_TOLERANCE = 6;
  const LOCKED_MISS_TOLERANCE = 14;
  const LOCK_HOLD_MS = 6500;
  const FULL_FRAME_MAX_SIDE = 1280;
  const FALLBACK_AFTER_MISSES = 5;
  const FALLBACK_EVERY = 3;
  const PRIMARY_FORMATS = ['Code128'];
  const FALLBACK_FORMATS = ['Code39', 'ITF', 'EAN13', 'EAN8', 'Codabar'];
  // 与高准确率测试页的视觉范围一致：宽 90%、高 64%，不同横竖屏按原始视频比例换算。
  const ROI_RECT = Object.freeze({ x: 0.05, y: 0.18, width: 0.9, height: 0.64 });

  let scanTimer = null;
  let scanBusy = false;
  let scanCanvas = null;
  let scanStatusEl = null;
  let scanChoicesEl = null;
  let voteWindow = []; // 最近若干帧各自识别到的候选集合（Set<string>）
  let consecutiveHits = new Map(); // 候选文本 -> 连续命中帧数
  let missCount = 0; // 连续多少帧完全没有候选
  let liveCode = ''; // 已确认且当前生效的号码（唯一确认，或用户从多个候选里点选后的结果）
  let lockedUntil = 0;
  let scanFrameNo = 0;
  let scanSession = 0;
  let scanGuideEl = null;
  let lastScanErrorAt = 0;
  let cameraDiagnostics = null;
  let liveCandidateMeta = new Map();
  let liveVoteCounts = new Map();
  let activeContext = {};
  let captureBusy = false;

  function el(id) { return document.getElementById(id); }

  function canUseLiveCamera() {
    return window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  }

  function fallbackFilePick(onCapture, onCancel) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    let settled = false;
    input.addEventListener('change', () => {
      settled = true;
      onCapture(input.files[0] || null);
    });
    // 取消系统相机/相册通常不会触发 change；回到页面后恢复原入口。
    window.addEventListener('focus', () => {
      setTimeout(() => {
        if (!settled) { settled = true; onCancel?.(); }
      }, 350);
    }, { once: true });
    input.click();
  }

  function ensureScanStatusEl() {
    if (scanStatusEl && document.body.contains(scanStatusEl)) return scanStatusEl;
    const video = el('camera-video');
    if (!video) return null;
    scanStatusEl = document.createElement('div');
    scanStatusEl.id = 'camera-scan-status';
    scanStatusEl.setAttribute('role', 'status');
    scanStatusEl.setAttribute('aria-live', 'polite');
    scanStatusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium';
    Object.assign(scanStatusEl.style, {
      position: 'absolute',
      left: '50%',
      top: '12px',
      transform: 'translateX(-50%)',
      width: 'min(92%, 580px)',
      zIndex: '6',
      boxShadow: '0 2px 12px rgba(0,0,0,.35)',
    });
    scanChoicesEl = document.createElement('div');
    scanChoicesEl.id = 'camera-scan-choices';
    scanChoicesEl.className = 'mt-2 flex flex-wrap gap-2 justify-center hidden';
    // 主状态固定覆盖在画面顶部，手机上始终可见；候选按钮仍放在画面外。
    const stage = el('camera-scan-stage');
    if (stage) {
      stage.appendChild(scanStatusEl);
      stage.insertAdjacentElement('afterend', scanChoicesEl);
    } else {
      video.insertAdjacentElement('afterend', scanStatusEl);
      scanStatusEl.insertAdjacentElement('afterend', scanChoicesEl);
    }
    return scanStatusEl;
  }

  function showCameraStatus(text, kind = 'info') {
    const statusEl = ensureScanStatusEl();
    if (!statusEl) return;
    statusEl.textContent = text;
    const colors = {
      ok: '#059669',
      warn: '#d97706',
      err: '#dc2626',
      info: 'rgba(17,24,39,.94)',
    };
    statusEl.className = 'px-3 py-2 rounded-md text-sm text-center font-medium';
    statusEl.style.backgroundColor = colors[kind] || colors.info;
    statusEl.style.color = '#fff';
  }

  function setCaptureButtonBusy(busy, text) {
    captureBusy = busy;
    const button = el('camera-btn-shoot');
    if (!button) return;
    button.disabled = busy;
    button.setAttribute('aria-busy', busy ? 'true' : 'false');
    button.textContent = text || (busy ? '处理中…' : '拍摄');
    button.style.opacity = busy ? '0.65' : '';
  }

  function ensureScanGuide() {
    const video = el('camera-video');
    if (!video) return null;
    if (scanGuideEl && document.body.contains(scanGuideEl)) return scanGuideEl;

    const stage = document.createElement('div');
    stage.id = 'camera-scan-stage';
    stage.style.position = 'relative';
    stage.style.overflow = 'hidden';
    stage.style.borderRadius = '0.375rem';
    video.parentNode.insertBefore(stage, video);
    stage.appendChild(video);
    video.style.maxHeight = 'min(68vh, 620px)';

    scanGuideEl = document.createElement('div');
    scanGuideEl.id = 'camera-scan-guide';
    scanGuideEl.setAttribute('aria-hidden', 'true');
    Object.assign(scanGuideEl.style, {
      position: 'absolute',
      pointerEvents: 'none',
      border: '3px solid #fbbf24',
      borderRadius: '12px',
      boxShadow: '0 0 0 9999px rgba(0,0,0,.30)',
      transition: 'border-color .18s, box-shadow .18s',
    });
    const scanLine = document.createElement('div');
    Object.assign(scanLine.style, {
      position: 'absolute',
      left: '2%',
      right: '2%',
      top: '8%',
      height: '2px',
      background: 'linear-gradient(90deg, transparent, #34d399, transparent)',
      boxShadow: '0 0 8px rgba(52,211,153,.9)',
    });
    scanGuideEl.appendChild(scanLine);
    scanLine.animate?.(
      [{ top: '8%', opacity: 0.55 }, { top: '91%', opacity: 1 }, { top: '8%', opacity: 0.55 }],
      { duration: 2200, iterations: Infinity, easing: 'ease-in-out' }
    );
    stage.appendChild(scanGuideEl);
    updateScanGuidePosition();
    return scanGuideEl;
  }

  // 扫描区域按摄像头原始画面的比例定义。下面只负责把相同区域映射到 object-fit:contain
  // 的屏幕显示位置，因此横竖屏、黑边和不同手机分辨率都不需要单独配置。
  function updateScanGuidePosition() {
    const video = el('camera-video');
    if (!video || !scanGuideEl || !video.videoWidth || !video.videoHeight) return;
    const boxW = video.clientWidth;
    const boxH = video.clientHeight;
    if (!boxW || !boxH) return;

    const scale = Math.min(boxW / video.videoWidth, boxH / video.videoHeight);
    const contentW = video.videoWidth * scale;
    const contentH = video.videoHeight * scale;
    const offsetX = (boxW - contentW) / 2;
    const offsetY = (boxH - contentH) / 2;
    Object.assign(scanGuideEl.style, {
      left: `${offsetX + contentW * ROI_RECT.x}px`,
      top: `${offsetY + contentH * ROI_RECT.y}px`,
      width: `${contentW * ROI_RECT.width}px`,
      height: `${contentH * ROI_RECT.height}px`,
    });
  }

  function setScanGuideReady(ready) {
    if (!scanGuideEl) return;
    scanGuideEl.style.borderColor = ready ? '#34d399' : '#fbbf24';
    scanGuideEl.style.boxShadow = ready
      ? '0 0 20px rgba(52,211,153,.75), 0 0 0 9999px rgba(0,0,0,.22)'
      : '0 0 0 9999px rgba(0,0,0,.30)';
  }

  function resetScanState() {
    voteWindow = [];
    consecutiveHits = new Map();
    missCount = 0;
    liveCode = '';
    lockedUntil = 0;
    scanFrameNo = 0;
    liveCandidateMeta = new Map();
    liveVoteCounts = new Map();
    setScanGuideReady(false);
    if (scanChoicesEl) { scanChoicesEl.innerHTML = ''; scanChoicesEl.classList.add('hidden'); }
  }

  // 用户从多个候选里手动点选一个：直接当作已确认结果锁定，跟自动确认一样可以直接拍照。
  function selectCandidate(text) {
    liveCode = text;
    lockedUntil = Date.now() + LOCK_HOLD_MS;
    updateScanStatus();
  }

  function updateScanStatus(ambiguous) {
    const statusEl = ensureScanStatusEl();
    if (!statusEl) return;
    statusEl.style.backgroundColor = '';
    statusEl.style.color = '';
    const confirmed = liveCode && Date.now() < lockedUntil;
    setScanGuideReady(!!confirmed);

    if (ambiguous && ambiguous.length > 1 && !confirmed) {
      statusEl.textContent = `检测到 ${ambiguous.length} 个不同的有效条码，请点选快递单号：`;
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400';
      statusEl.style.backgroundColor = '#d97706';
      statusEl.style.color = '#fff';
      scanChoicesEl.innerHTML = ambiguous.map((t) => `<button type="button" data-scan-choice="${t}" class="px-3 py-1.5 text-xs font-medium rounded-full bg-white dark:bg-gray-700 border border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/10">${t}</button>`).join('');
      scanChoicesEl.classList.remove('hidden');
      return;
    }
    scanChoicesEl?.classList.add('hidden');

    if (confirmed) {
      statusEl.textContent = `已识别：${liveCode}，可以拍照`;
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
      statusEl.style.backgroundColor = '#059669';
      statusEl.style.color = '#fff';
    } else if (liveVoteCounts.size || [...consecutiveHits.values()].some((count) => count > 0)) {
      const top = [...new Set([...liveVoteCounts.keys(), ...consecutiveHits.keys()])]
        .map((text) => ({
          text,
          votes: liveVoteCounts.get(text) || 0,
          consecutive: consecutiveHits.get(text) || 0,
        }))
        .sort((a, b) => b.votes - a.votes || b.consecutive - a.consecutive)[0];
      statusEl.textContent = `已检测：${top.text}（${top.votes}/${VOTES_TO_CONFIRM} 帧），正在确认…`;
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400';
      statusEl.style.backgroundColor = '#d97706';
      statusEl.style.color = '#fff';
    } else {
      statusEl.textContent = '请把条形码放入扫码框内，会自动识别';
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300';
      statusEl.style.backgroundColor = 'rgba(17,24,39,.94)';
      statusEl.style.color = '#fff';
    }
  }

  function captureVideoRegion(video, region, maxSide) {
    if (!scanCanvas) scanCanvas = document.createElement('canvas');
    const sx = Math.max(0, Math.round(video.videoWidth * region.x));
    const sy = Math.max(0, Math.round(video.videoHeight * region.y));
    const sw = Math.max(1, Math.min(video.videoWidth - sx, Math.round(video.videoWidth * region.width)));
    const sh = Math.max(1, Math.min(video.videoHeight - sy, Math.round(video.videoHeight * region.height)));
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    scanCanvas.width = w;
    scanCanvas.height = h;
    const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  function positionCenter(position) {
    if (!position || typeof position !== 'object') return null;
    const points = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft']
      .map((key) => position[key])
      .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));
    if (!points.length) return null;
    return {
      x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
      y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    };
  }

  function isPositionInGuide(position, width, height) {
    const center = positionCenter(position);
    if (!center) return false;
    return center.x >= width * ROI_RECT.x &&
      center.x <= width * (ROI_RECT.x + ROI_RECT.width) &&
      center.y >= height * ROI_RECT.y &&
      center.y <= height * (ROI_RECT.y + ROI_RECT.height);
  }

  async function timedDecode(imageData, options, label) {
    const startedAt = performance.now();
    const candidates = await window.BarcodeScan.decodeCandidates(imageData, options);
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    if (cameraDiagnostics) {
      cameraDiagnostics.lastAttempts ||= [];
      cameraDiagnostics.lastAttempts.push({ label, durationMs, candidates: candidates.length });
    }
    return candidates;
  }

  async function decodeAdaptiveFrame(video, frameNo, session) {
    if (cameraDiagnostics) cameraDiagnostics.lastAttempts = [];
    const fullImage = captureVideoRegion(
      video,
      { x: 0, y: 0, width: 1, height: 1 },
      FULL_FRAME_MAX_SIDE
    );

    // 主链路完全对齐测试页：每轮先用 1280 全画面只识别 Code128。
    const candidates = await timedDecode(fullImage, {
      formats: PRIMARY_FORMATS,
      maxNumberOfSymbols: 12,
      filterPlausible: false,
      throwOnError: true,
    }, 'Code128 全画面 1280');
    if (session !== scanSession) return [];

    const positionedPrimary = candidates.map((candidate) => ({
      ...candidate,
      inGuide: isPositionInGuide(candidate.position, fullImage.width, fullImage.height),
    }));
    // 参考页的扫码框只是取景提示，不是硬过滤条件。完整画面只要得到校验通过的
    // Code128 就必须进入投票，否则坐标缺失、旋转或稍微出框都会把正确结果丢掉。
    if (positionedPrimary.length) return positionedPrimary;

    const allowFullFrameFallback = missCount >= FALLBACK_AFTER_MISSES && frameNo % FALLBACK_EVERY === 0;
    // 连续若干轮没有 Code128 后才低频尝试其他一维格式，避免每轮扩大搜索空间。
    if (!positionedPrimary.length && allowFullFrameFallback) {
      const fallbackCandidates = await timedDecode(fullImage, {
        formats: FALLBACK_FORMATS,
        maxNumberOfSymbols: 6,
        throwOnError: true,
      }, '其他一维码低频兜底');
      if (session !== scanSession) return [];
      const positionedFallback = fallbackCandidates.map((candidate) => ({
        ...candidate,
        inGuide: isPositionInGuide(candidate.position, fullImage.width, fullImage.height),
      }));
      const fallbackInGuide = positionedFallback.filter((candidate) => candidate.inGuide);
      return fallbackInGuide.length ? fallbackInGuide : positionedFallback;
    }
    return [];
  }

  function selectedCourierName() {
    if (activeContext.courierName) return activeContext.courierName;
    const select = el('ib-courier') || el('fl-courier');
    return select?.selectedOptions?.[0]?.textContent || '';
  }

  function courierRuleBonus(text) {
    const name = selectedCourierName();
    if (/(顺丰|sf)/i.test(name) && /^SF[A-Z0-9]{10,}$/i.test(text)) return 120;
    if (/(ems|邮政|우체국)/i.test(name) && (/^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(text) || /^\d{13}$/.test(text))) return 120;
    if (/ups/i.test(name) && /^1Z[A-Z0-9]{16}$/i.test(text)) return 120;
    if (/fedex/i.test(name) && /^\d{12,15}$/.test(text)) return 120;
    if (/dhl/i.test(name) && /^\d{10}$/.test(text)) return 120;
    return 0;
  }

  function liveCandidateScore(text, voteCounts) {
    const meta = liveCandidateMeta.get(text) || {};
    const formatScore = { Code128: 30, Code39: 22, ITF: 18, EAN13: 14, EAN8: 8, Codabar: 6 };
    return (voteCounts.get(text) || 0) * 100 +
      (consecutiveHits.get(text) || 0) * 20 +
      (formatScore[meta.format] || 0) +
      (meta.inGuide ? 25 : 0) +
      Math.min(text.length, 20) +
      courierRuleBonus(text);
  }

  async function scanOneFrame(session) {
    const video = el('camera-video');
    if (session !== scanSession || !video || !video.videoWidth || video.readyState < 2 || scanBusy || !window.BarcodeScan) return;
    scanBusy = true;
    const startedAt = performance.now();
    try {
      scanFrameNo += 1;
      const candidates = await decodeAdaptiveFrame(video, scanFrameNo, session);
      // stop/close/reopen 后，旧的 WASM Promise 即使稍后返回也不能污染新会话。
      if (session !== scanSession) return;
      const frameSet = new Set(candidates.map((c) => c.text));
      candidates.forEach((candidate) => {
        const previous = liveCandidateMeta.get(candidate.text) || {};
        liveCandidateMeta.set(candidate.text, {
          format: candidate.format || previous.format,
          inGuide: !!candidate.inGuide || !!previous.inGuide,
        });
      });

      if (frameSet.size) {
        missCount = 0;
      } else {
        missCount += 1;
      }

      // 已确认的结果如果这一帧漏检了，只要还在锁定时间内就先不动它——已确认状态
      // 靠 lockedUntil 超时来清空，不受这里投票逻辑影响。
      if (liveCode && Date.now() < lockedUntil) {
        updateScanStatus();
        return;
      }
      if (liveCode && !frameSet.size && missCount <= LOCKED_MISS_TOLERANCE) {
        updateScanStatus();
        return;
      }
      if (liveCode) {
        // 锁定到期了，清掉过期结果，重新开始累计投票，而不是让一个过期号码悬在那
        liveCode = '';
        voteWindow = [];
        consecutiveHits = new Map();
      }

      // 每个候选独立计数：这一帧出现就 +1 连续命中，没出现就清零；滑动窗口另外
      // 单独累计"最近 N 帧里出现过几次"，两个条件任一满足就算确认。
      const allKnown = new Set([...consecutiveHits.keys(), ...frameSet]);
      for (const text of allKnown) {
        consecutiveHits.set(text, frameSet.has(text) ? (consecutiveHits.get(text) || 0) + 1 : 0);
      }
      voteWindow.push(frameSet);
      if (voteWindow.length > VOTE_WINDOW_SIZE) voteWindow.shift();

      const voteCounts = new Map();
      for (const frame of voteWindow) {
        for (const text of frame) voteCounts.set(text, (voteCounts.get(text) || 0) + 1);
      }
      liveVoteCounts = voteCounts;

      const confirmedTexts = [...voteCounts.keys()]
        .filter((text) =>
          (voteCounts.get(text) || 0) >= VOTES_TO_CONFIRM || (consecutiveHits.get(text) || 0) >= CONSECUTIVE_TO_CONFIRM
        )
        .sort((a, b) => liveCandidateScore(b, voteCounts) - liveCandidateScore(a, voteCounts));

      if (confirmedTexts.length === 1) {
        liveCode = confirmedTexts[0];
        lockedUntil = Date.now() + LOCK_HOLD_MS;
        if (navigator.vibrate) navigator.vibrate(60);
        updateScanStatus();
      } else if (confirmedTexts.length > 1) {
        // 不擅自二选一：多个候选都稳定出现，交给用户点选，避免把分拣码/路由码
        // 之类的另一个有效条码悄悄当成快递单号入库。
        updateScanStatus(confirmedTexts);
      } else if (!frameSet.size && missCount > CANDIDATE_MISS_TOLERANCE) {
        voteWindow = [];
        consecutiveHits = new Map();
        liveCandidateMeta = new Map();
        updateScanStatus();
      } else {
        updateScanStatus();
      }
    } catch (e) {
      showCameraStatus(`实时识别异常：${e?.message || e}`, 'err');
      if (Date.now() - lastScanErrorAt > 5000) {
        console.warn('实时条码识别失败，将继续重试：', e);
        lastScanErrorAt = Date.now();
      }
    } finally {
      if (session === scanSession && cameraDiagnostics) {
        cameraDiagnostics.lastDecodeMs = Math.round((performance.now() - startedAt) * 10) / 10;
        cameraDiagnostics.lastFrame = scanFrameNo;
      }
      if (session === scanSession) scanBusy = false;
    }
  }

  function startScanLoop() {
    stopScanLoop();
    resetScanState();
    updateScanStatus();
    updateScanGuidePosition();
    const session = scanSession;
    const runNext = async () => {
      if (session !== scanSession || !stream || document.hidden) return;
      await scanOneFrame(session);
      if (session === scanSession && stream && !document.hidden) {
        scanTimer = setTimeout(runNext, SCAN_DELAY_MS);
      }
    };
    runNext();
  }

  function stopScanLoop() {
    scanSession += 1;
    if (scanTimer) { clearTimeout(scanTimer); scanTimer = null; }
    scanBusy = false;
  }

  async function open(onCapture, options = {}) {
    activeContext = { ...options };
    if (!canUseLiveCamera()) {
      fallbackFilePick(onCapture, options.onCancel);
      return;
    }
    const modal = el('camera-modal');
    if (!modal) { fallbackFilePick(onCapture, options.onCancel); return; }
    onCaptureCb = onCapture;
    const title = modal.querySelector('h3');
    if (title) title.textContent = options.title || '拍照上传';
    modal.classList.remove('hidden');
    setCaptureButtonBusy(false, '拍摄');
    showCameraStatus('正在加载条码识别核心…', 'warn');
    const video = el('camera-video');
    try {
      if (!window.BarcodeScan?.prepare) throw new Error('条码识别核心未加载');
      await window.BarcodeScan.prepare();
      showCameraStatus('识别核心已加载，正在请求摄像头权限…', 'warn');
      // 与高成功率参考页保持相同的期望参数；ideal 无法满足时浏览器仍会自动降级。
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      });
      video.srcObject = stream;
      await video.play();
      const track = stream.getVideoTracks()[0];
      cameraDiagnostics = {
        openedAt: new Date().toISOString(),
        mode: activeContext.mode || 'image-upload',
        courierName: activeContext.courierName || '',
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        trackSettings: track?.getSettings?.() || {},
        trackCapabilities: track?.getCapabilities?.() || {},
        roi: ROI_RECT,
      };
      window.__barcodeCameraDiagnostics = cameraDiagnostics;
      console.info('条码摄像头参数：', cameraDiagnostics);
      updateScanGuidePosition();
      showCameraStatus('摄像头已开启，请把条形码完整放进框内', 'info');
      startScanLoop();
    } catch (e) {
      toast('摄像头打开失败，已切换到系统拍照/选图', 'err', 4200);
      close(false);
      fallbackFilePick(onCapture, options.onCancel);
    }
  }

  function close(notifyCancel = false, force = false) {
    if (captureBusy && !force) {
      toast('照片正在识别和保存，请稍候', 'info');
      return;
    }
    const onCancel = activeContext.onCancel;
    stopScanLoop();
    resetScanState();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    const video = el('camera-video');
    if (video) video.srcObject = null;
    cameraDiagnostics = null;
    el('camera-modal')?.classList.add('hidden');
    onCaptureCb = null;
    activeContext = {};
    if (notifyCancel) onCancel?.();
  }

  function canvasToJpegBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  }

  async function capture() {
    const video = el('camera-video');
    const shootButton = el('camera-btn-shoot');
    if (shootButton?.disabled) return;
    // readyState < 2 (HAVE_CURRENT_DATA) 意味着还没有真正解码出一帧画面，这时候拍
    // 大概率拿到的是黑屏/半帧，存下来的照片打开就是坏的——先等画面真正就绪。
    if (!video || !video.videoWidth || video.readyState < 2) {
      toast('摄像头画面还没准备好，请稍等一下再拍', 'err');
      return;
    }

    // 拍照这一下，如果实时循环已经连续确认过一个号码且还在锁定时间内，直接采信——
    // 用户在按下快门前就已经在状态栏看到了这个号码，拍出来的静态照片再重新识别一遍
    // 反而可能因为摩尔纹等原因得到不一致的结果，没必要多此一举。
    let recognizedText = (liveCode && Date.now() < lockedUntil) ? liveCode : null;
    stopScanLoop();
    setCaptureButtonBusy(true, '正在拍照…');
    showCameraStatus(
      recognizedText ? `已锁定单号 ${recognizedText}，正在拍照…` : '正在拍照，请保持稳定…',
      recognizedText ? 'ok' : 'warn'
    );

    let w = video.videoWidth;
    let h = video.videoHeight;
    const scale = Math.min(1, CAPTURE_MAX_DIM / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, w, h);

    // 参考页的关键路径：没有实时锁定结果时，先直接识别未压缩 Canvas，
    // 再生成用于上传的 JPEG。不能先压缩再识别，否则细条纹边缘会被 JPEG 损伤。
    if (!recognizedText) {
      setCaptureButtonBusy(true, '正在确认…');
      showCameraStatus('当前没有锁定结果，正在进行四级多尺寸识别…', 'warn');
      try {
        const candidates = await window.BarcodeScan.decodeCanvasCandidates(canvas, {
          courierName: selectedCourierName(),
        });
        recognizedText = await window.BarcodeScan.chooseCandidate(candidates);
      } catch (error) {
        console.error('未压缩拍照画面识别失败：', error);
        setCaptureButtonBusy(false, '重新拍摄');
        showCameraStatus(`本次确认异常：${error?.message || error}，已恢复实时扫描`, 'err');
        setTimeout(() => { if (stream) startScanLoop(); }, 450);
        return;
      }

      // 行内“扫码识别单号”必须识别成功才退出；失败时完全复刻参考页，恢复实时扫描。
      if (!recognizedText && activeContext.mode === 'row-tracking-scan') {
        setCaptureButtonBusy(false, '重新拍摄');
        showCameraStatus('本次照片未识别成功，已自动恢复实时扫描', 'warn');
        setTimeout(() => { if (stream) startScanLoop(); }, 450);
        return;
      }
      if (recognizedText) {
        liveCode = recognizedText;
        lockedUntil = Date.now() + LOCK_HOLD_MS;
        setScanGuideReady(true);
        showCameraStatus(`拍照识别成功：${recognizedText}，正在保存…`, 'ok');
        if (navigator.vibrate) navigator.vibrate([80, 60, 120]);
      }
    }

    const blob = await canvasToJpegBlob(canvas);
    {
      if (!blob) {
        toast('拍照失败，请重试', 'err');
        setCaptureButtonBusy(false, '重新拍摄');
        showCameraStatus('拍照失败，请重新拍摄', 'err');
        startScanLoop();
        return;
      }
      const file = new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' });
      const cb = onCaptureCb;
      const reportStatus = (text, kind = 'info') => showCameraStatus(text, kind);
      reportStatus(
        recognizedText
          ? `已确认单号 ${recognizedText}，正在检查并保存…`
          : '拍照完成，正在进行多尺寸识别…',
        recognizedText ? 'ok' : 'warn'
      );
      setCaptureButtonBusy(true, recognizedText ? '正在保存…' : '正在识别…');
      try {
        // 第四个参数表示已经对未压缩 Canvas 完成识别，业务层不要再对 JPEG 重复解码。
        if (cb) await cb(file, recognizedText, reportStatus, true);
      } catch (error) {
        console.error('拍照后处理失败：', error);
        toast('照片处理失败，请重试', 'err');
      } finally {
        close(false, true);
        setCaptureButtonBusy(false, '拍摄');
      }
    }
  }

  function init() {
    if (!el('camera-modal')) return;
    ensureScanGuide();
    el('camera-modal').querySelectorAll('[data-close-camera]').forEach((b) => b.addEventListener('click', () => close(true)));
    el('camera-btn-shoot')?.addEventListener('click', capture);
    // 多候选点选按钮是运行时动态插入的，用事件委托挂在 modal 上，不用每次重新绑定。
    el('camera-modal').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-scan-choice]');
      if (btn) selectCandidate(btn.dataset.scanChoice);
    });
    // 切到后台（锁屏/切应用）时暂停实时识别循环，回来再继续——摄像头本身不会因为
    // 切后台自动停，不暂停的话会一直空跑 WASM 解码，白费电。
    document.addEventListener('visibilitychange', () => {
      if (!stream) return;
      if (document.hidden) {
        stopScanLoop();
      } else {
        startScanLoop();
      }
    });
    window.addEventListener('resize', updateScanGuidePosition);
    el('camera-video')?.addEventListener('loadedmetadata', updateScanGuidePosition);
  }
  document.addEventListener('DOMContentLoaded', init);

  return { open, close };
})();
