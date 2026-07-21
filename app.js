// =============================================
// 獨品工坊開單系統 — 前端主程式
// =============================================

// ⚠️  部署 Apps Script 後，把網址貼到這裡
const API_URL = 'https://script.google.com/macros/s/AKfycbyeGdSEt24vgZtZzrG36oA4dkSPbEjGCSTUwAZ7xGViMV7zcWG1CrmNPnDoq_XIOopsEg/exec';

// ⚠️  建立 OAuth 用戶端 ID 後填入這裡即可啟用 Google 登入權限控管（留空則維持無登入模式）
const GOOGLE_CLIENT_ID = '1037907135545-vtb7eaqjbc5765ev01pgf76h4o4jjl32.apps.googleusercontent.com';

// 登入後的使用者資訊
// sessionToken：自家長效通行證（A2，30 天）；idToken：Google 憑證（僅初次登入/重登用）
let auth = { idToken: null, sessionToken: null, email: null, name: null, role: null };
// 是否為管理員（未啟用登入時所有人視為管理員，維持舊行為）
function isAdmin() { return !GOOGLE_CLIENT_ID || auth.role === 'admin'; }

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
  myFees: [],         // 員工專用：自己的傭金／費用（負責師傅＝自己）
  customers: [],
  workers: [],
  workerRates: {},      // { 姓名: 抽成比例 }，如 { '李安': 0.1 }
  workerReturnRates: {},// { 姓名: 接單返還比例 }，如 { '李安': 0.2 }
  expenses: [],         // 支出記錄
  fixedTemplates: [],   // 固定支出模板
  settings: {},
  viewCustomer: null, // 目前查看的客戶名稱
  viewWorker: null,   // 目前查看的師傅（進行中依師傅分組時）
  viewSection: null,  // 從哪個區塊進入（active/done/invoiced/paid）
  editCustomer: null,
  loading: false,
  search: '',
};

// ── API 呼叫 ─────────────────────────────────
const API_SECRET = 'dupin2026';
const TOKEN_REFRESH_MAX_ATTEMPTS = 3;
const TOKEN_REFRESH_RETRY_DELAY_MS = 1500;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function postApi(payload) {
  return fetch(API_URL, {
    method: 'POST',
    redirect: 'follow',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
  }).then(res => res.json());
}

function isAuthError(data) {
  return !!(data && (data.error === 'LOGIN_REQUIRED' || data.error === 'TOKEN_INVALID'));
}

// 後端若夾帶新的長效 session（快到期自動續發），存起來
function captureSession(data) {
  if (data && data._session) {
    auth.sessionToken = data._session;
    localStorage.setItem('dupin_session', data._session);
  }
}

async function api(action, sheet, extra = {}) {
  const payload = { action, sheet, secret: API_SECRET, ...extra };
  if (auth.sessionToken) payload.sessionToken = auth.sessionToken;
  if (auth.idToken)      payload.idToken = auth.idToken;
  try {
    let data = await postApi(payload);
    captureSession(data);

    // 只有在「沒有長效 session」的過渡狀態才退回 Google 靜默刷新重試
    let attempts = 0;
    while (isAuthError(data) && !auth.sessionToken && attempts < TOKEN_REFRESH_MAX_ATTEMPTS) {
      attempts++;
      const refreshed = await silentTokenRefresh();
      if (refreshed) { payload.idToken = auth.idToken; data = await postApi(payload); captureSession(data); }
      else if (attempts < TOKEN_REFRESH_MAX_ATTEMPTS) await sleep(TOKEN_REFRESH_RETRY_DELAY_MS);
    }

    if (isAuthError(data)) {
      // session 失效或未登入：清掉憑證並請使用者重新登入（30 天內通常不會走到這）
      auth.idToken = null; auth.sessionToken = null;
      localStorage.removeItem('dupin_session');
      if (GOOGLE_CLIENT_ID) showLoginGate('登入已過期，請重新登入');
    } else if (data && data.error === 'FORBIDDEN') {
      showToast('權限不足，此操作僅限管理員', 'error');
    }
    return data;
  } catch (e) {
    showToast('網路錯誤，請確認 API_URL 已設定', 'error');
    return { error: e.message };
  }
}

let _silentRefreshResolve = null;

function silentTokenRefresh() {
  return new Promise(resolve => {
    if (!window.google || !google.accounts || !GOOGLE_CLIENT_ID) { resolve(false); return; }
    const timeout = setTimeout(() => { _silentRefreshResolve = null; resolve(false); }, 5000);
    // 不重新 initialize（避免 FedCM AbortError），讓 handleCredentialResponse 接收新 token
    _silentRefreshResolve = () => {
      clearTimeout(timeout);
      _silentRefreshResolve = null;
      resolve(true);
    };
    google.accounts.id.prompt(notification => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        clearTimeout(timeout);
        _silentRefreshResolve = null;
        resolve(false);
      }
    });
  });
}

// 排程下一次靜默刷新；不管上一次成功或失敗都要繼續排，避免刷新鏈中斷後就再也不會自動恢復
function scheduleTokenRefresh() {
  clearTimeout(window._tokenRefreshTimer);
  window._tokenRefreshTimer = setTimeout(async () => {
    if (!auth.email) return;
    await silentTokenRefresh();
    scheduleTokenRefresh();
  }, 50 * 60 * 1000); // 50 分鐘後靜默刷新（token 1 小時到期前）
}

// ── 離線偵測 ────────────────────────────────
window.addEventListener('online',  () => showToast('網路已恢復 ✓'));
window.addEventListener('offline', () => showToast('目前離線，操作可能不會儲存', 'error'));

const CACHE_KEY = 'dupin_cache_v2';

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      items: state.items,
      myFees: state.myFees,
      customers: state.customers,
      settings: state.settings,
      workers: state.workers,
      workerRates: state.workerRates,
      workerReturnRates: state.workerReturnRates,
      expenses: state.expenses,
      fixedTemplates: state.fixedTemplates,
      ts: Date.now(),
    }));
  } catch(e) {}
}

function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const cache = JSON.parse(raw);
    state.items       = cache.items       || [];
    state.myFees      = cache.myFees      || [];
    state.customers   = cache.customers   || [];
    state.settings    = cache.settings    || {};
    state.workers            = cache.workers            || [];
    state.workerRates        = cache.workerRates        || {};
    state.workerReturnRates  = cache.workerReturnRates  || {};
    state.expenses           = cache.expenses           || [];
    state.fixedTemplates  = cache.fixedTemplates  || [];
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

  const [wi, c, s, w, exp, ftpl] = await Promise.all([
    api('getAll', '工作項目'),
    api('getAll', '客戶'),
    api('getSettings'),
    api('getAll', '員工'),
    api('getAll', '支出記錄'),
    api('getAll', '固定支出'),
  ]);
  if (wi.data)   state.items          = wi.data.map(normalizeItem);
  if (c.data)    state.customers      = c.data;
  if (s.data)    state.settings       = s.data;
  if (exp.data)  state.expenses       = exp.data;
  if (ftpl.data) state.fixedTemplates = ftpl.data;
  if (w.data) {
    state.workers = w.data.map(r => r['姓名'] || '').filter(Boolean);
    state.workerRates = {};
    state.workerReturnRates = {};
    w.data.forEach(r => {
      if (r['姓名']) {
        state.workerRates[r['姓名']]       = Number(r['抽成比例'] || 0);
        state.workerReturnRates[r['姓名']] = Number(r['接單返還比例'] || 0);
      }
    });
  }

  if (auth.email && !isAdmin()) {
    const mf = await api('getMyFees', null, {});
    if (mf.data) state.myFees = mf.data.map(normalizeItem);
    checkPaymentCelebration();
  }

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
    進度:         it['進度']         || '待施工',
    收款狀態:     it['收款狀態']     || '未收款',
    請款單狀態:   it['請款單狀態']   || '',
    費用類型:     it['費用類型']     || '',
    費用金額:     Number(it['費用金額']) || 0,
    返還金額:     Number(it['返還金額']) || 0,
    費用支付狀態: it['費用支付狀態'] || '',
    費用支付日期: formatDate(it['費用支付日期']),
    參考圖片:     it['參考圖片']     || '',
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
  const statsNavLabel = document.getElementById('statsNavLabel');
  if (statsNavLabel) statsNavLabel.textContent = isAdmin() ? '業績' : '傭金';

  switch (state.view) {
    case 'orders':
      title.textContent = '獨品工坊';
      back.classList.add('hidden');
      actions.innerHTML = GOOGLE_CLIENT_ID && auth.email
        ? `<div class="flex items-center gap-2 text-xs">
             <span class="text-amber-400">${auth.name || auth.email}</span>
             ${auth.sessionToken
               ? `<span class="flex items-center gap-1 text-green-400" title="長效登入，30 天免重登">🟢 已登入</span>`
               : `<span class="flex items-center gap-1 text-yellow-400" title="一般登入，可能較快到期">🟡 一般</span>`}
             <button onclick="logout()" class="text-gray-400">登出</button>
           </div>`
        : '';
      app.innerHTML = renderOrders();
      break;
    case 'customerDetail': {
      const sectionLabel = { active:'進行中', done:'完工交貨', invoiced:'已開請款單', paid:'已交貨收款' };
      const secTag = state.viewSection ? ` · ${sectionLabel[state.viewSection]||''}` : '';
      title.textContent = (state.viewCustomer || state.viewWorker || '工作項目') + secTag;
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
      title.textContent = isAdmin() ? '業績統計' : '我的傭金';
      back.classList.add('hidden');
      actions.innerHTML = '';
      if (!isAdmin()) adminCommissionWorker = null;
      app.innerHTML = isAdmin() ? renderStats() : renderMyCommission();
      if (!isAdmin()) requestAnimationFrame(startCommissionAnimations);
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
    <input type="search" placeholder="搜尋客戶、品名、車號、師傅…"
      value="${state.search}"
      oninput="state.search=this.value;document.getElementById('orderListContent').innerHTML=renderOrdersContent()"
      class="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500"/>
    <span class="absolute left-3 top-2.5 text-gray-500 text-sm"></span>
  </div>
  <div id="orderListContent">${renderOrdersContent()}</div>`;
}

// 員工視角安全過濾：不管 state.items 從哪裡來（快取／登入 token 尚未就緒時的回應），
// 前端一律再擋一次，只留「進行中且未指派」的項目，避免登入瞬間的競速狀態短暫露出全部資料
function visibleItems() {
  if (isAdmin()) return state.items;
  const me = String(auth.name || '').trim();
  return state.items.filter(it => {
    const w = String(it['負責師傅'] || '').trim();
    if (!w) return it['進度'] !== '完成';   // 未指派：只看進行中
    return me && w === me;                   // 已指派：只看自己的（含完成）
  });
}

function renderOrdersContent() {
  const q = state.search.toLowerCase();
  const matchItem = it => !q ||
    (it['客戶']    ||'').toLowerCase().includes(q) ||
    (it['品名']    ||'').toLowerCase().includes(q) ||
    (it['車號']    ||'').toLowerCase().includes(q) ||
    (it['負責師傅']||'').toLowerCase().includes(q) ||
    (it['訂單編號']||'').toLowerCase().includes(q);

  const items = visibleItems();
  // 四類
  const activeItems   = items.filter(it => it['進度'] !== '完成' && matchItem(it));
  const doneItems     = items.filter(it => it['進度'] === '完成' && !it['請款單狀態'] && it['收款狀態'] !== '已收款' && matchItem(it));
  const invoicedItems = items.filter(it => it['進度'] === '完成' && it['請款單狀態'] === '已開單' && it['收款狀態'] !== '已收款' && matchItem(it));
  const paidItems     = items.filter(it => it['收款狀態'] === '已收款' && matchItem(it));

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

  // 進行中：依師傅分組
  const groupByWorker = items => {
    const map = {};
    items.forEach(it => {
      const w = String(it['負責師傅'] || '').trim() || '(未指派)';
      if (!map[w]) map[w] = [];
      map[w].push(it);
    });
    // 未指派排最前，其餘按件數多到少
    return Object.entries(map).sort((a, b) => {
      if (a[0] === '(未指派)') return -1;
      if (b[0] === '(未指派)') return 1;
      return b[1].length - a[1].length;
    });
  };

  const workerCard = (worker, items) => {
    const total  = items.reduce((s, it) => s + Number(it['金額'] || 0), 0);
    const badges = items.slice(0, 8).map(it => `
      <span class="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-gray-700 text-gray-200">
        ${it['客戶'] || ''}·${it['品名'] || '-'}
        <span class="w-1.5 h-1.5 rounded-full ${progColor[it['進度']] || 'bg-gray-500'}"></span>
      </span>`).join('');
    const more = items.length > 8 ? `<span class="text-xs text-gray-500">+${items.length - 8}</span>` : '';
    return `
    <div class="card cursor-pointer" onclick="openWorker('${worker.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}')">
      <div class="flex justify-between items-start mb-0.5">
        <span class="text-lg font-bold">${worker === '(未指派)' ? '🔧 未指派' : '👤 ' + worker}</span>
        <span class="text-gray-400 text-sm mt-1">${items.length} 件${isAdmin() ? ` · <span class="text-amber-400 font-bold">$${total.toLocaleString()}</span>` : ''}</span>
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

  // 進行中區塊：標題列含 客戶/師傅 分組切換
  const activeHeader = `
    <div class="flex justify-between items-center py-2 mt-2">
      <span class="section-title mb-0 cursor-pointer" onclick="toggleSection('active')">進行中（${activeItems.length}）</span>
      <div class="flex items-center gap-2">
        <div class="flex rounded-full bg-gray-800 border border-gray-700 overflow-hidden text-xs">
          <button onclick="setActiveGroupBy('customer')"
            class="px-3 py-1 ${activeGroupBy === 'customer' ? 'bg-amber-500 text-gray-900 font-bold' : 'text-gray-400'}">客戶</button>
          <button onclick="setActiveGroupBy('worker')"
            class="px-3 py-1 ${activeGroupBy === 'worker' ? 'bg-amber-500 text-gray-900 font-bold' : 'text-gray-400'}">師傅</button>
        </div>
        <span id="arrow-active" class="text-gray-400 text-lg cursor-pointer" onclick="toggleSection('active')">${sectionOpen.active ? '▲' : '▼'}</span>
      </div>
    </div>`;

  const activeBody = activeGroupBy === 'worker'
    ? `<div id="section-active" style="display:${sectionOpen.active ? '' : 'none'}">
        ${groupByWorker(activeItems).map(([w, its]) => workerCard(w, its)).join('')
          || '<p class="text-gray-500 text-sm mb-4">暫無進行中工作</p>'}
      </div>`
    : sectionBody(activeItems, 'active', '暫無進行中工作', 'active');

  return `
  ${activeHeader}
  ${activeBody}

  ${sectionHeader('完工交貨（未開請款單）', doneItems.length, 'done')}
  ${sectionBody(doneItems, 'done', '暫無待開請款單工作', 'done')}

  ${sectionHeader('已開請款單（未收款）', invoicedItems.length, 'invoiced')}
  ${sectionBody(invoicedItems, 'invoiced', '暫無已開請款單工作', 'invoiced')}

  ${sectionHeader('已交貨收款', paidItems.length, 'paid')}
  ${sectionBody(paidItems, 'paid', '暫無已收款工作', 'paid')}`;
}

function openCustomer(name, section) {
  state.viewWorker  = null;
  state.viewSection = section || null;
  showView('customerDetail', name);
}

// 進行中分組模式：customer / worker
let activeGroupBy = localStorage.getItem('dupin_active_groupby') || 'customer';

function setActiveGroupBy(mode) {
  activeGroupBy = mode;
  localStorage.setItem('dupin_active_groupby', mode);
  sectionOpen.active = true; // 切換分組時自動展開
  const el = document.getElementById('orderListContent');
  if (el) el.innerHTML = renderOrdersContent();
}

function openWorker(name) {
  state.viewWorker   = name;
  state.viewCustomer = null;
  state.viewSection  = 'active';
  showView('customerDetail');
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
  const worker = state.viewWorker;
  const its = visibleItems().filter(it => {
    if (!filterFn(it)) return false;
    if (worker) {
      const w = String(it['負責師傅'] || '').trim();
      return worker === '(未指派)' ? !w : w === worker;
    }
    return it['客戶'] === name;
  });
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
    const showInvSel = section === 'done' && isAdmin();
    const feeType = it['費用類型'] || '';
    const feeChip = feeType
      ? `<span class="text-xs px-1.5 py-0.5 rounded ${feeType==='接單'?'bg-teal-800 text-teal-200':(feeType==='傭金'?'bg-indigo-900 text-indigo-200':'bg-amber-900 text-amber-200')}">${feeType}</span>`
      : '';
    return `
    <div class="card" id="itemCard_${it['工作ID']}">
      <div class="flex justify-between items-start">
        ${showInvSel ? `
        <label class="shrink-0 mr-3 mt-1" onclick="event.stopPropagation()">
          <input type="checkbox" class="invSel" checked
            data-id="${String(it['工作ID']).replace(/"/g,'&quot;')}"
            data-amt="${Number(it['金額'])||0}"
            onchange="updateInvoiceBar()"
            style="width:22px;height:22px;accent-color:#f59e0b;cursor:pointer;"/>
        </label>` : ''}
        <div class="flex-1 min-w-0">
          ${worker ? `<div class="text-xs text-amber-400 font-semibold">${it['客戶'] || ''}</div>` : ''}
          <div class="font-semibold flex items-center gap-1.5">${it['品名'] || '-'}${it['規格'] ? ' · ' + it['規格'] : ''}${feeChip}</div>
          <div class="text-xs text-gray-400 mb-1">
            ${it['數量']} × $${Number(it['單價']).toLocaleString()}
            ${it['車號'] ? ' · ' + it['車號'] : ''}
            ${it['負責師傅'] ? ' · ' + it['負責師傅'] : ''}
          </div>
          <div class="text-xs text-gray-500 mb-1">
            ${it['訂單編號'] || ''}
            ${it['開單日期'] ? ' · 開 ' + it['開單日期'] : ''}
            ${it['交貨期限'] ? ' · 交 ' + it['交貨期限'] : ''}
            ${it['建立者'] ? ' · 開單人 ' + it['建立者'] : ''}
          </div>
          ${it['備註'] ? `<div class="text-xs text-gray-500 mb-1">備註：${it['備註']}</div>` : ''}
          ${it['完工日期'] ? `<div class="text-xs text-amber-400 mb-1">完工：${it['完工日期']}</div>` : ''}
          ${it['請款單狀態'] === '已開單' ? `<div class="text-xs text-blue-400 mb-1">請款單已開</div>` : ''}
          ${(() => {
            const refs = String(it['參考圖片']||'').split(',').filter(u=>u.trim());
            if (!refs.length) return '';
            const urlsArg = refs.map(u=>`'${u.trim()}'`).join(',');
            return `<button onclick="openLightbox([${urlsArg}],0)" class="text-xs text-purple-400 mt-1 flex items-center gap-1">📎 ${refs.length} 張參考圖</button>`;
          })()}
          ${(() => {
            const photos = String(it['完工照片']||'').split(',').filter(u=>u.trim());
            if (!photos.length) return '';
            const urlsArg = photos.map(u=>`'${u.trim()}'`).join(',');
            return `<button onclick="openLightbox([${urlsArg}],0)" class="text-xs text-amber-400 mt-1 flex items-center gap-1">📷 ${photos.length} 張完工照片</button>`;
          })()}
          <div class="flex items-center gap-2 flex-wrap mt-1">
            <select onchange="cycleProgress('${it['工作ID']}',this.value)"
              class="${color} text-white text-xs px-2 py-0.5 rounded-full font-semibold border-0 outline-none cursor-pointer w-auto">
              <option value="待施工" ${prog==='待施工'?'selected':''}>待施工</option>
              <option value="施工中" ${prog==='施工中'?'selected':''}>施工中</option>
              <option value="完成"   ${prog==='完成'?'selected':''}>完成</option>
            </select>
            ${isAdmin() ? `
            <select onchange="updateItemField('${it['工作ID']}','收款狀態',this.value)"
              class="${payColor} text-white text-xs px-2 py-0.5 rounded-full font-semibold border-0 outline-none cursor-pointer w-auto">
              <option value="未收款" ${(it['收款狀態']||'未收款')==='未收款'?'selected':''}>未收款</option>
              <option value="已收款" ${it['收款狀態']==='已收款'?'selected':''}>已收款</option>
            </select>
            ` : `
            <span class="${payColor} text-white text-xs px-2 py-0.5 rounded-full font-semibold">${it['收款狀態']||'未收款'}</span>
            `}
          </div>
        </div>
        <div class="flex flex-col items-end gap-2 ml-3 shrink-0">
          <span class="text-amber-400 font-bold">$${Number(it['金額'] || 0).toLocaleString()}</span>
          <button onclick="editItem('${it['工作ID']}')" class="text-amber-400 text-sm" title="編輯">✎</button>
          <button onclick="duplicateItem('${it['工作ID']}')" class="text-amber-400 text-sm" title="複製成多件">⧉</button>
          ${isAdmin() ? `<button onclick="deleteItem('${it['工作ID']}')" class="text-amber-400 text-sm" title="刪除">✕</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  // 底部按鈕：done 區塊顯示「開請款單」；done/invoiced 區塊顯示「批量收款」
  const isDone     = state.viewSection === 'done';
  const isInvoiced = state.viewSection === 'invoiced';
  let actionBtns = '';
  if (isDone && its.length > 0 && isAdmin()) {
    const total = its.reduce((s, it) => s + Number(it['金額'] || 0), 0);
    actionBtns += `
    <div class="flex justify-between items-center mb-1">
      <button class="text-xs text-gray-400 underline" onclick="toggleAllInvSel()">全選／全不選</button>
      <span class="text-xs text-gray-400">勾選要開請款單的項目</span>
    </div>
    <button id="invoiceBtn" class="btn btn-primary text-sm mt-1 w-full"
      onclick="openInvoiceSelected(this)">
      開請款單（${its.length} 件 · $${total.toLocaleString()}）
    </button>`;
  }
  if ((isDone || isInvoiced) && its.length > 0) {
    const unpaidIds = its.filter(it => it['收款狀態'] !== '已收款').map(it => it['工作ID']);
    if (unpaidIds.length > 0) {
      const idsArg = "[" + unpaidIds.map(id => "'" + String(id).replace(/'/g, "\\'") + "'").join(",") + "]";
      actionBtns += `<button class="btn btn-ghost text-sm mt-2 w-full"
        style="background:#166534;color:#fff;"
        onclick="batchMarkPaid(${idsArg})">
        ✓ 批量收款（${unpaidIds.length} 件）
      </button>`;
    }
  }

  return `
  <div class="card mb-3">
    <div class="flex justify-between items-center">
      <div class="font-bold text-lg">${worker ? (worker === '(未指派)' ? '🔧 未指派' : '👤 ' + worker) : name}</div>
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
      <select id="ei_customer" class="col-span-2">
        ${state.customers.map(c => `<option value="${c['客戶名稱']||''}" ${it['客戶']===(c['客戶名稱']||'')?'selected':''}>${c['客戶名稱']||''}</option>`).join('')}
      </select>
      <input id="ei_name"  value="${it['品名']||''}"       placeholder="品名"/>
      <input id="ei_spec"  value="${it['規格']||''}"       placeholder="規格"/>
      <input id="ei_qty"   value="${it['數量']||1}"        type="number" placeholder="數量"
        oninput="document.getElementById('ei_amt').textContent='$'+((this.value||0)*(document.getElementById('ei_price').value||0)).toLocaleString();onEditFeeTypeChange()"/>
      <input id="ei_price" value="${it['單價']||''}"       type="number" placeholder="單價"
        oninput="document.getElementById('ei_amt').textContent='$'+((document.getElementById('ei_qty').value||1)*this.value).toLocaleString();onEditFeeTypeChange()"/>
      <input id="ei_plate"  value="${it['車號']||''}"      placeholder="車號（選填）"/>
      <select id="ei_worker" onchange="onEditFeeTypeChange()">
        <option value="">負責師傅（選填）</option>
        ${state.workers.map(w => `<option value="${w}" ${it['負責師傅']===w?'selected':''}>${w}</option>`).join('')}
      </select>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-1">
      <select id="ei_fee_type" onchange="onEditFeeTypeChange()">
        <option value="" ${!it['費用類型']?'selected':''}>無費用</option>
        <option value="傭金" ${it['費用類型']==='傭金'?'selected':''}>傭金（固定）</option>
        <option value="抽成" ${it['費用類型']==='抽成'?'selected':''}>抽成（比例）</option>
        <option value="接單" ${it['費用類型']==='接單'?'selected':''}>接單（返還公司）</option>
      </select>
      <input id="ei_fee_amt" type="number" placeholder="費用金額" value="${Number(it['費用金額'])||''}"/>
    </div>
    <div id="ei_fee_info" class="text-xs text-amber-400 mb-2 min-h-4"></div>
    <div class="mb-2">
      <label class="section-title">交貨期限</label>
      <input id="ei_deadline" type="date" value="${it['交貨期限']||''}"/>
    </div>
    <textarea id="ei_note" rows="2" placeholder="備註（選填）" class="w-full mb-2">${it['備註']||''}</textarea>
    <div class="flex justify-between items-center mb-3">
      <span class="text-xs text-gray-400">金額：<span id="ei_amt" class="text-amber-400">$${Number(it['金額']).toLocaleString()}</span></span>
      <div class="flex gap-2">
        <button onclick="showView('customerDetail',state.viewCustomer)" class="btn btn-ghost text-sm px-3">取消</button>
        <button onclick="saveItem('${id}',this)" class="btn btn-primary text-sm px-3">儲存</button>
      </div>
    </div>
    <div class="border-t border-gray-600 pt-3 mb-3">
      <div class="flex justify-between items-center mb-2">
        <span class="text-xs text-gray-400">參考圖片（施工用）</span>
        <label class="btn btn-ghost text-xs cursor-pointer">
          上傳
          <input type="file" accept="image/*" multiple class="hidden"
            onchange="uploadRefPhoto('${id}',this)">
        </label>
      </div>
      <div id="refPhotoGrid_${id}" class="grid grid-cols-3 gap-2">
        ${renderRefPhotoGrid(it['參考圖片'], id)}
      </div>
      <div id="refUploadProg_${id}" class="hidden text-xs text-amber-400 text-center mt-1">上傳中…</div>
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
  // 抽成類型：以目前 數量×單價 重算費用（修正舊資料只按單價算的金額）
  if (it['費用類型'] === '抽成' || it['費用類型'] === '接單') onEditFeeTypeChange();
}

async function saveItem(id, btn) {
  if (btn && btn.disabled) return;
  const it = state.items.find(x => String(x['工作ID']) === String(id));
  if (!it) return;
  const qty   = Number(document.getElementById('ei_qty').value)   || 1;
  const price = Number(document.getElementById('ei_price').value) || 0;
  const data = {
    '客戶':     document.getElementById('ei_customer').value,
    '品名':     document.getElementById('ei_name').value.trim(),
    '規格':     document.getElementById('ei_spec').value.trim(),
    '數量':     qty,
    '單價':     price,
    '金額':     qty * price,
    '交貨期限': document.getElementById('ei_deadline').value,
    '車號':     document.getElementById('ei_plate').value.trim(),
    '負責師傅': document.getElementById('ei_worker').value.trim(),
    '費用類型': document.getElementById('ei_fee_type').value,
    '費用金額': Number(document.getElementById('ei_fee_amt').value) || 0,
    '返還金額': (() => {
      if (document.getElementById('ei_fee_type').value !== '接單') return 0;
      const w = document.getElementById('ei_worker').value.trim();
      return qty * price - Math.round(qty * price * returnRateOf(w));
    })(),
    '費用支付狀態': (() => {
      const newType = document.getElementById('ei_fee_type').value;
      if (!newType) return '';
      if (it['費用支付狀態'] === '已支付') return '已支付';
      return '未支付';
    })(),
    '備註':     document.getElementById('ei_note').value.trim(),
  };
  Object.assign(it, data);
  showView('customerDetail', state.viewCustomer);
  saveCache();
  await withBtn(btn, async () => {
    await api('update', '工作項目', { key: id, data });
    showToast('品項已更新 ✓');
  });
}

async function deleteItem(id) {
  if (!document.getElementById('confirmDel_' + id)) {
    const btn = document.querySelector(`[onclick="deleteItem('${id}')"]`);
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

// ── 複製工作項目（拆成多件各自可獨立追蹤進度）────
function duplicateItem(id) {
  const card = document.getElementById(`itemCard_${id}`);
  if (!card || document.getElementById(`dupPanel_${id}`)) return;
  const panel = document.createElement('div');
  panel.id = `dupPanel_${id}`;
  panel.className = 'mt-3 pt-3 border-t border-gray-600';
  panel.dataset.n = '1';
  panel.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <span class="text-xs text-gray-400">另外複製幾件獨立項目？</span>
      <div class="flex items-center gap-2">
        <button onclick="stepDup('${id}',-1)" class="btn btn-ghost text-sm px-3 py-1">−</button>
        <span id="dupN_${id}" class="w-8 text-center font-bold text-amber-400">1</span>
        <button onclick="stepDup('${id}',1)" class="btn btn-ghost text-sm px-3 py-1">＋</button>
      </div>
    </div>
    <div class="text-xs text-gray-500 mt-1">複本會複製內容與費用設定，進度重設為待施工、清空完工/收款</div>
    <div class="flex gap-2 mt-2">
      <button onclick="closeDup('${id}')" class="btn btn-ghost text-sm flex-1">取消</button>
      <button onclick="confirmDuplicate('${id}',this)" class="btn btn-primary text-sm flex-1">建立複本</button>
    </div>`;
  card.appendChild(panel);
}

function stepDup(id, delta) {
  const panel = document.getElementById(`dupPanel_${id}`);
  if (!panel) return;
  let n = Math.max(1, Math.min(50, Number(panel.dataset.n || 1) + delta));
  panel.dataset.n = String(n);
  const label = document.getElementById(`dupN_${id}`);
  if (label) label.textContent = n;
}

function closeDup(id) {
  document.getElementById(`dupPanel_${id}`)?.remove();
}

async function confirmDuplicate(id, btn) {
  if (btn && btn.disabled) return;
  const src = state.items.find(x => String(x['工作ID']) === String(id));
  if (!src) return;
  const panel = document.getElementById(`dupPanel_${id}`);
  const n = Math.max(1, Math.min(50, Number(panel?.dataset.n || 1)));

  const base = Date.now();
  const copies = Array.from({ length: n }, (_, i) => ({
    '工作ID':       'W' + (base + i).toString(),
    '訂單編號':     src['訂單編號'] || '',
    '客戶':         src['客戶'] || '',
    '開單日期':     new Date().toISOString().slice(0, 10),
    '品名':         src['品名'] || '',
    '規格':         src['規格'] || '',
    '數量':         src['數量'] || 1,
    '單價':         src['單價'] || 0,
    '金額':         src['金額'] || 0,
    '交貨期限':     src['交貨期限'] || '',
    '進度':         '待施工',
    '完工日期':     '',
    '收款狀態':     '未收款',
    '車號':         src['車號'] || '',
    '負責師傅':     src['負責師傅'] || '',
    '備註':         src['備註'] || '',
    '完工照片':     '',
    '參考圖片':     src['參考圖片'] || '',
    '請款單狀態':   '',
    '費用類型':     src['費用類型'] || '',
    '費用金額':     src['費用類型'] ? (Number(src['費用金額']) || 0) : 0,
    '返還金額':     src['費用類型'] === '接單' ? (Number(src['返還金額']) || 0) : 0,
    '費用支付狀態': src['費用類型'] ? '未支付' : '',
    '費用支付日期': '',
  }));

  await withBtn(btn, async () => {
    const r = await api('addBatch', '工作項目', { rows: copies });
    if (r.error) { showToast('複製失敗：' + r.error, 'error'); return; }
    state.items.push(...copies.map(normalizeItem));
    saveCache();
    showView('customerDetail', state.viewCustomer);
    showToast(`已複製 ${n} 件 ✓`);
  });
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

// ── Lightbox ─────────────────────────────────
let _lbUrls = [], _lbIdx = 0;

function openLightbox(urls, idx) {
  _lbUrls = urls; _lbIdx = idx;
  let lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.92);z-index:999;display:flex;flex-direction:column;align-items:center;justify-content:center;touch-action:none;';
    lb.innerHTML = `
      <button onclick="closeLightbox()" style="position:absolute;top:16px;right:16px;color:#fff;font-size:28px;background:none;border:none;cursor:pointer;z-index:1000;">✕</button>
      <div id="lb_counter" style="position:absolute;top:20px;left:50%;transform:translateX(-50%);color:#aaa;font-size:13px;"></div>
      <img id="lb_img" style="max-width:95vw;max-height:82vh;object-fit:contain;border-radius:8px;user-select:none;" draggable="false"/>
      <div style="display:flex;gap:24px;margin-top:16px;">
        <button onclick="lbPrev()" id="lb_prev" style="color:#fff;font-size:28px;background:none;border:none;cursor:pointer;padding:8px 16px;">‹</button>
        <button onclick="lbNext()" id="lb_next" style="color:#fff;font-size:28px;background:none;border:none;cursor:pointer;padding:8px 16px;">›</button>
      </div>`;
    lb.addEventListener('click', e => { if (e.target === lb) closeLightbox(); });
    // 左右滑動支援
    let tx = 0;
    lb.addEventListener('touchstart', e => { tx = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - tx;
      if (Math.abs(dx) > 50) dx < 0 ? lbNext() : lbPrev();
    }, { passive: true });
    document.body.appendChild(lb);
  }
  lb.style.display = 'flex';
  lbShow();
}

function lbShow() {
  document.getElementById('lb_img').src = _lbUrls[_lbIdx];
  document.getElementById('lb_counter').textContent = _lbUrls.length > 1 ? `${_lbIdx + 1} / ${_lbUrls.length}` : '';
  document.getElementById('lb_prev').style.opacity = _lbIdx > 0 ? '1' : '0.2';
  document.getElementById('lb_next').style.opacity = _lbIdx < _lbUrls.length - 1 ? '1' : '0.2';
}

function lbPrev() { if (_lbIdx > 0) { _lbIdx--; lbShow(); } }
function lbNext() { if (_lbIdx < _lbUrls.length - 1) { _lbIdx++; lbShow(); } }
function closeLightbox() { const lb = document.getElementById('lightbox'); if (lb) lb.style.display = 'none'; }

// 鍵盤操作
document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox') || document.getElementById('lightbox').style.display === 'none') return;
  if (e.key === 'ArrowLeft') lbPrev();
  if (e.key === 'ArrowRight') lbNext();
  if (e.key === 'Escape') closeLightbox();
});

// ── 參考圖片 ─────────────────────────────────
function renderRefPhotoGrid(photoField, itemId) {
  if (!photoField) return '<p class="text-gray-500 text-xs col-span-3">尚無參考圖片</p>';
  const urls = String(photoField).split(',').filter(u => u.trim());
  if (!urls.length) return '<p class="text-gray-500 text-xs col-span-3">尚無參考圖片</p>';
  return urls.map((url, idx) => `
    <div class="relative">
      <a href="${url.trim()}" target="_blank">
        <img src="${url.trim()}" class="w-full aspect-square object-cover rounded-lg border border-gray-600"/>
      </a>
      <button onclick="deleteRefPhoto('${itemId}',${idx})"
        class="absolute top-1 right-1 bg-gray-700 text-amber-400 rounded-full w-6 h-6 text-xs flex items-center justify-center leading-none">✕</button>
    </div>`).join('');
}

async function uploadRefPhoto(itemId, input) {
  const files = Array.from(input.files || []);
  if (!files.length) return;
  const prog = document.getElementById(`refUploadProg_${itemId}`);
  const it = state.items.find(x => String(x['工作ID']) === String(itemId));
  let done = 0, failed = 0;
  for (let i = 0; i < files.length; i++) {
    if (prog) {
      prog.classList.remove('hidden');
      prog.textContent = `上傳中… ${i + 1} / ${files.length}`;
    }
    const base64 = await compressImage(files[i], 1024);
    const result = await api('uploadRefPhoto', null, { itemId, base64, fileName: files[i].name });
    if (result && result.url) {
      done++;
      if (it) {
        it['參考圖片'] = (it['參考圖片'] ? it['參考圖片'] + ',' : '') + result.url;
        const grid = document.getElementById(`refPhotoGrid_${itemId}`);
        if (grid) grid.innerHTML = renderRefPhotoGrid(it['參考圖片'], itemId);
      }
    } else failed++;
  }
  if (prog) prog.classList.add('hidden');
  input.value = '';
  saveCache();
  showToast(failed ? `參考圖：${done} 張成功、${failed} 張失敗` : `參考圖已上傳 ${done} 張 ✓`, failed ? 'error' : 'success');
}

async function deleteRefPhoto(itemId, idx) {
  const it = state.items.find(x => String(x['工作ID']) === String(itemId));
  if (!it) return;
  const urls = String(it['參考圖片'] || '').split(',').filter(u => u.trim());
  urls.splice(idx, 1);
  it['參考圖片'] = urls.join(',');
  const grid = document.getElementById(`refPhotoGrid_${itemId}`);
  if (grid) grid.innerHTML = renderRefPhotoGrid(it['參考圖片'], itemId);
  await api('update', '工作項目', { key: itemId, data: { '參考圖片': it['參考圖片'] } });
  saveCache();
}

// ── 批量收款 ──────────────────────────────────
async function batchMarkPaid(itemIds) {
  if (!confirm(`確定將 ${itemIds.length} 件工作項目標記為「已收款」？`)) return;
  if (!confirm(`再次確認：${itemIds.length} 件全部標記已收款，此操作無法批量還原。`)) return;
  itemIds.forEach(id => {
    const it = state.items.find(x => String(x['工作ID']) === String(id));
    if (it) it['收款狀態'] = '已收款';
  });
  showView('customerDetail', state.viewCustomer);
  saveCache();
  showToast(`正在更新 ${itemIds.length} 件...`);
  await Promise.all(itemIds.map(id =>
    api('update', '工作項目', { key: id, data: { '收款狀態': '已收款' } })
  ));
  showToast(`已收款完成（${itemIds.length} 件）`);
}

// ── 請款單勾選 ───────────────────────────────
function updateInvoiceBar() {
  const boxes = Array.from(document.querySelectorAll('.invSel'));
  const sel   = boxes.filter(b => b.checked);
  const total = sel.reduce((s, b) => s + Number(b.dataset.amt || 0), 0);
  const btn   = document.getElementById('invoiceBtn');
  if (!btn) return;
  if (!sel.length) {
    btn.disabled = true;
    btn.textContent = '請先勾選項目';
    btn.classList.add('opacity-50');
  } else {
    btn.disabled = false;
    btn.classList.remove('opacity-50');
    btn.textContent = `開請款單（${sel.length} 件 · $${total.toLocaleString()}）`;
  }
}

function toggleAllInvSel() {
  const boxes = Array.from(document.querySelectorAll('.invSel'));
  const allChecked = boxes.every(b => b.checked);
  boxes.forEach(b => { b.checked = !allChecked; });
  updateInvoiceBar();
}

function openInvoiceSelected(btn) {
  const ids = Array.from(document.querySelectorAll('.invSel'))
    .filter(b => b.checked)
    .map(b => b.dataset.id);
  if (!ids.length) { showToast('請先勾選項目'); return; }
  openInvoice(ids);
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
      <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden')" class="w-full flex items-center justify-between">
        <span class="section-title mb-0">語音開單</span>
        <span class="text-xs text-gray-400">Android Chrome 適用 ▼</span>
      </button>
      <div class="hidden mt-3">
        <p class="text-xs text-gray-400 mb-3">按下麥克風，說出品項資訊，自動填入表單</p>
        <div id="voiceResult" class="text-xs text-amber-300 mb-2 min-h-4"></div>
        <button type="button" id="voiceBtn" onclick="startVoice()"
          class="w-full py-3 rounded-lg font-bold text-white bg-blue-600 active:bg-blue-800 flex items-center justify-center gap-2">
          <span id="voiceBtnIcon">●</span><span id="voiceBtnText">開始語音輸入</span>
        </button>
      </div>
    </div>

    <div class="card bg-gray-800 border border-gray-600">
      <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden')" class="w-full flex items-center justify-between">
        <span class="section-title mb-0">文字開單</span>
        <span class="text-xs text-gray-400">AI 解析訊息 ▼</span>
      </button>
      <div class="hidden mt-3">
        <p class="text-xs text-gray-400 mb-3">貼上 LINE 訊息或任何文字描述，AI 自動解析品名、規格、備註等</p>
        <div id="imgResult" class="text-xs text-amber-300 mb-2 min-h-4"></div>
        <textarea id="textOrderInput" rows="4" placeholder="貼上訊息內容，例如：烤漆鴨尾白地圖L，6/20前交貨，完工後一起寄到高雄"></textarea>
        <button type="button" onclick="parseTextOrder()" class="w-full mt-2 py-3 rounded-lg font-bold text-white bg-purple-700 active:bg-purple-900">
          ✨ AI 解析文字
        </button>
      </div>
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
        <button type="button" onclick="confirmAddCustomer(this)" class="btn btn-primary text-sm px-3 shrink-0">確認</button>
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

    <button class="btn btn-primary mt-2" onclick="saveNewItems(this)">建立工作項目</button>
  </div>`;
}

// 員工開單時，負責師傅只能選自己或留空；老闆維持看得到全部名單
function workerOptions() {
  if (isAdmin()) return state.workers;
  const me = String(auth.name || '').trim();
  return state.workers.filter(w => w === me);
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
      <select id="r${idx}_worker" onchange="onFeeTypeChange(${idx})">
        <option value="">負責師傅（選填）</option>
        ${workerOptions().map(w => `<option value="${w}">${w}</option>`).join('')}
      </select>
    </div>
    <div class="grid grid-cols-2 gap-2 mb-1">
      <select id="r${idx}_fee_type" onchange="onFeeTypeChange(${idx})">
        <option value="">無費用</option>
        <option value="傭金">傭金（固定）</option>
        <option value="抽成">抽成（比例）</option>
        <option value="接單">接單（返還公司）</option>
      </select>
      <input id="r${idx}_fee_amt" type="number" placeholder="費用金額"/>
    </div>
    <div id="r${idx}_fee_info" class="text-xs text-amber-400 mb-2 min-h-4"></div>
    <div class="mb-2">
      <label class="text-xs text-gray-400">交貨期限（選填）</label>
      <input type="date" id="r${idx}_deadline"/>
    </div>
    <textarea placeholder="備註（選填）" rows="2" id="r${idx}_note" class="w-full mb-1"></textarea>
    <div class="flex items-center gap-2 mb-1">
      <label class="btn btn-ghost text-xs cursor-pointer shrink-0">
        📎 加參考圖
        <input type="file" accept="image/*" multiple class="hidden" id="r${idx}_ref"
          onchange="document.getElementById('r${idx}_ref_count').textContent=this.files.length?('已選 '+this.files.length+' 張'):''"/>
      </label>
      <span id="r${idx}_ref_count" class="text-xs text-purple-400"></span>
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
  const qty   = Number(document.getElementById(`r${idx}_qty`)?.value)   || 0;
  const price = Number(document.getElementById(`r${idx}_price`)?.value) || 0;
  const el = document.getElementById(`r${idx}_amt`);
  if (el) el.textContent = '$' + (qty * price).toLocaleString();
  onFeeTypeChange(idx);
}

function onFeeTypeChange(idx) {
  const feeTypeEl = document.getElementById(`r${idx}_fee_type`);
  const feeAmtEl  = document.getElementById(`r${idx}_fee_amt`);
  const infoEl    = document.getElementById(`r${idx}_fee_info`);
  if (!feeTypeEl) return;
  const feeType = feeTypeEl.value;
  const worker = document.getElementById(`r${idx}_worker`)?.value || '';
  const qty    = Number(document.getElementById(`r${idx}_qty`)?.value)   || 0;
  const price  = Number(document.getElementById(`r${idx}_price`)?.value) || 0;
  const amt    = qty * price;
  if (feeType === '接單') {
    const rate   = returnRateOf(worker);
    const income = Math.round(amt * rate);
    const ret    = amt - income;
    if (feeAmtEl) feeAmtEl.value = income;
    if (infoEl) infoEl.textContent = rate
      ? `接單分成 ${(rate*100).toFixed(0)}% → 員工實得 $${income.toLocaleString()}，返還公司 $${ret.toLocaleString()}`
      : '（此師傅尚未設定接單分成比例）';
  } else if (feeType === '抽成') {
    const rate = feeRateOf(worker);
    const fee  = Math.round(amt * rate);
    if (feeAmtEl) feeAmtEl.value = fee;
    if (infoEl) infoEl.textContent = rate ? `抽成 ${(rate*100).toFixed(0)}% = $${fee.toLocaleString()}` : '（此師傅尚未設定抽成比例）';
  } else {
    if (infoEl) infoEl.textContent = '';
  }
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

async function confirmAddCustomer(btn) {
  if (btn && btn.disabled) return;
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
  await withBtn(btn, async () => {
    await api('add', '客戶', { data: { '客戶名稱': name } });
    showToast(`已新增客戶：${name} ✓`);
  });
}

async function saveNewItems(btn) {
  if (btn && btn.disabled) return;
  const customer = document.getElementById('o_cus').value;
  const openDate = document.getElementById('o_date').value;
  if (!customer) { showToast('請選擇客戶'); return; }

  const rows = document.querySelectorAll('[id^="itemRow_"]');
  const toSave = [];
  const refFilesList = []; // 與 toSave 對齊：每列選取的參考圖 File 陣列
  for (const row of rows) {
    const idx  = row.id.replace('itemRow_', '');
    const name = document.getElementById(`r${idx}_name`)?.value.trim();
    if (!name) continue;
    const qty   = Number(document.getElementById(`r${idx}_qty`)?.value)      || 1;
    const price = Number(document.getElementById(`r${idx}_price`)?.value)    || 0;
    refFilesList.push(Array.from(document.getElementById(`r${idx}_ref`)?.files || []));
    toSave.push({
      '品名':     name,
      '規格':     document.getElementById(`r${idx}_spec`)?.value.trim()     || '',
      '數量':     qty,
      '單價':     price,
      '金額':     qty * price,
      '交貨期限': document.getElementById(`r${idx}_deadline`)?.value        || '',
      '車號':     document.getElementById(`r${idx}_plate`)?.value.trim()    || '',
      '負責師傅': document.getElementById(`r${idx}_worker`)?.value.trim()   || '',
      '費用類型':     document.getElementById(`r${idx}_fee_type`)?.value        || '',
      '費用金額':     Number(document.getElementById(`r${idx}_fee_amt`)?.value) || 0,
      '返還金額':     (() => {
        const ft = document.getElementById(`r${idx}_fee_type`)?.value;
        if (ft !== '接單') return 0;
        const w = document.getElementById(`r${idx}_worker`)?.value || '';
        return qty * price - Math.round(qty * price * returnRateOf(w));
      })(),
      '費用支付狀態': document.getElementById(`r${idx}_fee_type`)?.value ? '未支付' : '',
      '費用支付日期': '',
      '備註':         document.getElementById(`r${idx}_note`)?.value.trim()     || '',
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
    '參考圖片':   '',
    '請款單狀態': '',
    ...t,
  }));

  await withBtn(btn, async () => {
    const r = await api('addBatch', '工作項目', { rows: payloadRows });
    if (r.error) { showToast('建立失敗：' + r.error, 'error'); return; }
    state.items.push(...payloadRows);
    saveCache();
    itemRowCount = 1;
    showView('orders');
    showToast(`已建立 ${payloadRows.length} 件工作項目 ✓`);

    // 上傳各列選取的參考圖
    const totalRefs = refFilesList.reduce((s, fs) => s + fs.length, 0);
    if (totalRefs > 0) {
      showToast(`參考圖上傳中（${totalRefs} 張）…`);
      let done = 0, failed = 0;
      for (let i = 0; i < payloadRows.length; i++) {
        const itemId = payloadRows[i]['工作ID'];
        for (const file of refFilesList[i]) {
          const base64 = await compressImage(file, 1024);
          const res = await api('uploadRefPhoto', null, { itemId, base64, fileName: file.name });
          if (res && res.url) {
            const it = state.items.find(x => String(x['工作ID']) === String(itemId));
            if (it) it['參考圖片'] = (it['參考圖片'] ? it['參考圖片'] + ',' : '') + res.url;
            done++;
          } else failed++;
        }
      }
      saveCache();
      render();
      showToast(failed ? `參考圖：${done} 張成功、${failed} 張失敗` : `參考圖已上傳 ${done} 張 ✓`, failed ? 'error' : 'success');
    }
  });
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

// ── 文字開單 ─────────────────────────────────
async function parseTextOrder() {
  const input = document.getElementById('textOrderInput');
  const text = (input?.value || '').trim();
  if (!text) { showToast('請先輸入文字內容'); return; }
  const resultEl = document.getElementById('imgResult');
  if (resultEl) resultEl.textContent = '⏳ AI 解析中…';

  const customerNames = state.customers.map(c => c['客戶名稱']);
  const res = await api('parseText', null, { text, customers: customerNames });

  if (!res.success || !res.data) {
    if (resultEl) resultEl.textContent = 'AI 解析失敗：' + (res.error || 'unknown');
    showToast('文字解析失敗');
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
  if (d.deadline) {
    const dateEl = document.getElementById('o_date');
    if (dateEl && d.deadline) dateEl.value = d.deadline;
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
        if (item.qty)    document.getElementById(`r${idx}_qty`).value      = item.qty  || 1;
        if (item.price)  document.getElementById(`r${idx}_price`).value    = item.price || '';
        if (item.plate)  document.getElementById(`r${idx}_plate`).value    = item.plate || '';
        if (item.worker) document.getElementById(`r${idx}_worker`).value   = item.worker || '';
        if (item.note)   document.getElementById(`r${idx}_note`).value     = item.note  || '';
        if (d.deadline)  document.getElementById(`r${idx}_deadline`).value = d.deadline;
        calcRowAmount(idx);
      });
    }
  }
  if (resultEl) resultEl.textContent = '✓ 解析完成，請確認後送出';
  showToast('文字解析完成 ✓');
  if (input) input.value = '';
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
    <button class="btn btn-primary mt-2" onclick="saveCustomer(this)">
      ${state.editCustomer ? '儲存修改' : '新增客戶'}
    </button>
    ${state.editCustomer ? `<button class="btn btn-danger" onclick="deleteCustomer('${c['客戶名稱']}')">刪除客戶</button>` : ''}
  </div>`;
}

async function saveCustomer(btn) {
  if (btn && btn.disabled) return;
  const data = {
    '客戶名稱': document.getElementById('c_name').value.trim(),
    '聯絡人':   document.getElementById('c_contact').value.trim(),
    '電話':     document.getElementById('c_phone').value.trim(),
    '統一編號': document.getElementById('c_tax').value.trim(),
    '地址':     document.getElementById('c_addr').value.trim(),
    '備註':     document.getElementById('c_note').value.trim(),
  };
  if (!data['客戶名稱']) { showToast('請填客戶名稱'); return; }
  await withBtn(btn, async () => {
    if (state.editCustomer) {
      await api('update', '客戶', { key: data['客戶名稱'], data });
    } else {
      await api('add', '客戶', { data });
    }
    state.editCustomer = null;
    await loadAll();
    showView('customers');
    showToast('已儲存 ✓');
  });
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

function onEditFeeTypeChange() {
  const feeType = document.getElementById('ei_fee_type')?.value;
  const infoEl  = document.getElementById('ei_fee_info');
  const feeAmtEl = document.getElementById('ei_fee_amt');
  if (!infoEl) return;
  const worker = document.getElementById('ei_worker')?.value || '';
  const qty    = Number(document.getElementById('ei_qty')?.value)   || 1;
  const price  = Number(document.getElementById('ei_price')?.value) || 0;
  const amt    = qty * price;
  if (feeType === '接單') {
    const rate   = returnRateOf(worker);
    const income = Math.round(amt * rate);
    const ret    = amt - income;
    if (feeAmtEl) feeAmtEl.value = income;
    infoEl.textContent = rate
      ? `接單分成 ${(rate*100).toFixed(0)}% → 員工實得 $${income.toLocaleString()}，返還公司 $${ret.toLocaleString()}`
      : '（此師傅尚未設定接單分成比例）';
  } else if (feeType === '抽成') {
    const rate = feeRateOf(worker);
    const fee  = Math.round(amt * rate);
    if (feeAmtEl) feeAmtEl.value = fee;
    infoEl.textContent = rate ? `抽成 ${(rate*100).toFixed(0)}% = $${fee.toLocaleString()}` : '（此師傅尚未設定抽成比例）';
  } else {
    infoEl.textContent = '';
  }
}

// ── 固定支出模板 ─────────────────────────────
const EXP_CATS = ['固定支出','耗材','外包','薪資','設備','其他'];

function toggleFixedTemplates() {
  const el = document.getElementById('fixedTemplatePanel');
  const ar = document.getElementById('arrow-fixedTpl');
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) renderFixedTemplateList();
}

function renderFixedTemplateList() {
  const list = document.getElementById('fixedTplList');
  if (!list) return;
  if (!state.fixedTemplates.length) {
    list.innerHTML = '<p class="text-gray-500 text-xs mb-2">尚無固定支出，點下方新增</p>';
    return;
  }
  list.innerHTML = state.fixedTemplates.map((t, idx) => `
    <div class="flex items-center gap-2 mb-2 text-sm" id="ftpl_row_${idx}">
      <input value="${t['名稱']||''}" placeholder="名稱" class="flex-1 text-sm" id="ftpl_name_${idx}"/>
      <select id="ftpl_cat_${idx}" class="text-sm w-24">
        ${EXP_CATS.map(c => `<option ${(t['類別']||'固定支出')===c?'selected':''}>${c}</option>`).join('')}
      </select>
      <input type="number" value="${t['金額']||''}" placeholder="金額" class="w-20 text-sm" id="ftpl_amt_${idx}"/>
      <label class="flex items-center gap-1 shrink-0 text-xs">
        <input type="checkbox" ${(t['啟用']||'是')==='是'?'checked':''} id="ftpl_on_${idx}"/> 啟用
      </label>
      <button onclick="saveFixedTemplate(${idx},this)" class="btn btn-primary text-xs px-2 shrink-0">存</button>
      <button onclick="deleteFixedTemplate('${t['固定支出ID']}',${idx},this)" class="text-gray-500 hover:text-red-400 shrink-0">✕</button>
    </div>`).join('');
}

function addFixedTemplateRow() {
  const newTpl = { '固定支出ID': 'F' + Date.now(), '名稱': '', '類別': '固定支出', '金額': '', '備註': '', '啟用': '是' };
  state.fixedTemplates.push(newTpl);
  renderFixedTemplateList();
  // focus 最後一列的名稱
  const idx = state.fixedTemplates.length - 1;
  setTimeout(() => document.getElementById(`ftpl_name_${idx}`)?.focus(), 50);
}

async function saveFixedTemplate(idx, btn) {
  const tpl = state.fixedTemplates[idx];
  if (!tpl) return;
  tpl['名稱']   = document.getElementById(`ftpl_name_${idx}`).value.trim();
  tpl['類別']   = document.getElementById(`ftpl_cat_${idx}`).value;
  tpl['金額']   = Number(document.getElementById(`ftpl_amt_${idx}`).value) || 0;
  tpl['啟用']   = document.getElementById(`ftpl_on_${idx}`).checked ? '是' : '否';
  if (!tpl['名稱'] || !tpl['金額']) { showToast('請填名稱與金額'); return; }
  await withBtn(btn, async () => {
    const exists = await api('getAll', '固定支出');
    const existRow = (exists.data || []).find(r => String(r['固定支出ID']) === String(tpl['固定支出ID']));
    if (existRow) {
      await api('update', '固定支出', { key: tpl['固定支出ID'], data: tpl });
    } else {
      await api('add', '固定支出', { data: tpl });
    }
    saveCache();
    showToast('已儲存 ✓');
  });
}

async function deleteFixedTemplate(id, idx, btn) {
  if (btn.dataset.confirmed !== '1') {
    btn.dataset.confirmed = '1'; btn.textContent = '確定？';
    setTimeout(() => { if (btn.dataset.confirmed==='1') { btn.dataset.confirmed=''; btn.textContent='✕'; } }, 3000);
    return;
  }
  state.fixedTemplates.splice(idx, 1);
  saveCache();
  await api('delete', '固定支出', { key: id });
  renderFixedTemplateList();
  showToast('已刪除 ✓');
}

// ── 業績統計 ────────────────────────────────
function renderStats() {
  const thisYear = new Date().getFullYear();
  return `
  ${isAdmin() ? `
  <div class="card mb-4">
    <button type="button" onclick="this.nextElementSibling.classList.toggle('hidden')" class="w-full flex items-center justify-between">
      <span class="section-title mb-0">＋ 記一筆支出</span>
      <span class="text-xs text-gray-400">▼</span>
    </button>
    <div class="hidden mt-3 flex flex-col gap-2">
      <div class="grid grid-cols-2 gap-2">
        <input id="exp_date" type="date" value="${new Date().toISOString().slice(0,10)}"/>
        <select id="exp_cat">
          <option>固定支出</option><option>耗材</option><option>外包</option><option>薪資</option><option>設備</option><option>其他</option>
        </select>
      </div>
      <input id="exp_amt" type="number" placeholder="金額 *"/>
      <input id="exp_note" placeholder="備註（選填）"/>
      <button class="btn btn-primary" onclick="saveExpense(this)">記錄支出</button>
    </div>
  </div>

  <div class="card mb-4">
    <button type="button" onclick="toggleFixedTemplates()" class="w-full flex items-center justify-between">
      <span class="section-title mb-0">固定支出模板（每月自動）</span>
      <span id="arrow-fixedTpl" class="text-xs text-gray-400">▼</span>
    </button>
    <div id="fixedTemplatePanel" class="hidden mt-3">
      <div id="fixedTplList"></div>
      <button class="btn btn-ghost text-sm w-full mt-2" onclick="addFixedTemplateRow()">＋ 新增固定支出</button>
    </div>
  </div>` : ''}

  <div class="card mb-4">
    <div class="section-title">自訂查詢</div>
    <div class="flex items-end gap-2 mb-2">
      <div class="flex-1"><label class="text-xs text-gray-400">起始日</label>
        <input id="s_from" type="date" value="${thisYear}-01-01"/></div>
      <div class="flex-1"><label class="text-xs text-gray-400">結束日</label>
        <input id="s_to" type="date" value="${thisYear}-12-31"/></div>
      <button class="btn btn-ghost text-sm px-3 shrink-0 mb-0" style="height:38px" onclick="setThisMonth()">本月</button>
    </div>
    <select id="s_cus" class="mb-3">
      <option value="">全部客戶</option>
      ${state.customers.map(c => `<option>${c['客戶名稱']}</option>`).join('')}
    </select>
    <button class="btn btn-primary w-full" onclick="queryStats()">查詢</button>
  </div>
  <div id="statsResult"></div>

  ${isAdmin() ? `
  <div class="flex items-center justify-between cursor-pointer py-2" onclick="toggleProfitReport()">
    <span class="section-title mb-0">損益報告（老闆專屬）</span>
    <span id="arrow-profitReport" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="profitReport" class="hidden mb-3"></div>` : ''}

  <div class="flex items-center justify-between cursor-pointer py-2 mt-2" onclick="toggleStatsCus()">
    <span class="section-title mb-0">各客戶累計</span>
    <span id="arrow-statsCus" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="statsByCustomer" class="hidden"></div>

  <div class="flex items-center justify-between cursor-pointer py-2" onclick="toggleStatsWorker()">
    <span class="section-title mb-0">施工人員業績</span>
    <span id="arrow-statsWorker" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="statsByWorker" class="hidden"></div>

  <div class="flex items-center justify-between cursor-pointer py-2" onclick="toggleWorkerFeePending()">
    <span class="section-title mb-0">人員費用－待支付</span>
    <span id="arrow-workerFeePending" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="workerFeePending" class="hidden mb-2"></div>

  <div class="flex items-center justify-between cursor-pointer py-2" onclick="toggleWorkerFeePaid()">
    <span class="section-title mb-0">人員費用－已支付</span>
    <span id="arrow-workerFeePaid" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="workerFeePaid" class="hidden mb-4"></div>

  <div class="flex items-center justify-between cursor-pointer py-2" onclick="toggleWorkerCommission()">
    <span class="section-title mb-0">員工傭金頁</span>
    <span id="arrow-workerCommission" class="text-gray-400 text-lg">▼</span>
  </div>
  <div id="workerCommission" class="hidden mb-4">
    <select id="wc_worker" class="mb-3" onchange="renderWorkerCommission()">
      ${state.workers.map(w => `<option value="${w}">${w}</option>`).join('')}
    </select>
    <div id="workerCommissionBody"></div>
  </div>`;
}

// ── 管理員：檢視任一員工的傭金頁 ─────────────
function toggleWorkerCommission() {
  const el = document.getElementById('workerCommission');
  const ar = document.getElementById('arrow-workerCommission');
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) {
    renderWorkerCommission();
  } else {
    adminCommissionWorker = null;
  }
}

function renderWorkerCommission() {
  const sel = document.getElementById('wc_worker');
  if (!sel || !sel.value) return;
  adminCommissionWorker = sel.value;
  const body = document.getElementById('workerCommissionBody');
  if (body) {
    body.innerHTML = renderMyCommission();
    requestAnimationFrame(startCommissionAnimations);
  }
  adminCommissionWorker = sel.value; // 保持選取狀態供後續查詢（已結款查詢等）使用
}

// ── 傭金遊戲化：12 個搞笑等級（每 $1萬 一級）──
const RANK_THRESHOLDS = [
  { min: 0,      rank: '掃地的',     desc: '目前對本店的貢獻：地板很乾淨' },
  { min: 10000,  rank: '遮膠帶童工', desc: '貼了三小時，撕下來的時候最快樂' },
  { min: 20000,  rank: '砂紙戰士',   desc: '指紋已磨平，手機解鎖只能靠密碼' },
  { min: 30000,  rank: '噴霧吸太多', desc: '講話開始有創意，建議戴好口罩' },
  { min: 40000,  rank: '手抖美學家', desc: '那不是失誤，是限量版紋理' },
  { min: 50000,  rank: '垂流大師',   desc: '垂流控制自如——大部分時候' },
  { min: 60000,  rank: '勉強能看',   desc: '老闆看了三秒，點頭離開，沒罵人' },
  { min: 70000,  rank: '老闆免驚',   desc: '交給你，老闆終於敢去睡午覺' },
  { min: 80000,  rank: '客人指定',   desc: '「我要上次那個師傅做的」——說的就是你' },
  { min: 90000,  rank: '傳說塗裝手', desc: '同行打聽你的名字，老闆假裝沒聽到' },
  { min: 100000, rank: '人間國寶',   desc: '政府還沒認證，但本店已認證' },
  { min: 110000, rank: '獨品之神',   desc: '漆會自己聽話。本月請客雞排', isMax: true },
];

function getRankInfo(amount) {
  let idx = 0;
  for (let i = 0; i < RANK_THRESHOLDS.length; i++) {
    if (amount >= RANK_THRESHOLDS[i].min) idx = i;
    else break;
  }
  const cur  = RANK_THRESHOLDS[idx];
  const next = RANK_THRESHOLDS[idx + 1] || null;
  const isMax = !!cur.isMax;
  const floor = cur.min;
  const ceil  = next ? next.min : floor;
  const pct   = isMax ? 100 : Math.min(100, Math.max(0, ((amount - floor) / (ceil - floor)) * 100));
  return { rank: cur.rank, desc: cur.desc, level: idx + 1, isMax, floor, ceil, pct };
}

// 雙環目標：每 $3萬 一階，達成後自動變成下一階
function getRingGoal(amount) {
  return (Math.floor(amount / 30000) + 1) * 30000;
}

function monthRange(offset) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const last  = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
  const toIso = d => d.toISOString().slice(0, 10);
  return { start: toIso(first), end: toIso(last) };
}

// 連續達標：往前推算連續幾個月「已完成」傭金合計 ≥ $30,000
function computeMonthlyStreak() {
  const STREAK_TARGET = 30000;
  const monthly = {};
  commissionFees().forEach(it => {
    if (it['進度'] !== '完成' || !it['完工日期']) return;
    const key = String(it['完工日期']).slice(0, 7);
    monthly[key] = (monthly[key] || 0) + effectiveFee(it);
  });
  const now = new Date();
  const keyFor = i => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };
  let streak = 0;
  for (let i = 1; (monthly[keyFor(i)] || 0) >= STREAK_TARGET; i++) streak++;
  if ((monthly[keyFor(0)] || 0) >= STREAK_TARGET) streak++;
  return streak;
}

let _newHighShown = false;
function maybeShowNewHighToast(thisMonthTotal, lastMonthTotal) {
  if (adminCommissionWorker) return; // 管理員檢視他人時不跳提示
  if (_newHighShown || lastMonthTotal <= 0 || thisMonthTotal <= lastMonthTotal) return;
  _newHighShown = true;
  setTimeout(() => showToast('本月創新高 🎉', 'success'), 500);
}

// 結款慶祝：跟上次記錄比對，發現有新入帳的傭金就跳金幣雨
function checkPaymentCelebration() {
  if (!auth.email || isAdmin()) return;
  const key = 'dupin_seen_paid_' + auth.email;
  const paidIds = state.myFees.filter(it => it['費用支付狀態'] === '已支付').map(it => String(it['工作ID']));
  let seen = [];
  try { seen = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
  const seenSet = new Set(seen);
  const newlyPaid = paidIds.filter(id => !seenSet.has(id));
  localStorage.setItem(key, JSON.stringify(paidIds));
  if (seen.length > 0 && newlyPaid.length > 0) celebratePayment(newlyPaid.length);
}

function celebratePayment(count) {
  showToast(`💰 有 ${count} 筆傭金剛入帳！`, 'success');
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.id = 'coinRain';
  document.body.appendChild(layer);
  const coins = ['🪙', '💰', '✨'];
  for (let i = 0; i < 24; i++) {
    const c = document.createElement('span');
    c.className = 'coin';
    c.textContent = coins[i % coins.length];
    c.style.left = (Math.random() * 100) + 'vw';
    c.style.animationDelay = (Math.random() * 0.6) + 's';
    c.style.fontSize = (16 + Math.random() * 14) + 'px';
    layer.appendChild(c);
  }
  setTimeout(() => layer.remove(), 2600);
}

function animateNumber(el, from, to, duration) {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion) { el.textContent = '$' + to.toLocaleString(); return; }
  const start = performance.now();
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    const val = Math.round(from + (to - from) * eased);
    el.textContent = '$' + val.toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function startCommissionAnimations() {
  document.querySelectorAll('.count-up').forEach(el => {
    animateNumber(el, 0, Number(el.dataset.target || 0), 900);
  });
  const fill = document.getElementById('mcXpFill');
  if (fill) requestAnimationFrame(() => { fill.style.width = fill.dataset.pct + '%'; });
}

// ── 我的傭金（員工專用；管理員可透過 adminCommissionWorker 檢視任一員工）──
let adminCommissionWorker = null; // admin 在業績頁選擇檢視的員工姓名；null = 員工本人模式

// ── 費用計算 ─────────────────────────────────
// 費用類型：傭金(固定) / 抽成(金額×比例) / 接單(抽成，但需返還公司)
function feeRateOf(name)    { return (state.workerRates || {})[String(name || '').trim()] || 0; }
function returnRateOf(name) { return (state.workerReturnRates || {})[String(name || '').trim()] || 0; }

// 抽成/傭金 金額：未支付的抽成以 金額×抽成比例 即時算；已支付或傭金用存檔值
function commissionAmt(it) {
  if (it['費用類型'] === '抽成' && it['費用支付狀態'] !== '已支付') {
    const rate = feeRateOf(it['負責師傅']);
    if (rate) return Math.round(Number(it['金額'] || 0) * rate);
  }
  return Number(it['費用金額']) || 0;
}

// 接單員工實得：金額 × 接單分成比例（與抽成無關）
function referralIncome(it) {
  if (it['費用支付狀態'] !== '已支付') {
    const rate = returnRateOf(it['負責師傅']);
    return Math.round(Number(it['金額'] || 0) * rate);
  }
  return Number(it['費用金額']) || 0;
}

// 接單返還公司：金額 − 員工實得
function returnAmt(it) {
  if (it['費用類型'] !== '接單') return 0;
  if (it['費用支付狀態'] !== '已支付') {
    const rate = returnRateOf(it['負責師傅']);
    const amt  = Number(it['金額'] || 0);
    return amt - Math.round(amt * rate);
  }
  return Number(it['返還金額']) || 0;
}

// 員工收入（傭金頁 / 等級）：接單 = 員工實得；其餘 = 抽成/傭金
function workerIncome(it) {
  if (it['費用類型'] === '接單') return referralIncome(it);
  return commissionAmt(it);
}

// 老闆應付（人員費用 / 損益，可為負）：接單 = −返還(收回)；其餘 = 抽成/傭金
function bossPayable(it) {
  if (it['費用類型'] === '接單') return -returnAmt(it);
  return commissionAmt(it);
}

// 相容舊呼叫
function effectiveFee(it) { return workerIncome(it); }

function commissionFees() {
  if (adminCommissionWorker) {
    return state.items.filter(it => String(it['負責師傅'] || '').trim() === adminCommissionWorker);
  }
  return state.myFees;
}

function renderMyCommission() {
  const thisYear = new Date().getFullYear();

  const unfinished = commissionFees().filter(it => it['進度'] !== '完成');
  const unfinishedTotal = unfinished.reduce((s, it) => s + effectiveFee(it), 0);

  const { start: mStart, end: mEnd } = monthRange(0);
  const finishedThisMonth = commissionFees().filter(it => it['進度'] === '完成' && it['完工日期'] >= mStart && it['完工日期'] <= mEnd);
  const finishedThisMonthTotal = finishedThisMonth.reduce((s, it) => s + effectiveFee(it), 0);
  const thisMonthTotal = unfinishedTotal + finishedThisMonthTotal;

  const { start: lStart, end: lEnd } = monthRange(-1);
  const lastMonthTotal = commissionFees()
    .filter(it => it['進度'] === '完成' && it['完工日期'] >= lStart && it['完工日期'] <= lEnd)
    .reduce((s, it) => s + effectiveFee(it), 0);

  const rank = getRankInfo(thisMonthTotal);
  const ringGoal = getRingGoal(thisMonthTotal);
  const streak = computeMonthlyStreak();
  maybeShowNewHighToast(thisMonthTotal, lastMonthTotal);

  // 雙環：填滿比例 = 本月合計／本階目標，未完成／已完成依比例分兩色
  const totalPct = Math.min(1, ringGoal > 0 ? thisMonthTotal / ringGoal : 0);
  const totalDeg = totalPct * 360;
  const unfinishedDeg = thisMonthTotal > 0 ? (unfinishedTotal / thisMonthTotal) * totalDeg : 0;
  const ringGradient = `conic-gradient(#f59e0b 0deg ${unfinishedDeg}deg, #fbbf24 ${unfinishedDeg}deg ${totalDeg}deg, #0f172a ${totalDeg}deg 360deg)`;

  const pending = commissionFees().filter(it => it['進度'] === '完成' && it['費用支付狀態'] === '未支付');
  const pendingTotal = pending.reduce((s, it) => s + effectiveFee(it), 0);

  return `
  <div class="xp-card">
    <div class="xp-lastmonth">上個月傭金：<b>$${lastMonthTotal.toLocaleString()}</b></div>
    <div class="xp-top">
      <div class="xp-lv-row">
        <div class="lv-badge">${rank.isMax ? '★' : 'Lv' + rank.level}</div>
        <div>
          <div class="lv-name">${rank.rank}${rank.isMax ? ' ★' : ''}</div>
          <div class="text-xs text-gray-500">${rank.desc || ''}</div>
        </div>
      </div>
      <div class="xp-amt count-up" data-target="${thisMonthTotal}">$0</div>
    </div>
    <div class="xp-track"><div class="xp-fill${rank.isMax ? ' maxed' : ''}" id="mcXpFill" style="width:0%" data-pct="${rank.pct}"></div></div>
    <div class="xp-sub">
      <span>本月 ${mStart} ～ ${mEnd}</span>
      <span>${rank.isMax ? '已達最高段位 🏆' : '還差 $' + (rank.ceil - thisMonthTotal).toLocaleString() + ' 升級'}</span>
    </div>
    ${streak >= 2 ? `<div class="streak-badge">🔥 連續 ${streak} 個月破 $30,000</div>` : ''}
  </div>

  <div class="ring-card">
    <div class="ring-row">
      <div class="rank-ring" style="background:${ringGradient}">
        <div class="ring-center"><b class="count-up" data-target="${thisMonthTotal}">$0</b><span>本月合計</span></div>
      </div>
      <div class="ring-legend">
        <div><span class="dot" style="background:#f59e0b"></span>未完工預估 $${unfinishedTotal.toLocaleString()}</div>
        <div><span class="dot" style="background:#fbbf24"></span>本月已完成 $${finishedThisMonthTotal.toLocaleString()}</div>
        <div style="color:#6b7280">本階目標 $${ringGoal.toLocaleString()}</div>
      </div>
    </div>
  </div>

  <div class="card mb-4">
    <div class="flex justify-between items-center mb-2">
      <span class="section-title mb-0">未完工總和</span>
      <span class="text-amber-400 font-bold">$${unfinishedTotal.toLocaleString()}</span>
    </div>
    ${renderMyFeeRows(unfinished, '暫無進行中項目')}
  </div>

  <div class="card mb-4">
    <div class="flex justify-between items-center mb-2">
      <span class="section-title mb-0">完工尚未結款</span>
      <span class="text-amber-400 font-bold">$${pendingTotal.toLocaleString()}</span>
    </div>
    ${renderMyFeeRows(pending, '暫無待結款項目')}
  </div>

  <div class="card mb-4">
    <div class="section-title">已結款查詢</div>
    <div class="flex items-end gap-2 mb-2">
      <div class="flex-1"><label class="text-xs text-gray-400">起始日</label>
        <input id="mc_from" type="date" value="${thisYear}-01-01"/></div>
      <div class="flex-1"><label class="text-xs text-gray-400">結束日</label>
        <input id="mc_to" type="date" value="${thisYear}-12-31"/></div>
      <button class="btn btn-ghost text-sm px-3 shrink-0 mb-0" style="height:38px" onclick="setMyCommissionMonth()">本月</button>
    </div>
    <button class="btn btn-primary w-full" onclick="queryMyCommission()">查詢</button>
  </div>
  <div id="myCommissionPaid"></div>`;
}

function renderMyFeeRows(items, emptyMsg) {
  if (!items.length) return `<p class="text-gray-500 text-sm">${emptyMsg}</p>`;
  return items
    .slice()
    .sort((a, b) => (b['完工日期'] || '') > (a['完工日期'] || '') ? 1 : -1)
    .map(it => `
    <div class="flex justify-between text-sm py-1 border-b border-gray-700">
      <span class="text-gray-300">${it['完工日期'] || ''} · ${it['客戶'] || ''} · ${it['品名'] || ''}</span>
      <span class="text-amber-400 shrink-0 ml-2">${it['費用類型'] || ''} $${effectiveFee(it).toLocaleString()}</span>
    </div>`).join('');
}

function setMyCommissionMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  document.getElementById('mc_from').value = `${y}-${m}-01`;
  document.getElementById('mc_to').value   = `${y}-${m}-${String(last).padStart(2,'0')}`;
  queryMyCommission();
}

function queryMyCommission() {
  const from = document.getElementById('mc_from').value;
  const to   = document.getElementById('mc_to').value;
  const paid = commissionFees().filter(it => {
    const d = it['費用支付日期'] || '';
    return it['費用支付狀態'] === '已支付' && (!from || (d >= from && d <= to));
  });
  const total = paid.reduce((s, it) => s + workerIncome(it), 0);
  document.getElementById('myCommissionPaid').innerHTML = `
    <div class="card mb-2">
      <div class="flex justify-between items-center mb-2">
        <span class="section-title mb-0">已結款（${paid.length} 件）</span>
        <span class="text-amber-400 font-bold">$${total.toLocaleString()}</span>
      </div>
      ${renderMyFeeRows(paid, '此區間無已結款項目')}
    </div>`;
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

function setThisMonth() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const last = new Date(y, now.getMonth() + 1, 0).getDate();
  document.getElementById('s_from').value = `${y}-${m}-01`;
  document.getElementById('s_to').value   = `${y}-${m}-${String(last).padStart(2,'0')}`;
  queryStats();
}

function toggleProfitReport() {
  const el = document.getElementById('profitReport');
  const ar = document.getElementById('arrow-profitReport');
  if (!el) return;
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) {
    const { from, to } = getStatsFilter();
    el.innerHTML = renderProfitReport(from, to);
  }
}

function toggleWorkerFeePending() {
  const el = document.getElementById('workerFeePending');
  const ar = document.getElementById('arrow-workerFeePending');
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) el.innerHTML = renderWorkerFeePending();
}

function toggleWorkerFeePaid() {
  const el = document.getElementById('workerFeePaid');
  const ar = document.getElementById('arrow-workerFeePaid');
  el.classList.toggle('hidden');
  ar.textContent = el.classList.contains('hidden') ? '▼' : '▲';
  if (!el.classList.contains('hidden')) {
    const { from, to } = getStatsFilter();
    el.innerHTML = renderWorkerFeePaid(from, to);
  }
}

function renderStatsByCustomer(from, to) {
  const map = {};
  const itemsMap = {};
  state.items.filter(it => !from || (it['完工日期'] && it['完工日期'] >= from && it['完工日期'] <= to)).forEach(it => {
    const c = it['客戶'] || '(未知)';
    map[c] = (map[c] || 0) + Number(it['金額'] || 0);
    if (!itemsMap[c]) itemsMap[c] = [];
    itemsMap[c].push(it);
  });
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([name, total], idx) => {
      const rows = (itemsMap[name] || [])
        .sort((a, b) => (b['完工日期']||'') > (a['完工日期']||'') ? 1 : -1)
        .map(it => `<div class="flex justify-between text-sm py-1 border-b border-gray-700">
          <span class="text-gray-300">${it['完工日期']||''} · ${it['品名']||''}</span>
          <span class="text-amber-400">$${Number(it['金額']||0).toLocaleString()}</span>
        </div>`).join('');
      const detailId = `sc_detail_${idx}`;
      return `
      <div class="card mb-2">
        <div class="flex justify-between items-center cursor-pointer" onclick="document.getElementById('${detailId}').classList.toggle('hidden')">
          <span class="font-semibold">${name}</span>
          <span class="text-amber-400 font-bold">$${total.toLocaleString()}</span>
        </div>
        <div id="${detailId}" class="hidden mt-2">${rows}</div>
      </div>`;
    }).join('') || '<p class="text-gray-500 text-sm">無資料</p>';
}

function renderStatsByWorker(from, to) {
  const map = {};
  const itemsMap = {};
  state.items.filter(it => it['進度'] === '完成' && (!from || (it['完工日期'] >= from && it['完工日期'] <= to))).forEach(it => {
    const w = it['負責師傅'] || '(未指定)';
    if (!map[w]) map[w] = { count: 0, total: 0 };
    map[w].count++;
    map[w].total += Number(it['金額'] || 0);
    if (!itemsMap[w]) itemsMap[w] = [];
    itemsMap[w].push(it);
  });
  if (!Object.keys(map).length) return '<p class="text-gray-500 text-sm mb-4">無完工資料</p>';
  return Object.entries(map)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, s], idx) => {
      const rows = (itemsMap[name] || [])
        .sort((a, b) => (b['完工日期']||'') > (a['完工日期']||'') ? 1 : -1)
        .map(it => `<div class="flex justify-between text-sm py-1 border-b border-gray-700">
          <span class="text-gray-300">${it['完工日期']||''} · ${it['客戶']||''} · ${it['品名']||''}</span>
          <span class="text-amber-400">$${Number(it['金額']||0).toLocaleString()}</span>
        </div>`).join('');
      const detailId = `sw_detail_${idx}`;
      return `
      <div class="card mb-2">
        <div class="flex justify-between items-center cursor-pointer" onclick="document.getElementById('${detailId}').classList.toggle('hidden')">
          <div>
            <div class="font-semibold">${name}</div>
            <div class="text-xs text-gray-400">完工 ${s.count} 件</div>
          </div>
          <span class="text-amber-400 font-bold">$${s.total.toLocaleString()}</span>
        </div>
        <div id="${detailId}" class="hidden mt-2">${rows}</div>
      </div>`;
    }).join('');
}

function renderWorkerFeePending() {
  const pending = state.items.filter(it =>
    it['進度'] === '完成' && it['費用支付狀態'] === '未支付' && it['費用類型'] && bossPayable(it) !== 0
  );
  if (!pending.length) return '<p class="text-gray-500 text-sm mb-4">無待支付費用</p>';
  const byWorker = {};
  pending.forEach(it => {
    const w = it['負責師傅'] || '(未指定)';
    if (!byWorker[w]) byWorker[w] = [];
    byWorker[w].push(it);
  });
  return Object.entries(byWorker).map(([name, items], idx) => {
    const total = items.reduce((s, it) => s + bossPayable(it), 0);
    const ids   = items.map(it => String(it['工作ID']));
    const detailId = `wfp_${idx}`;
    const rows = items.map(it => {
      const amt = bossPayable(it);
      const label = it['費用類型'] === '接單' ? `接單返還 −$${returnAmt(it).toLocaleString()}` : `${it['費用類型']} $${amt.toLocaleString()}`;
      return `
      <div class="flex justify-between text-sm py-1 border-b border-gray-700">
        <span class="text-gray-300">${it['完工日期']||''} · ${it['客戶']||''} · ${it['品名']||''}</span>
        <span class="${amt < 0 ? 'text-emerald-400' : 'text-amber-400'} shrink-0 ml-2">${label}</span>
      </div>`;
    }).join('');
    const idsJson = JSON.stringify(ids).replace(/"/g, '&quot;');
    const totalLabel = total < 0 ? `收回 $${Math.abs(total).toLocaleString()}` : `$${total.toLocaleString()}`;
    const btnLabel = total < 0 ? '結算（員工返還）' : '支付全部';
    return `
    <div class="card mb-2">
      <div class="flex justify-between items-center cursor-pointer" onclick="document.getElementById('${detailId}').classList.toggle('hidden')">
        <div>
          <div class="font-semibold">${name}</div>
          <div class="text-xs text-gray-400">${items.length} 件待結算</div>
        </div>
        <span class="${total < 0 ? 'text-emerald-400' : 'text-amber-400'} font-bold">${totalLabel}</span>
      </div>
      <div id="${detailId}" class="hidden mt-2">
        ${rows}
        <button class="btn btn-primary w-full mt-3"
          onclick="confirmPayWorker('${name}', JSON.parse(this.dataset.ids), this)"
          data-ids="${idsJson}">${btnLabel}</button>
      </div>
    </div>`;
  }).join('');
}

function renderWorkerFeePaid(from, to) {
  const paid = state.items.filter(it => {
    const d = it['費用支付日期'] || '';
    return it['費用支付狀態'] === '已支付' && (!from || (d >= from && d <= to));
  });
  if (!paid.length) return '<p class="text-gray-500 text-sm mb-4">無已支付費用</p>';
  const byWorker = {};
  paid.forEach(it => {
    const w = it['負責師傅'] || '(未指定)';
    if (!byWorker[w]) byWorker[w] = [];
    byWorker[w].push(it);
  });
  return Object.entries(byWorker).map(([name, items], idx) => {
    const total = items.reduce((s, it) => s + bossPayable(it), 0);
    const detailId = `wfpaid_${idx}`;
    const rows = items.map(it => {
      const amt = bossPayable(it);
      const label = it['費用類型'] === '接單' ? `接單返還 −$${returnAmt(it).toLocaleString()}` : `$${amt.toLocaleString()}`;
      return `
      <div class="flex justify-between text-sm py-1 border-b border-gray-700">
        <span class="text-gray-300">${it['費用支付日期']||''} · ${it['客戶']||''} · ${it['品名']||''}</span>
        <span class="${amt < 0 ? 'text-emerald-400' : 'text-amber-400'} shrink-0 ml-2">${label}</span>
      </div>`;
    }).join('');
    return `
    <div class="card mb-2">
      <div class="flex justify-between items-center cursor-pointer" onclick="document.getElementById('${detailId}').classList.toggle('hidden')">
        <div>
          <div class="font-semibold">${name}</div>
          <div class="text-xs text-gray-400">${items.length} 件已支付</div>
        </div>
        <span class="text-amber-400 font-bold">$${total.toLocaleString()}</span>
      </div>
      <div id="${detailId}" class="hidden mt-2">${rows}</div>
    </div>`;
  }).join('');
}

function renderProfitReport(from, to) {
  // ── 收入：完工項目 ──
  const incomeItems = state.items.filter(it =>
    it['進度'] === '完成' && it['完工日期'] >= from && it['完工日期'] <= to
  ).sort((a, b) => (a['完工日期'] > b['完工日期'] ? -1 : 1));
  const revenue = incomeItems.reduce((s, it) => s + Number(it['金額'] || 0), 0);

  // ── 人員費用：已支付（接單返還為負，代表公司收回）──
  const feeItems = state.items.filter(it =>
    it['費用支付狀態'] === '已支付' && it['費用支付日期'] >= from && it['費用支付日期'] <= to
  ).sort((a, b) => (a['費用支付日期'] > b['費用支付日期'] ? -1 : 1));
  const totalFees = feeItems.reduce((s, it) => s + bossPayable(it), 0);

  // ── 公司支出 ──
  const expItems = (state.expenses || []).filter(e => {
    const d = String(e['日期'] || '').slice(0, 10);
    return d >= from && d <= to;
  }).sort((a, b) => (String(a['日期']) > String(b['日期']) ? -1 : 1));
  const totalExp = expItems.reduce((s, e) => s + Number(e['金額'] || 0), 0);
  const byCategory = {};
  expItems.forEach(e => { const c = e['類別']||'其他'; byCategory[c] = (byCategory[c]||0) + Number(e['金額']||0); });

  const profit = revenue - totalFees - totalExp;
  const profitColor = profit >= 0 ? 'text-green-400' : 'text-red-400';

  const incomeRows = incomeItems.map(it => `
    <div class="flex justify-between text-sm py-1 border-b border-gray-700">
      <span class="text-gray-300">${it['完工日期']} · ${it['客戶']||''} · ${it['品名']||''}</span>
      <span class="text-amber-400 shrink-0 ml-2">$${Number(it['金額']||0).toLocaleString()}</span>
    </div>`).join('') || '<p class="text-xs text-gray-500 py-1">無完工收入</p>';

  const feeRows = feeItems.map(it => {
    const amt = bossPayable(it);
    const isReturn = it['費用類型'] === '接單';
    return `
    <div class="flex justify-between text-sm py-1 border-b border-gray-700">
      <span class="text-gray-300">${it['費用支付日期']} · ${it['負責師傅']||''} · ${it['品名']||''}${isReturn ? '（接單返還）' : ''}</span>
      <span class="${amt < 0 ? 'text-emerald-400' : 'text-red-400'} shrink-0 ml-2">${amt < 0 ? '+$' + Math.abs(amt).toLocaleString() : '$' + amt.toLocaleString()}</span>
    </div>`;
  }).join('') || '<p class="text-xs text-gray-500 py-1">無已支付人員費用</p>';

  const expRows = expItems.map(e => `
    <div class="flex justify-between items-center text-sm py-1 border-b border-gray-700 gap-2">
      <span class="text-gray-300 flex-1 min-w-0">${String(e['日期']||'').slice(0,10)} · ${e['類別']||''} · ${e['備註']||''}</span>
      <span class="text-red-400 shrink-0">$${Number(e['金額']||0).toLocaleString()}</span>
      ${isAdmin() ? `<button onclick="deleteExpense('${e['支出ID']}',this)" class="text-gray-500 hover:text-red-400 shrink-0 text-xs px-1">✕</button>` : ''}
    </div>`).join('') || '<p class="text-xs text-gray-500 py-1">無支出記錄</p>';

  return `
  <div class="card">
    <div class="flex justify-between items-center mb-3 cursor-pointer" onclick="document.getElementById('pr_income').classList.toggle('hidden')">
      <span class="text-gray-300 font-semibold">收入（完工 ${incomeItems.length} 件）</span>
      <span class="text-amber-400 font-bold">$${revenue.toLocaleString()} ▾</span>
    </div>
    <div id="pr_income" class="hidden mb-3">${incomeRows}</div>

    <div class="flex justify-between items-center mb-3 cursor-pointer border-t border-gray-700 pt-3" onclick="document.getElementById('pr_fees').classList.toggle('hidden')">
      <span class="text-gray-300 font-semibold">人員費用（已支付 ${feeItems.length} 件）</span>
      <span class="text-red-400 font-bold">− $${totalFees.toLocaleString()} ▾</span>
    </div>
    <div id="pr_fees" class="hidden mb-3">${feeRows}</div>

    <div class="flex justify-between items-center mb-1 cursor-pointer border-t border-gray-700 pt-3" onclick="document.getElementById('pr_exp').classList.toggle('hidden')">
      <div>
        <div class="text-gray-300 font-semibold">公司支出（${expItems.length} 筆）</div>
        <div class="text-xs text-gray-500 mt-0.5">
          ${Object.entries(byCategory).map(([c,a])=>`${c} $${a.toLocaleString()}`).join('・')||''}
        </div>
      </div>
      <span class="text-red-400 font-bold shrink-0 ml-2">− $${totalExp.toLocaleString()} ▾</span>
    </div>
    <div id="pr_exp" class="hidden mb-3">${expRows}</div>

    <div class="flex justify-between items-center border-t-2 border-gray-500 pt-3 mt-2">
      <span class="font-bold text-base">淨利</span>
      <span class="text-2xl font-bold ${profitColor}">$${profit.toLocaleString()}</span>
    </div>
  </div>`;
}

async function confirmPayWorker(name, ids, btn) {
  if (btn.dataset.confirmed !== '1') {
    if (!btn.dataset.orig) btn.dataset.orig = btn.textContent;
    btn.dataset.confirmed = '1';
    btn.textContent = '確定？再按一次';
    btn.classList.remove('bg-blue-600');
    btn.classList.add('bg-amber-600');
    setTimeout(() => {
      if (btn.dataset.confirmed === '1') {
        btn.dataset.confirmed = '';
        btn.textContent = btn.dataset.orig || '支付全部';
        btn.classList.remove('bg-amber-600');
      }
    }, 3000);
    return;
  }
  btn.disabled = true;
  btn.textContent = '支付中…';
  const today = new Date().toISOString().slice(0, 10);
  for (const id of ids) {
    const it = state.items.find(x => String(x['工作ID']) === String(id));
    // 結算時把即時算出的抽成/返還金額寫回試算表，確保帳面一致
    const data = { '費用支付狀態': '已支付', '費用支付日期': today };
    if (it) {
      if (it['費用類型'] === '接單') {
        data['費用金額'] = referralIncome(it);
        data['返還金額'] = returnAmt(it);
      } else {
        const c = commissionAmt(it);
        if (c > 0) data['費用金額'] = c;
      }
    }
    await api('update', '工作項目', { key: id, data });
    if (it) {
      it['費用支付狀態'] = '已支付'; it['費用支付日期'] = today;
      if (data['費用金額'] != null) it['費用金額'] = data['費用金額'];
      if (data['返還金額'] != null) it['返還金額'] = data['返還金額'];
    }
  }
  saveCache();
  showToast(`已支付 ${name} 費用 ✓`);
  const pendingEl = document.getElementById('workerFeePending');
  if (pendingEl && !pendingEl.classList.contains('hidden')) pendingEl.innerHTML = renderWorkerFeePending();
  const paidEl = document.getElementById('workerFeePaid');
  if (paidEl && !paidEl.classList.contains('hidden')) {
    const { from, to } = getStatsFilter();
    paidEl.innerHTML = renderWorkerFeePaid(from, to);
  }
}

async function saveExpense(btn) {
  if (btn && btn.disabled) return;
  const date = document.getElementById('exp_date').value;
  const cat  = document.getElementById('exp_cat').value;
  const amt  = Number(document.getElementById('exp_amt').value);
  const note = document.getElementById('exp_note').value.trim();
  if (!amt) { showToast('請填金額'); return; }
  const data = { '支出ID': 'E' + Date.now(), '日期': date, '類別': cat, '金額': amt, '備註': note };
  await withBtn(btn, async () => {
    const r = await api('add', '支出記錄', { data });
    if (r.error) { showToast('記錄失敗：' + r.error, 'error'); return; }
    state.expenses.push(data);
    saveCache();
    document.getElementById('exp_amt').value = '';
    document.getElementById('exp_note').value = '';
    showToast('已記錄支出 ✓');
    const pEl = document.getElementById('profitReport');
    if (pEl && !pEl.classList.contains('hidden')) {
      const { from, to } = getStatsFilter();
      pEl.innerHTML = renderProfitReport(from, to);
    }
  });
}

async function deleteExpense(expId, btn) {
  if (btn.dataset.confirmed !== '1') {
    btn.dataset.confirmed = '1';
    btn.textContent = '確定？';
    btn.classList.add('text-red-400');
    setTimeout(() => { if (btn.dataset.confirmed === '1') { btn.dataset.confirmed = ''; btn.textContent = '✕'; btn.classList.remove('text-red-400'); } }, 3000);
    return;
  }
  btn.disabled = true;
  state.expenses = state.expenses.filter(e => String(e['支出ID']) !== String(expId));
  saveCache();
  await api('delete', '支出記錄', { key: expId });
  const pEl = document.getElementById('profitReport');
  if (pEl && !pEl.classList.contains('hidden')) {
    const { from, to } = getStatsFilter();
    pEl.innerHTML = renderProfitReport(from, to);
  }
  showToast('已刪除支出 ✓');
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
    <div class="card mb-3">
      <div class="flex justify-between mb-3">
        <span class="text-gray-400">查詢結果（${filtered.length} 件）</span>
        <span class="text-2xl font-bold text-amber-400">$${total.toLocaleString()}</span>
      </div>
      ${detail || '<p class="text-gray-500 text-sm">無符合資料</p>'}
    </div>`;

  const prEl = document.getElementById('profitReport');
  if (prEl && !prEl.classList.contains('hidden')) prEl.innerHTML = renderProfitReport(from, to);

  const cuEl = document.getElementById('statsByCustomer');
  if (cuEl && !cuEl.classList.contains('hidden')) cuEl.innerHTML = renderStatsByCustomer(from, to);
  const wkEl = document.getElementById('statsByWorker');
  if (wkEl && !wkEl.classList.contains('hidden')) wkEl.innerHTML = renderStatsByWorker(from, to);
  const paidEl = document.getElementById('workerFeePaid');
  if (paidEl && !paidEl.classList.contains('hidden')) paidEl.innerHTML = renderWorkerFeePaid(from, to);
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

// 通用按鈕防呆：送出期間 disable + 改文字，完成後還原
async function withBtn(btn, fn) {
  if (!btn || btn.disabled) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '處理中…';
  try { await fn(); } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

function showToast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `fixed top-16 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg text-sm z-50 ${type==='error'?'bg-red-600':'bg-green-700'} text-white`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

// ── Google 登入 ─────────────────────────────
function showLoginGate(msg, retries) {
  retries = retries || 0;
  document.querySelector('nav.no-print')?.classList.add('hidden');
  const header = document.querySelector('header.no-print');
  if (header) header.querySelector('#headerActions').innerHTML = '';
  document.getElementById('app').innerHTML = `
    <div class="flex flex-col items-center justify-center" style="min-height:70vh;">
      <div class="w-16 h-16 rounded-2xl bg-amber-400 flex items-center justify-center text-gray-900 font-black text-3xl mb-4">獨</div>
      <h2 class="text-amber-400 font-bold text-xl mb-1">獨品工坊開單系統</h2>
      <p class="text-gray-400 text-sm mb-6">${msg || '請使用授權的 Google 帳號登入'}</p>
      <div id="gsiButton"></div>
      <p id="loginError" class="text-red-400 text-sm mt-4"></p>
    </div>`;
  if (window.google && google.accounts) {
    if (!window._gsiInitialized) {
      google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredentialResponse, auto_select: true });
      window._gsiInitialized = true;
    }
    google.accounts.id.renderButton(document.getElementById('gsiButton'),
      { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill' });
  } else if (retries < 25) {
    // GIS 還沒載入完，稍候重試（最多約 7.5 秒）
    setTimeout(() => showLoginGate(msg, retries + 1), 300);
  } else {
    // Google 登入腳本載入失敗（網路不穩／被內容阻擋器擋住）
    document.getElementById('gsiButton').innerHTML = `
      <div class="text-center">
        <p class="text-red-400 text-sm mb-3">Google 登入元件載入失敗<br>請確認網路，或關閉廣告阻擋器後再試</p>
        <button class="btn btn-primary" onclick="location.reload()">重新載入</button>
      </div>`;
  }
}

async function handleCredentialResponse(response) {
  auth.idToken = response.credential;
  // 若是靜默刷新（舊制背景 token 更新），通知等待中的 promise 即可，不重新登入
  if (_silentRefreshResolve) { scheduleTokenRefresh(); _silentRefreshResolve(); return; }
  const r = await api('verifyLogin', null, {});
  if (r && r.success) {
    auth.email = r.email; auth.name = r.name; auth.role = r.role;
    localStorage.setItem('dupin_auth', JSON.stringify({ email: auth.email, name: auth.name, role: auth.role }));
    if (r.session) {
      // A2：拿到自家長效通行證，之後不再依賴 Google（1 小時到期）
      auth.sessionToken = r.session;
      localStorage.setItem('dupin_session', r.session);
      auth.idToken = null;
    } else {
      // 過渡：後端尚未設定 SESSION_SECRET，退回舊制的背景刷新
      scheduleTokenRefresh();
    }
    document.querySelector('nav.no-print')?.classList.remove('hidden');
    loadAll();
  } else {
    auth = { idToken: null, email: null, name: null, role: null };
    const el = document.getElementById('loginError');
    if (el) el.textContent = r && r.error === 'NOT_ALLOWED'
      ? `此帳號（${r.email}）未授權，請聯絡管理員加入員工名單`
      : '登入失敗，請重試';
  }
}

function logout(msg) {
  auth = { idToken: null, sessionToken: null, email: null, name: null, role: null };
  localStorage.removeItem('dupin_auth');
  localStorage.removeItem('dupin_session');
  if (window.google && google.accounts) google.accounts.id.disableAutoSelect();
  showLoginGate(msg);
}

// ── 初始化 ──────────────────────────────────
if (API_URL === 'YOUR_APPS_SCRIPT_URL_HERE') {
  document.getElementById('app').innerHTML = `
    <div class="text-center mt-20">
      <h2 class="text-amber-400 font-bold text-lg mb-2">請先設定 API</h2>
      <p class="text-gray-400 text-sm">請依步驟部署 Apps Script，<br>再把網址填入 app.js 的 API_URL 變數。</p>
    </div>`;
} else if (GOOGLE_CLIENT_ID) {
  // 嘗試從 localStorage 還原登入狀態（記住裝置）
  const saved = localStorage.getItem('dupin_auth');
  if (saved) {
    try {
      const s = JSON.parse(saved);
      auth.email = s.email; auth.name = s.name; auth.role = s.role;
    } catch (e) {}
  }
  const savedSession = localStorage.getItem('dupin_session');
  if (savedSession) auth.sessionToken = savedSession;

  if (auth.sessionToken && auth.email) {
    // A2：有長效通行證，直接進入，完全不需要 Google（不會被 1 小時/FedCM 卡住）
    document.querySelector('nav.no-print')?.classList.remove('hidden');
    loadAll();
  } else if (auth.email) {
    // 過渡（尚未換發 session）：沿用舊制的 Google 背景靜默登入
    loadAll();
    window.addEventListener('load', () => {
      if (window.google && google.accounts) {
        if (!window._gsiInitialized) {
          google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleCredentialResponse,
            auto_select: true,
          });
          window._gsiInitialized = true;
        }
        google.accounts.id.prompt();
      }
    });
  } else {
    showLoginGate();
  }
} else {
  loadAll();
}
