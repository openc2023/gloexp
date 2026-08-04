/* expv7 — 侧边栏 + 顶栏渲染（Windmill Dashboard 视觉语言），单一 MENU 数据源，按权限过滤 */
(function (global) {
  const ICONS = {
    home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    inbox: 'M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0l-2.3 2.3a1 1 0 01-.7.3H9a1 1 0 01-.7-.3L6 13m14 0h-3.6a1 1 0 00-.7.3l-1.4 1.4a1 1 0 01-.7.3h-2.2a1 1 0 01-.7-.3l-1.4-1.4a1 1 0 00-.7-.3H3',
    truck: 'M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v9a1 1 0 001 1h1m8-1a1 1 0 01-1 1H9m4-1V8a1 1 0 011-1h2.6a1 1 0 01.7.3l3.4 3.4a1 1 0 01.3.7V16a1 1 0 01-1 1h-1m-9 0a2 2 0 104 0 2 2 0 00-4 0zm9 0a2 2 0 104 0 2 2 0 00-4 0z',
    users: 'M17 20h5v-1a4 4 0 00-3-3.87M9 20H4v-1a4 4 0 013-3.87m9-5.13a4 4 0 11-8 0 4 4 0 018 0zM12 14a5 5 0 00-5 5v1h10v-1a5 5 0 00-5-5z',
    building: 'M5 21V7l7-4 7 4v14M5 21h14M5 21H3m16 0h2M9 9h1m-1 4h1m4-4h1m-1 4h1m-6 8v-4a1 1 0 011-1h2a1 1 0 011 1v4',
    trash: 'M19 7l-.87 12.14A2 2 0 0116.14 21H7.86a2 2 0 01-2-1.86L5 7m5 4v6m4-6v6M4 7h16M9.5 4h5l.5 3h-6l.5-3z',
    clipboard: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    search: 'M10 3a7 7 0 104.9 12.02l4.54 4.54a1 1 0 001.42-1.42l-4.54-4.54A7 7 0 0010 3z',
  };

  const MENU = [
    { href: 'index.html', label: '首页', perm: null, icon: 'home' },
    { href: 'inbound.html', label: '新增入库单', perm: 'inbound:view', icon: 'inbox' },
    { href: 'outbound.html', label: '快递管理', perm: 'parcels:view', icon: 'truck' },
    { href: 'team.html', label: '团队管理', perm: 'team:view', icon: 'users' },
    { href: 'couriers.html', label: '快递商管理', perm: 'couriers:view', icon: 'building' },
    { href: 'trash.html', label: '回收站', perm: 'trash:view', icon: 'trash' },
    { href: 'logs.html', label: '操作日志', perm: 'logs:view', icon: 'clipboard' },
  ];
  // 查快递指向公开的前台查询页（track.html），不受权限系统管辖，新标签页打开，
  // 不影响管理员当前正在操作的后台页面/筛选状态。跟上面几项用分隔线隔开，视觉上区分"这是外部页面"。
  const EXTRA_MENU = [
    { href: 'track.html', label: '查快递', perm: null, icon: 'search', external: true },
  ];

  function icon(name, extraClass = 'w-5 h-5') {
    const d = ICONS[name] || ICONS.home;
    return `<svg class="${extraClass}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="${d}"></path></svg>`;
  }

  function currentFile() {
    const p = location.pathname.split('/').pop();
    return p || 'index.html';
  }

  function menuItemHtml(m, activeHref) {
    const active = m.href === activeHref;
    return `
      <li class="relative px-2 py-0.5">
        <a href="${m.href}" ${m.external ? 'target="_blank" rel="noopener"' : ''}
           class="inline-flex items-center gap-3 w-full text-sm font-medium px-3 py-2.5 rounded-lg transition-colors
                  ${active
                    ? 'bg-purple-50 text-purple-700 dark:bg-gray-700 dark:text-purple-300'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-800 dark:hover:text-gray-100'}">
          ${icon(m.icon, 'w-5 h-5 flex-shrink-0')}
          <span>${esc(m.label)}</span>
        </a>
        ${active ? '<span class="absolute inset-y-0 left-0 w-1 rounded-r bg-purple-600"></span>' : ''}
      </li>`;
  }

  function sidebarHtml(activeHref) {
    const items = MENU.filter((m) => hasPerm(m.perm)).map((m) => menuItemHtml(m, activeHref)).join('');
    const extraItems = EXTRA_MENU.filter((m) => hasPerm(m.perm)).map((m) => menuItemHtml(m, activeHref)).join('');

    return `
      <div class="py-4 text-gray-500 dark:text-gray-300">
        <a href="index.html" class="flex items-center gap-2 px-6 mb-6">
          <span class="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-600 text-white font-bold text-sm">快</span>
          <span class="text-base font-semibold text-gray-800 dark:text-gray-100">快递管理系统</span>
        </a>
        <ul class="mt-2">${items}</ul>
        ${extraItems ? `<ul class="mt-2 pt-2 mx-4 border-t border-gray-100 dark:border-gray-700">${extraItems}</ul>` : ''}
      </div>
      <div class="px-6 py-4 border-t border-gray-100 dark:border-gray-700">
        <button id="btn-change-pwd" class="w-full inline-flex items-center gap-2 text-sm text-gray-500 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-300">
          ${icon('users', 'w-4 h-4')}
          <span>修改密码</span>
        </button>
      </div>`;
  }

  function topbarHtml() {
    return `
      <div class="flex items-center justify-between h-full px-4 md:px-6">
        <div class="flex items-center gap-3">
          <button id="btn-open-sidebar" class="md:hidden p-2 rounded-md text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
            <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 12h16M4 18h16"/></svg>
          </button>
          <h1 id="page-title" class="text-lg font-semibold text-gray-800 dark:text-gray-100"></h1>
        </div>
        <div class="flex items-center gap-3">
          <button id="btn-theme" class="p-2 rounded-md text-gray-500 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700" title="切换主题">
            <svg id="icon-sun" class="w-5 h-5 hidden" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.36 6.36l-.7-.7M6.34 6.34l-.7-.7m12.02 0l-.7.7M6.34 17.66l-.7.7M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
            <svg id="icon-moon" class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 1020.354 15.354z"/></svg>
          </button>
          <div class="relative">
            <button id="btn-profile" class="flex items-center gap-2 focus:outline-none">
              <span class="js-avatar-letter flex items-center justify-center w-8 h-8 rounded-full bg-purple-600 text-white text-sm font-semibold">?</span>
              <span class="hidden sm:flex flex-col items-start leading-tight">
                <span class="js-username text-sm font-medium text-gray-700 dark:text-gray-100">-</span>
                <span class="js-role text-xs text-gray-400">-</span>
              </span>
            </button>
            <div id="profile-menu" class="hidden absolute right-0 mt-2 w-40 rounded-md bg-white dark:bg-gray-700 shadow-lg ring-1 ring-black/5 py-1 z-30">
              <button id="btn-logout" class="w-full text-left px-4 py-2 text-sm text-gray-600 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-600">退出登录</button>
            </div>
          </div>
        </div>
      </div>`;
  }

  function applyTheme(dark) {
    document.documentElement.classList.toggle('dark', dark);
    document.getElementById('icon-sun')?.classList.toggle('hidden', !dark);
    document.getElementById('icon-moon')?.classList.toggle('hidden', dark);
  }

  function renderShell(activeHref, pageTitle) {
    const sidebar = document.getElementById('sidebar');
    const topbar = document.getElementById('topbar');
    if (sidebar) sidebar.innerHTML = sidebarHtml(activeHref || currentFile());
    if (topbar) topbar.innerHTML = topbarHtml();
    if (global.__user) Auth.renderUserBadge(global.__user);

    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = pageTitle || (MENU.find((m) => m.href === (activeHref || currentFile())) || {}).label || '';

    const dark = localStorage.getItem('expv7-dark') === '1'
      || (!localStorage.getItem('expv7-dark') && matchMedia('(prefers-color-scheme: dark)').matches);
    applyTheme(dark);

    document.getElementById('btn-theme')?.addEventListener('click', () => {
      const next = !document.documentElement.classList.contains('dark');
      localStorage.setItem('expv7-dark', next ? '1' : '0');
      applyTheme(next);
    });

    document.getElementById('btn-profile')?.addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('profile-menu')?.classList.toggle('hidden');
    });
    document.addEventListener('click', () => document.getElementById('profile-menu')?.classList.add('hidden'));

    document.getElementById('btn-logout')?.addEventListener('click', () => Auth.doLogout());
    document.getElementById('btn-change-pwd')?.addEventListener('click', () => Auth.openPwdModal(false));

    const backdrop = document.getElementById('sidebar-backdrop');
    document.getElementById('btn-open-sidebar')?.addEventListener('click', () => {
      sidebar?.classList.remove('-translate-x-full');
      backdrop?.classList.remove('hidden');
    });
    backdrop?.addEventListener('click', () => {
      sidebar?.classList.add('-translate-x-full');
      backdrop?.classList.add('hidden');
    });
  }

  global.Nav = { renderShell, MENU };
})(window);
