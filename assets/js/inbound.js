/* expv7 — 新增入库单页面逻辑（仅负责新增，列表/筛选见「快递管理」页） */
const IB = {
  couriers: [],
  managers: [],
  createImages: [],
};

// ── 智能解析（本地地址库，逻辑与 v5 admin-app.js 保持一致）───────
function cleanParsedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}
function joinAddressParts(parts) {
  const out = [];
  parts.map(cleanParsedText).filter(Boolean).forEach((part) => { if (!out.includes(part)) out.push(part); });
  return out.join('');
}
function trimAddressBusinessTail(value) {
  const text = cleanParsedText(value);
  if (!text) return '';
  const match = text.match(/(快递数量|快递数|包裹数量|负责人|卡张数|天数|客户备注|内部备注|备注|快递公司|服务类型|快递单号|物流单号|单号|物流|通知|(?:普通|特快|顺丰|EMS|圆通|中通|申通|韵达|极兔|京东|德邦|邮政)\s*\d+)/u);
  if (!match || match.index < 4) return text;
  return text.slice(0, match.index).replace(/[，,、;；:+＋\s]+$/u, '').trim();
}
function parseChineseAddress(text) {
  const parser = window.ZhAddressParse || (window.exports && window.exports.ZhAddressParse);
  if (!text || typeof parser !== 'function') return {};
  try {
    const parsed = parser(text, {
      type: 0,
      textFilter: ['邮寄地址', '收货地址', '收件地址', '详细地址', '地址', '邮寄', '姓名', '收货人', '收件人', '联系人', '电话', '手机', '手机号', '联系电话'],
      nameMaxLength: 4,
    }) || {};
    const detail = trimAddressBusinessTail(parsed.detail);
    const address = trimAddressBusinessTail(joinAddressParts([parsed.province, parsed.city, parsed.area, detail]));
    return { name: cleanParsedText(parsed.name), phone: cleanParsedText(parsed.phone), address };
  } catch (err) {
    console.warn('zh-address-parse failed:', err);
    return {};
  }
}
function hasExplicitCustomerName(text) {
  return /(姓名|收件人|收货人|联系人)\s*[：:\s]/u.test(text || '');
}
function isLikelyAddressNameGuess(name, text, zh) {
  const value = cleanParsedText(name);
  if (!value || hasExplicitCustomerName(text)) return false;
  if (zh?.address && zh.address.includes(value)) return true;
  return /(省|市|区|县|镇|乡|村|路|街|号|园|府|苑|快递|数量|普通|特快|顺丰|负责人|通讯社)/u.test(value);
}
// 本地地址库找不到真实地址时会瞎猜，把整段原文（含"快递数量""负责人"这类我们自己的标签词、
// 韩文、emoji）都当成地址吐出来。这种猜测比空着更糟——加一层粗过滤，命中就当它没猜出来。
function isLikelyGarbageAddress(addr) {
  if (!addr) return false;
  if (/(快递数量|负责人|通讯社|卡张数|天数)/u.test(addr)) return true;
  if (/[가-힣]/u.test(addr)) return true; // 韩文（谚文）
  if (/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(addr)) return true; // 常见 emoji 区段
  return false;
}
function mergeSmartParseResult(serverResult, text) {
  const zh = parseChineseAddress(text);
  const serverName = cleanParsedText(serverResult?.name);
  const zhAddress = isLikelyGarbageAddress(zh.address) ? '' : zh.address;
  return {
    ...(serverResult || {}),
    name: zh.name || (isLikelyAddressNameGuess(serverName, text, zh) ? '' : serverName),
    phone: zh.phone || serverResult?.phone || '',
    address: zhAddress || serverResult?.address || '',
  };
}

// ── 快递商 / 负责人下拉 ───────────────────────────────────────
function fillCourierSelect(cat, courierSel, serviceSel) {
  courierSel.innerHTML = '<option value="">未指定</option>';
  IB.couriers.filter((c) => c.category === cat).forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.id; opt.textContent = c.name;
    courierSel.appendChild(opt);
  });
  fillServiceTypeSelect('', serviceSel);
}
function fillServiceTypeSelect(courierId, serviceSel) {
  serviceSel.innerHTML = '';
  const courier = IB.couriers.find((c) => String(c.id) === String(courierId));
  const types = courier?.service_types?.length ? courier.service_types : ['普通'];
  types.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t; opt.textContent = t;
    if (t === '普通') opt.selected = true;
    serviceSel.appendChild(opt);
  });
}
function setupCategoryCascade(catEl, courierEl, serviceEl) {
  catEl.addEventListener('change', () => fillCourierSelect(catEl.value, courierEl, serviceEl));
  courierEl.addEventListener('change', () => fillServiceTypeSelect(courierEl.value, serviceEl));
}
function fillManagerSelect(selectEl, selectedId) {
  if (!selectEl) return;
  selectEl.innerHTML = '<option value="">未指定</option>';
  IB.managers.forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m.id; opt.textContent = m.username;
    if (String(m.id) === String(selectedId)) opt.selected = true;
    selectEl.appendChild(opt);
  });
}

// 新增入库单默认负责人为自己；数据范围为「仅自己」时锁定，不能指派给别人
// （对应后端 api/inbound.php 的 manager_allowed_in_inbound_scope，与快递管理页的范围校验同一套逻辑）
function applyManagerScopeDefault() {
  const selectEl = document.getElementById('ib-manager');
  const hint = document.getElementById('ib-manager-lock-hint');
  const user = window.__user;
  if (!selectEl || !user) return;
  const isPrivileged = user.role === 'admin' || (user.perms || []).includes('*');
  const scope = user.data_scopes?.inbound || 'global';

  if (!isPrivileged && scope === 'self') {
    const me = IB.managers.find((m) => String(m.id) === String(user.uid));
    selectEl.innerHTML = `<option value="${user.uid}" selected>${esc(me?.username || user.username)}</option>`;
    selectEl.disabled = true;
    hint?.classList.remove('hidden');
  } else {
    selectEl.disabled = false;
    hint?.classList.add('hidden');
    if (!isPrivileged && scope !== 'global') {
      selectEl.value = String(user.uid); // 本团队范围：默认自己，仍可改选团队内其他人
    }
  }
}

// ── 图片上传预览 ─────────────────────────────────────────────
function renderImagePreview(container, images, onRemove) {
  container.innerHTML = images.map((path, idx) => `
    <div class="relative group">
      <img src="${esc(path)}" class="img-thumb cursor-zoom-in" data-lightbox-src="${esc(path)}" />
      <button type="button" data-idx="${idx}" class="img-remove">×</button>
    </div>`).join('');
  container.querySelectorAll('[data-lightbox-src]').forEach((img) => img.addEventListener('click', () => Lightbox.open(img.dataset.lightboxSrc)));
  container.querySelectorAll('.img-remove').forEach((btn) => {
    btn.addEventListener('click', () => onRemove(parseInt(btn.dataset.idx, 10)));
  });
}
function updateImagesHint(count) {
  const hint = document.getElementById('ib-images-hint');
  if (hint) hint.textContent = count > 0 ? `已选择 ${count} 张` : '未选择文件';
}
// 移除的图片同时删掉服务器上的文件，不留孤儿文件（跟回收站彻底删除时的清理逻辑一致）。
function removeImage(targetArr, previewEl, idx) {
  const [removedPath] = targetArr.splice(idx, 1);
  renderImagePreview(previewEl, targetArr, (i) => removeImage(targetArr, previewEl, i));
  updateImagesHint(targetArr.length);
  if (removedPath) Api.deleteUploadedFile(removedPath);
}

function duplicateTrackingMessage(tracking, duplicate) {
  const courier = duplicate?.courier_name || '未指定快递公司';
  return `单号 ${tracking} 已经录入（${courier}），请勿重复录入`;
}

async function checkInboundTrackingDuplicate(tracking) {
  try {
    return await Api.api('inbound', 'check_tracking', { params: { tracking } });
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
      const courierName = document.getElementById('ib-courier')?.selectedOptions?.[0]?.textContent || '';
      const candidates = await BarcodeScan.decodeFileCandidates(file, { courierName });
      if (!candidates.length) continue;
      scannedText = await BarcodeScan.chooseCandidate(candidates);
      // 已经检测到候选时，无论用户选择还是取消，都不再用下一张图片覆盖这次决定。
      break;
    }
  }

  for (const file of list) {
    reportStatus?.('正在上传面单 / 包裹图片…', 'info');
    try { targetArr.push(await Api.uploadFile(file)); } catch (e) { /* toast already shown */ }
  }
  renderImagePreview(previewEl, targetArr, (idx) => removeImage(targetArr, previewEl, idx));
  updateImagesHint(targetArr.length);

  if (scannedText && trackingInput) {
    reportStatus?.('已识别单号，正在检查是否重复…', 'info');
    const duplicateCheck = await checkInboundTrackingDuplicate(scannedText.trim().toUpperCase());
    if (duplicateCheck.blocked) scannedText = null;
    if (duplicateCheck.exists) {
      toast(duplicateTrackingMessage(scannedText, duplicateCheck.data), 'err', 5200);
      scannedText = null;
    }
  }

  if (scannedText && trackingInput) {
    const prev = trackingInput.value.trim();
    trackingInput.value = scannedText.trim().toUpperCase();
    toast(prev && prev !== scannedText.trim().toUpperCase()
      ? `已从图片识别单号，原单号 ${prev} 已替换为 ${scannedText}`
      : '已从图片自动识别单号：' + scannedText, 'ok');
    reportStatus?.(`识别成功：${scannedText}，图片已添加`, 'ok');
  } else {
    reportStatus?.('图片已添加；未识别到可用的新单号', 'warn');
  }
}

// ── 新增表单 ────────────────────────────────────────────────
function resetCreateForm() {
  document.getElementById('ib-form').reset();
  IB.createImages = [];
  renderImagePreview(document.getElementById('ib-images-preview'), IB.createImages, (idx) => removeImage(IB.createImages, document.getElementById('ib-images-preview'), idx));
  updateImagesHint(0);
  fillCourierSelect(document.getElementById('ib-category').value, document.getElementById('ib-courier'), document.getElementById('ib-service'));
  applyManagerScopeDefault();
}

async function submitCreate(e) {
  e.preventDefault();
  const name = document.getElementById('ib-name').value.trim();
  if (!name) { toast('姓名必填', 'err'); return; }
  const body = {
    name,
    phone: document.getElementById('ib-phone').value.trim(),
    manager_id: document.getElementById('ib-manager').value || null,
    category: document.getElementById('ib-category').value,
    courier_id: document.getElementById('ib-courier').value || null,
    service_type: document.getElementById('ib-service').value,
    tracking_number: document.getElementById('ib-tracking').value.trim(),
    address: document.getElementById('ib-address').value.trim(),
    note: document.getElementById('ib-note').value.trim(),
    internal_note: document.getElementById('ib-internal-note').value.trim(),
    images: IB.createImages,
  };
  try {
    await Api.api('inbound', 'create', { method: 'POST', body });
    toast('入库成功，可在「快递管理」中继续处理', 'ok');
    resetCreateForm();
  } catch (e) { /* toast shown */ }
}

// 一次粘贴多条记录时（客服常见操作：把当天所有订单一起复制），逐字段解析会把不同客户的
// 姓名/地址/电话拼到一起，比如把 A 的姓名配上 B 的地址——这是不可靠的，与其瞎猜，不如
// 只识别第一条并明确提示，其余请分别粘贴解析。按空行分块，≥2 个分块各自都带手机号才判定为多条。
function splitMultiRecordText(text) {
  const blocks = text.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length <= 1) return { text, blockCount: 1 };
  const phoneRe = /1[3-9]\d{9}/;
  const blocksWithPhone = blocks.filter((b) => phoneRe.test(b));
  if (blocksWithPhone.length >= 2) {
    return { text: blocks[0], blockCount: blocks.length };
  }
  return { text, blockCount: 1 };
}

async function runSmartParse() {
  const rawText = document.getElementById('parse-text').value.trim();
  if (!rawText) { toast('请粘贴文本', 'err'); return; }
  const { text, blockCount } = splitMultiRecordText(rawText);
  if (blockCount > 1) {
    toast(`检测到粘贴内容里像是有 ${blockCount} 条不同记录，只识别了第一条，其余请分别粘贴解析`, 'info', 5000);
  }
  let serverResult = {};
  let usedLocalFallback = false;
  try {
    // 服务器解析失败时还会继续走本地地址库，不能让共享请求层先弹一个红色
    // “网络异常”，随后又弹绿色“识别成功”，否则用户会以为结果不可信。
    const data = await Api.api('inbound', 'parse', {
      method: 'POST',
      body: { text },
      suppressErrorToast: true,
    });
    serverResult = data.data || {};
  } catch (e) {
    usedLocalFallback = true;
    console.warn('服务器智能解析不可用，已切换到本地识别：', e);
  }
  const merged = mergeSmartParseResult(serverResult, text);

  if (merged.name) document.getElementById('ib-name').value = merged.name;
  if (merged.phone) document.getElementById('ib-phone').value = merged.phone;
  if (merged.address) document.getElementById('ib-address').value = merged.address;

  // 数据范围是"仅自己"的账号，负责人下拉是锁死显示自己的——但那只是 disabled，
  // 挡不住 JS 直接改 .value。之前这里不管数据范围，只要粘贴文本里识别出"负责人：
  // 某某"就会把负责人换成别人，提交时又会被后端 manager_allowed_in_inbound_scope
  // 正确拦下来（这本身没错，是权限校验在起作用），但用户自己根本没手动选人，
  // 只看到一个不明所以的"MANAGER_OUT_OF_SCOPE"报错。"仅自己"范围下直接不采信
  // 解析出来的负责人，永远维持锁定成自己，跟下拉框显示的状态保持一致。
  const user = window.__user;
  const isPrivileged = user && (user.role === 'admin' || (user.perms || []).includes('*'));
  const isSelfScoped = user && !isPrivileged && (user.data_scopes?.inbound || 'global') === 'self';
  if (!isSelfScoped) {
    if (serverResult.manager_id) {
      document.getElementById('ib-manager').value = serverResult.manager_id;
    } else if (serverResult.manager_name) {
      const m = IB.managers.find((mm) => mm.username === serverResult.manager_name);
      if (m) document.getElementById('ib-manager').value = m.id;
    }
  }
  // 分类必须先按识别出的快递商来定，否则快递商下拉会按旧分类重建，
  // 识别到的 courier_id 在列表里找不到，赋值静默失效（例如识别出韩国快递商但分类还停在"国内"）。
  let detectedCategory = serverResult.category || '';
  if (!detectedCategory && serverResult.courier_id) {
    const detectedCourier = IB.couriers.find((c) => String(c.id) === String(serverResult.courier_id));
    if (detectedCourier) detectedCategory = detectedCourier.category;
  }
  if (detectedCategory) document.getElementById('ib-category').value = detectedCategory;
  fillCourierSelect(document.getElementById('ib-category').value, document.getElementById('ib-courier'), document.getElementById('ib-service'));
  if (serverResult.courier_id) document.getElementById('ib-courier').value = serverResult.courier_id;
  fillServiceTypeSelect(document.getElementById('ib-courier').value, document.getElementById('ib-service'));
  if (serverResult.service_type) document.getElementById('ib-service').value = serverResult.service_type;

  // 内部备注保留完整原始粘贴内容（即使多条记录只识别了第一条，后面几条的原文仍留档可查）。
  const internalNote = document.getElementById('ib-internal-note');
  internalNote.value = internalNote.value ? internalNote.value + '\n' + rawText : rawText;
  const filledCount = [merged.name, merged.phone, merged.address].filter(Boolean).length;
  if (usedLocalFallback && filledCount > 0) {
    toast('服务器解析暂不可用，已使用本地识别填充表单，请核对后提交', 'info', 4200);
  } else if (usedLocalFallback) {
    toast('服务器解析暂不可用，本地也未识别出姓名、电话或地址，请手动填写', 'err', 5000);
  } else {
    toast('已识别并填充表单，请核对后提交', 'ok');
  }
}

// ── 初始化 ──────────────────────────────────────────────────
async function initInbound() {
  document.getElementById('parse-card').classList.toggle('hidden', !hasPerm('inbound:parse'));
  document.getElementById('create-card').classList.toggle('hidden', !hasPerm('inbound:create'));

  try {
    const [couriersData, managersData] = await Promise.all([
      Api.api('couriers', 'list'),
      Api.api('managers', 'dropdown'),
    ]);
    IB.couriers = couriersData.data || [];
    IB.managers = managersData.data || [];
  } catch (e) { /* toast shown */ }

  fillManagerSelect(document.getElementById('ib-manager'));
  applyManagerScopeDefault();
  fillCourierSelect('cn', document.getElementById('ib-courier'), document.getElementById('ib-service'));
  setupCategoryCascade(document.getElementById('ib-category'), document.getElementById('ib-courier'), document.getElementById('ib-service'));

  document.getElementById('btn-parse')?.addEventListener('click', runSmartParse);
  document.getElementById('ib-form')?.addEventListener('submit', submitCreate);
  document.getElementById('ib-images-input')?.addEventListener('change', (e) => {
    handleImageFiles(e.target.files, IB.createImages, document.getElementById('ib-images-preview'), 'ib-tracking');
    e.target.value = '';
  });
  document.getElementById('ib-btn-camera')?.addEventListener('click', () => {
    const courierName = document.getElementById('ib-courier')?.selectedOptions?.[0]?.textContent || '';
    CameraCapture.open((file, recognizedText, reportStatus, recognitionComplete) => {
      if (file) return handleImageFiles([file], IB.createImages, document.getElementById('ib-images-preview'), 'ib-tracking', recognizedText, reportStatus, recognitionComplete);
      return null;
    }, { mode: 'image-upload', title: '拍摄面单 / 包裹图片', courierName });
  });
  const ibDropzone = document.getElementById('ib-images-dropzone');
  if (ibDropzone) {
    ibDropzone.addEventListener('click', () => document.getElementById('ib-images-input').click());
    ['dragover', 'dragenter'].forEach((ev) => ibDropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      ibDropzone.classList.add('border-purple-400', 'text-purple-500');
    }));
    ['dragleave', 'drop'].forEach((ev) => ibDropzone.addEventListener(ev, (e) => {
      e.preventDefault(); e.stopPropagation();
      ibDropzone.classList.remove('border-purple-400', 'text-purple-500');
    }));
    ibDropzone.addEventListener('drop', (e) => handleImageFiles(e.dataTransfer.files, IB.createImages, document.getElementById('ib-images-preview'), 'ib-tracking'));
  }
}
