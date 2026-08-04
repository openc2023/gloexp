/* expv7 — 回收站 */
const TR = { list: [], selectedIds: new Set() };

const TR_STATUS_LABEL = {
  'pending-ship': '待邮寄', shipped: '已邮寄', 'not-arrived': '未到店', arrived: '已到店', notified: '已通知', 'picked-up': '已领取',
};

async function loadTrash() {
  const tbody = document.getElementById('tr-tbody');
  tbody.innerHTML = `<tr><td colspan="9" class="text-center text-gray-400 py-8">加载中...</td></tr>`;
  try {
    const data = await Api.api('trash', 'list');
    TR.list = data.data || [];
    const liveIds = new Set(TR.list.map((r) => String(r.id)));
    TR.selectedIds.forEach((id) => { if (!liveIds.has(id)) TR.selectedIds.delete(id); });
    renderTrash();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-gray-400 py-8">加载失败</td></tr>`;
  }
}

function renderTrash() {
  const tbody = document.getElementById('tr-tbody');
  if (!TR.list.length) { tbody.innerHTML = `<tr><td colspan="9" class="text-center text-gray-400 py-10">回收站为空</td></tr>`; updateTrashSelectionUI(); return; }
  tbody.innerHTML = TR.list.map((r) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3">
        <input type="checkbox" class="tr-row-select rounded border-gray-300" data-row-id="${r.id}" ${TR.selectedIds.has(String(r.id)) ? 'checked' : ''} />
      </td>
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
  tbody.querySelectorAll('.tr-row-select').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.rowId;
    if (cb.checked) TR.selectedIds.add(id); else TR.selectedIds.delete(id);
    updateTrashSelectionUI();
  }));
  updateTrashSelectionUI();
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

// ── 全选/批量操作：跟快递管理页的批量逻辑同一个思路，逐条调用现成的单条接口，
// 复用已经写好的权限/数据范围校验，失败的记下来最后一起提示。──────────────
function updateTrashSelectionUI() {
  const allIds = TR.list.map((r) => String(r.id));
  const selectAll = document.getElementById('tr-select-all');
  if (selectAll) {
    selectAll.checked = allIds.length > 0 && allIds.every((id) => TR.selectedIds.has(id));
    selectAll.indeterminate = TR.selectedIds.size > 0 && !selectAll.checked;
  }
  const info = document.getElementById('tr-selection-info');
  const countEl = document.getElementById('tr-selection-count');
  if (info && countEl) {
    countEl.textContent = TR.selectedIds.size;
    info.classList.toggle('hidden', TR.selectedIds.size === 0);
  }
}
function toggleTrashSelectAll(checked) {
  TR.list.forEach((r) => {
    if (checked) TR.selectedIds.add(String(r.id)); else TR.selectedIds.delete(String(r.id));
  });
  renderTrash();
}
function clearTrashSelection() {
  TR.selectedIds.clear();
  renderTrash();
}

// 同 outbound.js：防止手快连点导致同一批 id 被并发处理两遍。
let trBatchInFlight = false;

async function batchRestoreSelected() {
  if (trBatchInFlight) return;
  const ids = Array.from(TR.selectedIds);
  if (!ids.length) return;
  if (!confirm(`确认恢复已勾选的 ${ids.length} 条记录？`)) return;
  trBatchInFlight = true;
  let okCount = 0;
  const failed = [];
  for (const id of ids) {
    try {
      await Api.api('trash', 'restore', { method: 'POST', params: { id } });
      okCount++;
    } catch (e) {
      const r = TR.list.find((x) => String(x.id) === String(id));
      failed.push(r?.name || id);
    }
  }
  trBatchInFlight = false;
  TR.selectedIds.clear();
  toast(failed.length ? `已恢复 ${okCount} 条，${failed.length} 条失败：${failed.slice(0, 5).join('、')}${failed.length > 5 ? ' 等' : ''}` : `已恢复 ${okCount} 条`, failed.length ? 'err' : 'ok', 4500);
  loadTrash();
}

async function batchPurgeSelected() {
  if (trBatchInFlight) return;
  const ids = Array.from(TR.selectedIds);
  if (!ids.length) return;
  if (!confirm(`确认永久删除已勾选的 ${ids.length} 条记录？此操作不可恢复，关联图片也会一并删除。`)) return;
  trBatchInFlight = true;
  let okCount = 0;
  const failed = [];
  for (const id of ids) {
    try {
      await Api.api('trash', 'purge', { method: 'POST', params: { id } });
      okCount++;
    } catch (e) {
      const r = TR.list.find((x) => String(x.id) === String(id));
      failed.push(r?.name || id);
    }
  }
  trBatchInFlight = false;
  TR.selectedIds.clear();
  toast(failed.length ? `已永久删除 ${okCount} 条，${failed.length} 条失败：${failed.slice(0, 5).join('、')}${failed.length > 5 ? ' 等' : ''}` : `已永久删除 ${okCount} 条`, failed.length ? 'err' : 'ok', 4500);
  loadTrash();
}

function initTrash() {
  document.getElementById('tr-select-all').addEventListener('change', (e) => toggleTrashSelectAll(e.target.checked));
  document.getElementById('tr-clear-selection').addEventListener('click', clearTrashSelection);
  if (hasPerm('trash:restore')) {
    document.getElementById('tr-batch-restore-btn').classList.remove('hidden');
    document.getElementById('tr-batch-restore-btn').addEventListener('click', batchRestoreSelected);
  }
  if (hasPerm('trash:purge')) {
    document.getElementById('tr-batch-purge-btn').classList.remove('hidden');
    document.getElementById('tr-batch-purge-btn').addEventListener('click', batchPurgeSelected);
  }
  loadTrash();
}
