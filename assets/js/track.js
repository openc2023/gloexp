/* expv7 — 前台快递查询页（无需登录），对齐 v5 tracker.js 的查询逻辑，数据源 api/parcels.php?action=query */
const TRACK_STATUS_LABEL = {
  'not-arrived': '未到店',
  'arrived': '已到店待领取',
  'notified': '已通知',
  'picked-up': '已领取',
  'pending-ship': '待邮寄',
  'shipped': '已邮寄',
  'exception': '异常件',
};
const TRACK_STATUS_CLASS = {
  'pending-ship': 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  shipped: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  exception: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  'not-arrived': 'bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-300',
  arrived: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  notified: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400',
  'picked-up': 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
};

function applyTrackTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  document.getElementById('icon-sun')?.classList.toggle('hidden', !dark);
  document.getElementById('icon-moon')?.classList.toggle('hidden', dark);
}

function switchTrackTab(which) {
  document.getElementById('tab-name').classList.toggle('active', which === 'name');
  document.getElementById('tab-tracking').classList.toggle('active', which === 'tracking');
  document.getElementById('panel-name').classList.toggle('hidden', which !== 'name');
  document.getElementById('panel-tracking').classList.toggle('hidden', which !== 'tracking');
}

let trackSearchInFlight = false;

async function doTrackSearch(params, btnId) {
  if (trackSearchInFlight) return;
  trackSearchInFlight = true;
  const btns = [document.getElementById('btn-search-name'), document.getElementById('btn-search-tracking')];
  btns.forEach((b) => { if (b) b.disabled = true; });
  showTrackLoading();
  try {
    const data = await Api.api('parcels', 'query', { params });
    renderTrackResults(data.data || []);
  } catch (e) {
    showTrackError(e.message || '查询失败');
  } finally {
    trackSearchInFlight = false;
    btns.forEach((b) => { if (b) b.disabled = false; });
  }
}

function doSearchByName() {
  const name = document.getElementById('q-name').value.trim();
  const phone = document.getElementById('q-phone').value.trim();
  if (!name) { showTrackError('请输入姓名'); return; }
  doTrackSearch({ type: 'name', name, phone });
}
function doSearchByTracking() {
  const q = document.getElementById('q-tracking').value.trim();
  if (!q) { showTrackError('请输入快递单号'); return; }
  doTrackSearch({ type: 'tracking', q });
}

function showTrackLoading() {
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('results-header').classList.add('hidden');
  document.getElementById('results-list').innerHTML = `
    <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-8 text-center text-sm text-gray-400">查询中...</div>`;
}
function showTrackError(msg) {
  document.getElementById('results-section').classList.remove('hidden');
  document.getElementById('results-header').classList.add('hidden');
  document.getElementById('results-list').innerHTML = `
    <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-8 text-center text-sm text-red-500">${esc(msg)}</div>`;
}

function renderTrackResults(list) {
  const section = document.getElementById('results-section');
  const header = document.getElementById('results-header');
  const count = document.getElementById('results-count');
  const list_el = document.getElementById('results-list');

  section.classList.remove('hidden');

  if (!list.length) {
    header.classList.add('hidden');
    list_el.innerHTML = `
      <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-8 text-center text-sm text-gray-400">未找到相关快递记录</div>`;
    return;
  }

  header.classList.remove('hidden');
  count.textContent = `共 ${list.length} 条`;

  list_el.innerHTML = list.map((p) => {
    const statusCls = TRACK_STATUS_CLASS[p.status] || 'bg-gray-100 text-gray-500';
    const statusLabel = TRACK_STATUS_LABEL[p.status] || p.status || '-';
    const rows = [];
    if (p.courier_name) rows.push(['快递公司', esc(p.courier_name) + (p.service_type ? ' · ' + esc(p.service_type) : '')]);
    rows.push(['快递单号', p.tracking_number
      ? `<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
           <span class="font-mono break-all">${esc(p.tracking_number)}</span>
           <span class="flex gap-3 flex-shrink-0">
             <button type="button" data-copy-tracking="${esc(p.tracking_number)}" class="text-purple-600 hover:text-purple-800">复制单号</button>
             <button type="button" data-open-logistics="${esc(p.tracking_number)}" class="text-purple-600 hover:text-purple-800">物流查询</button>
           </span>
         </div>`
      : '<span class="text-gray-300">暂未填写</span>']);
    if (p.address) rows.push(['收件地址', esc(p.address)]);
    if (p.manager_name) rows.push(['负责人', esc(p.manager_name)]);
    rows.push(['录入时间', esc(fmtDate(p.created_at))]);

    return `
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 p-4">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-semibold text-gray-800 dark:text-gray-100">${esc(p.name)}</span>
          <span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${statusCls}">${esc(statusLabel)}</span>
        </div>
        <dl class="grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          ${rows.map(([label, value]) => `
            <dt class="text-gray-400">${label}</dt>
            <dd class="text-gray-600 dark:text-gray-300">${value}</dd>`).join('')}
        </dl>
      </div>`;
  }).join('');

  list_el.querySelectorAll('[data-copy-tracking]').forEach((b) => b.addEventListener('click', () => trackCopyTracking(b.dataset.copyTracking)));
  list_el.querySelectorAll('[data-open-logistics]').forEach((b) => b.addEventListener('click', () => trackOpenLogistics(b.dataset.openLogistics)));
}

function trackCopyTracking(tracking) {
  const value = String(tracking || '').trim().toUpperCase();
  if (!value) return;
  navigator.clipboard?.writeText(value).then(() => toast('已复制快递单号：' + value, 'ok')).catch(() => toast('复制失败', 'err'));
}
function trackOpenLogistics(tracking) {
  const value = String(tracking || '').trim();
  if (!value) return;
  window.open(`https://www.kuaidi100.com/chaxun?nu=${encodeURIComponent(value)}`, '_blank', 'noopener');
}

function initTrack() {
  const dark = localStorage.getItem('expv7-dark') === '1'
    || (!localStorage.getItem('expv7-dark') && matchMedia('(prefers-color-scheme: dark)').matches);
  applyTrackTheme(dark);
  document.getElementById('btn-theme').addEventListener('click', () => {
    const next = !document.documentElement.classList.contains('dark');
    localStorage.setItem('expv7-dark', next ? '1' : '0');
    applyTrackTheme(next);
  });

  document.getElementById('tab-name').addEventListener('click', () => switchTrackTab('name'));
  document.getElementById('tab-tracking').addEventListener('click', () => switchTrackTab('tracking'));

  document.getElementById('btn-search-name').addEventListener('click', doSearchByName);
  document.getElementById('q-name').addEventListener('keydown', (e) => e.key === 'Enter' && doSearchByName());
  document.getElementById('q-phone').addEventListener('keydown', (e) => e.key === 'Enter' && doSearchByName());

  document.getElementById('btn-search-tracking').addEventListener('click', doSearchByTracking);
  document.getElementById('q-tracking').addEventListener('keydown', (e) => e.key === 'Enter' && doSearchByTracking());
}

document.addEventListener('DOMContentLoaded', initTrack);
