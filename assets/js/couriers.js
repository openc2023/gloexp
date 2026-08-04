/* expv7 — 快递商管理 */
const CR = { list: [] };

async function loadCouriers() {
  try {
    const data = await Api.api('couriers', 'list');
    CR.list = data.data || [];
    renderCouriers();
  } catch (e) { /* toast shown */ }
}

function renderCouriers() {
  const tbody = document.getElementById('cr-tbody');
  if (!CR.list.length) { tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-400 py-8">暂无快递商</td></tr>`; return; }
  tbody.innerHTML = CR.list.map((c) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">${esc(c.name)}</td>
      <td class="px-4 py-3 text-gray-500">${c.category === 'kr' ? '韩国' : '国内'}</td>
      <td class="px-4 py-3 text-gray-500">${(c.service_types || []).map(esc).join('、')}</td>
      <td class="px-4 py-3 text-gray-500 max-w-[220px] truncate" title="${esc(c.tracking_url)}">
        ${c.tracking_url ? `<a href="${esc(c.tracking_url)}" target="_blank" class="text-purple-600 hover:underline">${esc(c.tracking_url)}</a>` : '-'}
      </td>
      <td class="px-4 py-3">
        <div class="flex justify-end gap-2 text-xs">
          ${hasPerm('couriers:edit') ? `<button data-edit="${c.id}" class="text-purple-600 hover:text-purple-800">编辑</button>` : ''}
          ${hasPerm('couriers:delete') ? `<button data-del="${c.id}" class="text-red-500 hover:text-red-700">删除</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editCourier(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteCourier(b.dataset.del)));
}

function resetCourierForm() {
  document.getElementById('cr-form').reset();
  document.getElementById('cr-id').value = '';
  document.getElementById('cr-form-title').textContent = '新增快递商';
  document.getElementById('cr-form-cancel').classList.add('hidden');
}

function editCourier(id) {
  const c = CR.list.find((x) => String(x.id) === String(id));
  if (!c) return;
  document.getElementById('cr-id').value = c.id;
  document.getElementById('cr-name').value = c.name;
  document.getElementById('cr-category').value = c.category || 'cn';
  document.getElementById('cr-tracking-url').value = c.tracking_url || '';
  document.getElementById('cr-service-types').value = (c.service_types || []).join(',');
  document.getElementById('cr-form-title').textContent = `编辑快递商：${c.name}`;
  document.getElementById('cr-form-cancel').classList.remove('hidden');
}

async function submitCourierForm(e) {
  e.preventDefault();
  const id = document.getElementById('cr-id').value;
  const name = document.getElementById('cr-name').value.trim();
  if (!name) { toast('名称必填', 'err'); return; }
  const body = {
    name,
    category: document.getElementById('cr-category').value,
    tracking_url: document.getElementById('cr-tracking-url').value.trim(),
    service_types: document.getElementById('cr-service-types').value.split(',').map((s) => s.trim()).filter(Boolean),
  };
  try {
    if (id) await Api.api('couriers', 'update', { method: 'POST', params: { id }, body });
    else await Api.api('couriers', 'create', { method: 'POST', body });
    toast('已保存', 'ok');
    resetCourierForm();
    loadCouriers();
  } catch (e) { /* toast shown */ }
}

async function deleteCourier(id) {
  const c = CR.list.find((x) => String(x.id) === String(id));
  if (!confirm(`确认删除快递商「${c?.name}」？`)) return;
  try {
    await Api.api('couriers', 'delete', { method: 'POST', params: { id } });
    toast('已删除', 'ok');
    loadCouriers();
  } catch (e) { /* toast shown */ }
}

function initCouriers() {
  if (!hasPerm('couriers:view')) {
    document.getElementById('cr-no-access').classList.remove('hidden');
    return;
  }
  document.getElementById('cr-page-content').classList.remove('hidden');
  document.getElementById('cr-form').addEventListener('submit', submitCourierForm);
  document.getElementById('cr-form-cancel').addEventListener('click', resetCourierForm);
  loadCouriers();
}
