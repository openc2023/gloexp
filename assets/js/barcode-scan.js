/* expv7 — 条形码识别（本地 ZXing-C++ WASM，assets/vendor/zxing-wasm，不依赖 CDN）
   提供 decodeFile(file)：图片选择/拖拽/拍照上传面单图片时，顺带尝试识别条码，
   不再有独立的"扫码"弹窗入口——识别和图片上传是同一个动作，见 inbound.js / outbound.js
   里的 handleImageFiles()。

   原来用的是纯 JS 移植版 ZXing（BrowserMultiFormatReader），换成 ZXing-C++ 编译出来的
   WASM 版（zxing-wasm）——同一套 C++ 解码核心，比纯 JS 移植版本准确率明显更高，
   自带 tryRotate（真正在解码器内部做旋转重试，能读出侧躺 90/270 度的条码——这是
   之前纯 JS 版 decodeFromImageUrl 这条路径做不到的，当时验证过是库本身的限制，
   转了也没用；WASM 版本身支持，不是我们代码层面能不能做的问题）和 tryInvert
   （黑白反色打印的条码）。

   识别策略（从便宜到贵，逐级 fallback）：
   1. 先对整张图直接解码一次，交给 WASM 核心自己做 tryHarder/tryRotate/tryInvert/
      tryDownscale——大多数情况条码本来就不算小，直接就中，最快。
   2. 失败再切成若干张有重叠的局部裁剪图，逐块在各自原始分辨率下解码——
      专门应对"图片本身很大很清晰，但条码在画面里只占一小块"：整图一起丢给
      解码器时条码占的有效像素比例太低，切块后占比被放大，成功率明显更高。
      （小图切块没意义，跳过。）
   3. 上面都不行，做一次中值滤波去噪再重新走一遍直接解码/切块——专门应对
      摩尔纹（比如对着屏幕或反光面拍）和相机噪点这类"条码本身没问题、但画面
      被高频干扰纹路弄花了"的情况。
      对于清晰度不够、本来就很小、或者被大面积反光/污渍挡住的条码，以上手段
      都无法凭空造出细节，帮不上忙——这种只能让客户重新提供更清楚的照片。

   格式限定成一维码白名单，不是"只认 Code128"，也不是"什么都试"：面单上除了
   快递单号，往往还印着分拣码/路由码/商家内部码，一帧解码可能同时冒出好几个
   有效条码——formats 限成常见一维码可以过滤掉二维码/PDF417 这类快递单号不会用
   的格式（减少无关候选和运算量），但不能只留 Code128，不同快递公司用的码制
   不一样，漏识别了反而更麻烦。
   maxNumberOfSymbols 同理不能设成 1——"一帧只认第一个"不代表"第一个就是
   快递单号"，设成 6 是为了让画面里所有有效条码都进候选池，交给后面的合理性
   过滤（长度/字符集）和多帧投票去挑出真正的单号，而不是解码器随便挑一个就停。 */
const BarcodeScan = (function () {
  let modulePrepared = null;
  let lastDecodeErrorAt = 0;

  const TRACKING_FORMATS = ['Code128', 'Code39', 'ITF', 'EAN13', 'EAN8', 'Codabar'];
  const MAX_SYMBOLS_PER_FRAME = 6;
  const PHOTO_MAX_SIDE = 2600;
  const PHOTO_RETRY_MAX_SIDE = 1280;

  // 快递单号的粗过滤：太短的（比如 6 位数字分拣码）、太长的、带非法字符的，
  // 直接排除在候选之外，不进多帧投票，减少把无关条码误当单号的概率。这是通用
  // 规则，没有按具体快递公司再收紧——收紧了万一识别对了快递公司却猜错格式，
  // 反而会把真正正确的号码也过滤掉，通用规则更安全。
  function isPlausibleTrackingNumber(text) {
    const value = (text || '').trim();
    return value.length >= 8 && value.length <= 30 && /^[A-Za-z0-9-]+$/.test(value);
  }

  function ensureModule() {
    if (!modulePrepared) {
      modulePrepared = (async () => {
        if (!window.ZXingWASM) {
          throw new Error('条形码识别核心未加载');
        }
        await ZXingWASM.prepareZXingModule({
          fireImmediately: true,
          overrides: {
            locateFile(path, prefix) {
              if (path.endsWith('.wasm')) {
                return 'assets/vendor/zxing-wasm/zxing_reader.wasm';
              }
              return prefix + path;
            },
          },
        });
      })().catch((error) => {
        // 网络/路径等临时问题修复后允许下一帧重新加载，而不是永久缓存 rejected Promise。
        modulePrepared = null;
        throw error;
      });
    }
    return modulePrepared;
  }

  // 返回这一帧/这张图里所有"看起来像快递单号"的候选：校验通过 + 格式在白名单里
  // + 长度字符集像单号。可能是 0 个、1 个，也可能好几个（面单上不止一个条码时）——
  // 是否只有一个、要不要提示用户从多个候选里选，交给调用方（实时循环里做多帧投票，
  // 静态图片会聚合多尺度候选；只有唯一候选才自动采用，多个候选交给用户确认。
  async function decodeCandidates(imageData, options = {}) {
    try {
      await ensureModule();
      const results = await ZXingWASM.readBarcodes(imageData, {
        formats: options.formats || TRACKING_FORMATS,
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        maxNumberOfSymbols: options.maxNumberOfSymbols || MAX_SYMBOLS_PER_FRAME,
      });
      const seen = new Set();
      const candidates = [];
      for (const r of results) {
        if (!r?.isValid || typeof r.text !== 'string') continue;
        const text = r.text.trim();
        // 参考页的实时 Code128 链路只检查 ZXing 校验是否通过，不在解码阶段
        // 按长度删除结果。业务合理性应当用于排序/确认，而不是让正确结果消失。
        if (!text || (options.filterPlausible !== false && !isPlausibleTrackingNumber(text)) || seen.has(text)) continue;
        seen.add(text);
        candidates.push({ text, format: r.format, position: r.position || null });
      }
      return candidates;
    } catch (e) {
      // 实时循环会持续调用，限频输出以免控制台被刷满，但保留真实故障线索。
      if (Date.now() - lastDecodeErrorAt > 5000) {
        console.warn('条形码解码失败：', e);
        lastDecodeErrorAt = Date.now();
      }
      if (options.throwOnError) throw e;
      return [];
    }
  }

  async function decodeImageData(imageData) {
    const candidates = await decodeCandidates(imageData);
    return candidates.length === 1 ? candidates[0].text : null;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  function imageDataFrom(img, sx, sy, sw, sh) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function createScaledCanvas(source, maxSide) {
    const sourceW = source.naturalWidth || source.width;
    const sourceH = source.naturalHeight || source.height;
    const scale = Math.min(1, maxSide / Math.max(sourceW, sourceH));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sourceW * scale));
    canvas.height = Math.max(1, Math.round(sourceH * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(
      source, 0, 0, sourceW, sourceH, 0, 0, canvas.width, canvas.height
    );
    return canvas;
  }

  function createCenterBarcodeCrop(source) {
    const sourceW = source.naturalWidth || source.width;
    const sourceH = source.naturalHeight || source.height;
    const sx = Math.round(sourceW * 0.03);
    const sy = Math.round(sourceH * 0.16);
    const sw = Math.max(1, Math.round(sourceW * 0.94));
    const sh = Math.max(1, Math.round(sourceH * 0.68));
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(
      source, sx, sy, sw, sh, 0, 0, sw, sh
    );
    return canvas;
  }

  function addCandidateGroup(store, candidates, source) {
    for (const candidate of candidates) {
      let item = store.get(candidate.text);
      if (!item) {
        item = { text: candidate.text, format: candidate.format, hits: 0, sources: [] };
        store.set(candidate.text, item);
      }
      // 同一次识别调用里已经去重，因此 hits 表示独立尺度/区域的重复命中数。
      item.hits += 1;
      item.sources.push(source);
    }
  }

  async function collectCanvasCandidates(store, canvas, source, decodeOptions = {}) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const candidates = await decodeCandidates(
      ctx.getImageData(0, 0, canvas.width, canvas.height),
      decodeOptions
    );
    addCandidateGroup(store, candidates, source);
  }

  async function collectTiledCandidates(store, img, decodeOptions = {}) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const cols = 3, rows = 3, overlap = 0.2;
    const tileW = w / cols, tileH = h / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = Math.max(0, col * tileW - tileW * overlap);
        const y = Math.max(0, row * tileH - tileH * overlap);
        const width = Math.min(w - x, tileW * (1 + overlap * 2));
        const height = Math.min(h - y, tileH * (1 + overlap * 2));
        const candidates = await decodeCandidates(imageDataFrom(img, x, y, width, height), decodeOptions);
        addCandidateGroup(store, candidates, `局部区域 ${row + 1}-${col + 1}`);
      }
    }
  }

  async function collectReferenceScales(store, source, decodeOptions = {}) {
    const workingCanvas = createScaledCanvas(source, PHOTO_MAX_SIDE);
    const retryCanvas = createScaledCanvas(workingCanvas, PHOTO_RETRY_MAX_SIDE);
    const cropCanvas = createCenterBarcodeCrop(workingCanvas);
    const cropRetryCanvas = createScaledCanvas(cropCanvas, PHOTO_RETRY_MAX_SIDE);
    await collectCanvasCandidates(store, workingCanvas, '完整照片', decodeOptions);
    await collectCanvasCandidates(store, retryCanvas, '完整照片 1280', decodeOptions);
    await collectCanvasCandidates(store, cropCanvas, '中央区域', decodeOptions);
    await collectCanvasCandidates(store, cropRetryCanvas, '中央区域 1280', decodeOptions);
    return workingCanvas;
  }

  // 直接识别尚未压缩成 JPEG 的拍照 Canvas。四级尺寸与参考测试页一致，
  // 避免窄条纹先经过 JPEG 压缩后再解码造成的边缘模糊和摩尔纹。
  async function decodeCanvasCandidates(source, options = {}) {
    const found = new Map();
    const primaryOptions = {
      formats: ['Code128'],
      maxNumberOfSymbols: 12,
      filterPlausible: false,
      throwOnError: true,
    };
    await collectReferenceScales(found, source, primaryOptions);
    if (!found.size && options.allowFallbackFormats !== false) {
      await collectReferenceScales(found, source, {
        formats: TRACKING_FORMATS.filter((format) => format !== 'Code128'),
        maxNumberOfSymbols: MAX_SYMBOLS_PER_FRAME,
      });
    }
    return sortCandidates([...found.values()], options.courierName);
  }

  function matchesCourierRule(text, courierName) {
    const name = String(courierName || '').toLowerCase();
    if (!name) return false;
    if (/(顺丰|sf)/i.test(name)) return /^SF[A-Z0-9]{10,}$/i.test(text);
    if (/(ems|邮政|우체국)/i.test(name)) return /^[A-Z]{2}\d{9}[A-Z]{2}$/i.test(text) || /^\d{13}$/.test(text);
    if (/ups/i.test(name)) return /^1Z[A-Z0-9]{16}$/i.test(text);
    if (/fedex/i.test(name)) return /^\d{12,15}$/.test(text);
    if (/dhl/i.test(name)) return /^\d{10}$/.test(text);
    // 其他快递公司没有足够可靠的唯一规则时不加分也不扣分，避免误杀正确单号。
    return false;
  }

  function candidateScore(candidate, courierName) {
    const formatScore = { Code128: 30, Code39: 22, ITF: 18, EAN13: 14, EAN8: 8, Codabar: 6 };
    const centerHits = candidate.sources.filter((source) => source.includes('中央')).length;
    return candidate.hits * 100 +
      (formatScore[candidate.format] || 0) +
      centerHits * 18 +
      Math.min(candidate.text.length, 20) +
      (matchesCourierRule(candidate.text, courierName) ? 120 : 0);
  }

  function sortCandidates(candidates, courierName) {
    const formatPriority = { Code128: 0, Code39: 1, ITF: 2, EAN13: 3, EAN8: 4, Codabar: 5 };
    candidates.forEach((candidate) => { candidate.score = candidateScore(candidate, courierName); });
    return candidates.sort((a, b) =>
      b.score - a.score ||
      (formatPriority[a.format] ?? 99) - (formatPriority[b.format] ?? 99) ||
      b.text.length - a.text.length ||
      a.text.localeCompare(b.text)
    );
  }

  // 3x3 网格切块，格子间留 20% 重叠，避免条码正好卡在切割线上被拦腰切断。
  // img 可以是 <img> 也可以是去噪产出的 <canvas>，两者取宽高的属性名不一样。
  async function decodeTiled(img) {
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return null;

    const cols = 3, rows = 3, overlap = 0.2;
    const tileW = w / cols, tileH = h / rows;
    const tiles = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = Math.max(0, c * tileW - tileW * overlap);
        const y = Math.max(0, r * tileH - tileH * overlap);
        const tw = Math.min(w - x, tileW * (1 + overlap * 2));
        const th = Math.min(h - y, tileH * (1 + overlap * 2));
        tiles.push({ x, y, w: tw, h: th });
      }
    }

    for (const t of tiles) {
      const imageData = imageDataFrom(img, t.x, t.y, t.w, t.h);
      const text = await decodeImageData(imageData);
      if (text) return text;
    }
    return null;
  }

  // 灰度化 + 中值滤波去噪：先转灰度，再用一个小窗口的中值滤波把摩尔纹/噪点这类
  // 局部离群像素抹掉，同时尽量保留条码黑白边缘的清晰度。
  function medianDenoise(img, radius = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data, width, height } = imageData;

    const gray = new Uint8ClampedArray(width * height);
    for (let i = 0; i < width * height; i++) {
      gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
    }

    const out = new Uint8ClampedArray(width * height);
    const win = [];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        win.length = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy));
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = Math.min(width - 1, Math.max(0, x + dx));
            win.push(gray[yy * width + xx]);
          }
        }
        win.sort((a, b) => a - b);
        out[y * width + x] = win[win.length >> 1];
      }
    }

    for (let i = 0; i < width * height; i++) {
      data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = out[i];
    }
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  async function decodeFileCandidates(file, options = {}) {
    if (!file || !file.type || !file.type.startsWith('image/')) return [];
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url).catch(() => null);
      if (!img || !img.naturalWidth) return [];

      // 手机原图可能达到 12MP～48MP；直接生成多份全尺寸 ImageData 会让移动浏览器
      // 卡死或触发 WASM 内存不足。与高成功率测试页一致，先限制工作图最长边。
      const found = new Map();

      // 第一轮完全采用参考页：四级尺寸全部只认 Code128，且不提前按长度删除。
      const workingCanvas = await collectReferenceScales(found, img, {
        formats: ['Code128'],
        maxNumberOfSymbols: 12,
        filterPlausible: false,
        throwOnError: true,
      });

      // 四级 Code128 均失败后，再尝试其他一维码，避免无关格式拖慢主链路。
      if (!found.size) {
        await collectReferenceScales(found, img, {
          formats: TRACKING_FORMATS.filter((format) => format !== 'Code128'),
          maxNumberOfSymbols: MAX_SYMBOLS_PER_FRAME,
        });
      }

      // 四种常规尝试均没有结果时才运行较贵的分块和去噪，不拖慢正常扫码。
      const big = workingCanvas.width * workingCanvas.height >= 700 * 700;
      if (!found.size && big) await collectTiledCandidates(found, workingCanvas);

      if (!found.size) {
        const denoisedCanvas = medianDenoise(workingCanvas);
        await collectCanvasCandidates(found, denoisedCanvas, '去噪照片');
        if (!found.size && big) await collectTiledCandidates(found, denoisedCanvas);
      }
      return sortCandidates([...found.values()], options.courierName);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 兼容旧调用：只有唯一候选才自动返回；多个候选绝不再静默取 results[0]。
  async function decodeFile(file) {
    const candidates = await decodeFileCandidates(file);
    return candidates.length === 1 ? candidates[0].text : null;
  }

  function chooseCandidate(candidates, title = '请选择快递单号') {
    const unique = [...new Map((candidates || []).map((item) => {
      const candidate = typeof item === 'string' ? { text: item } : item;
      return [candidate.text, candidate];
    })).values()].filter((item) => item?.text);
    if (!unique.length) return Promise.resolve(null);
    if (unique.length === 1) return Promise.resolve(unique[0].text);

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'fixed inset-0 z-[95] flex items-center justify-center p-4 bg-gray-900/75';
      const panel = document.createElement('div');
      panel.className = 'w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 shadow-xl p-5';
      const heading = document.createElement('h3');
      heading.className = 'text-base font-semibold text-gray-800 dark:text-gray-100';
      heading.textContent = title;
      const hint = document.createElement('p');
      hint.className = 'mt-1 mb-4 text-xs text-gray-500 dark:text-gray-400';
      hint.textContent = `检测到 ${unique.length} 个有效条码，系统无法安全自动判断，请点选正确单号。`;
      const choices = document.createElement('div');
      choices.className = 'space-y-2';

      const finish = (value) => { overlay.remove(); resolve(value); };
      for (const candidate of unique) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'w-full px-4 py-3 text-left rounded-md border border-purple-200 dark:border-purple-500/40 hover:bg-purple-50 dark:hover:bg-purple-500/10';
        const code = document.createElement('span');
        code.className = 'block font-semibold text-gray-800 dark:text-gray-100 break-all';
        code.textContent = candidate.text;
        const meta = document.createElement('span');
        meta.className = 'block mt-1 text-xs text-gray-500 dark:text-gray-400';
        meta.textContent = `${candidate.format || '条形码'}${candidate.hits ? ` · 多尺度命中 ${candidate.hits} 次` : ''}`;
        button.append(code, meta);
        button.addEventListener('click', () => finish(candidate.text));
        choices.appendChild(button);
      }

      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'mt-4 w-full px-3 py-2 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400';
      cancel.textContent = '取消，稍后手动输入';
      cancel.addEventListener('click', () => finish(null));
      overlay.addEventListener('click', (event) => { if (event.target === overlay) finish(null); });
      panel.append(heading, hint, choices, cancel);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    });
  }

  return {
    prepare: ensureModule,
    decodeFile,
    decodeFileCandidates,
    decodeCanvasCandidates,
    chooseCandidate,
    decodeImageData,
    decodeCandidates,
  };
})();

// 经典 script 中顶层 const 属于全局词法绑定，但不会成为 window 的属性。
// camera-capture.js 需要通过 window.BarcodeScan 判断模块是否已经加载；不显式导出时，
// 静态图片识别能调用 BarcodeScan，而实时摄像头循环却会每帧直接 return。
window.BarcodeScan = BarcodeScan;
