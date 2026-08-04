/* expv7 — 图片原图预览：点面单/包裹图片缩略图弹出大图，不再用 window.open 新开标签页。 */
const Lightbox = (function () {
  function open(path) {
    const modal = document.getElementById('lightbox-modal');
    const img = document.getElementById('lightbox-img');
    if (!modal || !img || !path) return;
    img.src = path;
    modal.classList.remove('hidden');
  }
  function close() {
    document.getElementById('lightbox-modal')?.classList.add('hidden');
  }
  function init() {
    const modal = document.getElementById('lightbox-modal');
    if (!modal) return;
    modal.querySelectorAll('[data-close-lightbox]').forEach((b) => b.addEventListener('click', close));
    document.getElementById('lightbox-img')?.addEventListener('click', (e) => e.stopPropagation());
  }
  document.addEventListener('DOMContentLoaded', init);
  return { open, close };
})();
