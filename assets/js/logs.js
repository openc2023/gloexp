/* expv7 — 操作日志 */
const LG = { rows: [], page: 1, limit: 20, total: 0 };

const ACTION_OPTIONS = ['新增', '编辑', '删除', '出库', '创建', '更新', '还原', '永久删除', '恢复账号', '重置密码', '清空日志'];
const TARGET_OPTIONS = ['入库单', '快递管理', '填单号', '快递商', '账号', '权限组', '团队', '团队成员', '权限模板', '回收站', '操作日志'];

function buildFilterParams(extra = {}) {
  const params = { page: LG.page, limit: LG.limit };
  const q = document.getElementById('f-q').value.trim();
  const username = document.getElementById('f-username').value.trim();
  const action_kw = document.getElementById('f-action').value;
  const target_type = document.getElementById('f-target').value;
  const ds = document.getElementById('f-date-start').value;
  const de = document.getElementById('f-date-end').value;
  if (q) params.q = q;
  if (username) params.username = username;
  if (action_kw) params.action_kw = action_kw;
  if (target_type) params.target_type = target_type;
  if (ds) params.date_start = ds;
  if (de) params.date_end = de;
  return { ...params, ...extra };
}

async function loadLogs() {
  const tbody = document.getElementById('lg-tbody');
  tbody.innerHTML = Array.from({ length: 4 }).map(() => `<tr class="skeleton-row"><td colspan="6"><div class="skeleton-bar w-full"></div></td></tr>`).join('');
  try {
    const data = await Api.api('logs', 'list', { params: buildFilterParams() });
    LG.rows = data.data || [];
    LG.total = data.total || 0;
    renderLogs();
    renderPagination();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-gray-400 py-8">加载失败</td></tr>`;
  }
}

function renderLogs() {
  const tbody = document.getElementById('lg-tbody');
  document.getElementById('lg-summary').textContent = `共 ${LG.total} 条`;
  if (!LG.rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="text-center text-gray-400 py-10">暂无记录</td></tr>`; return; }
  tbody.innerHTML = LG.rows.map((r) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3 whitespace-nowrap text-gray-500">${fmtDate(r.created_at)}</td>
      <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">${esc(r.username)}</td>
      <td class="px-4 py-3 text-gray-500">${esc(r.action)}</td>
      <td class="px-4 py-3 text-gray-500">${esc(r.target_type)}</td>
      <td class="px-4 py-3 text-gray-500">${esc(r.target_name || '-')}</td>
      <td class="px-4 py-3 text-gray-500 max-w-[260px] truncate" title="${esc(r.detail)}">${esc(r.detail || '-')}</td>
    </tr>`).join('');
}

function renderPagination() {
  const box = document.getElementById('lg-pagination');
  const pages = Math.max(1, Math.ceil(LG.total / LG.limit));
  const cur = LG.page;
  const mk = (label, page, disabled, active) => `
    <button ${disabled ? 'disabled' : `data-page="${page}"`}
      class="px-2.5 py-1 text-xs rounded-md ${active ? 'bg-purple-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}">${label}</button>`;
  let html = mk('上一页', cur - 1, cur <= 1, false);
  const start = Math.max(1, cur - 2);
  const end = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) html += mk(String(p), p, false, p === cur);
  html += mk('下一页', cur + 1, cur >= pages, false);
  box.innerHTML = html;
  box.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { LG.page = parseInt(b.dataset.page, 10); loadLogs(); }));
}

function openClearModal() {
  document.getElementById('clear-confirm-input').value = '';
  document.getElementById('clear-modal').classList.remove('hidden');
}
function closeClearModal() {
  document.getElementById('clear-modal').classList.add('hidden');
}
async function confirmClear() {
  if (document.getElementById('clear-confirm-input').value.trim() !== 'CLEAR') {
    toast('请输入 CLEAR 以确认', 'err');
    return;
  }
  try {
    await Api.api('logs', 'clear', { method: 'POST' });
    toast('日志已清空', 'ok');
    closeClearModal();
    LG.page = 1;
    loadLogs();
  } catch (e) { /* toast shown */ }
}

function initLogs() {
  document.getElementById('f-action').innerHTML = '<option value="">全部</option>' + ACTION_OPTIONS.map((a) => `<option value="${a}">${a}</option>`).join('');
  document.getElementById('f-target').innerHTML = '<option value="">全部</option>' + TARGET_OPTIONS.map((t) => `<option value="${t}">${t}</option>`).join('');
  document.getElementById('btn-clear').classList.toggle('hidden', !hasPerm('logs:clear'));

  document.getElementById('btn-search').addEventListener('click', () => { LG.page = 1; loadLogs(); });
  document.getElementById('btn-reset').addEventListener('click', () => {
    document.getElementById('f-q').value = '';
    document.getElementById('f-username').value = '';
    document.getElementById('f-action').value = '';
    document.getElementById('f-target').value = '';
    document.getElementById('f-date-start').value = '';
    document.getElementById('f-date-end').value = '';
    LG.page = 1;
    loadLogs();
  });
  document.getElementById('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { LG.page = 1; loadLogs(); } });
  document.getElementById('lg-limit').addEventListener('change', (e) => { LG.limit = parseInt(e.target.value, 10); LG.page = 1; loadLogs(); });

  document.getElementById('btn-clear').addEventListener('click', openClearModal);
  document.getElementById('btn-confirm-clear').addEventListener('click', confirmClear);
  document.querySelectorAll('[data-close-clear]').forEach((el) => el.addEventListener('click', closeClearModal));

  loadLogs();
}
