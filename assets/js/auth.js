/* expv7 — 会话管理：登录态校验、登录/登出、首次登录强制改密、修改密码入口 */
(function (global) {
  async function checkSession() {
    const data = await Api.api('auth', 'check');
    return data.user;
  }

  function showApp() {
    const boot = document.getElementById('boot-loading');
    const app = document.getElementById('app');
    if (boot) boot.classList.add('hidden');
    if (app) {
      app.classList.remove('hidden');
      app.classList.add('flex');
    }
  }

  function renderUserBadge(user) {
    document.querySelectorAll('.js-username').forEach((el) => { el.textContent = user.username; });
    document.querySelectorAll('.js-role').forEach((el) => {
      el.textContent = user.role === 'admin' ? '超级管理员' : (user.group_name || '操作员');
    });
    document.querySelectorAll('.js-avatar-letter').forEach((el) => {
      el.textContent = (user.username || '?').slice(0, 1).toUpperCase();
    });
  }

  async function protectPage() {
    let user;
    try {
      user = await checkSession();
    } catch (e) {
      location.href = 'login.html';
      return null;
    }
    if (!user) {
      location.href = 'login.html';
      return null;
    }
    global.__user = user;
    renderUserBadge(user);
    showApp();
    ensurePasswordUi();
    if (user.must_change_pwd) {
      openPwdModal(true);
    }
    document.dispatchEvent(new CustomEvent('auth:ready', { detail: user }));
    return user;
  }

  async function doLogout() {
    try { await Api.api('auth', 'logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    location.href = 'login.html';
  }

  async function doLogin(username, password) {
    const data = await Api.api('auth', 'login', { method: 'POST', body: { username, password } });
    return data.user;
  }

  // ── 修改密码 modal（首次登录强制 / 侧栏手动触发）───────────────
  function ensurePasswordUi() {
    if (document.getElementById('pwd-modal')) return;
    const wrap = document.createElement('div');
    wrap.id = 'pwd-modal';
    wrap.className = 'hidden fixed inset-0 z-50 flex items-center justify-center px-4';
    wrap.innerHTML = `
      <div class="modal-backdrop absolute inset-0 bg-gray-900/50" data-pwd-backdrop></div>
      <div class="modal-panel relative w-full max-w-sm rounded-lg bg-white dark:bg-gray-800 shadow-xl p-6">
        <h3 class="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">修改密码</h3>
        <p id="pwd-modal-hint" class="text-xs text-gray-500 dark:text-gray-400 mb-4">首次登录请先设置新密码</p>
        <form id="pwd-form" class="space-y-3">
          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">原密码</label>
            <input type="password" id="pwd-old" required class="w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500" />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">新密码（至少 6 位）</label>
            <input type="password" id="pwd-new" required minlength="6" class="w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500" />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-600 dark:text-gray-300 mb-1">确认新密码</label>
            <input type="password" id="pwd-new2" required minlength="6" class="w-full rounded-md border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-500" />
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" id="pwd-cancel" class="px-3 py-1.5 text-sm rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700">取消</button>
            <button type="submit" class="px-3 py-1.5 text-sm rounded-md bg-purple-600 text-white hover:bg-purple-700">确认修改</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(wrap);

    document.getElementById('pwd-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const old_password = document.getElementById('pwd-old').value.trim();
      const new_password = document.getElementById('pwd-new').value.trim();
      const new_password2 = document.getElementById('pwd-new2').value.trim();
      if (new_password !== new_password2) {
        toast('两次输入的新密码不一致', 'err');
        return;
      }
      try {
        await Api.api('auth', 'change_pwd', { method: 'POST', body: { old_password, new_password } });
        toast('密码已更新', 'ok');
        closePwdModal();
        global.__user.must_change_pwd = false;
      } catch (e) { /* toast already shown */ }
    });
    document.getElementById('pwd-cancel').addEventListener('click', () => {
      if (global.__user && global.__user.must_change_pwd) {
        toast('请先完成密码修改', 'info');
        return;
      }
      closePwdModal();
    });
  }

  function openPwdModal(forced = false) {
    ensurePasswordUi();
    const modal = document.getElementById('pwd-modal');
    document.getElementById('pwd-modal-hint').textContent = forced
      ? '首次登录请先设置新密码后再继续'
      : '输入原密码和新密码完成修改';
    document.getElementById('pwd-cancel').classList.toggle('hidden', forced);
    document.getElementById('pwd-form').reset();
    modal.classList.remove('hidden');
  }

  function closePwdModal() {
    const modal = document.getElementById('pwd-modal');
    if (modal) modal.classList.add('hidden');
  }

  global.Auth = { checkSession, protectPage, doLogout, doLogin, openPwdModal, renderUserBadge };
})(window);
