// =============================================
// 獨品工坊開單系統 — 前端主程式
// =============================================

// ⚠️  部署 Apps Script 後，把網址貼到這裡
const API_URL = 'https://script.google.com/macros/s/AKfycbxzHdJMopMPPYvozDfrnRq3BUtcEg0QaCcVWlQEnrkPh0txbJim-JU3-FR4X0A7VTmglA/exec';

// ── PWA 註冊 ────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js')
    .then(reg => reg.update()) // 每次開啟都強制檢查新版 SW
    .catch(() => {});
  // 新 SW 接管後自動重載頁面，確保用戶看到最新版
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
}

// ── 狀態 ────────────────────────────────────
let state = {
  view: 'orders',       // 目前畫面
  orders: [],
  customers: [],
  items: [],            // 品項（lineItems）
  settings: {},
  editOrder: null,      // 正在編輯的訂單
  viewOrder: null,      // 正在查看詳細的訂單
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
      headers: { 'Content-Type': 'text/plain' }, // 避免 CORS preflight
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

const CACHE_KEY = 'dupin_cache';

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      orders: state.orders,
      customers: state.customers,
      items: state.items,
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
    state.orders = cache.orders || [];
    state.customers = cache.customers || [];
    state.items = cache.items || [];
    state.settings = cache.settings || {};
    return true;
  } catch(e) { return false; }
}

async function loadAll() {
  // 先顯示快取資料（秒開）
  const hasCached = loadCache();
  if (hasCached) {
    showLoading(false);
    render();
  } else {
    showLoading(true);
  }

  // 背景更新
  const [o, c, i, s] = await Promise.all([
    api('getAll', '訂單'),
    api('getAll', '客戶'),
    api('getAll', '品項'),
    api('getSettings'),
  ]);
  if (o.data) state.orders = o.data.map(normalizeOrder);
  if (c.data) state.customers = c.data;
  if (i.data) state.items = i.data.map(normalizeItem);
  if (s.data) state.settings = s.data;
  saveCache();
  showLoading(false);
  render();
}

function normalizeOrder(o) {
  return {
    ...o,
    開單日期: formatDate(o['開單日期']),
    交貨期限: formatDate(o['交貨期限']),
    狀態: o['狀態'] || '進行中',
    收款狀態: o['收款狀態'] || '未收款',
  };
}

function normalizeItem(it) {
  const qty = Number(it['數量']) || 0;
  const price = Number(it['單價']) || 0;
  return { ...it, 數量: qty, 單價: price, 金額: qty * price };
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
  if (view === 'orderDetail' && data) state.viewOrder = data;
  if (view === 'editOrder'   && data) state.editOrder = data;
  if (view === 'editCustomer'&& data) state.editCustomer = data;
  render();
}

function goBack() {
  const back = {
    orderDetail: 'orders',
    editOrder: 'orders',
    newOrder: 'orders',
    editCustomer: 'customers',
    addItem: 'orderDetail',
    invoicePreview: 'orderDetail',
  };
  const target = back[state.view] || 'orders';
  if (target === 'orderDetail') {
    showView('orderDetail', state.viewOrder);
  } else {
    showView(target);
  }
}

// ── 渲染主控制 ──────────────────────────────
function render() {
  const app = document.getElementById('app');
  const title = document.getElementById('pageTitle');
  const back = document.getElementById('backBtn');
  const actions = document.getElementById('headerActions');

  // 更新底部導覽 active 狀態
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('text-amber-400', btn.dataset.view === state.view);
    btn.classList.toggle('text-gray-400', btn.dataset.view !== state.view);
  });

  switch (state.view) {
    case 'orders':
      title.textContent = '獨品工坊';
      back.classList.add('hidden');
      actions.innerHTML = '';
      app.innerHTML = renderOrders();
      break;
    case 'orderDetail':
      title.textContent = '訂單詳細';
      back.classList.remove('hidden');
      actions.innerHTML = `<button class="btn btn-ghost text-sm" onclick="editOrder('${state.viewOrder?.['訂單編號']}')">編輯</button>`;
      app.innerHTML = renderOrderDetail();
      break;
    case 'newOrder':
    case 'editOrder':
      title.textContent = state.view === 'newOrder' ? '新增訂單' : '編輯訂單';
      back.classList.remove('hidden');
      actions.innerHTML = '';
      app.innerHTML = renderOrderForm();
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
    case 'invoicePreview':
      title.textContent = '請款單';
      back.classList.remove('hidden');
      actions.innerHTML = `<button class="btn btn-primary text-sm" onclick="window.print()">列印</button>`;
      app.innerHTML = renderInvoicePreview();
      break;
  }
}

// ── 訂單列表 ────────────────────────────────
const sectionOpen = { active: true, done: false, paid: false };

function toggleSection(key) {
  sectionOpen[key] = !sectionOpen[key];
  const el = document.getElementById('section-' + key);
  const arrow = document.getElementById('arrow-' + key);
  if (el) el.style.display = sectionOpen[key] ? '' : 'none';
  if (arrow) arrow.textContent = sectionOpen[key] ? '▲' : '▼';
}

function renderOrders() {
  return `
  <div class="relative mb-3">
    <input type="search" placeholder="搜尋客戶、訂單編號、車號…"
      value="${state.search}"
      oninput="state.search=this.value;document.getElementById('orderListContent').innerHTML=renderOrdersContent()"
      class="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500"/>
    <span class="absolute left-3 top-2.5 text-gray-500 text-sm"></span>
  </div>
  <div id="orderListContent">${renderOrdersContent()}</div>`;
}

function renderOrdersContent() {
  const q = state.search.toLowerCase();
  const match = o => !q || (o['客戶']||'').toLowerCase().includes(q) ||
    (o['訂單編號']||'').toLowerCase().includes(q) ||
    state.items.filter(it => it['訂單編號'] === o['訂單編號'])
      .some(it => (it['車號']||'').toLowerCase().includes(q));

  // 分三類
  const active = state.orders
    .filter(o => o['狀態'] === '進行中' && match(o))
    .sort((a, b) => {
      const da = a['交貨期限'] ? new Date(a['交貨期限']) : new Date('9999-12-31');
      const db = b['交貨期限'] ? new Date(b['交貨期限']) : new Date('9999-12-31');
      return da - db;
    })
    .slice(0, 50);

  const done = state.orders
    .filter(o => o['狀態'] === '完工交貨' && o['收款狀態'] !== '已收款' && match(o))
    .sort((a, b) => new Date(b['完工日期'] || b['開單日期']) - new Date(a['完工日期'] || a['開單日期']))
    .slice(0, 50);

  const paid = state.orders
    .filter(o => o['狀態'] === '完工交貨' && o['收款狀態'] === '已收款' && match(o))
    .sort((a, b) => new Date(b['完工日期'] || b['開單日期']) - new Date(a['完工日期'] || a['開單日期']))
    .slice(0, 50);

  const orderCard = o => {
    const subtotal = orderSubtotal(o['訂單編號']);
    const deadline = o['交貨期限'] ? `· 交貨 ${o['交貨期限']}` : '';
    // 品項摘要 + 進度 badge
    const its = state.items.filter(it => it['訂單編號'] === o['訂單編號']);
    const progColor = { '待施工': 'bg-gray-600', '施工中': 'bg-blue-600', '完成': 'bg-green-600' };
    const itemLine = its.length ? `
      <div class="flex flex-wrap gap-1 mb-1">
        ${its.slice(0, 4).map(it => `
          <span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-200">
            ${it['品名'] || '-'}
            <span class="w-1.5 h-1.5 rounded-full ${progColor[it['進度']] || 'bg-gray-500'}"></span>
          </span>`).join('')}
        ${its.length > 4 ? `<span class="text-xs text-gray-500">+${its.length - 4}</span>` : ''}
      </div>` : '';
    return `
    <div class="card cursor-pointer" onclick="openOrder('${o['訂單編號']}')">
      <div class="flex justify-between items-start mb-0.5">
        <span class="text-lg font-bold">${o['客戶'] || '-'}</span>
        <span class="text-amber-400 font-bold text-lg">$${subtotal.toLocaleString()}</span>
      </div>
      ${itemLine}
      <div class="text-xs text-gray-400 mb-2">${o['訂單編號']} · ${o['開單日期']} ${deadline}</div>
      <div class="flex gap-2">
        <span class="badge-${o['狀態']} text-white text-xs px-2 py-0.5 rounded-full">${o['狀態']}</span>
        <span class="badge-${o['收款狀態']} text-white text-xs px-2 py-0.5 rounded-full">${o['收款狀態']}</span>
      </div>
    </div>`;
  };

  const sectionHeader = (label, count, key) => `
    <div class="flex justify-between items-center cursor-pointer py-2 mt-2" onclick="toggleSection('${key}')">
      <span class="section-title mb-0">${label}（${count}）</span>
      <span id="arrow-${key}" class="text-gray-400 text-lg">${sectionOpen[key] ? '▲' : '▼'}</span>
    </div>`;

  const sectionBody = (items, key, emptyMsg) => `
    <div id="section-${key}" style="display:${sectionOpen[key] ? '' : 'none'}">
      ${items.length ? items.map(orderCard).join('') : `<p class="text-gray-500 text-sm mb-4">${emptyMsg}</p>`}
    </div>`;

  return `
  ${sectionHeader('進行中', active.length, 'active')}
  ${sectionBody(active, 'active', '暫無進行中訂單')}

  ${sectionHeader('完工交貨', done.length, 'done')}
  ${sectionBody(done, 'done', '暫無完工訂單')}

  ${sectionHeader('已交貨收款', paid.length, 'paid')}
  ${sectionBody(paid, 'paid', '暫無已收款訂單')}`;
}

function orderSubtotal(orderNo) {
  return state.items
    .filter(it => it['訂單編號'] === orderNo)
    .reduce((s, it) => s + (Number(it['數量']) * Number(it['單價'])), 0);
}

function openOrder(orderNo) {
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (o) showView('orderDetail', o);
}

function editOrder(orderNo) {
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (o) showView('editOrder', o);
}

// ── 訂單詳細 ────────────────────────────────
function renderOrderDetail() {
  const o = state.viewOrder;
  if (!o) return '';
  const orderNo = o['訂單編號'];
  const its = state.items.filter(it => it['訂單編號'] === orderNo);
  const subtotal = its.reduce((s, it) => s + Number(it['金額']), 0);

  const progressColors = { '待施工': 'bg-gray-600', '施工中': 'bg-blue-600', '完成': 'bg-green-600' };
  const progressNext   = { '待施工': '施工中', '施工中': '完成', '完成': '待施工' };

  const itemRows = its.map(it => {
    const prog = it['進度'] || '待施工';
    const color = progressColors[prog] || 'bg-gray-600';
    return `
    <div class="card" id="itemCard_${it['品項ID']}">
      <div class="flex justify-between items-start">
        <div class="flex-1">
          <div class="font-semibold">${it['品名']}${it['規格'] ? ' · ' + it['規格'] : ''}</div>
          <div class="text-xs text-gray-400 mb-2">${it['數量']} × $${Number(it['單價']).toLocaleString()}${it['車號'] ? ' · ' + it['車號'] : ''}</div>
          <select onchange="cycleProgress('${it['品項ID']}',this.value)"
            class="${color} text-white text-xs px-2 py-1 rounded-full font-semibold border-0 outline-none cursor-pointer">
            <option value="待施工" ${prog==='待施工'?'selected':''}>待施工</option>
            <option value="施工中" ${prog==='施工中'?'selected':''}>施工中</option>
            <option value="完成"   ${prog==='完成'?'selected':''}>完成</option>
          </select>
        </div>
        <div class="flex flex-col items-end gap-2 ml-3">
          <span class="text-amber-400 font-bold">$${Number(it['金額']).toLocaleString()}</span>
          <button onclick="editItem('${it['品項ID']}')" class="text-amber-400 text-sm">✎</button>
          <button onclick="deleteItem('${it['品項ID']}')" class="text-amber-400 text-sm">✕</button>
        </div>
      </div>
    </div>`;
  }).join('');

  return `
  <div class="card mb-4">
    <div class="flex justify-between mb-3">
      <div>
        <div class="font-bold text-lg">${o['客戶']}</div>
        <div class="text-xs text-gray-400">${orderNo}</div>
      </div>
      <div class="text-right">
        <div class="text-xs text-gray-400">開單日期</div>
        <div>${o['開單日期']}</div>
      </div>
    </div>
    <div class="flex gap-2 mb-3">
      <select onchange="updateOrderStatus('${orderNo}',this.value)" class="flex-1 text-sm">
        <option ${o['狀態']==='進行中'?'selected':''}>進行中</option>
        <option ${o['狀態']==='完工交貨'?'selected':''}>完工交貨</option>
      </select>
      <select onchange="updateOrderField('${orderNo}','收款狀態',this.value)" class="flex-1 text-sm">
        <option ${o['收款狀態']==='未收款'?'selected':''}>未收款</option>
        <option ${o['收款狀態']==='收款訂金'?'selected':''}>收款訂金</option>
        <option ${o['收款狀態']==='已收款'?'selected':''}>已收款</option>
      </select>
    </div>
    ${o['完工日期'] ? `<div class="text-xs text-amber-400 mb-1">完工日期：${o['完工日期']}</div>` : ''}
    ${o['備註'] ? `<div class="text-sm text-gray-400">備註：${o['備註']}</div>` : ''}
  </div>

  <div class="section-title">品項清單</div>
  ${itemRows || '<p class="text-gray-500 text-sm mb-4">尚無品項</p>'}

  <!-- 新增品項表單 -->
  <div class="card mt-4" id="addItemForm">
    <div class="section-title mb-3">新增品項</div>
    <div class="grid grid-cols-2 gap-2 mb-2">
      <input id="i_name" placeholder="品名" />
      <input id="i_spec" placeholder="規格" />
      <input id="i_qty"  placeholder="數量" type="number" value="1"/>
      <input id="i_price" placeholder="單價" type="number"/>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-3">
      <input id="i_plate" placeholder="車號（選填）"/>
      <input id="i_worker" placeholder="負責師傅（選填）"/>
    </div>
    <button class="btn btn-primary w-full" onclick="addItem('${orderNo}')">加入品項</button>
  </div>

  <div class="flex justify-between items-center mt-4 mb-2">
    <span class="text-gray-400">未稅總和</span>
    <span class="text-2xl font-bold text-amber-400">$${subtotal.toLocaleString()}</span>
  </div>

  <div class="grid grid-cols-2 gap-3 mt-4">
    <button class="btn btn-primary" onclick="savePDF('${orderNo}','invoice')">請款單 PDF</button>
    <button class="btn btn-ghost"   onclick="savePDF('${orderNo}','work')">生產工單 PDF</button>
  </div>
  <div class="mt-3">
    <button class="btn btn-ghost w-full text-amber-400" onclick="deleteOrder('${orderNo}')">✕ 刪除訂單</button>
  </div>`;
}

// ── 新增/編輯品項 ────────────────────────────
async function addItem(orderNo) {
  const name   = document.getElementById('i_name').value.trim();
  const spec   = document.getElementById('i_spec').value.trim();
  const qty    = Number(document.getElementById('i_qty').value) || 1;
  const price  = Number(document.getElementById('i_price').value) || 0;
  const plate  = document.getElementById('i_plate').value.trim();
  const worker = document.getElementById('i_worker').value.trim();
  if (!name) { showToast('請填品名'); return; }

  const data = {
    '品項ID': Date.now().toString(),
    '訂單編號': orderNo,
    '品名': name,
    '規格': spec,
    '數量': qty,
    '單價': price,
    '金額': qty * price,
    '車號': plate,
    '負責師傅': worker,
  };
  // 樂觀更新：先加到本地 state
  state.items.push({ ...data, 金額: data['數量'] * data['單價'] });
  showView('orderDetail', state.viewOrder);
  // 背景同步，完成後再 loadAll 確保 ID 正確
  await api('add', '品項', { data });
  await loadAll();
}

function editItem(id) {
  const it = state.items.find(x => String(x['品項ID']) === String(id));
  if (!it) return;
  const card = document.getElementById(`itemCard_${id}`);
  if (!card) return;
  card.innerHTML = `
    <div class="grid grid-cols-2 gap-2 mb-2">
      <input id="ei_name" value="${it['品名']||''}" placeholder="品名"/>
      <input id="ei_spec" value="${it['規格']||''}" placeholder="規格"/>
      <input id="ei_qty"  value="${it['數量']||1}"  type="number" placeholder="數量" oninput="document.getElementById('ei_amt').textContent='$'+(this.value*(document.getElementById('ei_price').value||0)).toLocaleString()"/>
      <input id="ei_price" value="${it['單價']||''}" type="number" placeholder="單價" oninput="document.getElementById('ei_amt').textContent='$'+((document.getElementById('ei_qty').value||1)*this.value).toLocaleString()"/>
      <input id="ei_plate"  value="${it['車號']||''}"   placeholder="車號（選填）"/>
      <input id="ei_worker" value="${it['負責師傅']||''}" placeholder="負責師傅（選填）"/>
    </div>
    <div class="flex justify-between items-center mb-3">
      <span class="text-xs text-gray-400">金額：<span id="ei_amt" class="text-amber-400">$${Number(it['金額']).toLocaleString()}</span></span>
      <div class="flex gap-2">
        <button onclick="showView('orderDetail',state.viewOrder)" class="btn btn-ghost text-sm px-3">取消</button>
        <button onclick="saveItem('${id}')" class="btn btn-primary text-sm px-3">儲存</button>
      </div>
    </div>
    <div class="border-t border-gray-600 pt-3">
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs text-gray-400">完工照片</span>
        <label class="btn btn-ghost text-xs cursor-pointer">
          上傳
          <input type="file" accept="image/*" capture="environment" class="hidden"
            onchange="uploadItemPhoto('${id}','${it['訂單編號']}',this)">
        </label>
      </div>
      <div id="itemPhotoGrid_${id}" class="grid grid-cols-3 gap-2">
        ${renderItemPhotoGrid(it['完工照片'], id)}
      </div>
      <div id="itemUploadProg_${id}" class="hidden text-xs text-amber-400 text-center mt-1">上傳中…</div>
    </div>`;
}

async function saveItem(id) {
  const it = state.items.find(x => String(x['品項ID']) === String(id));
  if (!it) return;
  const qty   = Number(document.getElementById('ei_qty').value)   || 1;
  const price = Number(document.getElementById('ei_price').value) || 0;
  const data = {
    '品名':     document.getElementById('ei_name').value.trim(),
    '規格':     document.getElementById('ei_spec').value.trim(),
    '數量':     qty,
    '單價':     price,
    '金額':     qty * price,
    '車號':     document.getElementById('ei_plate').value.trim(),
    '負責師傅': document.getElementById('ei_worker').value.trim(),
  };
  Object.assign(it, data);
  showView('orderDetail', state.viewOrder);
  await api('update', '品項', { key: id, data });
  showToast('品項已更新 ✓');
}

async function deleteItem(id) {
  if (!document.getElementById('confirmDel_' + id)) {
    const card = document.getElementById(`itemCard_${id}`);
    const btn = card ? card.querySelector('[onclick*="deleteItem"]') : null;
    if (btn) { btn.textContent = '確定？'; btn.id = 'confirmDel_' + id; }
    setTimeout(() => { if (btn) { btn.textContent = '✕'; btn.removeAttribute('id'); } }, 3000);
    return;
  }
  const it = state.items.find(x => String(x['品項ID']) === String(id));
  const orderNo = it?.['訂單編號'];
  // 樂觀更新：先從本地移除
  state.items = state.items.filter(x => x['品項ID'] !== id);
  showView('orderDetail', state.viewOrder);
  api('delete', '品項', { key: id }); // 背景同步
}

// 品項進度更新（樂觀更新：畫面先動，背景同步）
async function cycleProgress(itemId, newProg) {
  const it = state.items.find(x => String(x['品項ID']) === String(itemId));
  if (!it) return;
  const prev = it['進度'];
  it['進度'] = newProg;                          // 立刻更新本地
  showView('orderDetail', state.viewOrder);       // 立刻重繪
  const r = await api('update', '品項', { key: itemId, data: { '進度': newProg } });
  if (r.error) { it['進度'] = prev; showView('orderDetail', state.viewOrder); showToast('更新失敗，已還原', 'error'); }
}

// 收款狀態變更（樂觀更新）
async function updateOrderField(orderNo, field, value) {
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (!o) return;
  const prev = o[field];
  o[field] = value;
  state.viewOrder = o;
  showView('orderDetail', o);
  const r = await api('update', '訂單', { key: orderNo, data: { [field]: value } });
  if (r.error) { o[field] = prev; showView('orderDetail', o); showToast('更新失敗，已還原', 'error'); return; }
  showToast('已更新');
}

// 狀態變更（完工時記錄日期並產生請款單）
async function updateOrderStatus(orderNo, newStatus) {
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (!o) return;
  const data = { '狀態': newStatus };
  if (newStatus === '完工交貨') {
    data['完工日期'] = new Date().toISOString().slice(0, 10);
  }
  // 樂觀更新
  o['狀態'] = newStatus;
  if (data['完工日期']) o['完工日期'] = data['完工日期'];
  state.viewOrder = o;
  showView('orderDetail', o);
  // 背景同步
  api('update', '訂單', { key: orderNo, data });
  if (newStatus === '完工交貨') {
    showToast('完工！背景產生請款單 PDF…');
    api('generatePDF', null, { orderNo, type: 'invoice' })
      .then(r => { if (r.success) showToast('請款單 PDF 已更新 ✓'); });
  } else {
    showToast('狀態已更新');
  }
}

// ── 訂單表單（新增/編輯）───────────────────
function renderOrderForm() {
  const o = state.editOrder || {};
  const today = new Date().toISOString().slice(0, 10);
  const newNo = generateOrderNo();

  const cusOptions = state.customers.map(c =>
    `<option value="${c['客戶名稱']}" ${o['客戶'] === c['客戶名稱'] ? 'selected' : ''}>${c['客戶名稱']}</option>`
  ).join('');

  const isNew = !state.editOrder;

  return `
  <div class="flex flex-col gap-3">

    ${isNew ? `
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
    </div>` : ''}

    <div>
      <label class="section-title">訂單編號</label>
      <input id="o_no" value="${o['訂單編號'] || newNo}" ${state.editOrder ? 'readonly' : ''}/>
    </div>
    <div>
      <label class="section-title">客戶</label>
      <select id="o_cus">
        <option value="">-- 選擇客戶 --</option>
        ${cusOptions}
      </select>
    </div>
    <div>
      <label class="section-title">開單日期</label>
      <input id="o_date" type="date" value="${o['開單日期'] || today}"/>
    </div>
    <div>
      <label class="section-title">交貨期限（選填）</label>
      <input id="o_deadline" type="date" value="${o['交貨期限'] || ''}"/>
    </div>
    <div>
      <label class="section-title">狀態</label>
      <select id="o_status">
        <option ${(o['狀態']||'進行中')==='進行中'?'selected':''}>進行中</option>
        <option ${o['狀態']==='完工交貨'?'selected':''}>完工交貨</option>
      </select>
    </div>
    <div>
      <label class="section-title">收款狀態</label>
      <select id="o_pay">
        <option ${(o['收款狀態']||'未收款')==='未收款'?'selected':''}>未收款</option>
        <option ${o['收款狀態']==='收款訂金'?'selected':''}>收款訂金</option>
        <option ${o['收款狀態']==='已收款'?'selected':''}>已收款</option>
      </select>
    </div>
    <div>
      <label class="section-title">備註</label>
      <textarea id="o_note" rows="2">${o['備註'] || ''}</textarea>
    </div>

    ${isNew ? `
    <div class="mt-2">
      <div class="flex justify-between items-center mb-2">
        <span class="section-title">品項</span>
        <button type="button" class="text-amber-400 text-sm font-bold" onclick="addItemRow()">＋ 新增品項</button>
      </div>
      <div id="itemRows">
        ${renderItemRow(0)}
      </div>
    </div>` : ''}

    <button class="btn btn-primary mt-2" onclick="saveOrder()">
      ${state.editOrder ? '儲存修改' : '建立訂單'}
    </button>
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
    <div class="grid grid-cols-2 gap-2 mb-1">
      <input placeholder="車號（選填）" id="r${idx}_plate"/>
      <input placeholder="負責師傅（選填）" id="r${idx}_worker"/>
    </div>
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
  const qty = Number(document.getElementById(`r${idx}_qty`)?.value) || 0;
  const price = Number(document.getElementById(`r${idx}_price`)?.value) || 0;
  const el = document.getElementById(`r${idx}_amt`);
  if (el) el.textContent = '$' + (qty * price).toLocaleString();
}

function generateOrderNo() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const same = state.orders.filter(o => o['訂單編號'].startsWith(today));
  const seq = String(same.length + 1).padStart(2, '0');
  return `${today}-${seq}`;
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

  if (voiceActive) {
    voiceRecognition?.stop();
    return;
  }

  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = 'zh-TW';
  voiceRecognition.interimResults = true;
  voiceRecognition.continuous = true;

  const btn = document.getElementById('voiceBtn');
  const btnIcon = document.getElementById('voiceBtnIcon');
  const btnText = document.getElementById('voiceBtnText');
  const result = document.getElementById('voiceResult');

  voiceActive = true;
  btn.classList.replace('bg-blue-600', 'bg-amber-600');
  btnIcon.textContent = '■';
  btnText.textContent = '聆聽中… 說完請點停止';

  let silenceTimer = null;
  let fullTranscript = '';

  voiceRecognition.onresult = e => {
    fullTranscript = Array.from(e.results).map(r => r[0].transcript).join('');
    result.textContent = '辨識：' + fullTranscript;

    // 偵測停頓 2 秒自動停止並送出
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      voiceRecognition.stop();
    }, 3500);
  };

  voiceRecognition.onend = () => {
    clearTimeout(silenceTimer);
    resetVoiceBtn();
    if (fullTranscript) {
      parseVoiceInput(fullTranscript);
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
  const btn = document.getElementById('voiceBtn');
  const btnIcon = document.getElementById('voiceBtnIcon');
  const btnText = document.getElementById('voiceBtnText');
  if (!btn) return;
  btn.classList.replace('bg-amber-600', 'bg-blue-600');
  btnIcon.textContent = '●';
  btnText.textContent = '再說一次';
}

function parseVoiceInput(text) {
  // 解析數字（中文數字 → 阿拉伯數字）
  const toNum = s => {
    const map = { 零:0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10,百:100,千:1000,萬:10000 };
    let n = parseInt(s.replace(/,/g, ''));
    if (!isNaN(n)) return n;
    // 簡易中文數字轉換
    let result = 0, tmp = 0;
    for (const c of s) {
      if (map[c] >= 10) { result += (tmp || 1) * map[c]; tmp = 0; }
      else if (map[c] !== undefined) tmp = map[c];
    }
    return result + tmp || null;
  };

  // 嘗試填入第一個品項列
  const row = 0;

  // 品名：取「彩繪/烤漆/改裝」等關鍵詞前後
  const nameMatch = text.match(/(.{2,10}?)(彩繪|烤漆|改裝|設計|噴漆|貼膜|拋光|鍍膜|車殼|油箱|車架)/);
  if (nameMatch) {
    const nameEl = document.getElementById(`r${row}_name`);
    if (nameEl) nameEl.value = nameMatch[1] + nameMatch[2];
  }

  // 數量：X個/X件/X台
  const qtyMatch = text.match(/(\d+|[零一二三四五六七八九十百千萬]+)\s*[個件台組套]/);
  if (qtyMatch) {
    const qty = toNum(qtyMatch[1]);
    const qtyEl = document.getElementById(`r${row}_qty`);
    if (qtyEl && qty) { qtyEl.value = qty; calcRowAmount(row); }
  }

  // 單價：X萬/X千/X百 或 $X 或 X元
  const priceMatch = text.match(/(?:單價|每[個件台])?[＄$]?(\d[\d,]*|\d+[萬千百]?\d*)\s*[元塊錢萬千]/);
  if (priceMatch) {
    const price = toNum(priceMatch[1].replace(/萬/, '0000').replace(/千/, '000').replace(/百/, '00'));
    const priceEl = document.getElementById(`r${row}_price`);
    if (priceEl && price) { priceEl.value = price; calcRowAmount(row); }
  }

  // 車號：2-4碼英文+數字組合
  const plateMatch = text.match(/[A-Z]{1,3}[-\s]?\d{3,4}|\d{3,4}[-\s]?[A-Z]{1,3}/i);
  if (plateMatch) {
    const plateEl = document.getElementById(`r${row}_plate`);
    if (plateEl) plateEl.value = plateMatch[0].toUpperCase();
  }

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

  // 填入客戶
  if (d.customer) {
    const cusEl = document.getElementById('o_cus');
    if (cusEl) {
      const opt = Array.from(cusEl.options).find(o => o.value === d.customer);
      if (opt) cusEl.value = d.customer;
    }
  }

  // 填入品項（清除舊列，重建）
  if (d.items && d.items.length) {
    // 補足品項列數
    const container = document.getElementById('itemRows');
    if (container) {
      // 清空舊列
      container.innerHTML = '';
      itemRowCount = 0;
      d.items.forEach((item, idx) => {
        const div = document.createElement('div');
        div.innerHTML = renderItemRow(idx);
        container.appendChild(div.firstElementChild);
        itemRowCount++;
        if (item.name)   document.getElementById(`r${idx}_name`).value  = item.name;
        if (item.spec)   document.getElementById(`r${idx}_spec`).value  = item.spec;
        if (item.qty)    document.getElementById(`r${idx}_qty`).value   = item.qty;
        if (item.price)  document.getElementById(`r${idx}_price`).value = item.price;
        if (item.plate)  document.getElementById(`r${idx}_plate`).value = item.plate;
        if (item.worker) document.getElementById(`r${idx}_worker`).value = item.worker;
        calcRowAmount(idx);
      });
    }
  }

  // 交貨日期
  if (d.deadline) {
    const deadlineEl = document.getElementById('o_deadline');
    if (deadlineEl) deadlineEl.value = d.deadline;
  }



  if (resultEl) resultEl.textContent = '✓ AI 解析完成，請確認後送出';
  showToast('AI 解析完成 ✓');
}

async function saveOrder() {
  const data = {
    '訂單編號': document.getElementById('o_no').value.trim(),
    '客戶':     document.getElementById('o_cus').value,
    '開單日期': document.getElementById('o_date').value,
    '交貨期限': document.getElementById('o_deadline').value,
    '狀態':     document.getElementById('o_status').value,
    '收款狀態': document.getElementById('o_pay').value,
    '備註':     document.getElementById('o_note').value.trim(),
  };
  if (!data['訂單編號']) { showToast('請填訂單編號'); return; }
  if (!data['客戶'])     { showToast('請選擇客戶'); return; }

  const isNew = !state.editOrder;
  const orderNo = data['訂單編號'];
  showLoading(true);

  if (state.editOrder) {
    await api('update', '訂單', { key: orderNo, data });
  } else {
    await api('add', '訂單', { data });
    // 收集並儲存品項
    const rows = document.querySelectorAll('[id^="itemRow_"]');
    for (const row of rows) {
      const idx = row.id.replace('itemRow_', '');
      const name = document.getElementById(`r${idx}_name`)?.value.trim();
      if (!name) continue;
      const qty   = Number(document.getElementById(`r${idx}_qty`)?.value) || 1;
      const price = Number(document.getElementById(`r${idx}_price`)?.value) || 0;
      const item = {
        '品項ID':   Date.now().toString() + idx,
        '訂單編號': orderNo,
        '品名':     name,
        '規格':     document.getElementById(`r${idx}_spec`)?.value.trim() || '',
        '數量':     qty,
        '單價':     price,
        '金額':     qty * price,
        '車號':     document.getElementById(`r${idx}_plate`)?.value.trim() || '',
        '負責師傅': document.getElementById(`r${idx}_worker`)?.value.trim() || '',
      };
      await api('add', '品項', { data: item });
    }
  }

  state.editOrder = null;
  itemRowCount = 1;
  await loadAll();
  showView('orders');

  if (isNew) {
    showToast('訂單已建立，正在產生請款單 PDF…');
    // 自動產生同月同客戶合併請款單（背景）
    api('generatePDF', null, { orderNo, type: 'invoice' })
      .then(r => { if (r.success) showToast('請款單 PDF 已更新到雲端 ✓'); });
  } else {
    showToast('已更新 ✓');
  }
}


async function deleteOrder(orderNo) {
  const btnId = 'confirmDelOrder';
  if (!document.getElementById(btnId)) {
    const btn = document.querySelector(`[onclick="deleteOrder('${orderNo}')"]`);
    if (btn) { btn.textContent = '確定刪除？再按一次確認'; btn.id = btnId; btn.classList.add('text-amber-500'); }
    setTimeout(() => { const b = document.getElementById(btnId); if (b) { b.textContent = '✕ 刪除訂單'; b.removeAttribute('id'); } }, 3000);
    return;
  }
  showLoading(true);
  await api('delete', '訂單', { key: orderNo });
  const its = state.items.filter(it => it['訂單編號'] === orderNo);
  for (const it of its) {
    await api('delete', '品項', { key: it['品項ID'] });
  }
  await loadAll();
  showView('orders');
}

// ── 客戶管理 ────────────────────────────────
function renderCustomers() {
  if (!state.customers.length) return '<p class="text-gray-500 mt-8 text-center">尚無客戶，點右上角新增</p>';
  return state.customers.map(c => `
    <div class="card flex justify-between items-center">
      <div>
        <div class="font-semibold">${c['客戶名稱']}</div>
        <div class="text-xs text-gray-400">${c['電話'] || ''} ${c['聯絡人'] ? '· ' + c['聯絡人'] : ''}</div>
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
      <input id="c_name" value="${c['客戶名稱'] || ''}" placeholder="例：太古哈雷 台照" ${state.editCustomer ? 'readonly' : ''}/>
    </div>
    <div>
      <label class="section-title">聯絡人</label>
      <input id="c_contact" value="${c['聯絡人'] || ''}"/>
    </div>
    <div>
      <label class="section-title">電話</label>
      <input id="c_phone" value="${c['電話'] || ''}" type="tel"/>
    </div>
    <div>
      <label class="section-title">統一編號</label>
      <input id="c_tax" value="${c['統一編號'] || ''}"/>
    </div>
    <div>
      <label class="section-title">地址</label>
      <input id="c_addr" value="${c['地址'] || ''}"/>
    </div>
    <div>
      <label class="section-title">備註</label>
      <textarea id="c_note" rows="2">${c['備註'] || ''}</textarea>
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
  const yearStart = `${thisYear}-01-01`;
  const yearEnd   = `${thisYear}-12-31`;

  return `
  <div class="card mb-4">
    <div class="section-title">自訂查詢</div>
    <div class="grid grid-cols-2 gap-2 mb-2">
      <div><label class="text-xs text-gray-400">起始日</label>
        <input id="s_from" type="date" value="${yearStart}"/></div>
      <div><label class="text-xs text-gray-400">結束日</label>
        <input id="s_to" type="date" value="${yearEnd}"/></div>
    </div>
    <select id="s_cus" class="mb-3">
      <option value="">全部客戶</option>
      ${state.customers.map(c => `<option>${c['客戶名稱']}</option>`).join('')}
    </select>
    <button class="btn btn-primary w-full" onclick="queryStats()">查詢</button>
  </div>
  <div id="statsResult"></div>
  <div class="section-title mt-4">各客戶累計</div>
  <div id="statsByCustomer">${renderStatsByCustomer()}</div>`;
}

function renderStatsByCustomer() {
  const map = {};
  state.orders.forEach(o => {
    const sub = orderSubtotal(o['訂單編號']);
    map[o['客戶']] = (map[o['客戶']] || 0) + sub;
  });
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total]) => `
      <div class="card flex justify-between">
        <span>${name}</span>
        <span class="text-amber-400 font-bold">$${total.toLocaleString()}</span>
      </div>`).join('') || '<p class="text-gray-500 text-sm">無資料</p>';
}

function queryStats() {
  const from = document.getElementById('s_from').value;
  const to   = document.getElementById('s_to').value;
  const cus  = document.getElementById('s_cus').value;

  const filtered = state.orders.filter(o => {
    const d = o['開單日期'];
    return d >= from && d <= to && (!cus || o['客戶'] === cus);
  });

  const total = filtered.reduce((s, o) => s + orderSubtotal(o['訂單編號']), 0);
  const detail = filtered.map(o => {
    const sub = orderSubtotal(o['訂單編號']);
    return `<div class="flex justify-between text-sm py-1 border-b border-gray-700">
      <span>${o['開單日期']} ${o['客戶']}</span>
      <span>$${sub.toLocaleString()}</span>
    </div>`;
  }).join('');

  document.getElementById('statsResult').innerHTML = `
    <div class="card">
      <div class="flex justify-between mb-3">
        <span class="text-gray-400">查詢結果（${filtered.length} 張訂單）</span>
        <span class="text-2xl font-bold text-amber-400">$${total.toLocaleString()}</span>
      </div>
      ${detail || '<p class="text-gray-500 text-sm">無符合資料</p>'}
    </div>`;
}

// ── 品項完工照片 ─────────────────────────────
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

async function uploadItemPhoto(itemId, orderNo, input) {
  const file = input.files[0];
  if (!file) return;
  const prog = document.getElementById(`itemUploadProg_${itemId}`);
  if (prog) prog.classList.remove('hidden');
  const base64 = await compressImage(file, 1024);
  const result = await api('uploadItemPhoto', null, { itemId, orderNo, base64, fileName: file.name });
  if (prog) prog.classList.add('hidden');
  input.value = '';
  if (result.error) { showToast('上傳失敗：' + result.error, 'error'); return; }
  const it = state.items.find(x => String(x['品項ID']) === String(itemId));
  if (it) {
    it['完工照片'] = (it['完工照片'] ? it['完工照片'] + ',' : '') + result.url;
    const grid = document.getElementById(`itemPhotoGrid_${itemId}`);
    if (grid) grid.innerHTML = renderItemPhotoGrid(it['完工照片'], itemId);
  }
  showToast('照片已上傳 ✓');
}

async function deleteItemPhoto(itemId, idx) {
  const it = state.items.find(x => String(x['品項ID']) === String(itemId));
  if (!it) return;
  const urls = String(it['完工照片'] || '').split(',').filter(u => u.trim());
  urls.splice(idx, 1);
  it['完工照片'] = urls.join(',');
  const grid = document.getElementById(`itemPhotoGrid_${itemId}`);
  if (grid) grid.innerHTML = renderItemPhotoGrid(it['完工照片'], itemId);
  await api('update', '品項', { key: itemId, data: { '完工照片': it['完工照片'] } });
}

// ── 完工照片（訂單層級，保留相容）──────────
function renderPhotoGrid(photoField, orderNo) {
  if (!photoField) return '<p class="text-gray-500 text-xs col-span-3">尚無照片</p>';
  const urls = String(photoField).split(',').filter(u => u.trim());
  if (!urls.length) return '<p class="text-gray-500 text-xs col-span-3">尚無照片</p>';
  return urls.map((url, idx) => `
    <div class="relative">
      <a href="${url.trim()}" target="_blank">
        <img src="${url.trim()}" class="w-full aspect-square object-cover rounded-lg border border-gray-600"/>
      </a>
      <button onclick="deletePhoto('${orderNo}',${idx})"
        class="absolute top-1 right-1 bg-gray-700 text-amber-400 rounded-full w-6 h-6 text-xs flex items-center justify-center leading-none">✕</button>
    </div>`).join('');
}

async function deletePhoto(orderNo, idx) {
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (!o) return;
  const urls = String(o['完工照片'] || '').split(',').filter(u => u.trim());
  urls.splice(idx, 1);
  const newVal = urls.join(',');
  o['完工照片'] = newVal;
  document.getElementById('photoGrid').innerHTML = renderPhotoGrid(newVal, orderNo);
  await api('update', '訂單', { key: orderNo, data: { '完工照片': newVal } });
}

async function uploadPhoto(orderNo, input) {
  const file = input.files[0];
  if (!file) return;
  const prog = document.getElementById('uploadProgress');
  prog.classList.remove('hidden');

  // 壓縮圖片
  const base64 = await compressImage(file, 1024);
  const result = await api('uploadPhoto', null, { orderNo, base64, fileName: file.name });

  prog.classList.add('hidden');
  input.value = '';

  if (result.error) { showToast('上傳失敗：' + result.error, 'error'); return; }

  // 更新本地 state
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (o) {
    const existing = o['完工照片'] ? o['完工照片'] + ',' : '';
    o['完工照片'] = existing + result.url;
    state.viewOrder = o;
    document.getElementById('photoGrid').innerHTML = renderPhotoGrid(o['完工照片'], o['訂單編號']);
  }
  showToast('照片已上傳 ✓');
}

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

// ── PDF 開啟或產生 ───────────────────────────
async function savePDF(orderNo, type) {
  const label = type === 'work' ? '生產工單' : '請款單';
  showToast(`正在查詢 ${label} PDF…`);

  // 先查雲端是否已有檔案
  const found = await api('getPDFUrl', null, { orderNo, type });
  if (found.url) {
    window.open(found.url, '_blank');
    showToast(`已開啟雲端 ${label} ✓`);
    return;
  }

  // 沒有才產生
  showToast(`正在產生 ${label} PDF…`);
  const result = await api('generatePDF', null, { orderNo, type });
  if (result.error) {
    showToast('產生失敗：' + result.error, 'error');
    return;
  }
  window.open(result.url, '_blank');
  showToast(`${label} 已存到雲端並開啟 ✓`);
}

// ── 請款單預覽（保留列印用）────────────────
function showInvoice(orderNo) {
  state.viewOrder = state.orders.find(o => o['訂單編號'] === orderNo);
  showView('invoicePreview');
}

function renderInvoicePreview() {
  const o = state.viewOrder;
  const s = state.settings;
  const its = state.items.filter(it => it['訂單編號'] === o['訂單編號']);
  const subtotal = its.reduce((sum, it) => sum + Number(it['金額']), 0);
  const taxRate = Number(s['稅率'] || 0);
  const total   = subtotal * (1 + taxRate);
  const d = new Date(o['開單日期']);
  const roc = d.getFullYear() - 1911;

  const rows = its.map(it => `
    <tr>
      <td>${it['品名']}</td>
      <td>${it['規格'] || ''}</td>
      <td style="text-align:center">${it['數量']}</td>
      <td style="text-align:right">$${Number(it['單價']).toLocaleString()}</td>
      <td style="text-align:right">$${Number(it['金額']).toLocaleString()}</td>
    </tr>`).join('');

  const html = `
  <div style="font-family:'Noto Sans TC',sans-serif; color:#000; padding:24px; max-width:600px; margin:auto; background:#fff;">
    <h2 style="text-align:center; font-size:20px; margin-bottom:16px;">${d.getMonth() + 1} 月請款單</h2>
    <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
      <div>客戶：<strong>${o['客戶']}</strong></div>
      <div>中華民國 ${roc} 年 ${d.getMonth()+1} 月 ${d.getDate()} 日</div>
    </div>
    <table style="width:100%; border-collapse:collapse; margin-bottom:12px; font-size:13px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="text-align:left; padding:6px 4px; border:1px solid #ddd;">品名</th>
          <th style="text-align:left; padding:6px 4px; border:1px solid #ddd;">規格</th>
          <th style="text-align:center; padding:6px 4px; border:1px solid #ddd;">數量</th>
          <th style="text-align:right; padding:6px 4px; border:1px solid #ddd;">單價</th>
          <th style="text-align:right; padding:6px 4px; border:1px solid #ddd;">金額</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="text-align:right; margin-bottom:4px;">未稅總和：<strong>$${subtotal.toLocaleString()}</strong></div>
    <div style="text-align:right; font-size:16px; font-weight:bold;">總額（新台幣）：$${total.toLocaleString()}</div>
    <hr style="margin:16px 0;">
    <div style="font-size:13px; line-height:2;">
      <div>報價廠商：${s['廠商名稱']||'獨品工坊'}&nbsp;&nbsp;&nbsp;負責人：${s['負責人']||'李安晟'}</div>
      <div>統一編號：${s['統一編號']||'95323326'}&nbsp;&nbsp;&nbsp;電話：${s['電話']||'0919726434'}</div>
      <div>匯款：${s['匯款銀行']||'玉山銀行 808 台中分行'}</div>
      <div>戶名：${s['匯款戶名']||'獨品工坊 李安晟'}&nbsp;&nbsp;&nbsp;帳號：${s['匯款帳號']||'1366940043038'}</div>
      <div>報價 LINE：${s['LINE']||'kingpig6'}</div>
    </div>
  </div>`;

  // 同步更新列印區域
  document.getElementById('invoicePrint').innerHTML = html;

  return `
  <div class="card mb-4">
    <div class="text-center text-gray-400 text-sm mb-2">預覽（點「列印」可匯出 PDF）</div>
    ${html}
  </div>`;
}

// ── 工具函式 ────────────────────────────────
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
      <div class="text-4xl mb-4">⚙️</div>
      <h2 class="text-amber-400 font-bold text-lg mb-2">請先設定 API</h2>
      <p class="text-gray-400 text-sm">請依 README 步驟部署 Apps Script，<br>再把網址填入 app.js 的 API_URL 變數。</p>
    </div>`;
} else {
  loadAll();
}
