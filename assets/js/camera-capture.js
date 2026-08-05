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
  const CAPTURE_MAX_DIM = 2400;

  // 摄像头预览时后台跑一个轻量实时识别循环，让用户在按下拍摄之前就能看到"识别到了
  // 没有"，不用盲拍。这不是参考实现里那套面向"连续扫很多个包裹"的完整投票系统，
  // 咱们是"开一次摄像头、拍一张、关掉"的单次场景，窗口不用留那么长；但也不能只按
  // "连续两帧就确认"处理——面单上除了快递单号，往往还有分拣码/路由码/商家内部码，
  // 一帧可能同时解出好几个有效条码，每个候选都要独立计票，且解码器返回的顺序不代表
  // 哪个是真正的快递单号。所以这里对每个候选文本分别维护"滑动窗口累计次数"和
  // "连续命中次数"，同时满足其一即可视为该候选已确认；如果同一时刻有不止一个候选
  // 都被确认了，不擅自二选一，交给用户点选。
  const SCAN_INTERVAL_MS = 450;
  const VOTE_WINDOW_SIZE = 5; // 最近几帧的滑动窗口
  const VOTES_TO_CONFIRM = 3; // 窗口内累计出现够这么多次也算确认（容忍偶尔漏帧）
  const CONSECUTIVE_TO_CONFIRM = 2; // 连续命中够这么多帧，不用等满窗口也能提前确认
  const MISS_TOLERANCE = 5; // 完全没有任何候选时，允许连续几帧空手不清空历史（应对自动对焦短暂重新搜索）
  const LOCK_HOLD_MS = 4000; // 确认后即使后面几帧漏检，结果仍保留这么久——防止用户刚看到绿色去点拍摄的一瞬间又变灰
  const SCAN_MAX_SIDE = 900; // 实时循环用的取帧尺寸，比正式拍照小很多，换取每秒能多跑几次

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

  function el(id) { return document.getElementById(id); }

  function canUseLiveCamera() {
    return window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  }

  function fallbackFilePick(onCapture) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.addEventListener('change', () => onCapture(input.files[0] || null));
    input.click();
  }

  function ensureScanStatusEl() {
    if (scanStatusEl && document.body.contains(scanStatusEl)) return scanStatusEl;
    const video = el('camera-video');
    if (!video) return null;
    scanStatusEl = document.createElement('div');
    scanStatusEl.id = 'camera-scan-status';
    scanStatusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium';
    scanChoicesEl = document.createElement('div');
    scanChoicesEl.id = 'camera-scan-choices';
    scanChoicesEl.className = 'mt-2 flex flex-wrap gap-2 justify-center hidden';
    video.insertAdjacentElement('afterend', scanStatusEl);
    scanStatusEl.insertAdjacentElement('afterend', scanChoicesEl);
    return scanStatusEl;
  }

  function resetScanState() {
    voteWindow = [];
    consecutiveHits = new Map();
    missCount = 0;
    liveCode = '';
    lockedUntil = 0;
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
    const confirmed = liveCode && Date.now() < lockedUntil;

    if (ambiguous && ambiguous.length > 1 && !confirmed) {
      statusEl.textContent = `检测到 ${ambiguous.length} 个不同的有效条码，请点选快递单号：`;
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400';
      scanChoicesEl.innerHTML = ambiguous.map((t) => `<button type="button" data-scan-choice="${t}" class="px-3 py-1.5 text-xs font-medium rounded-full bg-white dark:bg-gray-700 border border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-500/10">${t}</button>`).join('');
      scanChoicesEl.classList.remove('hidden');
      return;
    }
    scanChoicesEl?.classList.add('hidden');

    if (confirmed) {
      statusEl.textContent = `已识别：${liveCode}，可以拍照`;
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    } else if (consecutiveHits.size > 0) {
      const top = [...consecutiveHits.entries()].sort((a, b) => b[1] - a[1])[0];
      statusEl.textContent = `识别中…看到号码 ${top[0]}`;
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-amber-50 dark:bg-amber-500/10 text-amber-600 dark:text-amber-400';
    } else {
      statusEl.textContent = '请把条形码对准镜头，会自动识别';
      statusEl.className = 'mt-2 px-3 py-2 rounded-md text-sm text-center font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-300';
    }
  }

  async function scanOneFrame() {
    const video = el('camera-video');
    if (!video || !video.videoWidth || video.readyState < 2 || scanBusy || !window.BarcodeScan) return;
    scanBusy = true;
    try {
      if (!scanCanvas) scanCanvas = document.createElement('canvas');
      const scale = Math.min(1, SCAN_MAX_SIDE / Math.max(video.videoWidth, video.videoHeight));
      const w = Math.max(1, Math.round(video.videoWidth * scale));
      const h = Math.max(1, Math.round(video.videoHeight * scale));
      scanCanvas.width = w;
      scanCanvas.height = h;
      const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(video, 0, 0, w, h);
      const candidates = await BarcodeScan.decodeCandidates(ctx.getImageData(0, 0, w, h));
      const frameSet = new Set(candidates.map((c) => c.text));

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
      if (liveCode) {
        // 锁定到期了，清掉过期结果，重新开始累计投票，而不是让一个过期号码悬在那
        liveCode = '';
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

      const confirmedTexts = [...voteCounts.keys()].filter((text) =>
        (voteCounts.get(text) || 0) >= VOTES_TO_CONFIRM || (consecutiveHits.get(text) || 0) >= CONSECUTIVE_TO_CONFIRM
      );

      if (confirmedTexts.length === 1) {
        liveCode = confirmedTexts[0];
        lockedUntil = Date.now() + LOCK_HOLD_MS;
        if (navigator.vibrate) navigator.vibrate(60);
        updateScanStatus();
      } else if (confirmedTexts.length > 1) {
        // 不擅自二选一：多个候选都稳定出现，交给用户点选，避免把分拣码/路由码
        // 之类的另一个有效条码悄悄当成快递单号入库。
        updateScanStatus(confirmedTexts);
      } else if (!frameSet.size && missCount > MISS_TOLERANCE) {
        voteWindow = [];
        consecutiveHits = new Map();
        updateScanStatus();
      } else {
        updateScanStatus();
      }
    } catch (e) {
      // 单帧识别失败不影响下一帧继续尝试
    } finally {
      scanBusy = false;
    }
  }

  function startScanLoop() {
    stopScanLoop();
    resetScanState();
    updateScanStatus();
    scanTimer = setInterval(scanOneFrame, SCAN_INTERVAL_MS);
  }

  function stopScanLoop() {
    if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
    scanBusy = false;
  }

  async function open(onCapture) {
    if (!canUseLiveCamera()) {
      fallbackFilePick(onCapture);
      return;
    }
    const modal = el('camera-modal');
    if (!modal) { fallbackFilePick(onCapture); return; }
    onCaptureCb = onCapture;
    modal.classList.remove('hidden');
    const video = el('camera-video');
    try {
      // 主动要一个较高分辨率的画面（很多手机浏览器默认给的分辨率偏低，条码本来就小的话
      // 更难识别）；ideal 只是期望值，设备给不了会自动降级，不会导致打不开摄像头。
      // 注意：只给 width 一个期望值，不强行指定 height——手机摄像头天生是长方形
      // （常见 3:4 / 9:16），width/height 都指定成一样的数等于要求一个正方形画面，
      // 会跟设备实际拍出来的画幅对不上，看起来就是"跟手机摄像头本身不一样"。
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1920 } },
      });
      video.srcObject = stream;
      await video.play();
      startScanLoop();
    } catch (e) {
      close();
      fallbackFilePick(onCapture);
    }
  }

  function close() {
    stopScanLoop();
    resetScanState();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    const video = el('camera-video');
    if (video) video.srcObject = null;
    el('camera-modal')?.classList.add('hidden');
    onCaptureCb = null;
  }

  function capture() {
    const video = el('camera-video');
    // readyState < 2 (HAVE_CURRENT_DATA) 意味着还没有真正解码出一帧画面，这时候拍
    // 大概率拿到的是黑屏/半帧，存下来的照片打开就是坏的——先等画面真正就绪。
    if (!video || !video.videoWidth || video.readyState < 2) {
      toast('摄像头画面还没准备好，请稍等一下再拍', 'err');
      return;
    }

    // 拍照这一下，如果实时循环已经连续确认过一个号码且还在锁定时间内，直接采信——
    // 用户在按下快门前就已经在状态栏看到了这个号码，拍出来的静态照片再重新识别一遍
    // 反而可能因为摩尔纹等原因得到不一致的结果，没必要多此一举。
    const recognizedText = (liveCode && Date.now() < lockedUntil) ? liveCode : null;

    let w = video.videoWidth;
    let h = video.videoHeight;
    const scale = Math.min(1, CAPTURE_MAX_DIM / Math.max(w, h));
    w = Math.round(w * scale);
    h = Math.round(h * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) {
        toast('拍照失败，请重试', 'err');
        return;
      }
      const file = new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' });
      const cb = onCaptureCb;
      close();
      if (cb) cb(file, recognizedText);
    }, 'image/jpeg', 0.92);
  }

  function init() {
    if (!el('camera-modal')) return;
    el('camera-modal').querySelectorAll('[data-close-camera]').forEach((b) => b.addEventListener('click', close));
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
  }
  document.addEventListener('DOMContentLoaded', init);

  return { open, close };
})();
