/* expv7 — 团队管理：账号 / 权限组 / 团队架构 */
const TEAM = {
  accounts: [],
  groups: [],
  permsMeta: [],
  catalog: {},
  templates: [],
  orgGroups: [],
  members: [],
  allUsers: [],
  selectedOrgId: null,
};

const SCOPE_LABEL = { global: '全部', group: '本团队', self: '仅自己' };

// ══════════════════════ Tabs ══════════════════════
// 团队架构暂缓（待定），相关函数保留在文件末尾但不接入 UI。
function switchTab(tab) {
  document.querySelectorAll('.team-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('panel-accounts').classList.toggle('hidden', tab !== 'accounts');
  document.getElementById('panel-groups').classList.toggle('hidden', tab !== 'groups');
  document.getElementById('panel-update').classList.toggle('hidden', tab !== 'update');
  if (tab === 'update') loadUpdateStatus();
}

// ══════════════════════ 账号 ══════════════════════
async function loadAccounts() {
  try {
    const data = await Api.api('managers', 'list');
    TEAM.accounts = data.data || [];
    renderAccounts();
  } catch (e) { /* toast shown */ }
}
function renderAccounts() {
  const tbody = document.getElementById('acc-tbody');
  if (!TEAM.accounts.length) { tbody.innerHTML = `<tr><td colspan="4" class="text-center text-gray-400 py-8">暂无账号</td></tr>`; return; }
  tbody.innerHTML = TEAM.accounts.map((a) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">
        ${esc(a.username)}
        ${a.role === 'admin' ? '<span class="ml-1 inline-flex px-1.5 py-0.5 rounded text-[10px] bg-purple-100 text-purple-600 dark:bg-purple-500/20 dark:text-purple-300">超级管理员</span>' : ''}
      </td>
      <td class="px-4 py-3 text-gray-500">${esc(a.group_name || '未分组')}</td>
      <td class="px-4 py-3 text-gray-500">${fmtDate(a.created_at)}</td>
      <td class="px-4 py-3">
        <div class="flex justify-end gap-2 text-xs">
          ${hasPerm('team:accounts_edit') ? `<button data-edit="${a.id}" class="text-purple-600 hover:text-purple-800">编辑</button>` : ''}
          ${hasPerm('team:accounts_edit') ? `<button data-reset="${a.id}" class="text-gray-500 hover:text-gray-700">重置密码</button>` : ''}
          ${hasPerm('team:accounts_delete') && a.id !== window.__user.uid ? `<button data-del="${a.id}" class="text-red-500 hover:text-red-700">删除</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editAccount(b.dataset.edit)));
  tbody.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => resetAccountPwd(b.dataset.reset)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteAccount(b.dataset.del)));
}
function fillGroupSelect(selectEl, selectedId) {
  selectEl.innerHTML = '<option value="">未分组</option>';
  TEAM.groups.forEach((g) => {
    const opt = document.createElement('option');
    opt.value = g.id; opt.textContent = g.name;
    if (String(g.id) === String(selectedId)) opt.selected = true;
    selectEl.appendChild(opt);
  });
}
function resetAccForm() {
  document.getElementById('acc-form').reset();
  document.getElementById('acc-id').value = '';
  document.getElementById('acc-form-title').textContent = '新增账号';
  document.getElementById('acc-username').disabled = false;
  document.getElementById('acc-password').placeholder = '新增默认 glo2026';
  document.getElementById('acc-group').disabled = false;
  document.getElementById('acc-form-cancel').classList.add('hidden');
}
function editAccount(id) {
  const a = TEAM.accounts.find((x) => String(x.id) === String(id));
  if (!a) return;
  document.getElementById('acc-id').value = a.id;
  document.getElementById('acc-username').value = a.username;
  document.getElementById('acc-username').disabled = false;
  document.getElementById('acc-password').value = '';
  document.getElementById('acc-password').placeholder = '留空不修改密码';
  fillGroupSelect(document.getElementById('acc-group'), a.group_id);
  document.getElementById('acc-group').disabled = a.role === 'admin';
  document.getElementById('acc-form-title').textContent = `编辑账号：${a.username}`;
  document.getElementById('acc-form-cancel').classList.remove('hidden');
}
async function submitAccountForm(e) {
  e.preventDefault();
  const id = document.getElementById('acc-id').value;
  const username = document.getElementById('acc-username').value.trim();
  const password = document.getElementById('acc-password').value.trim();
  const group_id = document.getElementById('acc-group').value || null;
  try {
    if (id) {
      if (username.length < 2) { toast('账号至少 2 个字符', 'err'); return; }
      const body = {};
      const original = TEAM.accounts.find((x) => String(x.id) === String(id));
      if (username !== original?.username) body.username = username;
      if (!document.getElementById('acc-group').disabled) body.group_id = group_id;
      if (password) body.password = password;
      if (!Object.keys(body).length) { toast('没有可更新的内容', 'err'); return; }
      await Api.api('managers', 'update', { method: 'POST', params: { id }, body });
    } else {
      if (username.length < 2) { toast('账号至少 2 个字符', 'err'); return; }
      await Api.api('managers', 'create', { method: 'POST', body: { username, password: password || 'glo2026', group_id } });
    }
    toast('已保存', 'ok');
    resetAccForm();
    await Promise.all([loadAccounts(), loadGroups()]);
  } catch (e) { /* toast shown */ }
}
async function resetAccountPwd(id) {
  const a = TEAM.accounts.find((x) => String(x.id) === String(id));
  if (!confirm(`确认将 ${a?.username} 的密码重置为默认密码 glo2026？`)) return;
  try {
    await Api.api('managers', 'reset_pwd', { method: 'POST', params: { id }, body: {} });
    toast('密码已重置为 glo2026', 'ok');
  } catch (e) { /* toast shown */ }
}
async function deleteAccount(id) {
  const a = TEAM.accounts.find((x) => String(x.id) === String(id));
  if (!confirm(`确认删除账号 ${a?.username}？删除后可在回收站账号列表恢复（需重新创建同名账号）。`)) return;
  try {
    await Api.api('managers', 'delete', { method: 'POST', params: { id } });
    toast('已删除', 'ok');
    loadAccounts();
  } catch (e) { /* toast shown */ }
}

// ══════════════════════ 权限组：矩阵（页面 × 操作）══════════════════════
// 行 = 页面/模块，列 = 该模块支持的操作；每行第一列固定是「查看」门控——
// 不勾查看，其余操作即使勾了也进不了页面（前端置灰，后端 require_can 也是这个逻辑）。
const PERM_MATRIX = [
  { label: '新增入库单', cols: [
    { key: 'inbound:view', label: '查看' },
    { key: 'inbound:create', label: '新增' },
    { key: 'inbound:edit', label: '编辑' },
    { key: 'inbound:delete', label: '删除' },
    { key: 'inbound:export', label: '导出' },
    { key: 'inbound:phone', label: '手机号' },
    { key: 'inbound:parse', label: '智能解析' },
  ] },
  { label: '快递管理', cols: [
    { key: 'parcels:view', label: '查看' },
    { key: 'parcels:edit', label: '处理/编辑' },
    { key: 'parcels:delete', label: '删除' },
    { key: 'parcels:export', label: '导出' },
    { key: 'parcels:phone', label: '手机号' },
  ] },
  { label: '团队管理入口', cols: [
    { key: 'team:view', label: '进入' },
  ] },
  { label: '账号管理', cols: [
    { key: 'team:accounts_view', label: '查看' },
    { key: 'team:accounts_create', label: '新增' },
    { key: 'team:accounts_edit', label: '编辑' },
    { key: 'team:accounts_delete', label: '删除' },
  ] },
  { label: '权限组管理', cols: [
    { key: 'team:groups_view', label: '查看' },
    { key: 'team:groups_create', label: '新增' },
    { key: 'team:groups_edit', label: '编辑' },
    { key: 'team:groups_delete', label: '删除' },
  ] },
  { label: '快递商管理', cols: [
    { key: 'couriers:view', label: '查看' },
    { key: 'couriers:create', label: '新增' },
    { key: 'couriers:edit', label: '编辑' },
    { key: 'couriers:delete', label: '删除' },
  ] },
  { label: '回收站', cols: [
    { key: 'trash:view', label: '查看' },
    { key: 'trash:restore', label: '恢复' },
    { key: 'trash:purge', label: '永久删除' },
  ] },
  { label: '操作日志', cols: [
    { key: 'logs:view', label: '查看' },
    { key: 'logs:clear', label: '清空' },
  ] },
];

async function loadPermsMeta() {
  const data = await Api.api('groups', 'perms_meta');
  TEAM.catalog = data.catalog || {};
  buildPermMatrix();
  buildLookupSelect();
}
function buildPermMatrix() {
  const box = document.getElementById('perm-matrix');
  box.innerHTML = PERM_MATRIX.map((row) => {
    const gateKey = row.cols[0].key;
    return `
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5">
      <div class="w-32 flex-shrink-0 text-xs font-medium text-gray-700 dark:text-gray-200">${esc(row.label)}</div>
      <div class="flex flex-wrap gap-x-4 gap-y-1.5">
        ${row.cols.map((c, idx) => `
          <label class="inline-flex items-center gap-1.5 text-xs ${idx === 0 ? 'text-gray-700 dark:text-gray-200 font-medium' : 'text-gray-500 dark:text-gray-400'}">
            <input type="checkbox" class="${idx === 0 ? 'perm-gate' : 'perm-action'} rounded border-gray-300" data-gate="${gateKey}" value="${c.key}" />
            ${esc(c.label)}
          </label>`).join('')}
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.perm-gate').forEach((gate) => {
    gate.addEventListener('change', () => {
      box.querySelectorAll(`.perm-action[data-gate="${CSS.escape(gate.value)}"]`).forEach((c) => {
        c.disabled = !gate.checked;
        if (!gate.checked) c.checked = false;
      });
      updateGroupPreview();
    });
  });
  box.querySelectorAll('.perm-action').forEach((c) => c.addEventListener('change', updateGroupPreview));
  box.querySelectorAll('.perm-gate').forEach((g) => g.dispatchEvent(new Event('change')));
}
function setPermMatrixValues(canonicalPerms) {
  const box = document.getElementById('perm-matrix');
  const set = new Set(canonicalPerms || []);
  const isAll = set.has('*');
  box.querySelectorAll('.perm-gate').forEach((gate) => {
    gate.checked = isAll || set.has(gate.value);
    gate.dispatchEvent(new Event('change'));
  });
  box.querySelectorAll('.perm-action').forEach((c) => { c.checked = isAll || set.has(c.value); });
  updateGroupPreview();
}
function collectPermMatrixValues() {
  const box = document.getElementById('perm-matrix');
  const values = [];
  box.querySelectorAll('.perm-gate:checked').forEach((g) => values.push(g.value));
  box.querySelectorAll('.perm-action:checked').forEach((c) => values.push(c.value));
  return Array.from(new Set(values));
}
function updateGroupPreview() {
  const perms = collectPermMatrixValues();
  const box = document.getElementById('grp-preview');
  if (!perms.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const dangerous = perms.filter((p) => TEAM.catalog[p]?.dangerous);
  const pages = PERM_MATRIX.filter((row) => perms.includes(row.cols[0].key)).map((row) => row.label);
  box.innerHTML = `
    <div>可访问页面：${pages.length ? esc(pages.join('、')) : '（无）'}</div>
    <div class="mt-1">共 ${perms.length} 项权限${dangerous.length ? `，其中 <span class="text-red-500">${dangerous.length} 项为高危操作</span>` : ''}</div>`;
}

async function loadTemplates() {
  const data = await Api.api('perm_templates', 'list');
  TEAM.templates = data.data || [];
  const sel = document.getElementById('grp-template');
  sel.innerHTML = '<option value="">不使用模板</option>' + TEAM.templates.map((t) => `<option value="${t.id}">${esc(t.name)}${t.is_system ? '（系统）' : ''}</option>`).join('');
}
function applyTemplate(id) {
  const tpl = TEAM.templates.find((t) => String(t.id) === String(id));
  if (!tpl) return;
  setPermMatrixValues(tpl.permissions || []);
  const scopes = tpl.data_scopes || {};
  document.getElementById('grp-scope-inbound').value = scopes.inbound || 'group';
  document.getElementById('grp-scope-outbound').value = scopes.outbound || 'group';
  document.getElementById('grp-scope-parcels').value = scopes.parcels || 'group';
}

async function loadGroups() {
  try {
    const data = await Api.api('groups', 'list');
    TEAM.groups = data.data || [];
    renderGroups();
    fillGroupSelect(document.getElementById('acc-group'), document.getElementById('acc-group').value);
  } catch (e) { /* toast shown */ }
}
function renderGroups() {
  const tbody = document.getElementById('grp-tbody');
  if (!TEAM.groups.length) { tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-400 py-8">暂无权限组</td></tr>`; return; }
  tbody.innerHTML = TEAM.groups.map((g) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">${esc(g.name)}</td>
      <td class="px-4 py-3 text-gray-500">${g.user_count}</td>
      <td class="px-4 py-3 text-gray-500">${(g.canonical_permissions || []).includes('*') ? '全部' : (g.canonical_permissions || []).length}</td>
      <td class="px-4 py-3 text-gray-500 text-xs">
        入库:${SCOPE_LABEL[g.data_scopes?.inbound] || '-'} 快递:${SCOPE_LABEL[g.data_scopes?.outbound] || '-'} 回收:${SCOPE_LABEL[g.data_scopes?.parcels] || '-'}
      </td>
      <td class="px-4 py-3">
        <div class="flex justify-end gap-2 text-xs">
          ${hasPerm('team:groups_edit') ? `<button data-edit="${g.id}" class="text-purple-600 hover:text-purple-800">编辑</button>` : ''}
          ${hasPerm('team:groups_delete') ? `<button data-del="${g.id}" class="text-red-500 hover:text-red-700">删除</button>` : ''}
        </div>
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editGroup(b.dataset.edit)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteGroup(b.dataset.del)));
}
function showGrpFormCard() {
  document.getElementById('grp-form-card').classList.remove('hidden');
}
function hideGrpFormCard() {
  document.getElementById('grp-form-card').classList.add('hidden');
}
function resetGrpForm() {
  document.getElementById('grp-form').reset();
  document.getElementById('grp-id').value = '';
  document.getElementById('grp-form-title').textContent = '新增权限组';
  setPermMatrixValues([]);
}
function newGroup() {
  resetGrpForm();
  showGrpFormCard();
  document.getElementById('grp-name').focus();
}
function editGroup(id) {
  const g = TEAM.groups.find((x) => String(x.id) === String(id));
  if (!g) return;
  document.getElementById('grp-id').value = g.id;
  document.getElementById('grp-name').value = g.name;
  document.getElementById('grp-scope-inbound').value = g.data_scopes?.inbound || 'group';
  document.getElementById('grp-scope-outbound').value = g.data_scopes?.outbound || 'group';
  document.getElementById('grp-scope-parcels').value = g.data_scopes?.parcels || 'group';
  setPermMatrixValues(g.canonical_permissions || []);
  document.getElementById('grp-form-title').textContent = `编辑权限组：${g.name}`;
  showGrpFormCard();
}
async function submitGroupForm(e) {
  e.preventDefault();
  const id = document.getElementById('grp-id').value;
  const name = document.getElementById('grp-name').value.trim();
  if (!name) { toast('权限组名称不能为空', 'err'); return; }
  const body = {
    name,
    permissions: collectPermMatrixValues(),
    data_scopes: {
      inbound: document.getElementById('grp-scope-inbound').value,
      outbound: document.getElementById('grp-scope-outbound').value,
      parcels: document.getElementById('grp-scope-parcels').value,
    },
  };
  try {
    if (id) await Api.api('groups', 'update', { method: 'POST', params: { id }, body });
    else await Api.api('groups', 'create', { method: 'POST', body });
    toast('已保存', 'ok');
    resetGrpForm();
    hideGrpFormCard();
    loadGroups();
  } catch (e) { /* toast shown */ }
}
async function deleteGroup(id) {
  const g = TEAM.groups.find((x) => String(x.id) === String(id));
  if (!confirm(`确认删除权限组「${g?.name}」？该组下账号会被移除分组。`)) return;
  try {
    await Api.api('groups', 'delete', { method: 'POST', params: { id } });
    toast('已删除', 'ok');
    loadGroups();
  } catch (e) { /* toast shown */ }
}

function buildLookupSelect() {
  const sel = document.getElementById('lookup-perm');
  sel.innerHTML = Object.entries(TEAM.catalog).map(([key, meta]) => `<option value="${key}">${esc(meta.label)} (${key})</option>`).join('');
}
async function runPermissionLookup() {
  const perm = document.getElementById('lookup-perm').value;
  const box = document.getElementById('lookup-result');
  box.textContent = '查询中...';
  try {
    const data = await Api.api('groups', 'permission_lookup', { params: { permission: perm } });
    const d = data.data;
    const groupNames = d.groups.map((g) => g.name).join('、') || '（无）';
    const userNames = d.users.map((u) => `${u.username}${u.source === 'super_admin' ? '(超管)' : u.source === 'member_override' ? '(成员例外)' : ''}`).join('、') || '（无）';
    box.innerHTML = `<div>拥有该权限的权限组：${esc(groupNames)}</div><div class="mt-1">拥有该权限的账号：${esc(userNames)}</div>`;
  } catch (e) {
    box.textContent = '查询失败';
  }
}

// ══════════════════════ 团队架构 ══════════════════════
async function loadOrgGroups() {
  try {
    const data = await Api.api('org_groups', 'list');
    TEAM.orgGroups = data.data || [];
    renderOrgList();
    fillOrgParentSelect();
  } catch (e) { /* toast shown */ }
}
function renderOrgList() {
  const box = document.getElementById('org-list');
  if (!TEAM.orgGroups.length) { box.innerHTML = `<p class="text-xs text-gray-400 py-4 text-center">暂无团队</p>`; return; }
  box.innerHTML = TEAM.orgGroups.map((o) => `
    <div data-org="${o.id}" class="org-item cursor-pointer rounded-md border ${TEAM.selectedOrgId == o.id ? 'border-purple-400 bg-purple-50 dark:bg-gray-700' : 'border-gray-100 dark:border-gray-700'} p-3 hover:border-purple-300">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-gray-800 dark:text-gray-100">${o.parent_name ? `<span class="text-gray-400 font-normal">${esc(o.parent_name)} / </span>` : ''}${esc(o.name)}</span>
        <span class="text-xs text-gray-400">${o.member_count} 人</span>
      </div>
      <div class="text-xs text-gray-400 mt-1">负责人：${esc((o.leader_names || []).join('、') || '未指定')}</div>
      <div class="text-xs text-gray-400 mt-0.5">入库:${SCOPE_LABEL[o.data_scopes?.inbound]} 快递:${SCOPE_LABEL[o.data_scopes?.outbound]} 回收:${SCOPE_LABEL[o.data_scopes?.parcels]}</div>
    </div>`).join('');
  box.querySelectorAll('.org-item').forEach((el) => el.addEventListener('click', () => selectOrg(el.dataset.org)));
}
function fillOrgParentSelect() {
  const sel = document.getElementById('org-parent');
  const cur = sel.value;
  sel.innerHTML = '<option value="">无（顶级团队）</option>' + TEAM.orgGroups.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('');
  sel.value = cur;
}
function fillLeaderSelect() {
  const sel = document.getElementById('org-leaders');
  sel.innerHTML = TEAM.allUsers.map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('');
}
function selectOrg(id) {
  TEAM.selectedOrgId = id;
  renderOrgList();
  const o = TEAM.orgGroups.find((x) => String(x.id) === String(id));
  if (!o) return;
  document.getElementById('org-id').value = o.id;
  document.getElementById('org-name').value = o.name;
  document.getElementById('org-parent').value = o.parent_id || '';
  document.getElementById('org-desc').value = o.description || '';
  document.getElementById('org-scope-inbound').value = o.data_scopes?.inbound || 'group';
  document.getElementById('org-scope-outbound').value = o.data_scopes?.outbound || 'group';
  document.getElementById('org-scope-parcels').value = o.data_scopes?.parcels || 'group';
  Array.from(document.getElementById('org-leaders').options).forEach((opt) => {
    opt.selected = (o.leader_ids || []).map(String).includes(opt.value);
  });
  document.getElementById('org-form-title').textContent = `编辑团队：${o.name}`;
  document.getElementById('org-form-cancel').classList.remove('hidden');
  document.getElementById('btn-delete-org').classList.toggle('hidden', !hasPerm('team:org_delete'));
  document.getElementById('org-members-title').textContent = `- ${o.name}`;
  document.getElementById('member-add-box').classList.toggle('hidden', !hasPerm('team:member_add'));
  loadMembers(o.id);
}
function resetOrgForm() {
  document.getElementById('org-form').reset();
  document.getElementById('org-id').value = '';
  document.getElementById('org-form-title').textContent = '新增团队';
  document.getElementById('org-form-cancel').classList.add('hidden');
  document.getElementById('btn-delete-org').classList.add('hidden');
}
async function submitOrgForm(e) {
  e.preventDefault();
  const id = document.getElementById('org-id').value;
  const name = document.getElementById('org-name').value.trim();
  if (name.length < 2) { toast('团队名称至少 2 个字', 'err'); return; }
  const leaderIds = Array.from(document.getElementById('org-leaders').selectedOptions).map((o) => parseInt(o.value, 10));
  const body = {
    name,
    parent_id: document.getElementById('org-parent').value || null,
    leader_ids: leaderIds,
    description: document.getElementById('org-desc').value.trim(),
    data_scopes: {
      inbound: document.getElementById('org-scope-inbound').value,
      outbound: document.getElementById('org-scope-outbound').value,
      parcels: document.getElementById('org-scope-parcels').value,
    },
  };
  try {
    if (id) await Api.api('org_groups', 'update', { method: 'POST', params: { id }, body });
    else await Api.api('org_groups', 'create', { method: 'POST', body });
    toast('已保存', 'ok');
    resetOrgForm();
    loadOrgGroups();
  } catch (e) { /* toast shown */ }
}
async function deleteSelectedOrg() {
  const id = document.getElementById('org-id').value;
  if (!id) return;
  if (!confirm('确认删除该团队？请先确保没有子团队和成员。')) return;
  try {
    await Api.api('org_groups', 'delete', { method: 'POST', params: { id } });
    toast('已删除', 'ok');
    resetOrgForm();
    TEAM.selectedOrgId = null;
    document.getElementById('member-tbody').innerHTML = `<tr><td colspan="5" class="text-center text-gray-400 py-8">请选择左侧团队</td></tr>`;
    loadOrgGroups();
  } catch (e) { /* toast shown */ }
}

async function loadMembers(groupId) {
  const tbody = document.getElementById('member-tbody');
  tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-400 py-6">加载中...</td></tr>`;
  try {
    const data = await Api.api('org_groups', 'members', { params: { id: groupId } });
    TEAM.members = data.data || [];
    renderMembers();
    fillMemberAddSelect();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-400 py-6">加载失败</td></tr>`;
  }
}
function renderMembers() {
  const tbody = document.getElementById('member-tbody');
  if (!TEAM.members.length) { tbody.innerHTML = `<tr><td colspan="5" class="text-center text-gray-400 py-8">暂无成员</td></tr>`; return; }
  const roleLabel = { leader: '组长', senior: '资深成员', member: '成员' };
  tbody.innerHTML = TEAM.members.map((m) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">${esc(m.username)}</td>
      <td class="px-4 py-3">
        ${hasPerm('team:member_edit') ? `
          <select data-role-for="${m.user_id}" class="field !py-1 !text-xs w-28">
            <option value="member" ${m.role_in_group === 'member' ? 'selected' : ''}>成员</option>
            <option value="senior" ${m.role_in_group === 'senior' ? 'selected' : ''}>资深成员</option>
            <option value="leader" ${m.role_in_group === 'leader' ? 'selected' : ''}>组长</option>
          </select>` : `<span class="text-gray-500">${roleLabel[m.role_in_group] || m.role_in_group}</span>`}
      </td>
      <td class="px-4 py-3 text-gray-500">${esc(m.perm_group_name || '未分组')}</td>
      <td class="px-4 py-3 text-gray-500">${fmtDate(m.last_active_at) || '-'}</td>
      <td class="px-4 py-3">
        ${hasPerm('team:member_remove') && m.user_id !== window.__user.uid ? `<button data-remove="${m.user_id}" class="text-red-500 hover:text-red-700 text-xs">移出</button>` : ''}
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-role-for]').forEach((sel) => sel.addEventListener('change', () => updateMemberRole(sel.dataset.roleFor, sel.value)));
  tbody.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeMember(b.dataset.remove)));
}
function fillMemberAddSelect() {
  const sel = document.getElementById('member-user');
  const existingIds = new Set(TEAM.members.map((m) => String(m.user_id)));
  sel.innerHTML = TEAM.allUsers.filter((u) => !existingIds.has(String(u.id))).map((u) => `<option value="${u.id}">${esc(u.username)}</option>`).join('');
}
async function addMember() {
  const groupId = TEAM.selectedOrgId;
  const userId = document.getElementById('member-user').value;
  const role = document.getElementById('member-role').value;
  if (!groupId || !userId) return;
  try {
    await Api.api('org_groups', 'add_member', { method: 'POST', body: { group_id: parseInt(groupId, 10), user_id: parseInt(userId, 10), role_in_group: role } });
    toast('已添加', 'ok');
    loadMembers(groupId);
    loadOrgGroups();
  } catch (e) { /* toast shown */ }
}
async function updateMemberRole(userId, role) {
  try {
    await Api.api('org_groups', 'update_member', { method: 'POST', body: { group_id: parseInt(TEAM.selectedOrgId, 10), user_id: parseInt(userId, 10), role_in_group: role } });
    toast('已更新', 'ok');
    loadOrgGroups();
  } catch (e) { loadMembers(TEAM.selectedOrgId); }
}
async function removeMember(userId) {
  if (!confirm('确认将该成员移出团队？')) return;
  try {
    await Api.api('org_groups', 'remove_member', { method: 'POST', body: { group_id: parseInt(TEAM.selectedOrgId, 10), user_id: parseInt(userId, 10) } });
    toast('已移出', 'ok');
    loadMembers(TEAM.selectedOrgId);
    loadOrgGroups();
  } catch (e) { /* toast shown */ }
}

// ══════════════════════ 系统更新 ══════════════════════
async function loadUpdateStatus() {
  const statusBox = document.getElementById('update-status');
  const baselineBox = document.getElementById('update-baseline-box');
  const availBox = document.getElementById('update-available-box');
  statusBox.textContent = '检查中...';
  baselineBox.classList.add('hidden');
  availBox.classList.add('hidden');
  try {
    const data = await Api.api('system_update', 'status');
    if (data.baseline_missing) {
      statusBox.textContent = '当前版本：未知（还没有设置基线）';
      baselineBox.classList.remove('hidden');
      TEAM.latestSha = data.latest;
    } else if (data.has_update) {
      statusBox.textContent = `当前版本：${data.current.slice(0, 8)}`;
      document.getElementById('update-latest-msg').textContent =
        `最新提交：${data.latest.slice(0, 8)} · ${data.latest_message || ''} · ${fmtDate(data.latest_date)}`;
      availBox.classList.remove('hidden');
    } else {
      statusBox.textContent = `当前已是最新版本（${(data.current || '').slice(0, 8)}）`;
    }
  } catch (e) {
    statusBox.textContent = '检查失败，请稍后再试';
  }
  loadUpdateBackups();
}

async function setUpdateBaseline() {
  if (!TEAM.latestSha) return;
  try {
    await Api.api('system_update', 'set_baseline', { method: 'POST', body: { sha: TEAM.latestSha } });
    toast('已设置基线版本', 'ok');
    loadUpdateStatus();
  } catch (e) { /* toast shown */ }
}

async function doSystemUpdate(btnId) {
  if (!confirm('确认立即更新？会自动备份当前代码，更新过程中请勿关闭页面。')) return;
  const btn = document.getElementById(btnId || 'btn-do-update');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '更新中...';
  try {
    const data = await Api.api('system_update', 'update', { method: 'POST', body: {} });
    toast('更新成功，版本 ' + (data.version || '').slice(0, 8), 'ok');
    loadUpdateStatus();
  } catch (e) {
    /* toast shown */
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function loadUpdateBackups() {
  const box = document.getElementById('update-backups-list');
  try {
    const data = await Api.api('system_update', 'backups');
    const list = data.data || [];
    if (!list.length) { box.textContent = '暂无备份'; return; }
    box.innerHTML = list.map((b) => `
      <div class="flex items-center justify-between border border-gray-100 dark:border-gray-700 rounded-md px-3 py-2">
        <span class="text-gray-600 dark:text-gray-300">${esc(b.name)}</span>
        <span class="text-gray-400">${esc(fmtDate(new Date(b.time * 1000).toISOString()))}</span>
        <button type="button" data-rollback="${esc(b.name)}" class="text-purple-600 hover:text-purple-800">回滚</button>
      </div>`).join('');
    box.querySelectorAll('[data-rollback]').forEach((btn) =>
      btn.addEventListener('click', () => rollbackUpdate(btn.dataset.rollback)));
  } catch (e) { box.textContent = '加载失败'; }
}

async function rollbackUpdate(name) {
  if (!confirm(`确认回滚到备份"${name}"？当前代码会被这份备份覆盖。`)) return;
  try {
    await Api.api('system_update', 'rollback', { method: 'POST', body: { name } });
    toast('已回滚', 'ok');
    loadUpdateStatus();
  } catch (e) { /* toast shown */ }
}

// ══════════════════════ 初始化 ══════════════════════
// 团队架构暂缓：org-form / btn-add-member 等监听器不再注册，loadOrgGroups 不再调用。
async function initTeam() {
  document.querySelectorAll('.team-tab').forEach((btn) => {
    if (btn.dataset.tab === 'accounts' && !hasPerm('team:accounts_view')) btn.classList.add('hidden');
    if (btn.dataset.tab === 'groups' && !hasPerm('team:groups_view')) btn.classList.add('hidden');
    // 系统更新只给真正的超级管理员看——服务端 system_update.php 也强制校验 role=admin，
    // 这里只是不给用不了的人看见入口，不是唯一的权限防线。
    if (btn.dataset.tab === 'update' && !(window.__user && window.__user.role === 'admin')) btn.classList.add('hidden');
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  const firstVisible = document.querySelector('.team-tab:not(.hidden)');
  if (firstVisible) switchTab(firstVisible.dataset.tab);

  try {
    const usersData = await Api.api('managers', 'dropdown');
    TEAM.allUsers = usersData.data || [];
  } catch (e) { /* toast shown */ }

  document.getElementById('acc-form').addEventListener('submit', submitAccountForm);
  document.getElementById('acc-form-cancel').addEventListener('click', resetAccForm);

  document.getElementById('btn-new-group').addEventListener('click', newGroup);
  document.getElementById('grp-form').addEventListener('submit', submitGroupForm);
  document.getElementById('grp-form-cancel').addEventListener('click', () => { resetGrpForm(); hideGrpFormCard(); });
  document.getElementById('grp-template').addEventListener('change', (e) => { if (e.target.value) applyTemplate(e.target.value); });
  document.getElementById('btn-lookup').addEventListener('click', runPermissionLookup);

  document.getElementById('btn-check-update')?.addEventListener('click', loadUpdateStatus);
  document.getElementById('btn-set-baseline')?.addEventListener('click', setUpdateBaseline);
  document.getElementById('btn-do-update')?.addEventListener('click', () => doSystemUpdate('btn-do-update'));
  document.getElementById('btn-do-update-from-baseline')?.addEventListener('click', () => doSystemUpdate('btn-do-update-from-baseline'));

  if (hasPerm('team:accounts_view')) await Promise.all([loadAccounts(), loadGroups()]);
  if (hasPerm('team:groups_view')) { await loadPermsMeta(); await loadTemplates(); if (!TEAM.groups.length) await loadGroups(); }
}
