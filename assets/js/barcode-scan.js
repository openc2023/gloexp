/* expv7 — 条形码识别（本地 ZXing，assets/vendor/zxing，不依赖 CDN）
   只提供 decodeFile(file)：图片选择/拖拽/拍照上传面单图片时，顺带尝试识别条码，
   不再有独立的"扫码"弹窗入口——识别和图片上传是同一个动作，见 inbound.js / outbound.js
   里的 handleImageFiles()。 */
const BarcodeScan = (function () {
  let reader = null;
  function ensureReader() {
    if (!reader) reader = new ZXing.BrowserMultiFormatReader();
    return reader;
  }

  async function decodeFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) return null;
    const url = URL.createObjectURL(file);
    try {
      const result = await ensureReader().decodeFromImageUrl(url);
      return result.getText();
    } catch (e) {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  return { decodeFile };
})();
