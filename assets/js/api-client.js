/* expv7 — 共享 API 客户端：统一 fetch 封装、JSON 信封解析、Toast、HTML 转义 */
(function (global) {
  const API_BASE = 'api/';

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toastRoot() {
    let root = document.getElementById('toast-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'toast-root';
      document.body.appendChild(root);
    }
    return root;
  }

  function toast(msg, type = 'info', duration = 2600) {
    const root = toastRoot();
    const el = document.createElement('div');
    el.className = `toast-item ${type}`;
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 200);
    }, duration);
  }

  async function request(action, { method = 'GET', params = {}, body, endpoint = 'auth', suppressErrorToast = false } = {}) {
    const qs = new URLSearchParams({ action, ...params });
    const url = `${API_BASE}${endpoint}.php?${qs.toString()}`;
    const opts = {
      method,
      credentials: 'same-origin',
      headers: {},
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    let res, data;
    try {
      res = await fetch(url, opts);
      data = await res.json();
    } catch (e) {
      if (!suppressErrorToast) toast('网络异常，请重试', 'err');
      throw e;
    }

    if (res.status === 401) {
      if (data && data.redirect === 'login' && !isOnLoginPage()) {
        location.href = resolveLoginPath();
      }
      throw new Error(data?.msg || 'UNAUTHORIZED');
    }

    if (!data || data.ok !== true) {
      const msg = data?.msg || '操作失败';
      if (!suppressErrorToast) toast(msg, 'err');
      const err = new Error(msg);
      err.payload = data;
      throw err;
    }

    return data;
  }

  function resolveLoginPath() {
    return 'login.html';
  }

  function isOnLoginPage() {
    return /(^|\/)login\.html$/.test(location.pathname);
  }

  function api(endpoint, action, options) {
    return request(action, { ...options, endpoint });
  }

  async function uploadFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API_BASE}upload.php`, {
      method: 'POST',
      credentials: 'same-origin',
      body: fd,
    });
    const data = await res.json();
    if (!data || data.ok !== true) {
      toast(data?.msg || '上传失败', 'err');
      throw new Error(data?.msg || 'upload failed');
    }
    return data.path;
  }

  async function deleteUploadedFile(path) {
    try {
      await fetch(`${API_BASE}upload.php?path=${encodeURIComponent(path)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    } catch (e) { /* best effort */ }
  }

  function fmtDate(s) {
    if (!s) return '';
    return String(s).replace('T', ' ').slice(0, 16);
  }

  function debounce(fn, wait = 350) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  // 姓名/电话/地址拼成一段不带"姓名："这种标签的自然文本，方便直接粘到快递公司
  // 网站的地址智能识别框里——那类识别框本来就是照着客户自己发来的文本训练的，
  // 带标签反而更容易被当成地址的一部分识别错，不带标签兼容性最好。
  function customerAddressText({ name, phone, address }) {
    return [String(name || '').trim(), String(phone || '').trim()]
      .filter(Boolean).join(' ') + (address ? '\n' + String(address).trim() : '');
  }

  global.Api = { api, uploadFile, deleteUploadedFile };
  global.esc = esc;
  global.toast = toast;
  global.fmtDate = fmtDate;
  global.debounce = debounce;
  global.customerAddressText = customerAddressText;
})(window);
