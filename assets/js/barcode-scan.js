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
      都无法凭空造出细节，帮不上忙——这种只能让客户重新提供更清楚的照片。 */
const BarcodeScan = (function () {
  let modulePrepared = null;

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
      })();
    }
    return modulePrepared;
  }

  async function decodeImageData(imageData) {
    try {
      await ensureModule();
      const results = await ZXingWASM.readBarcodes(imageData, {
        tryHarder: true,
        tryRotate: true,
        tryInvert: true,
        tryDownscale: true,
        maxNumberOfSymbols: 1,
      });
      const hit = results.find((r) => r?.isValid && typeof r.text === 'string' && r.text.trim());
      return hit ? hit.text.trim() : null;
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

  function imageDataFrom(img, sx, sy, sw, sh) {
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    return ctx.getImageData(0, 0, sw, sh);
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
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
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

  async function decodeFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return null;
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url).catch(() => null);
      if (!img || !img.naturalWidth) return null;

      const direct = await decodeImageData(imageDataFrom(img, 0, 0, img.naturalWidth, img.naturalHeight));
      if (direct) return direct;

      // 门槛比较宽松：只要不是明显很小的缩略图（3x3 切完每块还有点分辨率可用）
      // 就值得试一次切块，切块本身也不贵。
      const big = img.naturalWidth * img.naturalHeight >= 700 * 700;
      if (big) {
        const tiled = await decodeTiled(img);
        if (tiled) return tiled;
      }

      // 最后一级：去噪后再试一遍整图直接解码 + 切块（大图才切块，小图没意义）
      const denoisedCanvas = medianDenoise(img);
      const denoisedCtx = denoisedCanvas.getContext('2d', { willReadFrequently: true });
      const denoisedData = denoisedCtx.getImageData(0, 0, denoisedCanvas.width, denoisedCanvas.height);
      const denoisedText = await decodeImageData(denoisedData);
      if (denoisedText) return denoisedText;
      if (big) return await decodeTiled(denoisedCanvas);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { decodeFile };
})();
