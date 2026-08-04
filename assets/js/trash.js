/* expv7 — 回收站 */
const TR = { list: [] };

const TR_STATUS_LABEL = {
  'pending-ship': '待邮寄', shipped: '已邮寄', 'not-arrived': '未到店', arrived: '已到店', notified: '已通知', 'picked-up': '已领取',
};

async function loadTrash() {
  const tbody = document.getElementById('tr-tbody');
  tbody.innerHTML = `<tr><td colspan="8" class="text-center text-gray-400 py-8">加载中...</td></tr>`;
  try {
    const data = await Api.api('trash', 'list');
    TR.list = data.data || [];
    renderTrash();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-gray-400 py-8">加载失败</td></tr>`;
  }
}

function renderTrash() {
  const tbody = document.getElementById('tr-tbody');
  if (!TR.list.length) { tbody.innerHTML = `<tr><td colspan="8" class="text-center text-gray-400 py-10">回收站为空</td></tr>`; return; }
  tbody.innerHTML = TR.list.map((r) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3">
        <span class="inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${r.source === 'inbound' ? 'bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-300' : 'bg-gray-100 text-gray-500'}">
          ${r.source === 'inbound' ? '入库单' : '快递管理'}
        </span>
      </td>
      <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">${esc(r.name)}</td>
      <td class="px-4 py-3 text-gray-500">${esc(r.phone)}</td>
      <td class="px-4 py-3 text-gray-500">${esc(r.courier_name || '-')}</td>
      <td class="px-4 py-3 text-gray-500">${TR_STATUS_LABEL[r.status] || r.status || '-'}</td>
      <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${fmtDate(r.deleted_at)}</td>
      <td class="px-4 py-3 text-gray-500 whitespace-nowrap">${fmtDate(r.expires_at)}</td>
      <td class="px-4 py-3">
        <div class="flex justify-end gap-2 text-xs">
          ${hasPerm('trash:restore') ? `<button data-restore="${r.id}" class="text-emerald-600 hover:text-emerald-800">恢复</button>` : ''}
          ${hasPerm('trash:purge') ? `<button data-purge="${r.id}" class="text-red-500 hover:text-red-700">永久删除</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-restore]').forEach((b) => b.addEventListener('click', () => restoreItem(b.dataset.restore)));
  tbody.querySelectorAll('[data-purge]').forEach((b) => b.addEventListener('click', () => purgeItem(b.dataset.purge)));
}

async function restoreItem(id) {
  const r = TR.list.find((x) => String(x.id) === String(id));
  if (!confirm(`确认恢复 ${r?.name || '该记录'}？`)) return;
  try {
    await Api.api('trash', 'restore', { method: 'POST', params: { id } });
    toast('已恢复', 'ok');
    loadTrash();
  } catch (e) { /* toast shown */ }
}

async function purgeItem(id) {
  const r = TR.list.find((x) => String(x.id) === String(id));
  if (!confirm(`确认永久删除 ${r?.name || '该记录'}？此操作不可恢复，关联图片也会一并删除。`)) return;
  try {
    await Api.api('trash', 'purge', { method: 'POST', params: { id } });
    toast('已永久删除', 'ok');
    loadTrash();
  } catch (e) { /* toast shown */ }
}

function initTrash() {
  loadTrash();
}
