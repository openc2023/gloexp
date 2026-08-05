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

  global.Api = { api, uploadFile, deleteUploadedFile };
  global.esc = esc;
  global.toast = toast;
  global.fmtDate = fmtDate;
  global.debounce = debounce;
})(window);
