/* expv7 — 快递管理（填单号）页面逻辑 */
const OB = {
  couriers: [],
  managers: [],
  rows: [],
  page: 1,
  limit: 20,
  total: 0,
  status: '',
  fillImages: [],
  pendingImageDeletes: [], // 编辑弹窗里点×移除的旧图，保存成功后才真正删物理文件（见 removeImage）
  selectedIds: new Set(),
};

const OB_STATUS_LABEL = { 'pending-ship': '待邮寄', shipped: '已邮寄', exception: '异常件' };
const OB_STATUS_CLASS = {
  'pending-ship': 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400',
  shipped: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400',
  exception: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};
function obStatusBadge(status) {
  return `<span class="status-badge inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${OB_STATUS_CLASS[status] || 'bg-gray-100 text-gray-500'}">${OB_STATUS_LABEL[status] || status || '-'}</span>`;
}

function fillCourierFilterSelect(selectEl) {
  if (!selectEl) return;
  const cur = selectEl.value;
  selectEl.innerHTML = '<option value="">全部</option>';
  OB.couriers.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name}${c.category ? ' · ' + (c.category === 'cn' ? '中国' : '韩国') : ''}`;
    if (String(c.id) === String(cur)) opt.selected = true;
    selectEl.appendChild(opt);
  });
}
function fillCourierSelect(cat, courierSel, serviceSel) {
  courierSel.innerHTML = '<option value="">未指定</option>';
  OB.couriers.filter((c) => c.category === cat).forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    courierSel.appendChild(opt);
  });
  fillServiceTypeSelect('', serviceSel);
}
function fillServiceTypeSelect(courierId, serviceSel) {
  serviceSel.innerHTML = '';
  const courier = OB.couriers.find((c) => String(c.id) === String(courierId));
  const types = courier?.service_types?.length ? courier.service_types : ['普通'];
  types.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    if (t === '普通') opt.selected = true;
    serviceSel.appendChild(opt);
  });
}
// managers.php?action=dropdown 返回的是全员列表，不按数据范围过滤——数据范围是
// "仅自己"的账号，负责人下拉必须锁死成自己，否则选了别人提交时会被后端
// manager_allowed_in_outbound_scope 拒绝，报一个前端完全没提示过的 MANAGER_OUT_OF_SCOPE。
// （inbound.js 的新增表单已经有这个锁，这里是快递管理的填单号/编辑弹窗，之前漏掉了。）
function fillManagerSelect(selectEl, selectedId) {
  if (!selectEl) return;
  const user = window.__user;
  const isPrivileged = user && (user.role === 'admin' || (user.perms || []).includes('*'));
  const scope = user?.data_scopes?.outbound || 'global';
  if (user && !isPrivileged && scope === 'self') {
    const me = OB.managers.find((m) => String(m.id) === String(user.uid));
    selectEl.innerHTML = `<option value="${user.uid}" selected>${esc(me?.username || user.username)}</option>`;
    selectEl.disabled = true;
    return;
  }
  selectEl.disabled = false;
  selectEl.innerHTML = '<option value="">未指定</option>';
  OB.managers.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.username;
    if (String(m.id) === String(selectedId)) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

function renderImagePreview(container, images, onRemove) {
  container.innerHTML = images.map((path, idx) => `
    <div class="relative group">
      <img src="${esc(path)}" class="img-thumb cursor-zoom-in" data-lightbox-src="${esc(path)}" />
      <button type="button" data-idx="${idx}" class="img-remove">×</button>
    </div>`).join('');
  container.querySelectorAll('[data-lightbox-src]').forEach((img) => img.addEventListener('click', () => Lightbox.open(img.dataset.lightboxSrc)));
  container.querySelectorAll('.img-remove').forEach((btn) => btn.addEventListener('click', () => onRemove(parseInt(btn.dataset.idx, 10))));
}
function updateImagesHint(count) {
  const hint = document.getElementById('fl-images-hint');
  if (hint) hint.textContent = count > 0 ? `已选择 ${count} 张` : '未选择文件';
}
// 这里的图片列表始终来自已经保存过的记录（openFillModal 从 r.images 初始化），
// 点 × 只是从这次编辑的本地草稿里移除，不能立刻删物理文件——真正保存成功之前，
// 数据库里那条记录仍然引用着这个路径。之前是点了就立刻删文件，结果用户点了
// × 但没点保存就关掉弹窗（或者保存失败），文件已经被删了但数据库从没更新过，
// 刷新页面后这条记录的 images 字段里那张图还在，指向的却是个已经不存在的文件——
// 表现出来就是"删除了图片，刷新又出现了"。现在改成先记到 OB.pendingImageDeletes
// 里，等 submitFill 真的保存成功之后才去删这些文件；如果直接关掉弹窗不保存，
// 待删列表清空但不动文件，数据库和文件保持一致。
function removeImage(targetArr, previewEl, idx) {
  const [removedPath] = targetArr.splice(idx, 1);
  renderImagePreview(previewEl, targetArr, (i) => removeImage(targetArr, previewEl, i));
  updateImagesHint(targetArr.length);
  if (removedPath) OB.pendingImageDeletes.push(removedPath);
}

function duplicateTrackingMessage(tracking, duplicate) {
  const courier = duplicate?.courier_name || '未指定快递公司';
  return `单号 ${tracking} 已经录入（${courier}），请勿重复录入`;
}

async function checkOutboundTrackingDuplicate(tracking, excludeId) {
  try {
    return await Api.api('outbound', 'check_tracking', {
      params: { tracking, exclude_id: excludeId || 0 },
    });
  } catch (e) {
    toast('暂时无法校验单号是否重复，请稍后重试', 'err');
    return { blocked: true };
  }
}

// 选图/拖拽/拍照统一走这一个函数：上传图片的同时，顺手在本地识别一下面单条形码。
// 新上传的图片是明确的"重新扫一下"动作，所以识别到就直接填（覆盖旧单号也一样），
// 不因为单号框里已经有内容就跳过识别——只是覆盖时提示一下原来的值，方便发现认错。
async function handleImageFiles(files, targetArr, previewEl, trackingElId, knownText, reportStatus, recognitionComplete = false) {
  const list = Array.from(files || []).filter((f) => f.type && f.type.startsWith('image/'));
  if (!list.length) return;

  const trackingInput = trackingElId ? document.getElementById(trackingElId) : null;
  // knownText：拍照弹窗实时识别循环已经连续确认过的号码（见 camera-capture.js），
  // 拍下来的这张照片没必要再重新跑一遍解码——直接采信用户拍照前就已经在状态栏看到的结果。
  let scannedText = knownText || null;
  if (trackingInput && !scannedText && !recognitionComplete) {
    reportStatus?.('拍照完成，正在进行多尺寸条码识别…', 'warn');
    for (const file of list) {
      const courierName = document.getElementById('fl-courier')?.selectedOptions?.[0]?.textContent || '';
      const candidates = await BarcodeScan.decodeFileCandidates(file, { courierName });
      if (!candidates.length) continue;
      scannedText = await BarcodeScan.chooseCandidate(candidates);
      break;
    }
  }

  for (const file of list) {
    reportStatus?.('正在上传面单 / 包裹图片…', 'info');
    try { targetArr.push(await Api.uploadFile(file)); } catch (e) { /* toast shown */ }
  }
  renderImagePreview(previewEl, targetArr, (idx) => removeImage(targetArr, previewEl, idx));
  updateImagesHint(targetArr.length);

  if (scannedText && trackingInput) {
    reportStatus?.('已识别单号，正在检查是否重复…', 'info');
    const excludeId = document.getElementById('fl-id')?.value || 0;
    const duplicateCheck = await checkOutboundTrackingDuplicate(scannedText.trim().toUpperCase(), excludeId);
    if (duplicateCheck.blocked) scannedText = null;
    if (duplicateCheck.exists) {
      toast(duplicateTrackingMessage(scannedText, duplicateCheck.data), 'err', 5200);
      scannedText = null;
    }
  }

  if (scannedText && trackingInput) {
    const prev = trackingInput.value.trim();
    trackingInput.value = scannedText.trim().toUpperCase();
    trackingInput.dispatchEvent(new Event('input'));
    toast(prev && prev !== scannedText.trim().toUpperCase()
      ? `已从图片识别单号，原单号 ${prev} 已替换为 ${scannedText}`
      : '已从图片自动识别单号：' + scannedText, 'ok');
    reportStatus?.(`识别成功：${scannedText}，图片已添加`, 'ok');
  } else {
    reportStatus?.('图片已添加；未识别到可用的新单号', 'warn');
  }
}

function buildFilterParams(extra = {}) {
  const params = { page: OB.page, limit: OB.limit };
  const q = document.getElementById('f-q').value.trim();
  const courier = document.getElementById('f-courier').value;
  const mode = document.getElementById('f-date-mode').value;
  if (q) params.q = q;
  if (courier) params.courier_id = courier;
  if (OB.status) params.status = OB.status;
  if (mode === 'single') {
    const d = document.getElementById('f-date-single').value;
    if (d) params.date = d;
  } else if (mode === 'range') {
    const ds = document.getElementById('f-date-start').value;
    const de = document.getElementById('f-date-end').value;
    if (ds) params.date_start = ds;
    if (de) params.date_end = de;
  }
  return { ...params, ...extra };
}

// ── 日期筛选：全部日期 / 单日 / 范围（对齐 v5 admin-app.js 的 setupDateFilterMode）──
function setupDateFilterMode(modeId, singleId, startId, endId, onFilterChange) {
  const mode = document.getElementById(modeId);
  const single = document.getElementById(singleId);
  const start = document.getElementById(startId);
  const end = document.getElementById(endId);
  const sync = () => syncDateFilterMode(mode, single, start, end);

  mode.addEventListener('change', () => {
    single.value = '';
    start.value = '';
    end.value = '';
    sync();
    onFilterChange();
  });
  single.addEventListener('change', () => {
    if (single.value) {
      mode.value = 'single';
      start.value = '';
      end.value = '';
      sync();
      onFilterChange();
    }
  });
  [start, end].forEach((el) => {
    el.addEventListener('change', () => {
      if (el.value) {
        mode.value = 'range';
        single.value = '';
        sync();
        onFilterChange();
      }
    });
  });
  sync();
}
function syncDateFilterMode(mode, single, start, end) {
  const isSingle = mode.value === 'single';
  const isRange = mode.value === 'range';
  single.classList.toggle('hidden', !isSingle);
  start.classList.toggle('hidden', !isRange);
  end.classList.toggle('hidden', !isRange);
  document.getElementById('ob-filter-panel')?.classList.toggle('date-expanded', isSingle || isRange);
}
function resetDateFilter() {
  document.getElementById('f-date-mode').value = '';
  document.getElementById('f-date-single').value = '';
  document.getElementById('f-date-start').value = '';
  document.getElementById('f-date-end').value = '';
  syncDateFilterMode(
    document.getElementById('f-date-mode'),
    document.getElementById('f-date-single'),
    document.getElementById('f-date-start'),
    document.getElementById('f-date-end'),
  );
}

async function loadOutboundList() {
  const tbody = document.getElementById('ob-tbody');
  tbody.innerHTML = Array.from({ length: 4 }).map(() => `<tr class="skeleton-row"><td colspan="7"><div class="skeleton-bar w-full"></div></td></tr>`).join('');
  try {
    const data = await Api.api('outbound', 'list', { params: buildFilterParams() });
    OB.rows = data.data;
    OB.total = data.total;
    renderOutboundTable();
    renderPagination();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-gray-400 py-8">加载失败</td></tr>`;
  }
}

function renderOutboundTable() {
  const tbody = document.getElementById('ob-tbody');
  document.getElementById('ob-summary').textContent = `共 ${OB.total} 条`;
  const badge = document.getElementById('ob-count-badge');
  if (badge) badge.textContent = `共 ${OB.total} 条`;
  if (!OB.rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-gray-400 py-10">暂无数据</td></tr>`;
    return;
  }
  tbody.innerHTML = OB.rows.map((r) => `
    <tr class="hover:bg-gray-50 dark:hover:bg-gray-700/30">
      <td data-label="时间" class="px-4 py-3 whitespace-nowrap text-gray-500">${fmtDate(r.created_at)}</td>
      <td data-label="姓名" class="px-4 py-3 font-medium text-gray-800 dark:text-gray-100">
        <label class="inline-flex items-center gap-2 cursor-pointer">
          <input type="checkbox" class="row-select rounded border-gray-300 flex-shrink-0" data-row-id="${r.id}" ${OB.selectedIds.has(String(r.id)) ? 'checked' : ''} />
          <span>${esc(r.name)}</span>
        </label>
      </td>
      <td data-label="手机" class="px-4 py-3 text-gray-500">${esc(r.phone)}</td>
      <td data-label="快递信息" class="px-4 py-3 text-gray-500">
        <span class="courier-info-name">${esc(r.courier_name || '-')}</span><span class="courier-info-service">${esc(r.service_type || '')}</span>
      </td>
      <td data-label="单号" class="px-4 py-3 text-gray-500">${trackingCellHtml(r)}</td>
      <td data-label="状态" class="px-4 py-3">${obStatusBadge(r.status)}</td>
      <td data-label="操作" class="px-4 py-3">
        <div class="record-actions flex justify-end flex-wrap gap-2 text-xs">
          <button data-copy-address="${r.id}" class="text-gray-700 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-400">复制地址</button>
          ${r.tracking_number ? `<button data-copy-track="${r.id}" class="text-gray-700 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-400">复制单号</button>` : ''}
          ${r.tracking_number ? `<button data-logistics="${r.id}" class="text-gray-700 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-400">物流查询</button>` : ''}
          ${r.tracking_number ? `<button data-notice="${r.id}" class="text-gray-700 dark:text-gray-300 hover:text-purple-600 dark:hover:text-purple-400">客户通知</button>` : ''}
          ${hasPerm('parcels:edit') ? `<button data-fill="${r.id}" class="text-purple-600 hover:text-purple-800">${r.status === 'pending-ship' ? '填单号' : '编辑'}</button>` : ''}
          ${hasPerm('parcels:delete') ? `<button data-del="${r.id}" class="text-red-500 hover:text-red-700">删除</button>` : ''}
        </div>
      </td>
    </tr>`).join('');

  tbody.querySelectorAll('[data-copy-address]').forEach((b) => b.addEventListener('click', () => copyCustomerAddress(b.dataset.copyAddress)));
  tbody.querySelectorAll('[data-copy-track]').forEach((b) => b.addEventListener('click', () => copyTrackingNo(b.dataset.copyTrack)));
  tbody.querySelectorAll('[data-logistics]').forEach((b) => b.addEventListener('click', () => openLogistics(b.dataset.logistics)));
  tbody.querySelectorAll('[data-notice]').forEach((b) => b.addEventListener('click', () => copyCustomerNotice(b.dataset.notice)));
  tbody.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => openFillModal(b.dataset.fill)));
  tbody.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => deleteOutbound(b.dataset.del)));
  tbody.querySelectorAll('[data-edit-tracking]').forEach((b) => b.addEventListener('click', () => openTrackingInlineEdit(b.dataset.editTracking)));
  tbody.querySelectorAll('[data-scan-tracking]').forEach((b) => b.addEventListener('click', () => scanTrackingForRow(b.dataset.scanTracking)));
  tbody.querySelectorAll('.row-select').forEach((cb) => cb.addEventListener('change', () => {
    const id = cb.dataset.rowId;
    if (cb.checked) OB.selectedIds.add(id); else OB.selectedIds.delete(id);
    updateSelectionUI();
  }));
  updateSelectionUI();
}

// ── 单号内联编辑（表格里直接改，不用打开填单弹窗）─────────────
// 防误触：只有点专门的铅笔按钮才进入编辑态（点单元格其它地方没反应）；
// 保存只认 Enter 或点 ✓，blur 不保存（避免手滑点到别处导致误存）；Esc/✕ 直接放弃。
function trackingCellHtml(r) {
  const display = r.tracking_number ? `<span class="font-mono">${esc(r.tracking_number)}</span>` : '<span class="text-gray-300">未填写</span>';
  const editBtn = hasPerm('parcels:edit') ? `
    <button type="button" class="tracking-icon-btn tracking-edit-btn text-gray-400 hover:text-purple-600 flex-shrink-0" data-edit-tracking="${r.id}" title="修改单号" aria-label="修改单号">
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
    </button>` : '';
  const scanBtn = hasPerm('parcels:edit') ? `
    <button type="button" class="tracking-icon-btn text-gray-400 hover:text-purple-600 flex-shrink-0" data-scan-tracking="${r.id}" title="拍照/选图扫码识别" aria-label="拍照/选图扫码识别">
      <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 012-2h2M4 16v2a2 2 0 002 2h2m8-16h2a2 2 0 012 2v2m-4 12h2a2 2 0 002-2v-2M7 8v8m3-8v8m4-8v8m3-8v8"/></svg>
    </button>` : '';
  return `<div class="inline-flex items-center gap-1.5" data-tracking-cell="${r.id}">${display}${editBtn}${scanBtn}</div>`;
}

function bindTrackingCellActions(cell, id) {
  cell?.querySelector(`[data-edit-tracking="${CSS.escape(String(id))}"]`)
    ?.addEventListener('click', () => openTrackingInlineEdit(id));
  cell?.querySelector(`[data-scan-tracking="${CSS.escape(String(id))}"]`)
    ?.addEventListener('click', () => scanTrackingForRow(id));
}

function restoreTrackingCell(id) {
  const row = getRow(id);
  const current = document.querySelector(`[data-tracking-cell="${CSS.escape(String(id))}"]`);
  if (!row || !current) return null;
  const holder = document.createElement('div');
  holder.innerHTML = trackingCellHtml(row);
  const next = holder.firstElementChild;
  current.replaceWith(next);
  bindTrackingCellActions(next, id);
  return next;
}

function captureTrackingScrollAnchor(id) {
  const main = document.querySelector('main');
  const row = document.querySelector(`[data-tracking-cell="${CSS.escape(String(id))}"]`)?.closest('tr');
  return { main, scrollTop: main?.scrollTop || 0, rowTop: row?.getBoundingClientRect().top ?? null };
}

function restoreTrackingScrollAnchor(anchor, id) {
  if (!anchor?.main) return;
  const restore = () => {
    const row = document.querySelector(`[data-tracking-cell="${CSS.escape(String(id))}"]`)?.closest('tr');
    if (row && anchor.rowTop != null) {
      anchor.main.scrollTop += row.getBoundingClientRect().top - anchor.rowTop;
    } else {
      anchor.main.scrollTop = anchor.scrollTop;
    }
  };
  requestAnimationFrame(() => requestAnimationFrame(restore));
  // 手机软键盘收起时 visualViewport 变化会稍有延迟，再校正一次。
  setTimeout(restore, 180);
}

function openTrackingInlineEdit(id) {
  const row = getRow(id);
  const cell = document.querySelector(`[data-tracking-cell="${CSS.escape(String(id))}"]`);
  if (!row || !cell) return;
  cell.innerHTML = `
    <input type="text" class="field tracking-inline-input !w-36 !py-1 font-mono" id="tracking-inline-input-${id}" value="${esc(row.tracking_number || '')}" placeholder="填写单号" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done" />
    <button type="button" class="tracking-icon-btn text-emerald-600 hover:text-emerald-800 flex-shrink-0" data-confirm-tracking="${id}" title="保存" aria-label="确认保存单号">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>
    </button>
    <button type="button" class="tracking-icon-btn text-gray-400 hover:text-gray-600 flex-shrink-0" data-cancel-tracking="${id}" title="取消" aria-label="取消修改单号">
      <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 18L18 6M6 6l12 12"/></svg>
    </button>`;
  const input = document.getElementById(`tracking-inline-input-${id}`);
  input.focus();
  input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveTrackingInline(id); }
    if (e.key === 'Escape') { e.preventDefault(); cancelTrackingInlineEdit(input); }
  });
  cell.querySelector(`[data-confirm-tracking="${id}"]`).addEventListener('click', () => saveTrackingInline(id));
  cell.querySelector(`[data-cancel-tracking="${id}"]`).addEventListener('click', () => cancelTrackingInlineEdit(input));
}

// 取消时只恢复当前单号单元格，不重绘整张表。手机软键盘还在收起时替换 tbody，
// Safari/Chrome 都可能丢失原滚动锚点并跳到页面顶部。
function cancelTrackingInlineEdit(input) {
  if (input?.dataset.saving === '1') return;
  const id = input?.id?.replace('tracking-inline-input-', '');
  input?.blur();
  if (id) restoreTrackingCell(id);
}

// 展示态点相机图标：弹出小面板，可拖拽/选图，也可以拍照（三种方式最终都走
// processRowScanFile）。这里没有打开填单弹窗，没有 OB.fillImages 可用，所以照片
// 直接上传并立刻写回该记录的图片列表（不用等保存）；单号识别成功后进入内联编辑态
// 并预填，仍需手动 Enter/✓ 确认保存。
let ROW_SCAN_ID = null;

function scanTrackingForRow(id) {
  ROW_SCAN_ID = id;
  document.getElementById('row-scan-modal').classList.remove('hidden');
}
function closeRowScanModal() {
  document.getElementById('row-scan-modal').classList.add('hidden');
  document.getElementById('row-scan-file-input').value = '';
  ROW_SCAN_ID = null;
}

async function processRowScanFile(file, knownText, reportStatus) {
  const id = ROW_SCAN_ID;
  closeRowScanModal();
  if (!id || !file || !file.type || !file.type.startsWith('image/')) return;

  const row = getRow(id);
  const courierName = row?.courier_name || getCourierForRow(row)?.name || '';
  reportStatus?.(knownText ? `已识别 ${knownText}，正在上传并检查重复…` : '正在识别条码并上传照片…', 'info');
  // knownText：拍照弹窗实时识别循环已经连续确认过的号码，不用再重新解码一遍。
  const [text, uploadedPath] = await Promise.all([
    knownText
      ? Promise.resolve(knownText)
      : BarcodeScan.decodeFileCandidates(file, { courierName }).then((candidates) => BarcodeScan.chooseCandidate(candidates)),
    Api.uploadFile(file).catch(() => null),
  ]);

  // 快捷扫码若命中已录入单号，不把这次临时照片挂到错误/重复记录上。
  if (text) {
    reportStatus?.('已识别单号，正在检查是否已经录入…', 'info');
    const normalizedText = text.trim().toUpperCase();
    const duplicateCheck = await checkOutboundTrackingDuplicate(normalizedText, id);
    if (duplicateCheck.blocked || duplicateCheck.exists) {
      if (uploadedPath) Api.deleteUploadedFile(uploadedPath);
      if (duplicateCheck.exists) {
        reportStatus?.(duplicateTrackingMessage(normalizedText, duplicateCheck.data), 'err');
        toast(duplicateTrackingMessage(normalizedText, duplicateCheck.data), 'err', 5200);
      } else {
        reportStatus?.('无法完成重复单号检查，请稍后重试', 'err');
      }
      return;
    }
  }

  if (uploadedPath && row) {
    reportStatus?.('正在保存面单图片…', 'info');
    const images = [...(row.images || []), uploadedPath];
    try {
      await Api.api('outbound', 'update', { method: 'POST', params: { id }, body: { images } });
      row.images = images;
      toast('照片已保存到面单图片', 'ok');
    } catch (e) { /* toast shown */ }
  }

  if (!text) {
    reportStatus?.('未识别到条形码，请换个角度重新拍摄', 'err');
    toast('未识别到条形码，换一张更清晰的图片，或手动输入', 'err');
    return;
  }
  reportStatus?.(`正在自动保存单号 ${text.trim().toUpperCase()}…`, 'info');
  await saveTrackingValue(id, text.trim().toUpperCase(), { fromScan: true, skipDuplicateCheck: true });
}

async function saveTrackingValue(id, rawValue, { input = null, fromScan = false, skipDuplicateCheck = false } = {}) {
  const row = getRow(id);
  if (!row) return false;
  const scrollAnchor = captureTrackingScrollAnchor(id);
  const value = String(rawValue || '').trim().toUpperCase();

  if (value && (value.length < 4 || value.length > 40)) {
    toast('快递单号长度需为 4-40 字符', 'err');
    return false;
  }
  if (value && !skipDuplicateCheck) {
    const duplicateCheck = await checkOutboundTrackingDuplicate(value, id);
    if (duplicateCheck.blocked) return false;
    if (duplicateCheck.exists) {
      toast(duplicateTrackingMessage(value, duplicateCheck.data), 'err', 5200);
      return false;
    }
  }
  if (!value && row.status === 'shipped') {
    toast('已邮寄状态下不能清空快递单号，请先修改状态', 'err');
    return false;
  }

  const body = { tracking_number: value };
  const autoShip = !!value && row.status === 'pending-ship'; // 方案A：待邮寄+填了单号→自动已邮寄
  if (autoShip) body.status = 'shipped';

  try {
    await Api.api('outbound', 'update', { method: 'POST', params: { id }, body });
    toast(fromScan
      ? (autoShip ? '扫码单号已自动保存，并切换为已邮寄' : '扫码单号已自动保存')
      : (autoShip ? '已保存，并自动切换为已邮寄' : '单号已更新'), 'ok');
    input?.blur();
    row.tracking_number = value;
    if (autoShip) row.status = 'shipped';
    const nextCell = restoreTrackingCell(id);
    const statusCell = nextCell?.closest('tr')?.querySelector('td[data-label="状态"]');
    if (statusCell) statusCell.innerHTML = obStatusBadge(row.status);
    restoreTrackingScrollAnchor(scrollAnchor, id);
    return true;
  } catch (e) { return false; /* toast shown */ }
}

async function saveTrackingInline(id) {
  const input = document.getElementById(`tracking-inline-input-${id}`);
  if (!input || input.dataset.saving === '1') return;
  input.dataset.saving = '1';
  input.readOnly = true;
  const cell = input.closest('[data-tracking-cell]');
  const buttons = Array.from(cell?.querySelectorAll('button') || []);
  buttons.forEach((button) => { button.disabled = true; });
  cell?.classList.add('tracking-saving');
  const saved = await saveTrackingValue(id, input.value, { input });
  if (!saved && input.isConnected) {
    input.dataset.saving = '0';
    input.readOnly = false;
    buttons.forEach((button) => { button.disabled = false; });
    cell?.classList.remove('tracking-saving');
    input.focus({ preventScroll: true });
  }
}

// ── 行选择（导出用）────────────────────────────────────────
function updateSelectionUI() {
  const pageIds = OB.rows.map((r) => String(r.id));
  const selectedOnPage = pageIds.filter((id) => OB.selectedIds.has(id));
  const selectAll = document.getElementById('ob-select-all-page');
  if (selectAll) {
    selectAll.checked = pageIds.length > 0 && selectedOnPage.length === pageIds.length;
    selectAll.indeterminate = selectedOnPage.length > 0 && selectedOnPage.length < pageIds.length;
  }
  const info = document.getElementById('ob-selection-info');
  const countEl = document.getElementById('ob-selection-count');
  if (info && countEl) {
    countEl.textContent = OB.selectedIds.size;
    info.classList.toggle('hidden', OB.selectedIds.size === 0);
  }
}
function toggleSelectAllPage(checked) {
  OB.rows.forEach((r) => {
    if (checked) OB.selectedIds.add(String(r.id)); else OB.selectedIds.delete(String(r.id));
  });
  renderOutboundTable();
}
function clearSelection() {
  OB.selectedIds.clear();
  renderOutboundTable();
}

// ── 批量操作（改状态 / 删除）：挑选出来的 id 逐条调用现成的单条接口，
// 复用已经写好的权限校验/数据范围/业务规则（比如"已邮寄"要求先有单号），
// 不重复实现一遍，失败的记下来最后一起提示，不中断后面的。────────────
// 勾选是跨页/跨筛选持续保留的（导出功能需要这个特性：先勾几页再一起导出），
// 但这意味着换了筛选条件之后，之前别的条件下勾的记录还留着、当下却看不见——
// 这时候如果直接批量删除/改状态，会在用户毫无察觉的情况下动到不在眼前的记录。
// 这里检测一下，有这种"看不见的勾选"就在确认框里明确提示出来。
function warnIfSelectionHasHiddenRows(ids) {
  const visibleIds = new Set(OB.rows.map((r) => String(r.id)));
  const hiddenCount = ids.filter((id) => !visibleIds.has(String(id))).length;
  return hiddenCount > 0 ? `\n\n注意：其中 ${hiddenCount} 条不在当前筛选结果里（可能是之前换筛选条件前勾选的），请确认这些也是你要操作的记录。` : '';
}

// 批量操作正在跑的时候按钮没禁用，手快连点两下会让同一批 id 被并发处理两遍——
// 结果上不算错（第二遍大多数会因为"已经删过/已经是这个状态"而失败），但会打两遍
// 请求、弹两次汇总提示，体验很糊。加个简单的进行中锁，跟系统更新按钮的禁用逻辑一致。
let obBatchInFlight = false;

async function batchUpdateStatus() {
  if (obBatchInFlight) return;
  const ids = Array.from(OB.selectedIds);
  if (!ids.length) return;
  const status = document.getElementById('ob-batch-status').value;
  const label = OB_STATUS_LABEL[status] || status;
  if (!confirm(`确认把已勾选的 ${ids.length} 条记录状态改为"${label}"？${warnIfSelectionHasHiddenRows(ids)}`)) return;

  obBatchInFlight = true;
  let okCount = 0;
  const failed = [];
  for (const id of ids) {
    try {
      await Api.api('outbound', 'update', { method: 'POST', params: { id }, body: { status } });
      okCount++;
    } catch (e) {
      const row = getRow(id);
      failed.push(row?.name || id);
    }
  }
  obBatchInFlight = false;
  clearSelection();
  if (failed.length) {
    toast(`已更新 ${okCount} 条，${failed.length} 条失败：${failed.slice(0, 5).join('、')}${failed.length > 5 ? ' 等' : ''}`, 'err', 4500);
  } else {
    toast(`已更新 ${okCount} 条`, 'ok');
  }
  loadOutboundList();
}

async function batchDeleteSelected() {
  if (obBatchInFlight) return;
  const ids = Array.from(OB.selectedIds);
  if (!ids.length) return;
  if (!confirm(`确认删除已勾选的 ${ids.length} 条记录？删除后会进入回收站。${warnIfSelectionHasHiddenRows(ids)}`)) return;

  obBatchInFlight = true;
  let okCount = 0;
  const failed = [];
  for (const id of ids) {
    try {
      await Api.api('outbound', 'delete', { method: 'POST', params: { id } });
      okCount++;
    } catch (e) {
      const row = getRow(id);
      failed.push(row?.name || id);
    }
  }
  obBatchInFlight = false;
  clearSelection();
  if (failed.length) {
    toast(`已删除 ${okCount} 条，${failed.length} 条失败：${failed.slice(0, 5).join('、')}${failed.length > 5 ? ' 等' : ''}`, 'err', 4500);
  } else {
    toast(`已删除 ${okCount} 条`, 'ok');
  }
  loadOutboundList();
}

function renderPagination() {
  const box = document.getElementById('ob-pagination');
  const pages = Math.max(1, Math.ceil(OB.total / OB.limit));
  const cur = OB.page;
  const mk = (label, page, disabled, active) => `
    <button ${disabled ? 'disabled' : `data-page="${page}"`}
      class="px-2.5 py-1 text-xs rounded-md ${active ? 'bg-purple-600 text-white' : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700'} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}">${label}</button>`;
  let html = mk('上一页', cur - 1, cur <= 1, false);
  const start = Math.max(1, cur - 2);
  const end = Math.min(pages, start + 4);
  for (let p = start; p <= end; p++) html += mk(String(p), p, false, p === cur);
  html += mk('下一页', cur + 1, cur >= pages, false);
  box.innerHTML = html;
  box.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { OB.page = parseInt(b.dataset.page, 10); loadOutboundList(); }));
}

function getRow(id) { return OB.rows.find((x) => String(x.id) === String(id)); }
function getCourierForRow(row) { return OB.couriers.find((c) => String(c.id) === String(row?.courier_id)); }

// 复制姓名/电话/地址，方便直接粘到快递公司网站建单——跟"复制单号"不同，这个不需要
// 已经有单号才能用，恰恰是去建单拿单号之前要用的，所以不按 tracking_number 门控显示。
function copyCustomerAddress(id) {
  const row = getRow(id);
  if (!row?.name && !row?.address) { toast('这条记录还没有姓名或地址', 'err'); return; }
  navigator.clipboard?.writeText(customerAddressText(row)).then(() => toast('已复制姓名/电话/地址', 'ok'));
}

function copyTrackingNo(id) {
  const row = getRow(id);
  const tracking = String(row?.tracking_number || '').trim().toUpperCase();
  if (!tracking) { toast('快递单号尚未填写', 'err'); return; }
  navigator.clipboard?.writeText(tracking).then(() => toast('已复制快递单号：' + tracking, 'ok'));
}
// 物流查询统一走快递100（自动识别快递公司，不依赖每个快递商自己配置的查询地址）
function logisticsUrl(row) {
  const tracking = String(row?.tracking_number || '').trim();
  if (!tracking) return '';
  return `https://www.kuaidi100.com/chaxun?nu=${encodeURIComponent(tracking)}`;
}
function openLogistics(id) {
  const row = getRow(id);
  const url = logisticsUrl(row);
  if (!url) { toast('快递单号尚未填写', 'err'); return; }
  window.open(url, '_blank', 'noopener');
}
function publicTrackUrl() {
  // 注意：不能指向 index.html——那是需要登录的后台首页。公开查询页是 track.html。
  return location.origin + location.pathname.replace(/[^/]*$/, 'track.html');
}
function customerNoticeText(row) {
  const tracking = String(row?.tracking_number || '').trim();
  const courier = getCourierForRow(row);
  const courierName = row?.courier_name || courier?.name || '';
  return [
    '您好，您的快递已经发出。',
    '',
    courierName ? '快递公司：' + courierName : '',
    '快递单号：' + tracking,
    row?.service_type ? '服务类型：' + row.service_type : '',
    '',
    '快递查询：',
    publicTrackUrl(),
    '',
    '您也可以复制快递单号，前往对应快递公司的官方平台查询物流信息。',
  ].filter((l) => l !== '').join('\n');
}
function copyCustomerNotice(id) {
  const row = getRow(id);
  if (!row?.tracking_number) { toast('快递单号尚未填写', 'err'); return; }
  navigator.clipboard?.writeText(customerNoticeText(row)).then(() => toast('客户通知已复制', 'ok'));
}

async function deleteOutbound(id) {
  const row = getRow(id);
  if (!confirm(`确认删除 ${row?.name || '这条记录'}？删除后会进入回收站。`)) return;
  try {
    await Api.api('outbound', 'delete', { method: 'POST', params: { id } });
    toast('已删除', 'ok');
    loadOutboundList();
  } catch (e) { /* toast shown */ }
}

// ── 填单弹窗 ────────────────────────────────────────────────
function syncTrackingRequired() {
  const required = document.getElementById('fl-status').value === 'shipped';
  document.getElementById('fl-tracking-required').classList.toggle('hidden', !required);
}

// 单号从空变成非空时，如果当前状态还是"待邮寄"，自动切到"已邮寄"——但不锁死，
// 操作员发现要填异常件之类仍可手动改回去。只在"从无到有"这个瞬间触发一次，
// 不是每次改单号内容都触发（避免已经是"已邮寄"或"异常件"时被打扰）。
function handleTrackingAutoStatus() {
  const trackingInput = document.getElementById('fl-tracking');
  const statusSelect = document.getElementById('fl-status');
  const hadValue = trackingInput.dataset.hadValue === '1';
  const hasValue = trackingInput.value.trim() !== '';
  if (!hadValue && hasValue && statusSelect.value === 'pending-ship') {
    statusSelect.value = 'shipped';
    syncTrackingRequired();
    toast('已自动切换为「已邮寄」，如需要可手动改回其它状态', 'info', 3500);
  }
  trackingInput.dataset.hadValue = hasValue ? '1' : '0';
}

function openFillModal(id) {
  const r = getRow(id);
  if (!r) return;
  document.getElementById('fill-modal-title').textContent = r.status === 'pending-ship' ? '填写快递单号' : '编辑快递记录';
  document.getElementById('fl-id').value = r.id;
  document.getElementById('fl-name').value = r.name || '';
  document.getElementById('fl-phone').value = r.phone || '';
  fillManagerSelect(document.getElementById('fl-manager'), r.manager_id);
  document.getElementById('fl-category').value = r.category || 'cn';
  fillCourierSelect(r.category || 'cn', document.getElementById('fl-courier'), document.getElementById('fl-service'));
  document.getElementById('fl-courier').value = r.courier_id || '';
  fillServiceTypeSelect(r.courier_id, document.getElementById('fl-service'));
  document.getElementById('fl-service').value = r.service_type || '普通';
  document.getElementById('fl-address').value = r.address || '';
  document.getElementById('fl-status').value = r.status === 'shipped' ? 'shipped' : (r.status || 'pending-ship');
  const trackingInput = document.getElementById('fl-tracking');
  trackingInput.value = r.tracking_number || '';
  trackingInput.dataset.hadValue = trackingInput.value.trim() !== '' ? '1' : '0';
  document.getElementById('fl-note').value = r.note || '';
  document.getElementById('fl-internal-note').value = r.internal_note || '';
  OB.fillImages = [...(r.images || [])];
  OB.pendingImageDeletes = [];
  renderImagePreview(document.getElementById('fl-images-preview'), OB.fillImages, (idx) => removeImage(OB.fillImages, document.getElementById('fl-images-preview'), idx));
  updateImagesHint(OB.fillImages.length);
  syncTrackingRequired();
  document.getElementById('fill-modal').classList.remove('hidden');
}
function closeFillModal() {
  // 取消编辑：待删列表直接丢弃，不删物理文件——数据库里还引用着这些图，
  // 删了就跟上面 removeImage 的注释说的那个 bug 一样了。
  OB.pendingImageDeletes = [];
  document.getElementById('fill-modal').classList.add('hidden');
}

async function submitFill(e) {
  e.preventDefault();
  const id = document.getElementById('fl-id').value;
  const name = document.getElementById('fl-name').value.trim();
  const status = document.getElementById('fl-status').value;
  const tracking = document.getElementById('fl-tracking').value.trim();
  if (!name) { toast('姓名必填', 'err'); return; }
  if (status === 'shipped') {
    if (!tracking) { toast('已邮寄状态需要填写快递单号', 'err'); return; }
    if (tracking.length < 4 || tracking.length > 40) { toast('快递单号长度需为 4-40 字符', 'err'); return; }
    const duplicateCheck = await checkOutboundTrackingDuplicate(tracking.toUpperCase(), id);
    if (duplicateCheck.blocked) return;
    if (duplicateCheck.exists) {
      toast(duplicateTrackingMessage(tracking, duplicateCheck.data), 'err', 5200);
      return;
    }
  }

  const original = getRow(id);
  const wasPending = original?.status === 'pending-ship';
  const body = {
    name,
    phone: document.getElementById('fl-phone').value.trim(),
    manager_id: document.getElementById('fl-manager').value || null,
    category: document.getElementById('fl-category').value,
    courier_id: document.getElementById('fl-courier').value || null,
    service_type: document.getElementById('fl-service').value,
    tracking_number: tracking,
    address: document.getElementById('fl-address').value.trim(),
    status,
    note: document.getElementById('fl-note').value.trim(),
    internal_note: document.getElementById('fl-internal-note').value.trim(),
    images: OB.fillImages,
  };

  try {
    if (wasPending && status === 'shipped') {
      await Api.api('outbound', 'fill', { method: 'POST', params: { id }, body });
    } else {
      await Api.api('outbound', 'update', { method: 'POST', params: { id }, body });
    }
    // 保存成功了，数据库确认不再引用这些被移除的旧图，这时候删物理文件才安全。
    OB.pendingImageDeletes.forEach((p) => Api.deleteUploadedFile(p));
    OB.pendingImageDeletes = [];
    toast('已保存', 'ok');
    closeFillModal();

    const autoNext = document.getElementById('fl-auto-next').checked;
    if (autoNext && wasPending && status === 'shipped') {
      const next = OB.rows.find((x) => String(x.id) !== String(id) && x.status === 'pending-ship');
      await loadOutboundList();
      if (next) {
        setTimeout(() => openFillModal(next.id), 200);
        toast('已自动跳转下一条待邮寄记录', 'info');
      }
    } else {
      loadOutboundList();
    }
  } catch (e) { /* toast shown */ }
}

// ── 导出 CSV：可选列，记住上次选择（对齐 v5 exportOutbound 的字段集）────
const EXPORT_COLUMNS = [
  { key: 'created_at', label: '时间', get: (r) => fmtDate(r.created_at) },
  { key: 'name', label: '姓名', get: (r) => r.name || '' },
  { key: 'phone', label: '手机', get: (r) => r.phone || '' },
  { key: 'courier_name', label: '快递公司', get: (r) => r.courier_name || '' },
  { key: 'service_type', label: '服务类型', get: (r) => r.service_type || '' },
  { key: 'tracking_number', label: '快递单号', get: (r) => r.tracking_number || '' },
  { key: 'address', label: '地址', get: (r) => r.address || '' },
  { key: 'manager_name', label: '负责人', get: (r) => r.manager_name || '' },
  { key: 'status', label: '状态', get: (r) => OB_STATUS_LABEL[r.status] || r.status || '' },
  { key: 'note', label: '客户可见备注', get: (r) => (r.note || '').replace(/\r?\n/g, ' ') },
  { key: 'internal_note', label: '内部备注', get: (r) => (r.internal_note || '').replace(/\r?\n/g, ' ') },
];
const EXPORT_COLS_STORAGE_KEY = 'expv7-outbound-export-cols';

function loadExportColumnSelection() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPORT_COLS_STORAGE_KEY) || 'null');
    if (Array.isArray(saved) && saved.length) return new Set(saved);
  } catch (e) { /* ignore malformed storage */ }
  return new Set(EXPORT_COLUMNS.map((c) => c.key));
}

function openExportModal() {
  const selected = loadExportColumnSelection();
  const box = document.getElementById('export-columns');
  box.innerHTML = EXPORT_COLUMNS.map((c) => `
    <label class="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
      <input type="checkbox" data-export-col="${c.key}" class="rounded border-gray-300" ${selected.has(c.key) ? 'checked' : ''} />
      ${esc(c.label)}
    </label>`).join('');
  syncExportSelectAll();
  box.querySelectorAll('[data-export-col]').forEach((cb) => cb.addEventListener('change', syncExportSelectAll));

  document.getElementById('export-page-count').textContent = OB.rows.length;
  document.getElementById('export-selected-count').textContent = OB.selectedIds.size;
  const selectedRadio = document.getElementById('export-scope-selected');
  selectedRadio.disabled = OB.selectedIds.size === 0;
  if (OB.selectedIds.size === 0 && selectedRadio.checked) {
    document.getElementById('export-scope-filtered').checked = true;
  }
  syncExportLimitBox();

  document.getElementById('export-modal').classList.remove('hidden');
}
function closeExportModal() {
  document.getElementById('export-modal').classList.add('hidden');
}
function syncExportSelectAll() {
  const boxes = Array.from(document.querySelectorAll('#export-columns [data-export-col]'));
  document.getElementById('export-select-all').checked = boxes.length > 0 && boxes.every((b) => b.checked);
}
function syncExportLimitBox() {
  const scope = document.querySelector('input[name="export-scope"]:checked')?.value || 'filtered';
  document.getElementById('export-limit-box').classList.toggle('hidden', scope !== 'filtered');
}

async function confirmExportOutboundCsv() {
  const checked = Array.from(document.querySelectorAll('#export-columns [data-export-col]:checked')).map((cb) => cb.dataset.exportCol);
  if (!checked.length) { toast('请至少选择一列', 'err'); return; }
  const columns = EXPORT_COLUMNS.filter((c) => checked.includes(c.key));
  localStorage.setItem(EXPORT_COLS_STORAGE_KEY, JSON.stringify(checked));

  const scope = document.querySelector('input[name="export-scope"]:checked')?.value || 'filtered';

  try {
    let rows;
    if (scope === 'page') {
      rows = OB.rows;
    } else {
      const limitInput = parseInt(document.getElementById('export-limit').value, 10);
      const limit = scope === 'filtered' && limitInput > 0 ? Math.min(limitInput, 9999) : 9999;
      const data = await Api.api('outbound', 'list', { params: buildFilterParams({ export: 1, limit, page: 1 }) });
      rows = data.data || [];
      if (scope === 'selected') {
        rows = rows.filter((r) => OB.selectedIds.has(String(r.id)));
      }
    }

    if (!rows.length) { toast('没有可导出的记录', 'err'); return; }

    const lines = [columns.map((c) => c.label).map(csvCell).join(',')];
    rows.forEach((r) => {
      lines.push(columns.map((c) => csvCell(c.get(r))).join(','));
    });
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `快递管理_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    closeExportModal();
    toast(`已导出 ${rows.length} 条记录`, 'ok');
  } catch (e) { /* toast shown */ }
}
function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function setStatusFilter(status) {
  OB.status = status;
  document.querySelectorAll('.ob-status-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.status || '') === status);
  });
}

async function initOutbound() {
  document.getElementById('btn-export').classList.toggle('hidden', !hasPerm('parcels:export'));

  try {
    const [couriersData, managersData] = await Promise.all([
      Api.api('couriers', 'list'),
      Api.api('managers', 'dropdown'),
    ]);
    OB.couriers = couriersData.data || [];
    OB.managers = managersData.data || [];
  } catch (e) { /* toast shown */ }

  fillCourierFilterSelect(document.getElementById('f-courier'));
  fillManagerSelect(document.getElementById('fl-manager'));
  fillCourierSelect('cn', document.getElementById('fl-courier'), document.getElementById('fl-service'));

  document.getElementById('fl-category').addEventListener('change', function () {
    fillCourierSelect(this.value, document.getElementById('fl-courier'), document.getElementById('fl-service'));
  });
  document.getElementById('fl-courier').addEventListener('change', function () {
    fillServiceTypeSelect(this.value, document.getElementById('fl-service'));
  });
  document.getElementById('fl-status').addEventListener('change', syncTrackingRequired);
  document.getElementById('fl-tracking').addEventListener('input', handleTrackingAutoStatus);

  document.querySelectorAll('.ob-status-btn').forEach((btn) => {
    btn.addEventListener('click', () => { setStatusFilter(btn.dataset.status || ''); OB.page = 1; loadOutboundList(); });
  });

  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('status')) setStatusFilter(urlParams.get('status'));

  document.getElementById('fill-form').addEventListener('submit', submitFill);
  document.getElementById('fl-images-input').addEventListener('change', (e) => {
    handleImageFiles(e.target.files, OB.fillImages, document.getElementById('fl-images-preview'), 'fl-tracking');
    e.target.value = '';
  });
  document.getElementById('fl-btn-camera').addEventListener('click', () => {
    const courierName = document.getElementById('fl-courier')?.selectedOptions?.[0]?.textContent || '';
    CameraCapture.open((file, recognizedText, reportStatus, recognitionComplete) => {
      if (file) return handleImageFiles([file], OB.fillImages, document.getElementById('fl-images-preview'), 'fl-tracking', recognizedText, reportStatus, recognitionComplete);
      return null;
    }, { mode: 'image-upload', title: '拍摄面单 / 包裹图片', courierName });
  });
  const flDropzone = document.getElementById('fl-images-dropzone');
  flDropzone.addEventListener('click', () => document.getElementById('fl-images-input').click());
  ['dragover', 'dragenter'].forEach((ev) => flDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    flDropzone.classList.add('border-purple-400', 'text-purple-500');
  }));
  ['dragleave', 'drop'].forEach((ev) => flDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    flDropzone.classList.remove('border-purple-400', 'text-purple-500');
  }));
  flDropzone.addEventListener('drop', (e) => handleImageFiles(e.dataTransfer.files, OB.fillImages, document.getElementById('fl-images-preview'), 'fl-tracking'));
  document.querySelectorAll('[data-close-fill]').forEach((el) => el.addEventListener('click', closeFillModal));

  const rowScanDropzone = document.getElementById('row-scan-dropzone');
  rowScanDropzone.addEventListener('click', () => document.getElementById('row-scan-file-input').click());
  ['dragover', 'dragenter'].forEach((ev) => rowScanDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    rowScanDropzone.classList.add('border-purple-400', 'text-purple-500');
  }));
  ['dragleave', 'drop'].forEach((ev) => rowScanDropzone.addEventListener(ev, (e) => {
    e.preventDefault(); e.stopPropagation();
    rowScanDropzone.classList.remove('border-purple-400', 'text-purple-500');
  }));
  rowScanDropzone.addEventListener('drop', (e) => processRowScanFile(e.dataTransfer.files[0]));
  document.getElementById('row-scan-file-input').addEventListener('change', (e) => processRowScanFile(e.target.files[0]));
  document.getElementById('row-scan-btn-camera').addEventListener('click', () => {
    // 只隐藏面板，不清空 ROW_SCAN_ID——摄像头拍完之后 processRowScanFile 还要用它
    document.getElementById('row-scan-modal').classList.add('hidden');
    const row = getRow(ROW_SCAN_ID);
    const courierName = row?.courier_name || getCourierForRow(row)?.name || '';
    CameraCapture.open(
      (file, recognizedText, reportStatus) => processRowScanFile(file, recognizedText, reportStatus),
      {
        mode: 'row-tracking-scan',
        title: '扫码识别单号',
        courierName,
        onCancel: () => {
          if (ROW_SCAN_ID) document.getElementById('row-scan-modal').classList.remove('hidden');
        },
      }
    );
  });
  document.querySelectorAll('[data-close-row-scan]').forEach((el) => el.addEventListener('click', closeRowScanModal));

  document.getElementById('btn-search').addEventListener('click', () => { OB.page = 1; loadOutboundList(); });
  setupDateFilterMode('f-date-mode', 'f-date-single', 'f-date-start', 'f-date-end', () => {
    OB.page = 1;
    loadOutboundList();
  });

  document.getElementById('btn-reset').addEventListener('click', () => {
    document.getElementById('f-q').value = '';
    document.getElementById('f-courier').value = '';
    resetDateFilter();
    setStatusFilter('');
    OB.page = 1;
    loadOutboundList();
  });
  document.getElementById('f-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { OB.page = 1; loadOutboundList(); } });
  document.getElementById('ob-limit').addEventListener('change', (e) => { OB.limit = parseInt(e.target.value, 10); OB.page = 1; loadOutboundList(); });

  document.getElementById('btn-export').addEventListener('click', openExportModal);
  document.getElementById('btn-confirm-export').addEventListener('click', confirmExportOutboundCsv);
  document.getElementById('export-select-all').addEventListener('change', (e) => {
    document.querySelectorAll('#export-columns [data-export-col]').forEach((cb) => { cb.checked = e.target.checked; });
  });
  document.querySelectorAll('input[name="export-scope"]').forEach((r) => r.addEventListener('change', syncExportLimitBox));
  document.querySelectorAll('[data-close-export]').forEach((el) => el.addEventListener('click', closeExportModal));

  document.getElementById('ob-select-all-page').addEventListener('change', (e) => toggleSelectAllPage(e.target.checked));
  document.getElementById('ob-clear-selection').addEventListener('click', clearSelection);

  if (hasPerm('parcels:edit')) {
    document.getElementById('ob-batch-status-wrap').classList.remove('hidden');
    document.getElementById('ob-batch-status-btn').addEventListener('click', batchUpdateStatus);
  }
  if (hasPerm('parcels:delete')) {
    document.getElementById('ob-batch-delete-btn').classList.remove('hidden');
    document.getElementById('ob-batch-delete-btn').addEventListener('click', batchDeleteSelected);
  }

  loadOutboundList();
}
