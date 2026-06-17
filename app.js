// =============================================
// 獨品工坊開單系統 — 前端主程式
// =============================================

// ⚠️  部署 Apps Script 後，把網址貼到這裡
const API_URL = 'https://script.google.com/macros/s/AKfycbxzHdJMopMPPYvozDfrnRq3BUtcEg0QaCcVWlQEnrkPh0txbJim-JU3-FR4X0A7VTmglA/exec';

// ── PWA 註冊 ────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(reg => reg.update())
    .catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
}

// ── 狀態 ────────────────────────────────────
let state = {
  view: 'orders',
  items: [],          // 工作項目（扁平，單一表）
  customers: [],
  workers: [],
  settings: {},
  viewCustomer: null, // 目前查看的客戶名稱
  viewSection: null,  // 從哪個區塊進入（active/done/invoiced/paid）
  editCustomer: null,
  loading: false,
  search: '',
};

// ── API 呼叫 ─────────────────────────────────
const API_SECRET = 'dupin2026';
async function api(action, sheet, extra = {}) {
  const payload = { action, sheet, secret: API_SECRET, ...extra };
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    showToast('網路錯誤，請確認 API_URL 已設定', 'error');
    return { error: e.message };
  }
}

// ── 離線偵測 ────────────────────────────────
window.addEventListener('online',  () => showToast('網路已恢復 ✓'));
window.addEventListener('offline', () => showToast('目前離線，操作可能不會儲存', 'error'));

const CACHE_KEY = 'dupin_cache_v2';

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      items: state.items,
      customers: state.customers,
      settings: state.settings,
      ts: Date.now(),
    }));
  } catch(e) {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const cache = JSON.parse(raw);
    state.items     = cache.items     || [];
    state.customers = cache.customers || [];
    state.settings  = cache.settings  || {};
    return true;
  } catch(e) { return false; }
}

async function loadAll() {
  const hasCached = loadCache();
  if (hasCached) {
    showLoading(false);
    render();
  } else {
    showLoading(true);
  }

  const [wi, c, s, w] = await Promise.all([
    api('getAll', '工作項目'),
    api('getAll', '客戶'),
    api('getSettings'),
    api('getAll', '施工人員'),
  ]);
  if (wi.data) state.items     = wi.data.map(normalizeItem);
  if (c.data)  state.customers = c.data;
  if (s.data)  state.settings  = s.data;
  if (w.data)  state.workers   = w.data.map(r => Object.values(r)[0] || '').filter(Boolean);
  saveCache();
  showLoading(false);
  render();
}

function normalizeItem(it) {
  const qty   = Number(it['數量']) || 0;
  const price = Number(it['單價']) || 0;
  return {
    ...it,
    數量:       qty,
    單價:       price,
    金額:       qty * price || Number(it['金額']) || 0,
    開單日期:   formatDate(it['開單日期']),
    交貨期限:   formatDate(it['交貨期限']),
    完工日期:   formatDate(it['完工日期']),
    進度:       it['進度']       || '待施工',
    收款狀態:   it['收款狀態']   || '未收款',
    請款單狀態: it['請款單狀態'] || '',
  };
}

function formatDate(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return d.toISOString().slice(0, 10);
}

// ── 導覽 ────────────────────────────────────
function showView(view, data = null) {
  state.view = view;
  if (view === 'customerDetail' && data !== null) state.viewCustomer = data;
  if (view === 'editCustomer'   && data !== null) state.editCustomer = data;
  render();
}

function goBack() {
  const back = {
    customerDetail: 'orders',
    newOrder:       'orders',
    editCustomer:   'customers',
  };
  showView(back[state.view] || 'orders');
}

// ── 渲染主控制 ──────────────────────────────
function render() {
  const app     = document.getElementById('app');
  const title   = document.getElementById('pageTitle');
  const back    = document.getElementById('backBtn');
  const actions = document.getElementById('headerActions');

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('text-amber-400', btn.dataset.view === state.view);
    btn.classList.toggle('text-gray-400',  btn.dataset.view !== state.view);
  });

  switch (state.view) {
    case 'orders':
      title.textContent = '獨品工坊';
      back.classList.add('hidden');
      actions.innerHTML = '';
      app.innerHTML = renderOrders();
      break;
    case 'customerDetail': {
      const sectionLabel = { active:'進行中', done:'完工交貨', invoiced:'已開請款單', paid:'已交貨收款' };
      const secTag = state.viewSection ? ` · ${sectionLabel[state.viewSection]||''}` : '';
      title.textContent = (state.viewCustomer || '工作項目') + secTag;
      back.classList.remove('hidden');
      actions.innerHTML = `<button class="btn btn-ghost text-sm" onclick="showView('newOrder')">＋ 新增</button>`;
      app.innerHTML = renderCustomerDetail();
      break;
    }
    case 'newOrder':
      title.textContent = '新增工作';
      back.classList.remove('hidden');
      actions.innerHTML = '';
      app.innerHTML = renderNewOrder();
      break;
    case 'customers':
      title.textContent = '客戶管理';
      back.classList.add('hidden');
      actions.innerHTML = `<button class="btn btn-primary text-sm" onclick="showView('editCustomer',null)">+ 新增</button>`;
      app.innerHTML = renderCustomers();
      break;
    case 'editCustomer':
      title.textContent = state.editCustomer ? '編輯客戶' : '新增客戶';
      back.classList.remove('hidden');
      actions.innerHTML = '';
      app.innerHTML = renderCustomerForm();
      break;
    case 'stats':
      title.textContent = '業績統計';
      back.classList.add('hidden');
      actions.innerHTML = '';
      app.innerHTML = renderStats();
      break;
  }
}

// ── 訂單列表（四摺疊區塊）──────────────────
const sectionOpen = { active: true, done: false, invoiced: false, paid: false };

function toggleSection(key) {
  sectionOpen[key] = !sectionOpen[key];
  const el    = document.getElementById('section-' + key);
  const arrow = document.getElementById('arrow-' + key);
  if (el)    el.style.display  = sectionOpen[key] ? '' : 'none';
  if (arrow) arrow.textContent = sectionOpen[key] ? '▲' : '▼';
}

function renderOrders() {
  return `
  <div class="relative mb-3">
    <input type="search" placeholder="搜尋客戶、品名、車號…"
      value="${state.search}"
      oninput="state.search=this.value;document.getElementById('orderListContent').innerHTML=renderOrdersContent()"
      class="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500"/>
    <span class="absolute left-3 top-2.5 text-gray-500 text-sm"></span>
  </div>
  <div id="orderListContent">${renderOrdersContent()}</div>`;
}

function renderOrdersContent() {
  const q = state.search.toLowerCase();
  const matchItem = it => !q ||
    (it['客戶']    ||'').toLowerCase().includes(q) ||
    (it['品名']    ||'').toLowerCase().includes(q) ||
    (it['車號']    ||'').toLowerCase().includes(q) ||
    (it['訂單編號']||'').toLowerCase().includes(q);

  // 四類
  const activeItems   = state.items.filter(it => it['進度'] !== '完成' && matchItem(it));
  const doneItems     = state.items.filter(it => it['進度'] === '完成' && !it['請款單狀態'] && it['收款狀態'] !== '已收款' && matchItem(it));
  const invoicedItems = state.items.filter(it => it['進度'] === '完成' && it['請款單狀態'] === '已開單' && it['收款狀態'] !== '已收款' && matchItem(it));
  const paidItems     = state.items.filter(it => it['收款狀態'] === '已收款' && matchItem(it));

  // 依交貨期限排序進行中
  activeItems.sort((a, b) => {
    const da = a['交貨期限'] ? new Date(a['交貨期限']) : new Date('9999-12-31');
    const db = b['交貨期限'] ? new Date(b['交貨期限']) : new Date('9999-12-31');
    return da - db;
  });

  const groupByCustomer = items => {
    const map = {};
    items.forEach(it => {
      const c = it['客戶'] || '(未知客戶)';
      if (!map[c]) map[c] = [];
      map[c].push(it);
    });
    return Object.entries(map);
  };

  const progColor = { '待施工': 'bg-gray-600', '施工中': 'bg-blue-600', '完成': 'bg-green-600' };

  const customerCard = (customer, items, section) => {
    const total  = items.reduce((s, it) => s + Number(it['金額'] || 0), 0);
    const badges = items.slice(0, 8).map(it => `
      <span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-200">
        ${it['品名'] || '-'}
        <span class="w-1.5 h-1.5 rounded-full ${progColor[it['進度']] || 'bg-gray-500'}"></span>
      </span>`).join('');
    const more = items.length > 8 ? `<span class="text-xs text-gray-500">+${items.length - 8}</span>` : '';

    return `
    <div class="card cursor-pointer" onclick="openCustomer('${customer.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}','${section}')">
      <div class="flex justify-between items-start mb-0.5">
        <span class="text-lg font-bold">${customer}</span>
        <span class="text-amber-400 font-bold text-lg">$${total.toLocaleString()}</span>
      </div>
      <div class="flex flex-wrap gap-1 mb-1">${badges}${more}</div>
    </div>`;
  };

  const sectionHeader = (label, count, key) => `
    <div class="flex justify-between items-center cursor-pointer py-2 mt-2" onclick="toggleSection('${key}')">
      <span class="section-title mb-0">${label}（${count}）</span>
      <span id="arrow-${key}" class="text-gray-400 text-lg">${sectionOpen[key] ? '▲' : '▼'}</span>
    </div>`;

  const sectionBody = (items, key, emptyMsg, section) => {
    const groups = groupByCustomer(items);
    return `
    <div id="section-${key}" style="display:${sectionOpen[key] ? '' : 'none'}">
      ${groups.length
        ? groups.map(([c, its]) => customerCard(c, its, section)).join('')
        : `<p class="text-gray-500 text-sm mb-4">${emptyMsg}</p>`}
    </div>`;
  };

  return `
  ${sectionHeader('進行中', activeItems.length, 'active')}
  ${sectionBody(activeItems, 'active', '暫無進行中工作', 'active')}

  ${sectionHeader('完工交貨（未開請款單）', doneItems.length, 'done')}
  ${sectionBody(doneItems, 'done', '暫無待開請款單工作', 'done')}

  ${sectionHeader('已開請款單（未收款）', invoicedItems.length, 'invoiced')}
  ${sectionBody(invoicedItems, 'invoiced', '暫無已開請款單工作', 'invoiced')}

  ${sectionHeader('已交貨收款', paidItems.length, 'paid')}
  ${sectionBody(paidItems, 'paid', '暫無已收款工作', 'paid')}`;
}

function openCustomer(name, section) {
  state.viewSection = section || null;
  showView('customerDetail', name);
}

// ── 客戶詳細（工作項目列表）────────────────
function renderCustomerDetail() {
  const name    = state.viewCustomer;
  const section = state.viewSection;

  // 依進入的區塊篩選品項
  const sectionFilter = {
    active:   it => it['進度'] !== '完成',
    done:     it => it['進度'] === '完成' && !it['請款單狀態'] && it['收款狀態'] !== '已收款',
    invoiced: it => it['進度'] === '完成' && it['請款單狀態'] === '已開單' && it['收款狀態'] !== '已收款',
    paid:     it => it['收款狀態'] === '已收款',
  };
  const filterFn = section && sectionFilter[section] ? sectionFilter[section] : () => true;
  const its = state.items.filter(it => it['客戶'] === name && filterFn(it));
  const subtotal = its.reduce((s, it) => s + Number(it['金額'] || 0), 0);

  const progColor = { '待施工': 'bg-gray-600', '施工中': 'bg-blue-600', '完成': 'bg-green-600' };

  const sorted = [...its].sort((a, b) => {
    // 完工區塊：按完工日期新到舊；其他：按開單日期新到舊
    if (state.viewSection === 'done' || state.viewSection === 'invoiced' || state.viewSection === 'paid') {
      const da = a['完工日期'] ? new Date(a['完工日期']) : new Date(0);
      const db = b['完工日期'] ? new Date(b['完工日期']) : new Date(0);
      return db - da;
    }
    const da = a['開單日期'] ? new Date(a['開單日期']) : new Date(0);
    const db = b['開單日期'] ? new Date(b['開單日期']) : new Date(0);
    return db - da;
  });

  const itemCards = sorted.map(it => {
    const prog  = it['進度'] || '待施工';
    const color = progColor[prog] || 'bg-gray-600';
    const payColor = it['收款狀態'] === '已收款' ? 'bg-green-700' : 'bg-red-900';
    return `
    <div class="card" id="itemCard_${it['工作ID']}">
      <div class="flex justify-between items-start">
        <div class="flex-1 min-w-0">
          <div class="font-semibold">${it['品名'] || '-'}${it['規格'] ? ' · ' + it['規格'] : ''}</div>
          <div class="text-xs text-gray-400 mb-1">
            ${it['數量']} × $${Number(it['單價']).toLocaleString()}
            ${it['車號'] ? ' · ' + it['車號'] : ''}
            ${it['負責師傅'] ? ' · ' + it['負責師傅'] : ''}
          </div>
          <div class="text-xs text-gray-500 mb-1">
            ${it['訂單編號'] || ''}
            ${it['開單日期'] ? ' · 開 ' + it['開單日期'] : ''}
            ${it['交貨期限'] ? ' · 交 ' + it['交貨期限'] : ''}
          </div>
          ${it['備註'] ? `<div class="text-xs text-gray-500 mb-1">備註：${it['備註']}</div>` : ''}
          ${it['完工日期'] ? `<div class="text-xs text-amber-400 mb-1">完工：${it['完工日期']}</div>` : ''}
          ${it['請款單狀態'] === '已開單' ? `<div class="text-xs text-blue-400 mb-1">請款單已開</div>` : ''}
          <div class="flex items-center gap-2 flex-wrap mt-1">
            <select onchange="cycleProgress('${it['工作ID']}',this.value)"
              class="${color} text-white text-xs px-2 py-0.5 rounded-full font-semibold border-0 outline-none cursor-pointer w-auto">
              <option value="待施工" ${prog==='待施工'?'selected':''}>待施工</option>
              <option value="施工中" ${prog==='施工中'?'selected':''}>施工中</option>
              <option value="完成"   ${prog==='完成'?'selected':''}>完成</option>
            </select>
            <select onchange="updateItemField('${it['工作ID']}','收款狀態',this.value)"
              class="${payColor} text-white text-xs px-2 py-0.5 rounded-full font-semibold border-0 outline-none cursor-pointer w-auto">
              <option value="未收款" ${(it['收款狀態']||'未收款')==='未收款'?'selected':''}>未收款</option>
              <option value="已收款" ${it['收款狀態']==='已收款'?'selected':''}>已收款</option>
            </select>
          </div>
        </div>
        <div class="flex flex-col items-end gap-2 ml-3 shrink-0">
          <span class="text-amber-400 font-bold">$${Number(it['金額'] || 0).toLocaleString()}</span>
          <button onclick="editItem('${it['工作ID']}')" class="text-amber-400 text-sm">✎</button>
          <button onclick="deleteItem('${it['工作ID']}')" class="text-amber-400 text-sm">✕</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // 底部按鈕：done 區塊才顯示「開請款單」（同客戶全部合併一張）
  const isDone = state.viewSection === 'done';
  let actionBtns = '';
  if (isDone && its.length > 0) {
    const allIds = its.map(it => it['工作ID']);
    const idsArg = "[" + allIds.map(id => "'" + String(id).replace(/'/g, "\\'") + "'").join(",") + "]";
    actionBtns = `<button class="btn btn-primary text-sm mt-1 w-full"
      onclick="openInvoice(${idsArg})">
      開請款單（${allIds.length} 件）
    </button>`;
  }

  return `
  <div class="card mb-3">
    <div class="flex justify-between items-center">
      <div class="font-bold text-lg">${name}</div>
      <div class="text-amber-400 font-bold text-lg">$${subtotal.toLocaleString()}</div>
    </div>
  </div>

  <div class="section-title">工作項目</div>
  ${itemCards || '<p class="text-gray-500 text-sm mb-4">尚無工作項目</p>'}

  ${actionBtns ? `<div class="mt-4">${actionBtns}</div>` : ''}`;
}

// ── 品項進度更新（樂觀更新，自動完工日期）──
async function cycleProgress(itemId, newProg) {
  const it = state.items.find(x => String(x['工作ID']) === String(itemId));
  if (!it) return;
  const prev = it['進度'];
  const prevDate = it['完工日期'];
  it['進度'] = newProg;
  const data = { '進度': newProg };

  // 前端也自動填完工日期（後端亦會填，確保一致）
  if (newProg === '完成' && !it['完工日期']) {
    const today = new Date().toISOString().slice(0, 10);
    it['完工日期'] = today;
    data['完工日期'] = today;
  }

  showView('customerDetail', state.viewCustomer);
  saveCache();
  const r = await api('update', '工作項目', { key: itemId, data });
  if (r.error) {
    it['進度']     = prev;
    it['完工日期'] = prevDate;
    showView('customerDetail', state.viewCustomer);
    saveCache();
    showToast('更新失敗，已還原', 'error');
  } else {
    // 後端可能回傳更新後的完工日期，同步到本地
    if (r.data && r.data['完工日期'] && !prevDate) {
      it['完工日期'] = r.data['完工日期'];
      saveCache();
    }
  }
}

// 通用欄位更新（收款狀態等）
async function updateItemField(itemId, field, value) {
  const it = state.items.find(x => String(x['工作ID']) === String(itemId));
  if (!it) return;
  const prev = it[field];
  it[field] = value;
  showView('customerDetail', state.viewCustomer);
  saveCache();
  const r = await api('update', '工作項目', { key: itemId, data: { [field]: value } });
  if (r.error) {
    it[field] = prev;
    showView('customerDetail', state.viewCustomer);
    saveCache();
    showToast('更新失敗，已還原', 'error');
  } else {
    showToast('已更新');
  }
}

// ── 編輯品項（inline）───────────────────────
function editItem(id) {
  const it = state.items.find(x => String(x['工作ID']) === String(id));
  if (!it) return;
  const card = document.getElementById(`itemCard_${id}`);
  if (!card) return;
  // 同訂單編號的整批項目（生產工單依批次產生）
  const batchNo = it['訂單編號'] || '';
  const batchIds = state.items
    .filter(x => (x['訂單編號'] || '') === batchNo)
    .map(x => x['工作ID']);
  const batchArg = "[" + batchIds.map(bid => "'" + String(bid).replace(/'/g, "\\'") + "'").join(",") + "]";
  card.innerHTML = `
    <div class="grid grid-cols-2 gap-2 mb-2">
      <input id="ei_name"  value="${it['品名']||''}"       placeholder="品名"/>
      <input id="ei_spec"  value="${it['規格']||''}"       placeholder="規格"/>
      <input id="ei_qty"   value="${it['數量']||1}"        type="number" placeholder="數量"
        oninput="document.getElementById('ei_amt').textContent='$'+((this.value||0)*(document.getElementById('ei_price').value||0)).toLocaleString()"/>
      <input id="ei_price" value="${it['單價']||''}"       type="number" placeholder="單價"
        oninput="document.getElementById('ei_amt').textContent='$'+((document.getElementById('ei_qty').value||1)*this.value).toLocaleString()"/>
      <input id="ei_plate"  value="${it['車號']||''}"      placeholder="車號（選填）"/>
      <select id="ei_worker">
        <option value="">負責師傅（選填）</option>
        ${state.workers.map(w => `<option value="${w}" ${it['負責師傅']===w?'selected':''}>${w}</option>`).join('')}
      </select>
    </div>
    <div class="mb-2">
      <label class="section-title">交貨期限</label>
      <input id="ei_deadline" type="date" value="${it['交貨期限']||''}"/>
    </div>
    <textarea id="ei_note" rows="2" placeholder="備註（選填）" class="w-full mb-2">${it['備註']||''}</textarea>
    <div class="flex justify-between items-center mb-3">
      <span class="text-xs text-gray-400">金額：<span id="ei_amt" class="text-amber-400">$${Number(it['金額']).toLocaleString()}</span></span>
      <div class="flex gap-2">
        <button onclick="showView('customerDetail',state.viewCustomer)" class="btn btn-ghost text-sm px-3">取消</button>
        <button onclick="saveItem('${id}')" class="btn btn-primary text-sm px-3">儲存</button>
      </div>
    </div>
    <div class="border-t border-gray-600 pt-3">
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs text-gray-400">完工照片</span>
        <label class="btn btn-ghost text-xs cursor-pointer">
          上傳
          <input type="file" accept="image/*" capture="environment" class="hidden"
            onchange="uploadItemPhoto('${id}',this)">
        </label>
      </div>
      <div id="itemPhotoGrid_${id}" class="grid grid-cols-3 gap-2">
        ${renderItemPhotoGrid(it['完工照片'], id)}
      </div>
      <div id="itemUploadProg_${id}" class="hidden text-xs text-amber-400 text-center mt-1">上傳中…</div>
    </div>
    ${batchNo ? `<button class="btn btn-ghost text-sm w-full mt-3" onclick="openWorkOrder(${batchArg})">
      生產工單 ${batchNo}（${batchIds.length} 件）
    </button>` : ''}`;
}

async function saveItem(id) {
  const it = state.items.find(x => String(x['工作ID']) === String(id));
  if (!it) return;
  const qty   = Number(document.getElementById('ei_qty').value)   || 1;
  const price = Number(document.getElementById('ei_price').value) || 0;
  const data = {
    '品名':     document.getElementById('ei_name').value.trim(),
    '規格':     document.getElementById('ei_spec').value.trim(),
    '數量':     qty,
    '單價':     price,
    '金額':     qty * price,
    '交貨期限': document.getElementById('ei_deadline').value,
    '車號':     document.getElementById('ei_plate').value.trim(),
    '負責師傅': document.getElementById('ei_worker').value.trim(),
    '備註':     document.getElementById('ei_note').value.trim(),
  };
  Object.assign(it, data);
  showView('customerDetail', state.viewCustomer);
  saveCache();
  await api('update', '工作項目', { key: id, data });
  showToast('品項已更新 ✓');
}

async function deleteItem(id) {
  if (!document.getElementById('confirmDel_' + id)) {
    const card = document.getElementById(`itemCard_${id}`);
    const btn  = card ? card.querySelectorAll('button')[1] : null; // ✕ button
    if (btn) { btn.textContent = '確定？'; btn.id = 'confirmDel_' + id; }
    setTimeout(() => {
      const b = document.getElementById('confirmDel_' + id);
      if (b) { b.textContent = '✕'; b.removeAttribute('id'); }
    }, 3000);
    return;
  }
  state.items = state.items.filter(x => String(x['工作ID']) !== String(id));
  showView('customerDetail', state.viewCustomer);
  saveCache();
  api('delete', '工作項目', { key: id });
}

// ── 完工照片 ─────────────────────────────────
function renderItemPhotoGrid(photoField, itemId) {
  if (!photoField) return '<p class="text-gray-500 text-xs col-span-3">尚無照片</p>';
  const urls = String(photoField).split(',').filter(u => u.trim());
  if (!urls.length) return '<p class="text-gray-500 text-xs col-span-3">尚無照片</p>';
  return urls.map((url, idx) => `
    <div class="relative">
      <a href="${url.trim()}" target="_blank">
        <img src="${url.trim()}" class="w-full aspect-square object-cover rounded-lg border border-gray-600"/>
      </a>
      <button onclick="deleteItemPhoto('${itemId}',${idx})"
        class="absolute top-1 right-1 bg-gray-700 text-amber-400 rounded-full w-6 h-6 text-xs flex items-center justify-center leading-none">✕</button>
    </div>`).join('');
}

async function uploadItemPhoto(itemId, input) {
  const file = input.files[0];
  if (!file) return;
  const prog = document.getElementById(`itemUploadProg_${itemId}`);
  if (prog) prog.classList.remove('hidden');
  const base64 = await compressImage(file, 1024);
  const result = await api('uploadItemPhoto', null, { itemId, base64, fileName: file.name });
  if (prog) prog.classList.add('hidden');
  input.value = '';
  if (result.error) { showToast('上傳失敗：' + result.error, 'error'); return; }
  const it = state.items.find(x => String(x['工作ID']) === String(itemId));
  if (it) {
    it['完工照片'] = (it['完工照片'] ? it['完工照片'] + ',' : '') + result.url;
    const grid = document.getElementById(`itemPhotoGrid_${itemId}`);
    if (grid) grid.innerHTML = renderItemPhotoGrid(it['完工照片'], itemId);
    saveCache();
  }
  showToast('照片已上傳 ✓');
}

async function deleteItemPhoto(itemId, idx) {
  const it = state.items.find(x => String(x['工作ID']) === String(itemId));
  if (!it) return;
  const urls = String(it['完工照片'] || '').split(',').filter(u => u.trim());
  urls.splice(idx, 1);
  it['完工照片'] = urls.join(',');
  const grid = document.getElementById(`itemPhotoGrid_${itemId}`);
  if (grid) grid.innerHTML = renderItemPhotoGrid(it['完工照片'], itemId);
  await api('update', '工作項目', { key: itemId, data: { '完工照片': it['完工照片'] } });
  saveCache();
}

// ── PDF 操作 ─────────────────────────────────
async function openInvoice(itemIds) {
  const win = window.open('', '_blank'); // 先開視窗保留使用者手勢
  showToast('正在產生請款單 PDF…');
  const result = await api('generateInvoice', null, { itemIds, type: 'invoice' });
  if (result.error) {
    win.close();
    showToast('產生失敗：' + result.error, 'error');
    return;
  }
  itemIds.forEach(id => {
    const it = state.items.find(x => String(x['工作ID']) === String(id));
    if (it) it['請款單狀態'] = '已開單';
  });
  saveCache();
  render();
  win.location.href = result.url;
  showToast('請款單 PDF 已存到雲端並開啟 ✓');
}

async function openWorkOrder(itemIds) {
  const win = window.open('', '_blank');
  showToast('正在查詢生產工單 PDF…');
  const found = await api('getPDFUrl', null, { itemId: itemIds[0], type: 'work' });
  if (found.url) {
    win.location.href = found.url;
    showToast('已開啟雲端生產工單 ✓');
    return;
  }
  showToast('正在產生生產工單 PDF…');
  const result = await api('generateInvoice', null, { itemIds, type: 'work' });
  if (result.error) { win.close(); showToast('產生失敗：' + result.error, 'error'); return; }
  win.location.href = result.url;
  showToast('生產工單已存到雲端並開啟 ✓');
}

// ── 新增工作（開單）─────────────────────────
function renderNewOrder() {
  const today = new Date().toISOString().slice(0, 10);
  const cusOptions = state.customers.map(c =>
    `<option value="${c['客戶名稱']}" ${state.viewCustomer === c['客戶名稱'] ? 'selected' : ''}>${c['客戶名稱']}</option>`
  ).join('');

  return `
  <div class="flex flex-col gap-3">

    <div class="card bg-gray-800 border border-gray-600">
      <div class="flex items-center justify-between mb-2">
        <span class="section-title mb-0">語音開單</span>
        <span class="text-xs text-gray-400">Android Chrome 適用</span>
      </div>
      <p class="text-xs text-gray-400 mb-3">按下麥克風，說出品項資訊，自動填入表單</p>
      <div id="voiceResult" class="text-xs text-amber-300 mb-2 min-h-4"></div>
      <button type="button" id="voiceBtn" onclick="startVoice()"
        class="w-full py-3 rounded-lg font-bold text-white bg-blue-600 active:bg-blue-800 flex items-center justify-center gap-2">
        <span id="voiceBtnIcon">●</span><span id="voiceBtnText">開始語音輸入</span>
      </button>
    </div>

    <div>
      <div class="flex items-center justify-between mb-1">
        <label class="section-title mb-0">客戶</label>
        <button type="button" onclick="toggleAddCustomer()" class="text-amber-400 text-lg font-bold leading-none px-1">＋</button>
      </div>
      <select id="o_cus">
        <option value="">-- 選擇客戶 --</option>
        ${cusOptions}
      </select>
      <div id="addCusPanel" class="hidden mt-2 flex gap-2">
        <input id="newCusName" placeholder="輸入新客戶名稱" class="flex-1"/>
        <button type="button" onclick="confirmAddCustomer()" class="btn btn-primary text-sm px-3 shrink-0">確認</button>
      </div>
    </div>
    <div>
      <label class="section-title">開單日期</label>
      <input id="o_date" type="date" value="${today}"/>
    </div>

    <div class="mt-2">
      <div class="flex justify-between items-center mb-2">
        <span class="section-title">品項</span>
        <button type="button" class="text-amber-400 text-sm font-bold" onclick="addItemRow()">＋ 新增品項</button>
      </div>
      <div id="itemRows">
        ${renderItemRow(0)}
      </div>
    </div>

    <button class="btn btn-primary mt-2" onclick="saveNewItems()">建立工作項目</button>
  </div>`;
}

function renderItemRow(idx) {
  return `
  <div class="card mb-2" id="itemRow_${idx}">
    <div class="grid grid-cols-2 gap-2 mb-2">
      <input placeholder="品名 *" id="r${idx}_name"/>
      <input placeholder="規格" id="r${idx}_spec"/>
      <input placeholder="數量" type="number" value="1" id="r${idx}_qty" oninput="calcRowAmount(${idx})"/>
      <input placeholder="單價" type="number" id="r${idx}_price" oninput="calcRowAmount(${idx})"/>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-2">
      <input placeholder="車號（選填）" id="r${idx}_plate"/>
      <select id="r${idx}_worker">
        <option value="">負責師傅（選填）</option>
        ${state.workers.map(w => `<option value="${w}">${w}</option>`).join('')}
      </select>
    </div>
    <div class="mb-2">
      <label class="text-xs text-gray-400">交貨期限（選填）</label>
      <input type="date" id="r${idx}_deadline"/>
    </div>
    <textarea placeholder="備註（選填）" rows="2" id="r${idx}_note" class="w-full mb-1"></textarea>
    <div class="flex justify-between items-center mt-1">
      <span class="text-xs text-gray-400">金額：<span id="r${idx}_amt" class="text-amber-400">$0</span></span>
      ${idx > 0 ? `<button type="button" onclick="removeItemRow(${idx})" class="text-amber-400 text-sm">移除</button>` : ''}
    </div>
  </div>`;
}

let itemRowCount = 1;
function addItemRow() {
  const container = document.getElementById('itemRows');
  const div = document.createElement('div');
  div.innerHTML = renderItemRow(itemRowCount);
  container.appendChild(div.firstElementChild);
  itemRowCount++;
}

function removeItemRow(idx) {
  document.getElementById(`itemRow_${idx}`)?.remove();
}

function calcRowAmount(idx) {
  const qty   = Number(document.getElementById(`r${idx}_qty`)?.value)   || 0;
  const price = Number(document.getElementById(`r${idx}_price`)?.value) || 0;
  const el = document.getElementById(`r${idx}_amt`);
  if (el) el.textContent = '$' + (qty * price).toLocaleString();
}

function generateOrderNo() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const existing = [...new Set(state.items
    .filter(it => (it['訂單編號']||'').startsWith(today))
    .map(it => it['訂單編號']))];
  const seq = String(existing.length + 1).padStart(2, '0');
  return `${today}-${seq}`;
}

function toggleAddCustomer() {
  const panel = document.getElementById('addCusPanel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) {
    document.getElementById('newCusName').focus();
  }
}

async function confirmAddCustomer() {
  const input = document.getElementById('newCusName');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }

  // 樂觀加入本地
  if (!state.customers.find(c => c['客戶名稱'] === name)) {
    state.customers.push({ '客戶名稱': name });
  }

  // 更新下拉選單並選取
  const sel = document.getElementById('o_cus');
  if (!sel.querySelector(`option[value="${name}"]`)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = name;

  // 收起面板
  input.value = '';
  document.getElementById('addCusPanel').classList.add('hidden');

  // 寫入試算表
  await api('add', '客戶', { data: { '客戶名稱': name } });
  showToast(`已新增客戶：${name} ✓`);
}

async function saveNewItems() {
  const customer = document.getElementById('o_cus').value;
  const openDate = document.getElementById('o_date').value;
  if (!customer) { showToast('請選擇客戶'); return; }

  const rows = document.querySelectorAll('[id^="itemRow_"]');
  const toSave = [];
  for (const row of rows) {
    const idx  = row.id.replace('itemRow_', '');
    const name = document.getElementById(`r${idx}_name`)?.value.trim();
    if (!name) continue;
    const qty   = Number(document.getElementById(`r${idx}_qty`)?.value)      || 1;
    const price = Number(document.getElementById(`r${idx}_price`)?.value)    || 0;
    toSave.push({
      '品名':     name,
      '規格':     document.getElementById(`r${idx}_spec`)?.value.trim()     || '',
      '數量':     qty,
      '單價':     price,
      '金額':     qty * price,
      '交貨期限': document.getElementById(`r${idx}_deadline`)?.value        || '',
      '車號':     document.getElementById(`r${idx}_plate`)?.value.trim()    || '',
      '負責師傅': document.getElementById(`r${idx}_worker`)?.value.trim()   || '',
      '備註':     document.getElementById(`r${idx}_note`)?.value.trim()     || '',
    });
  }
  if (!toSave.length) { showToast('請至少填一個品名'); return; }

  const orderNo = generateOrderNo();
  const base = Date.now();
  const payloadRows = toSave.map((t, i) => ({
    '工作ID':     'W' + (base + i).toString(),
    '訂單編號':   orderNo,
    '客戶':       customer,
    '開單日期':   openDate,
    '進度':       '待施工',
    '完工日期':   '',
    '收款狀態':   '未收款',
    '完工照片':   '',
    '請款單狀態': '',
    ...t,
  }));

  showLoading(true);
  const r = await api('addBatch', '工作項目', { rows: payloadRows });
  showLoading(false);
  if (r.error) { showToast('建立失敗：' + r.error, 'error'); return; }

  // 樂觀更新本地狀態，免去重新抓全部資料
  state.items.push(...payloadRows);
  saveCache();
  itemRowCount = 1;
  showView('orders');
  showToast(`已建立 ${payloadRows.length} 件工作項目 ✓`);
}

// ── 語音開單 ────────────────────────────────
let voiceRecognition = null;
let voiceActive = false;

function startVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    showToast('你的瀏覽器不支援語音辨識，請用 Android Chrome');
    return;
  }
  if (voiceActive) { voiceRecognition?.stop(); return; }

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = 'zh-TW';
  voiceRecognition.interimResults = true;
  voiceRecognition.continuous = true;

  const btn     = document.getElementById('voiceBtn');
  const btnIcon = document.getElementById('voiceBtnIcon');
  const btnText = document.getElementById('voiceBtnText');
  const result  = document.getElementById('voiceResult');

  voiceActive = true;
  btn.classList.replace('bg-blue-600', 'bg-amber-600');
  btnIcon.textContent = '■';
  btnText.textContent = '聆聽中… 說完請點停止';

  let silenceTimer = null;
  let fullTranscript = '';

  voiceRecognition.onresult = e => {
    fullTranscript = Array.from(e.results).map(r => r[0].transcript).join('');
    result.textContent = '辨識：' + fullTranscript;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => { voiceRecognition.stop(); }, 3500);
  };

  voiceRecognition.onend = () => {
    clearTimeout(silenceTimer);
    resetVoiceBtn();
    if (fullTranscript) {
      parseVoiceLocalFill(fullTranscript);
      parseVoiceWithAI(fullTranscript);
    }
  };

  voiceRecognition.onerror = e => {
    clearTimeout(silenceTimer);
    if (e.error !== 'no-speech') showToast('語音錯誤：' + e.error);
    resetVoiceBtn();
  };

  voiceRecognition.start();
}

function resetVoiceBtn() {
  voiceActive = false;
  const btn     = document.getElementById('voiceBtn');
  const btnIcon = document.getElementById('voiceBtnIcon');
  const btnText = document.getElementById('voiceBtnText');
  if (!btn) return;
  btn.classList.replace('bg-amber-600', 'bg-blue-600');
  btnIcon.textContent = '●';
  btnText.textContent = '再說一次';
}

function parseVoiceLocalFill(text) {
  const toNum = s => {
    const map = { 零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,百:100,千:1000,萬:10000 };
    let n = parseInt(s.replace(/,/g,''));
    if (!isNaN(n)) return n;
    let result = 0, tmp = 0;
    for (const c of s) {
      if (map[c] >= 10) { result += (tmp||1)*map[c]; tmp=0; }
      else if (map[c] !== undefined) tmp = map[c];
    }
    return result + tmp || null;
  };
  const row = 0;
  const nameMatch = text.match(/(.{2,10}?)(彩繪|烤漆|改裝|設計|噴漆|貼膜|拋光|鍍膜|車殼|油箱|車架)/);
  if (nameMatch) { const el = document.getElementById(`r${row}_name`); if (el) el.value = nameMatch[1]+nameMatch[2]; }
  const qtyMatch = text.match(/(\d+|[零一二三四五六七八九十百千萬]+)\s*[個件台組套]/);
  if (qtyMatch) { const qty = toNum(qtyMatch[1]); const el = document.getElementById(`r${row}_qty`); if (el && qty) { el.value = qty; calcRowAmount(row); } }
  const priceMatch = text.match(/(?:單價|每[個件台])?[＄$]?(\d[\d,]*|\d+[萬千百]?\d*)\s*[元塊錢萬千]/);
  if (priceMatch) { const price = toNum(priceMatch[1].replace(/萬/,'0000').replace(/千/,'000').replace(/百/,'00')); const el = document.getElementById(`r${row}_price`); if (el && price) { el.value = price; calcRowAmount(row); } }
  const plateMatch = text.match(/[A-Z]{1,3}[-\s]?\d{3,4}|\d{3,4}[-\s]?[A-Z]{1,3}/i);
  if (plateMatch) { const el = document.getElementById(`r${row}_plate`); if (el) el.value = plateMatch[0].toUpperCase(); }
  showToast('語音已解析，AI 解析中…');
}

async function parseVoiceWithAI(text) {
  const resultEl = document.getElementById('voiceResult');
  if (resultEl) resultEl.textContent = '⏳ AI 解析中…';

  const customerNames = state.customers.map(c => c['客戶名稱']);
  const res = await api('parseVoice', null, { text, customers: customerNames });

  if (!res.success || !res.data) {
    const msg = res.error || 'unknown';
    if (resultEl) resultEl.textContent = 'AI 解析失敗：' + msg;
    showToast('AI 失敗：' + msg);
    return;
  }

  const d = res.data;

  if (d.customer) {
    const cusEl = document.getElementById('o_cus');
    if (cusEl) {
      const opt = Array.from(cusEl.options).find(o => o.value === d.customer);
      if (opt) cusEl.value = d.customer;
    }
  }

  if (d.items && d.items.length) {
    const container = document.getElementById('itemRows');
    if (container) {
      container.innerHTML = '';
      itemRowCount = 0;
      d.items.forEach((item, idx) => {
        const div = document.createElement('div');
        div.innerHTML = renderItemRow(idx);
        container.appendChild(div.firstElementChild);
        itemRowCount++;
        if (item.name)   document.getElementById(`r${idx}_name`).value     = item.name;
        if (item.spec)   document.getElementById(`r${idx}_spec`).value     = item.spec;
        if (item.qty)    document.getElementById(`r${idx}_qty`).value      = item.qty;
        if (item.price)  document.getElementById(`r${idx}_price`).value    = item.price;
        if (item.plate)  document.getElementById(`r${idx}_plate`).value    = item.plate;
        if (item.worker) document.getElementById(`r${idx}_worker`).value   = item.worker;
        if (item.note)   document.getElementById(`r${idx}_note`).value     = item.note;
        if (d.deadline)  document.getElementById(`r${idx}_deadline`).value = d.deadline;
        calcRowAmount(idx);
      });
    }
  }

  if (resultEl) resultEl.textContent = '✓ AI 解析完成，請確認後送出';
  showToast('AI 解析完成 ✓');
}

// ── 客戶管理 ────────────────────────────────
function renderCustomers() {
  if (!state.customers.length) return '<p class="text-gray-500 mt-8 text-center">尚無客戶，點右上角新增</p>';
  return state.customers.map(c => `
    <div class="card flex justify-between items-center">
      <div>
        <div class="font-semibold">${c['客戶名稱']}</div>
        <div class="text-xs text-gray-400">${c['電話']||''} ${c['聯絡人']?'· '+c['聯絡人']:''}</div>
      </div>
      <button class="btn btn-ghost text-sm" onclick="showView('editCustomer', ${JSON.stringify(c).replace(/"/g,'&quot;')})">編輯</button>
    </div>`).join('');
}

function renderCustomerForm() {
  const c = state.editCustomer || {};
  return `
  <div class="flex flex-col gap-3">
    <div>
      <label class="section-title">客戶名稱 *</label>
      <input id="c_name" value="${c['客戶名稱']||''}" placeholder="例：太古哈雷 台照" ${state.editCustomer?'readonly':''}/>
    </div>
    <div>
      <label class="section-title">聯絡人</label>
      <input id="c_contact" value="${c['聯絡人']||''}"/>
    </div>
    <div>
      <label class="section-title">電話</label>
      <input id="c_phone" value="${c['電話']||''}" type="tel"/>
    </div>
    <div>
      <label class="section-title">統一編號</label>
      <input id="c_tax" value="${c['統一編號']||''}"/>
    </div>
    <div>
      <label class="section-title">地址</label>
      <input id="c_addr" value="${c['地址']||''}"/>
    </div>
    <div>
      <label class="section-title">備註</label>
      <textarea id="c_note" rows="2">${c['備註']||''}</textarea>
    </div>
    <button class="btn btn-primary mt-2" onclick="saveCustomer()">
      ${state.editCustomer ? '儲存修改' : '新增客戶'}
    </button>
    ${state.editCustomer ? `<button class="btn btn-danger" onclick="deleteCustomer('${c['客戶名稱']}')">刪除客戶</button>` : ''}
  </div>`;
}

async function saveCustomer() {
  const data = {
    '客戶名稱': document.getElementById('c_name').value.trim(),
    '聯絡人':   document.getElementById('c_contact').value.trim(),
    '電話':     document.getElementById('c_phone').value.trim(),
    '統一編號': document.getElementById('c_tax').value.trim(),
    '地址':     document.getElementById('c_addr').value.trim(),
    '備註':     document.getElementById('c_note').value.trim(),
  };
  if (!data['客戶名稱']) { showToast('請填客戶名稱'); return; }
  showLoading(true);
  if (state.editCustomer) {
    await api('update', '客戶', { key: data['客戶名稱'], data });
  } else {
    await api('add', '客戶', { data });
  }
  state.editCustomer = null;
  await loadAll();
  showView('customers');
  showToast('已儲存 ✓');
}

async function deleteCustomer(name) {
  const btnId = 'confirmDelCus';
  if (!document.getElementById(btnId)) {
    const btn = document.querySelector(`[onclick="deleteCustomer('${name}')"]`);
    if (btn) { btn.textContent = '確定刪除？再按一次'; btn.id = btnId; }
    setTimeout(() => { const b = document.getElementById(btnId); if (b) { b.textContent = '刪除客戶'; b.removeAttribute('id'); } }, 3000);
    return;
  }
  showLoading(true);
  await api('delete', '客戶', { key: name });
  state.editCustomer = null;
  await loadAll();
  showView('customers');
}

// ── 業績統計 ────────────────────────────────
function renderStats() {
  const thisYear = new Date().getFullYear();
  return `
  <div class="card mb-4">
    <div class="section-title">自訂查詢</div>
    <div class="grid grid-cols-2 gap-2 mb-2">
      <div><label class="text-xs text-gray-400">起始日</label>
        <input id="s_from" type="date" value="${thisYear}-01-01"/></div>
      <div><label class="text-xs text-gray-400">結束日</label>
        <input id="s_to" type="date" value="${thisYear}-12-31"/></div>
    </div>
    <select id="s_cus" class="mb-3">
      <option value="">全部客戶</option>
      ${state.customers.map(c => `<option>${c['客戶名稱']}</option>`).join('')}
    </select>
    <button class="btn btn-primary w-full" onclick="queryStats()">查詢</button>
  </div>
  <div id="statsResult"></div>

  <div class="flex items-center justify-between cursor-pointer py-2 mt-2" onclick="toggleStatsCus()">
    <span class="section-title mb-0">各客戶累計</span>
    <span id="arrow-statsCus" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="statsByCustomer" class="hidden"></div>

  <div class="flex items-center justify-between cursor-pointer py-2 mt-2" onclick="toggleStatsWorker()">
    <span class="section-title mb-0">施工人員業績</span>
    <span id="arrow-statsWorker" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="statsByWorker" class="hidden"></div>`;
}

function toggleStatsCus() {
  const el = document.getElementById('statsByCustomer');
  const ar = document.getElementById('arrow-statsCus');
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) {
    const { from, to } = getStatsFilter();
    el.innerHTML = renderStatsByCustomer(from, to);
  }
}

function toggleStatsWorker() {
  const el = document.getElementById('statsByWorker');
  const ar = document.getElementById('arrow-statsWorker');
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) {
    const { from, to } = getStatsFilter();
    el.innerHTML = renderStatsByWorker(from, to);
  }
}

function renderStatsByCustomer(from, to) {
  const map = {};
  state.items.filter(it => !from || (it['完工日期'] && it['完工日期'] >= from && it['完工日期'] <= to)).forEach(it => {
    const c = it['客戶'] || '(未知)';
    map[c] = (map[c] || 0) + Number(it['金額'] || 0);
  });
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => `
      <div class="card flex justify-between">
        <span>${name}</span>
        <span class="text-amber-400 font-bold">$${total.toLocaleString()}</span>
      </div>`).join('') || '<p class="text-gray-500 text-sm">無資料</p>';
}

function renderStatsByWorker(from, to) {
  const map = {};
  state.items.filter(it => it['進度'] === '完成' && (!from || (it['完工日期'] >= from && it['完工日期'] <= to))).forEach(it => {
    const w = it['負責師傅'] || '(未指定)';
    if (!map[w]) map[w] = { count: 0, total: 0 };
    map[w].count++;
    map[w].total += Number(it['金額'] || 0);
  });
  if (!Object.keys(map).length) return '<p class="text-gray-500 text-sm mb-4">無完工資料</p>';
  return Object.entries(map)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, s]) => `
      <div class="card flex justify-between items-center">
        <div>
          <div class="font-semibold">${name}</div>
          <div class="text-xs text-gray-400">完工 ${s.count} 件</div>
        </div>
        <span class="text-amber-400 font-bold">$${s.total.toLocaleString()}</span>
      </div>`).join('');
}

function getStatsFilter() {
  const from = document.getElementById('s_from').value;
  const to   = document.getElementById('s_to').value;
  const cus  = document.getElementById('s_cus').value;
  return { from, to, cus };
}

function queryStats() {
  const { from, to, cus } = getStatsFilter();

  const filtered = state.items.filter(it => {
    const d = it['完工日期'];
    return d && d >= from && d <= to && (!cus || it['客戶'] === cus);
  });

  const total  = filtered.reduce((s, it) => s + Number(it['金額'] || 0), 0);
  const detail = filtered.map(it =>
    `<div class="flex justify-between text-sm py-1 border-b border-gray-700">
      <span>${it['完工日期']} ${it['客戶']} · ${it['品名']||''}</span>
      <span>$${Number(it['金額']||0).toLocaleString()}</span>
    </div>`
  ).join('');

  document.getElementById('statsResult').innerHTML = `
    <div class="card">
      <div class="flex justify-between mb-3">
        <span class="text-gray-400">查詢結果（${filtered.length} 件）</span>
        <span class="text-2xl font-bold text-amber-400">$${total.toLocaleString()}</span>
      </div>
      ${detail || '<p class="text-gray-500 text-sm">無符合資料</p>'}
    </div>`;

  // 同步更新各客戶累計與施工人員業績（若已展開）
  const cuEl = document.getElementById('statsByCustomer');
  if (cuEl && !cuEl.classList.contains('hidden')) cuEl.innerHTML = renderStatsByCustomer(from, to);
  const wkEl = document.getElementById('statsByWorker');
  if (wkEl && !wkEl.classList.contains('hidden')) wkEl.innerHTML = renderStatsByWorker(from, to);
}

// ── 工具函式 ────────────────────────────────
function compressImage(file, maxPx) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width  = img.width  * ratio;
        canvas.height = img.height * ratio;
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function showLoading(on) {
  state.loading = on;
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `fixed top-16 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm z-50 ${type==='error'?'bg-red-600':'bg-green-700'} text-white`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ── 初始化 ──────────────────────────────────
if (API_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
  document.getElementById('app').innerHTML = `
    <div class="text-center mt-20">
      <h2 class="text-amber-400 font-bold text-lg mb-2">請先設定 API</h2>
      <p class="text-gray-400 text-sm">請依步驟部署 Apps Script，<br>再把網址填入 app.js 的 API_URL 變數。</p>
    </div>`;
} else {
  loadAll();
}
