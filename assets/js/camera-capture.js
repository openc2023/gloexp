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
    // readyState < 2 (HAVE_CURRENT_DATA) 意味着还没有真正解码出一帧画面，这时候拍
    // 大概率拿到的是黑屏/半帧，存下来的照片打开就是坏的——先等画面真正就绪。
    if (!video || !video.videoWidth || video.readyState < 2) {
      toast('摄像头画面还没准备好，请稍等一下再拍', 'err');
      return;
    }

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
      if (cb) cb(file);
    }, 'image/jpeg', 0.92);
  }

  function init() {
    if (!el('camera-modal')) return;
    el('camera-modal').querySelectorAll('[data-close-camera]').forEach((b) => b.addEventListener('click', close));
    el('camera-btn-shoot')?.addEventListener('click', capture);
  }
  document.addEventListener('DOMContentLoaded', init);

  return { open, close };
})();
