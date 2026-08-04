/* expv7 — 条形码识别（本地 ZXing，assets/vendor/zxing，不依赖 CDN）
   提供 decodeFile(file)：图片选择/拖拽/拍照上传面单图片时，顺带尝试识别条码，
   不再有独立的"扫码"弹窗入口——识别和图片上传是同一个动作，见 inbound.js / outbound.js
   里的 handleImageFiles()。

   识别策略（从便宜到贵，逐级 fallback）：
   1. 先对整张图直接解码一次（大多数情况条码本来就不算小，直接就中，最快）。
   2. 失败再切成若干张有重叠的局部裁剪图，逐块在各自原始分辨率下解码——
      专门应对"图片本身很大很清晰，但条码在画面里只占一小块"：整图一起丢给
      解码器时条码占的有效像素比例太低，切块后占比被放大，成功率明显更高。
      （小图切块没意义，跳过。）
   3. 上面都不行，做一次中值滤波去噪再重新走一遍直接解码/切块——专门应对
      摩尔纹（比如对着屏幕或反光面拍）和相机噪点这类"条码本身没问题、但画面
      被高频干扰纹路弄花了"的情况。中值滤波对这种局部离群像素特别有效，
      比 NLM 计算量小得多，纯 JS 在手机上跑单张图也就一两秒，作为最后一级
      兜底可以接受。
      对于清晰度不够、本来就很小、或者被大面积反光/污渍挡住的条码，以上手段
      都无法凭空造出细节，帮不上忙——这种只能让客户重新提供更清楚的照片。

      （曾经在这里加过一级"整图转 90/180/270 度重试"，后来验证发现纯粹是
      浪费时间就去掉了：180 度的情况其实第 1 步直接解码就已经能读出来
      （ZXing 对一维码的首尾方向本来就不敏感），而 90/270 度真正"侧躺"的
      条码，不管转不转、ZXing 这条浏览器解码路径都读不出来——是库本身在
      这条 API 上的限制，转了也没用，白白多花好几秒。） */
const BarcodeScan = (function () {
  let reader = null;
  function ensureReader() {
    if (!reader) {
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true); // 单张静态图解码，不追求实时速度，宁可多花点时间换成功率
      reader = new ZXing.BrowserMultiFormatReader(hints);
    }
    return reader;
  }

  async function decodeImageUrl(url) {
    try {
      const result = await ensureReader().decodeFromImageUrl(url);
      return result.getText();
    } catch (e) {
      return null;
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
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
      const canvas = document.createElement('canvas');
      canvas.width = t.w;
      canvas.height = t.h;
      canvas.getContext('2d').drawImage(img, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      // 用无损 PNG，不要 JPEG——JPEG 的有损压缩会在条码黑白边缘introduce新的振铃
      // 伪影，把切块/去噪好不容易换来的清晰边缘又弄花，实测验证过这个区别是真的：
      // 同一张去噪后的图，PNG 能解出来，JPEG（92% 质量）解不出来。这些图片只是
      // 临时拿去解码、不会上传/存储，用 PNG 也没有体积代价。
      const text = await decodeImageUrl(canvas.toDataURL('image/png'));
      if (text) return text;
    }
    return null;
  }

  // 灰度化 + 中值滤波去噪：先转灰度（条码识别本来就是黑白模式，色彩通道没用，
  // 顺带减少后续计算量），再用一个小窗口的中值滤波把摩尔纹/噪点这类局部离群
  // 像素抹掉，同时尽量保留条码黑白边缘的清晰度（中值滤波对保边缘比均值模糊要好）。
  function medianDenoise(img, radius = 1) {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
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

  async function decodeFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return null;
    const url = URL.createObjectURL(file);
    try {
      const direct = await decodeImageUrl(url);
      if (direct) return direct;

      const img = await loadImage(url).catch(() => null);
      if (!img || !img.naturalWidth) return null;

      // 之前拿 1600x1600（约 256 万像素）当"值不值得切块"的门槛，是照着一张刻意造的
      // 3000x3000 测试图拍脑袋定的——真实测试发现一张很普通的 1080x1920（约 207 万
      // 像素）手机截图/照片会被这个门槛卡在外面，切块压根没机会跑，明显定高了。
      // 改成一个宽松很多的门槛：只要不是明显很小的缩略图（3x3 切完每块还有点分辨率
      // 可用）就值得试一次，切块本身也不贵。
      const big = img.naturalWidth * img.naturalHeight >= 700 * 700;
      if (big) {
        const tiled = await decodeTiled(img);
        if (tiled) return tiled;
      }

      // 最后一级：去噪后再试一遍整图直接解码 + 切块（大图才切块，小图没意义）
      const denoisedCanvas = medianDenoise(img);
      const denoisedText = await decodeImageUrl(denoisedCanvas.toDataURL('image/png'));
      if (denoisedText) return denoisedText;
      if (big) return await decodeTiled(denoisedCanvas);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { decodeFile };
})();
