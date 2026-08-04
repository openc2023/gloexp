/* expv7 — 首页仪表盘 */
let _dashboardCache = null;
let _dashboardCacheAt = 0;
const DASHBOARD_CACHE_MS = 45 * 1000;

const QUICK_LINKS = [
  { href: 'inbound.html', label: '新增入库单', perm: 'inbound:create', icon: 'M12 4v16m8-8H4' },
  { href: 'outbound.html', label: '快递管理', perm: 'parcels:view', icon: 'M13 16V6a1 1 0 00-1-1H4a1 1 0 00-1 1v9a1 1 0 001 1h9zm0 0h4l3-3.5V13a1 1 0 00-1-1h-2' },
  { href: 'team.html', label: '团队管理', perm: 'team:view', icon: 'M17 20h5v-1a4 4 0 00-3-3.87M9 20H4v-1a4 4 0 013-3.87m9-5.13a4 4 0 11-8 0 4 4 0 018 0z' },
  { href: 'logs.html', label: '操作日志', perm: 'logs:view', icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2' },
];

function renderQuickLinks() {
  const box = document.getElementById('quick-links');
  if (!box) return;
  box.innerHTML = QUICK_LINKS.filter((q) => hasPerm(q.perm)).map((q) => `
    <a href="${q.href}" class="flex flex-col items-center gap-2 rounded-lg border border-gray-100 dark:border-gray-700 p-4 hover:border-purple-300 hover:bg-purple-50 dark:hover:bg-gray-700 transition-colors">
      <svg class="w-5 h-5 text-purple-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${q.icon}"/></svg>
      <span class="text-xs text-gray-600 dark:text-gray-300">${esc(q.label)}</span>
    </a>`).join('') || '<p class="text-xs text-gray-400 col-span-4">暂无可用快捷入口</p>';
}

function greetingText() {
  const h = new Date().getHours();
  if (h < 6) return '夜深了，注意休息';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

async function loadDashboard(force = false) {
  const now = Date.now();
  if (!force && _dashboardCache && (now - _dashboardCacheAt) < DASHBOARD_CACHE_MS) {
    return _dashboardCache;
  }
  const data = await Api.api('stats', 'summary');
  _dashboardCache = data.data;
  _dashboardCacheAt = now;
  return _dashboardCache;
}

function renderDashboard(s) {
  document.getElementById('stat-total').textContent = s.total ?? 0;
  document.getElementById('stat-today').textContent = s.today ?? 0;
  document.getElementById('stat-pending').textContent = s.pending ?? 0;
  document.getElementById('stat-shipped').textContent = s.shipped ?? 0;

  const pending = s.pending ?? 0;
  const shipped = s.shipped ?? 0;
  const totalFlow = pending + shipped;
  const pct = totalFlow > 0 ? Math.round((shipped / totalFlow) * 100) : 0;
  document.getElementById('flow-bar').style.width = pct + '%';
  document.getElementById('flow-pending-label').textContent = `待邮寄 ${pending}`;
  document.getElementById('flow-shipped-label').textContent = `已邮寄 ${shipped}`;
  document.getElementById('flow-greeting').textContent = `${greetingText()}，${window.__user?.username || ''}`;
}

async function initDashboard() {
  renderQuickLinks();
  try {
    const s = await loadDashboard();
    renderDashboard(s);
  } catch (e) { /* toast already shown by Api */ }
}
