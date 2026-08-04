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
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream;
      await video.play();
    } catch (e) {
      close();
      fallbackFilePick(onCapture);
    }
  }

  function close() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    const video = el('camera-video');
    if (video) video.srcObject = null;
    el('camera-modal')?.classList.add('hidden');
    onCaptureCb = null;
  }

  function capture() {
    const video = el('camera-video');
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      const file = new File([blob], 'camera-' + Date.now() + '.jpg', { type: 'image/jpeg' });
      const cb = onCaptureCb;
      close();
      if (cb) cb(file);
    }, 'image/jpeg', 0.9);
  }

  function init() {
    if (!el('camera-modal')) return;
    el('camera-modal').querySelectorAll('[data-close-camera]').forEach((b) => b.addEventListener('click', close));
    el('camera-btn-shoot')?.addEventListener('click', capture);
  }
  document.addEventListener('DOMContentLoaded', init);

  return { open, close };
})();
