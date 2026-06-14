// =============================================
// 獨品工坊開單系統 — 前端主程式
// =============================================

// ⚠️  部署 Apps Script 後，把網址貼到這裡
const API_URL = 'https://script.google.com/macros/s/AKfycbxzHdJMopMPPYvozDfrnRq3BUtcEg0QaCcVWlQEnrkPh0txbJim-JU3-FR4X0A7VTmglA/exec';

// ── PWA 註冊 ────────────────────────────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
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
};

// ── API 呼叫 ─────────────────────────────────
async function api(action, sheet, extra = {}) {
  const payload = { action, sheet, ...extra };
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return await res.json();
  } catch (e) {
    showToast('網路錯誤，請確認 API_URL 已設定', 'error');
    return { error: e.message };
  }
}

async function loadAll() {
  showLoading(true);
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
function renderOrders() {
  const active = state.orders.filter(o => o['狀態'] === '進行中');
  const done   = state.orders.filter(o => o['狀態'] === '完工交貨');

  const orderCard = o => {
    const subtotal = orderSubtotal(o['訂單編號']);
    return `
    <div class="card cursor-pointer" onclick="openOrder('${o['訂單編號']}')">
      <div class="flex justify-between items-start mb-1">
        <span class="font-semibold">${o['客戶'] || '-'}</span>
        <span class="text-amber-400 font-bold">$${subtotal.toLocaleString()}</span>
      </div>
      <div class="text-xs text-gray-400 mb-2">${o['訂單編號']} · ${o['開單日期']}</div>
      <div class="flex gap-2">
        <span class="badge-${o['狀態']} text-white text-xs px-2 py-0.5 rounded-full">${o['狀態']}</span>
        <span class="badge-${o['收款狀態']} text-white text-xs px-2 py-0.5 rounded-full">${o['收款狀態']}</span>
      </div>
    </div>`;
  };

  return `
  <div class="section-title">進行中（${active.length}）</div>
  ${active.length ? active.map(orderCard).join('') : '<p class="text-gray-500 text-sm mb-6">暫無進行中訂單</p>'}
  <div class="section-title mt-4">完工交貨（${done.length}）</div>
  ${done.length ? done.map(orderCard).join('') : '<p class="text-gray-500 text-sm">暫無完工訂單</p>'}`;
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

  const itemRows = its.map(it => `
    <div class="card flex justify-between items-center">
      <div>
        <div class="font-semibold">${it['品名']}${it['規格'] ? ' · ' + it['規格'] : ''}</div>
        <div class="text-xs text-gray-400">${it['數量']} × $${Number(it['單價']).toLocaleString()}${it['車號'] ? ' · ' + it['車號'] : ''}</div>
      </div>
      <div class="flex items-center gap-3">
        <span class="text-amber-400 font-bold">$${Number(it['金額']).toLocaleString()}</span>
        <button onclick="deleteItem('${it['品項ID']}')" class="text-red-400 text-lg">✕</button>
      </div>
    </div>`).join('');

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
      <select onchange="updateOrderField('${orderNo}','狀態',this.value)" class="flex-1 text-sm">
        <option ${o['狀態']==='進行中'?'selected':''}>進行中</option>
        <option ${o['狀態']==='完工交貨'?'selected':''}>完工交貨</option>
      </select>
      <select onchange="updateOrderField('${orderNo}','收款狀態',this.value)" class="flex-1 text-sm">
        <option ${o['收款狀態']==='未收款'?'selected':''}>未收款</option>
        <option ${o['收款狀態']==='收款訂金'?'selected':''}>收款訂金</option>
        <option ${o['收款狀態']==='已收款'?'selected':''}>已收款</option>
      </select>
    </div>
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
    <button class="btn btn-primary" onclick="showInvoice('${orderNo}')">📄 請款單</button>
    <button class="btn btn-ghost"   onclick="deleteOrder('${orderNo}')">🗑️ 刪除訂單</button>
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
  showLoading(true);
  await api('add', '品項', { data });
  await loadAll();
  showView('orderDetail', state.orders.find(o => o['訂單編號'] === orderNo));
}

async function deleteItem(id) {
  if (!confirm('確定刪除此品項？')) return;
  const it = state.items.find(x => x['品項ID'] === id);
  const orderNo = it?.['訂單編號'];
  showLoading(true);
  await api('delete', '品項', { key: id });
  await loadAll();
  showView('orderDetail', state.orders.find(o => o['訂單編號'] === orderNo));
}

// ── 訂單表單（新增/編輯）───────────────────
function renderOrderForm() {
  const o = state.editOrder || {};
  const today = new Date().toISOString().slice(0, 10);
  const newNo = generateOrderNo();

  const cusOptions = state.customers.map(c =>
    `<option value="${c['客戶名稱']}" ${o['客戶'] === c['客戶名稱'] ? 'selected' : ''}>${c['客戶名稱']}</option>`
  ).join('');

  return `
  <div class="flex flex-col gap-3">
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
    <button class="btn btn-primary mt-2" onclick="saveOrder()">
      ${state.editOrder ? '儲存修改' : '建立訂單'}
    </button>
  </div>`;
}

function generateOrderNo() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const same = state.orders.filter(o => o['訂單編號'].startsWith(today));
  const seq = String(same.length + 1).padStart(2, '0');
  return `${today}-${seq}`;
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

  showLoading(true);
  if (state.editOrder) {
    await api('update', '訂單', { key: data['訂單編號'], data });
  } else {
    await api('add', '訂單', { data });
  }
  state.editOrder = null;
  await loadAll();
  showView('orders');
  showToast(state.editOrder ? '已更新' : '訂單已建立 ✓');
}

async function updateOrderField(orderNo, field, value) {
  const o = state.orders.find(x => x['訂單編號'] === orderNo);
  if (!o) return;
  o[field] = value;
  state.viewOrder = o;
  await api('update', '訂單', { key: orderNo, data: { [field]: value } });
  showToast('已更新');
}

async function deleteOrder(orderNo) {
  if (!confirm('確定刪除這張訂單及所有品項？')) return;
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
  if (!confirm(`確定刪除客戶「${name}」？`)) return;
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

// ── 請款單 ──────────────────────────────────
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
