/* expv7 — 条形码识别（本地 ZXing，assets/vendor/zxing，不依赖 CDN）
   提供 decodeFile(file)：图片选择/拖拽/拍照上传面单图片时，顺带尝试识别条码，
   不再有独立的"扫码"弹窗入口——识别和图片上传是同一个动作，见 inbound.js / outbound.js
   里的 handleImageFiles()。

   识别策略：
   1. 先对整张图直接解码一次（大多数情况条码本来就不算小，直接就中，最快）。
   2. 失败再切成若干张有重叠的局部裁剪图，逐块在各自原始分辨率下解码——
      这是专门应对"图片本身很大很清晰，但条码在画面里只占一小块"的情况：
      整图一起丢给解码器时，条码所占的有效像素比例太低，容易识别不出来；
      切块后条码在单张裁剪图里的占比被放大了，解码成功率明显更高。
      对于清晰度不够、本来就很小的条码，切块无法凭空造出细节，帮不上忙。 */
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
  async function decodeTiled(img) {
    const w = img.naturalWidth, h = img.naturalHeight;
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
      const text = await decodeImageUrl(canvas.toDataURL('image/jpeg', 0.92));
      if (text) return text;
    }
    return null;
  }

  async function decodeFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return null;
    const url = URL.createObjectURL(file);
    try {
      const direct = await decodeImageUrl(url);
      if (direct) return direct;

      // 图不大的话切块也没意义（本来就没多少像素可分），跳过
      const img = await loadImage(url).catch(() => null);
      if (!img || img.naturalWidth * img.naturalHeight < 1600 * 1600) return null;
      return await decodeTiled(img);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { decodeFile };
})();
