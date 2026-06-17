// =============================================
// 獨品工坊開單系統 — Google Apps Script API
// =============================================
// 部署方式：
// 1. 開啟你的 Google 試算表 → 「擴充功能」→「Apps Script」
// 2. 把這整份貼進去，取代原本的內容
// 3. 存檔 → 「部署」→「新增部署」→「類型選 Web 應用程式」
//    執行身分：我（你的帳號）
//    誰可存取：所有人（Anyone）
// 4. 複製部署網址，貼到 app.js 的 API_URL 變數

const SHEET_ID = '1P0a6jPoozsvuoemsQS9b3Pcpb3M7KWfNGahEUWT2NLU';
const ss = SpreadsheetApp.openById(SHEET_ID);

// ── 工作表欄位定義 ──────────────────────────
// 工作項目：工作ID|訂單編號|客戶|開單日期|品名|規格|數量|單價|金額|交貨期限|進度|完工日期|收款狀態|車號|負責師傅|備註|完工照片|請款單狀態
// 客戶：客戶名稱|聯絡人|電話|統一編號|地址|備註
// 設定：鍵|值

function doGet(e) {
  // 客戶查詢頁面：有 token 參數就直接回傳 HTML
  if (e.parameter && e.parameter.token && !e.parameter.action) {
    return HtmlService.createHtmlOutput(buildCustomerViewHtml(e.parameter.token))
      .setTitle('獨品工坊 · 訂單查詢')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }
  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}

function handleRequest(e) {
  try {
    const params = e.parameter;
    const body = e.postData ? JSON.parse(e.postData.contents) : {};
    const action = params.action || body.action;
    const sheet = params.sheet || body.sheet;
    const secret = params.secret || body.secret;

    // 客戶查詢連結：用 token 驗證，不需要 API_SECRET
    if (action === 'customerView') {
      return ContentService
        .createTextOutput(JSON.stringify(getCustomerView(params.token || body.token)))
        .setMimeType(ContentService.MimeType.JSON);
    }

    const expected = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (expected && secret !== expected) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' })).setMimeType(ContentService.MimeType.JSON);
    }

    // ── 身分驗證（Google 登入）──────────────────
    // 若已設定 GOOGLE_CLIENT_ID 則啟用權限控管；未設定則維持舊行為
    const clientId = PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID');
    let user = null;
    if (body.idToken) user = verifyIdToken(body.idToken);

    // 登入驗證專用 action：回傳角色
    if (action === 'verifyLogin') {
      if (!user) return jsonOut({ error: 'TOKEN_INVALID', debug: debugTokenInfo(body.idToken) });
      const role = getUserRole(user.email);
      if (!role) return jsonOut({ error: 'NOT_ALLOWED', email: user.email });
      return jsonOut({ success: true, email: user.email, name: role.name || user.name, role: role.role });
    }

    // 啟用權限控管後：所有寫入/敏感操作需要有效登入與足夠權限
    if (clientId) {
      const roleInfo = user ? getUserRole(user.email) : null;
      const role = roleInfo ? roleInfo.role : null;
      const writeActions = ['add','addBatch','update','delete','saveSettings','generateInvoice','uploadItemPhoto'];
      if (writeActions.indexOf(action) >= 0) {
        if (!user)  return jsonOut({ error: 'LOGIN_REQUIRED' });
        if (!role)  return jsonOut({ error: 'NOT_ALLOWED', email: user.email });
        // 僅 admin：刪除、開請款單
        if (action === 'delete' && role !== 'admin') return jsonOut({ error: 'FORBIDDEN' });
        if (action === 'generateInvoice' && body.type === 'invoice' && role !== 'admin') return jsonOut({ error: 'FORBIDDEN' });
      }
    }

    let result;
    switch (action) {
      case 'getAll':          result = getAll(sheet); break;
      case 'add':             result = addRow(sheet, body.data, user); break;
      case 'addBatch':        result = addRows(sheet, body.rows, user); break;
      case 'update':          result = updateRow(sheet, body.key, body.data); break;
      case 'delete':          result = deleteRow(sheet, body.key); break;
      case 'getSettings':     result = getSettings(); break;
      case 'saveSettings':    result = saveSettings(body.data); break;
      case 'generateInvoice': result = generateInvoicePDF(body.itemIds, body.type); break;
      case 'getPDFUrl':       result = getPDFUrl(body.itemId, body.type); break;
      case 'uploadItemPhoto': result = uploadItemPhoto(body.itemId, body.base64, body.fileName); break;
      case 'parseVoice':      result = parseVoiceWithAI(body.text, body.customers); break;
      default:                result = { error: 'Unknown action: ' + action };
    }

    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── 驗證 Google ID Token（含快取，減少延遲）──
// ── 除錯用：回傳 tokeninfo 的實際內容與比對結果（上線後可移除）──
function debugTokenInfo(idToken) {
  try {
    if (!idToken) return { reason: 'no idToken in request' };
    const resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    const code = resp.getResponseCode();
    const info = JSON.parse(resp.getContentText() || '{}');
    const clientId = (PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') || '').trim();
    return {
      httpCode: code,
      aud: info.aud || null,
      configuredClientId: clientId,
      audMatches: String(info.aud || '').trim() === clientId,
      email: info.email || null,
      email_verified: info.email_verified,
      exp: info.exp || null,
      expired: info.exp ? (Number(info.exp) * 1000 < Date.now()) : null,
      rawError: info.error || info.error_description || null
    };
  } catch (e) {
    return { reason: 'exception', message: String(e) };
  }
}

function verifyIdToken(idToken) {
  if (!idToken) return null;
  try {
    const cache = CacheService.getScriptCache();
    const key = 'tok_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, idToken)
    );
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);

    const resp = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (resp.getResponseCode() !== 200) return null;
    const info = JSON.parse(resp.getContentText());

    const clientId = (PropertiesService.getScriptProperties().getProperty('GOOGLE_CLIENT_ID') || '').trim();
    if (clientId && String(info.aud || '').trim() !== clientId) return null;
    if (info.exp && Number(info.exp) * 1000 < Date.now()) return null;
    if (info.email_verified === false || info.email_verified === 'false') return null;

    const user = { email: String(info.email || '').toLowerCase(), name: info.name || '' };
    if (!user.email) return null;
    cache.put(key, JSON.stringify(user), 1800); // 快取 30 分鐘
    return user;
  } catch (e) {
    return null;
  }
}

// ── 查員工角色（員工表：email | 姓名 | 角色）──
function getUserRole(email) {
  const sheet = ss.getSheetByName('員工');
  if (!sheet) return null;
  const rows = sheet.getDataRange().getValues();
  const target = String(email || '').trim().toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim().toLowerCase() === target) {
      return { email: target, name: rows[i][1] || '', role: String(rows[i][2] || 'staff').trim() };
    }
  }
  return null;
}

// ── 客戶查詢頁面 HTML ────────────────────────
function buildCustomerViewHtml(token) {
  const data = getCustomerView(token);
  if (data.error) {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>獨品工坊</title></head><body style="font-family:sans-serif;background:#111827;color:#f3f4f6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
    <div style="text-align:center;color:#f87171;">${data.error === 'Invalid token' ? '連結無效或已過期' : data.error}</div>
    </body></html>`;
  }

  const customers = data.customers;
  const items = data.items;
  const activeItems = items.filter(it => it['進度'] !== '完成');
  const doneItems   = items.filter(it => it['進度'] === '完成');

  const progColor = { '待施工': '#4b5563', '施工中': '#1d4ed8', '完成': '#15803d' };

  function renderGroup(list) {
    if (!list.length) return '<p style="color:#6b7280;font-size:13px;">暫無項目</p>';
    const groups = {};
    list.forEach(it => {
      const c = it['客戶'] || '未知';
      if (!groups[c]) groups[c] = [];
      groups[c].push(it);
    });
    return Object.entries(groups).map(([cus, its]) => `
      ${customers.length > 1 ? `<div style="color:#f59e0b;font-size:12px;font-weight:600;margin-bottom:6px;">${cus}</div>` : ''}
      ${its.map(it => {
        const prog = it['進度'] || '待施工';
        const bg = progColor[prog] || '#4b5563';
        const amt = Number(it['金額'] || 0);
        return `<div style="background:#1f2937;border-radius:12px;padding:14px;margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:15px;">${it['品名']||'-'}${it['規格']?' · '+it['規格']:''}</div>
              <div style="color:#9ca3af;font-size:12px;margin-top:3px;">${it['數量']} × $${Number(it['單價']).toLocaleString()}</div>
              ${it['交貨期限']?`<div style="color:#9ca3af;font-size:12px;margin-top:2px;">預計交期：${it['交貨期限']}</div>`:''}
              ${it['完工日期']?`<div style="color:#f59e0b;font-size:12px;margin-top:2px;">完工：${it['完工日期']}</div>`:''}
              ${it['備註']?`<div style="color:#9ca3af;font-size:12px;margin-top:2px;">備註：${it['備註']}</div>`:''}
              <div style="margin-top:8px;"><span style="background:${bg};color:#fff;font-size:11px;padding:2px 10px;border-radius:99px;font-weight:600;">${prog}</span></div>
            </div>
            ${amt?`<div style="color:#f59e0b;font-weight:700;margin-left:12px;white-space:nowrap;">$${amt.toLocaleString()}</div>`:''}
          </div>
        </div>`;
      }).join('')}
    `).join('');
  }

  return `<!DOCTYPE html>
<html lang="zh-TW"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0">
<meta name="theme-color" content="#f59e0b">
<title>獨品工坊 · ${customers.join('、')}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#111827;color:#f3f4f6;font-family:'Noto Sans TC',sans-serif;padding:20px 16px 40px;}
  .header{display:flex;align-items:center;gap:12px;margin-bottom:24px;}
  .logo{width:40px;height:40px;border-radius:10px;background:#f59e0b;display:flex;align-items:center;justify-content:center;color:#111827;font-weight:900;font-size:18px;flex-shrink:0;}
  .section-label{font-size:11px;color:#6b7280;letter-spacing:1px;text-transform:uppercase;margin:20px 0 10px;}
  .footer{text-align:center;font-size:11px;color:#374151;margin-top:24px;}
</style>
</head><body>
<div style="max-width:480px;margin:0 auto;">
  <div class="header">
    <div class="logo">獨</div>
    <div>
      <div style="color:#f59e0b;font-weight:700;font-size:17px;">獨品工坊</div>
      <div style="color:#6b7280;font-size:12px;">${customers.join('、')} · 訂單查詢</div>
    </div>
  </div>
  <div class="section-label">進行中（${activeItems.length}）</div>
  ${renderGroup(activeItems)}
  <div class="section-label">完工待收款（${doneItems.length}）</div>
  ${renderGroup(doneItems)}
  <div class="footer">獨品工坊客製彩繪 · 僅供訂單查詢</div>
</div>
</body></html>`;
}

// ── 客戶查詢連結：用 token 取得指定客戶的進行中+完工未收款項目 ──
function getCustomerView(token) {
  if (!token) return { error: 'Missing token' };
  const linkSheet = ss.getSheetByName('客戶連結');
  if (!linkSheet) return { error: '找不到「客戶連結」工作表' };
  const rows = linkSheet.getDataRange().getValues();
  // 找 token 對應的客戶名稱（跳過第一列標題）
  let customers = [];
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === String(token).trim()) {
      customers = String(rows[i][1]).split(/[,，]/).map(s => s.trim()).filter(Boolean);
      break;
    }
  }
  if (!customers.length) return { error: 'Invalid token' };

  const itemSheet = ss.getSheetByName('工作項目');
  if (!itemSheet) return { error: '找不到工作項目工作表' };
  const all = itemSheet.getDataRange().getValues();
  const headers = all[0];

  const visible = ['工作ID','訂單編號','客戶','開單日期','品名','規格','數量','單價','金額','交貨期限','進度','完工日期','收款狀態','備註'];

  const items = [];
  for (let i = 1; i < all.length; i++) {
    const row = all[i];
    const rowObj = {};
    headers.forEach((h, ci) => { rowObj[h] = row[ci]; });
    const cus = String(rowObj['客戶'] || '').trim();
    if (!customers.map(c => c.trim()).includes(cus)) continue;
    // 只回傳：進行中（進度≠完成）或 完工未收款（進度=完成 且 收款狀態≠已收款）
    const done = rowObj['進度'] === '完成';
    const paid = rowObj['收款狀態'] === '已收款';
    if (paid) continue; // 已收款不顯示
    const filtered = {};
    visible.forEach(k => { filtered[k] = rowObj[k] !== undefined ? rowObj[k] : ''; });
    items.push(filtered);
  }

  return { customers, items };
}

// ── 通用：取得整張表 ────────────────────────
function getAll(sheetName) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: '工作表不存在：' + sheetName };
  const rows = sheet.getDataRange().getValues();
  if (rows.length < 2) return { data: [] };
  const headers = rows[0];
  const data = rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
  return { data };
}

// ── 通用：新增一列 ──────────────────────────
function addRow(sheetName, data, user) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: '工作表不存在：' + sheetName };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (user && headers.indexOf('建立者') >= 0 && !data['建立者']) {
    data['建立者'] = user.name || user.email;
  }
  const row = headers.map(h => data[h] !== undefined ? data[h] : '');
  sheet.appendRow(row);
  return { success: true };
}

// ── 通用：一次寫入多列（單次 setValues，速度遠快於逐筆 appendRow）──
function addRows(sheetName, rowsData, user) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: '工作表不存在：' + sheetName };
  if (!rowsData || !rowsData.length) return { success: true, count: 0 };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const creator = user ? (user.name || user.email) : '';
  const matrix = rowsData.map(data =>
    headers.map(h => {
      if (h === '建立者' && creator && !data[h]) return creator;
      return data[h] !== undefined ? data[h] : '';
    })
  );
  sheet.getRange(sheet.getLastRow() + 1, 1, matrix.length, headers.length).setValues(matrix);
  return { success: true, count: matrix.length };
}

// ── 通用：更新一列（以第一欄主鍵比對）───────
function updateRow(sheetName, key, data) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: '工作表不存在：' + sheetName };
  const all = sheet.getDataRange().getValues();
  const headers = all[0];

  // 當進度改為「完成」且尚無完工日期時，自動寫入今天
  if (sheetName === '工作項目' && data['進度'] === '完成' && !data['完工日期']) {
    const rowIdx = all.findIndex((r, i) => i > 0 && String(r[0]) === String(key));
    if (rowIdx > 0) {
      const completedCol = headers.indexOf('完工日期');
      if (completedCol >= 0 && !all[rowIdx][completedCol]) {
        data['完工日期'] = new Date().toISOString().slice(0, 10);
      }
    }
  }

  for (let i = 1; i < all.length; i++) {
    if (String(all[i][0]) === String(key)) {
      headers.forEach((h, ci) => {
        if (data[h] !== undefined) sheet.getRange(i + 1, ci + 1).setValue(data[h]);
      });
      return { success: true, data };
    }
  }
  return { error: '找不到資料：' + key };
}

// ── 通用：刪除一列（以第一欄主鍵比對）───────
function deleteRow(sheetName, key) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: '工作表不存在：' + sheetName };
  const all = sheet.getDataRange().getValues();
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][0]) === String(key)) {
      sheet.deleteRow(i + 1);
      return { success: true };
    }
  }
  return { error: '找不到資料：' + key };
}

// ── 設定：讀取 ──────────────────────────────
function getSettings() {
  const sheet = ss.getSheetByName('設定');
  if (!sheet) return { data: {} };
  const rows = sheet.getDataRange().getValues();
  const obj = {};
  rows.forEach(r => { if (r[0]) obj[r[0]] = r[1]; });
  return { data: obj };
}

// ── 設定：儲存 ──────────────────────────────
function saveSettings(data) {
  const sheet = ss.getSheetByName('設定');
  if (!sheet) return { error: '工作表不存在：設定' };
  const rows = sheet.getDataRange().getValues();
  Object.entries(data).forEach(([k, v]) => {
    let found = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][0] === k) {
        sheet.getRange(i + 1, 2).setValue(v);
        found = true;
        break;
      }
    }
    if (!found) sheet.appendRow([k, v]);
  });
  return { success: true };
}

// ── 產生請款單 / 生產工單 PDF ────────────────
function generateInvoicePDF(itemIds, type) {
  if (!itemIds || !itemIds.length) return { error: '未指定工作項目' };

  const sheet = ss.getSheetByName('工作項目');
  if (!sheet) return { error: '工作表不存在：工作項目' };
  const all = sheet.getDataRange().getValues();
  const headers = all[0];

  // 取出指定工作項目
  const idSet = new Set(itemIds.map(String));
  const items = [];
  for (let i = 1; i < all.length; i++) {
    if (idSet.has(String(all[i][0]))) {
      const it = {};
      headers.forEach((h, ci) => { it[h] = all[i][ci]; });
      items.push(it);
    }
  }
  if (!items.length) return { error: '找不到指定工作項目' };

  const cfg = getSettings().data;
  const customer = items[0]['客戶'] || '';

  // 請款單以完工日期月份為基準；生產工單以開單日期
  let dateRef;
  if (type === 'invoice') {
    const first = items.find(it => it['完工日期']);
    dateRef = first ? new Date(first['完工日期']) : new Date();
  } else {
    dateRef = items[0]['開單日期'] ? new Date(items[0]['開單日期']) : new Date();
  }

  const roc     = dateRef.getFullYear() - 1911;
  const month   = dateRef.getMonth() + 1;
  const day     = dateRef.getDate();
  const yearMonth = `${dateRef.getFullYear()}-${String(month).padStart(2,'0')}`;
  const label   = type === 'work' ? '生產工單' : '請款單';

  let fileName;
  if (type === 'invoice') {
    fileName = `請款單_${yearMonth}_${customer}.pdf`;
  } else {
    const orderNo = items[0]['訂單編號'] || items[0]['工作ID'];
    fileName = `生產工單_${orderNo}_${customer}.pdf`;
  }

  const subtotal = items.reduce((s, it) => s + (Number(it['數量']) * Number(it['單價'])), 0);
  const taxRate  = Number(cfg['稅率'] || 0);
  const total    = subtotal * (1 + taxRate);

  const extraHeaders = type === 'work' ? '<th>車號</th><th>負責師傅</th>' : '';
  const itemRowsHtml = items.map(it => `
    <tr>
      <td>${it['品名']||''}</td><td>${it['規格']||''}</td>
      <td style="text-align:center">${it['數量']}</td>
      <td style="text-align:right">$${Number(it['單價']).toLocaleString()}</td>
      <td style="text-align:right">$${(Number(it['數量'])*Number(it['單價'])).toLocaleString()}</td>
      ${type==='work'?`<td>${it['車號']||''}</td><td>${it['負責師傅']||''}</td>`:''}
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  body{font-family:Arial,sans-serif;color:#000;padding:32px;font-size:13px;}
  h2{text-align:center;font-size:18px;margin-bottom:16px;}
  .hdr{display:flex;justify-content:space-between;margin-bottom:12px;}
  table{width:100%;border-collapse:collapse;margin-bottom:16px;}
  th,td{border:1px solid #999;padding:6px 8px;}
  th{background:#f3f4f6;}
  .totals{text-align:right;margin-bottom:16px;}
  .info{font-size:12px;line-height:2;border-top:1px solid #ccc;padding-top:12px;}
</style></head><body>
<h2>${month} 月${label}</h2>
<div class="hdr">
  <div>客戶：<strong>${customer}</strong></div>
  <div>中華民國 ${roc} 年 ${month} 月 ${day} 日</div>
</div>
<table><thead><tr>
  <th>品名</th><th>規格</th><th>數量</th><th>單價</th><th>金額</th>${extraHeaders}
</tr></thead><tbody>${itemRowsHtml}</tbody></table>
<div class="totals">
  <div>未稅總和：<strong>$${subtotal.toLocaleString()}</strong></div>
  ${type!=='work'?`<div style="font-size:15px;font-weight:bold;">總額（新台幣）：$${total.toLocaleString()}</div>`:''}
</div>
${type==='work'?`
<table><thead><tr><th colspan="6">製程進度</th></tr>
<tr><th>設計稿</th><th>噴底</th><th>彩繪</th><th>烤漆</th><th>品檢</th><th>出貨</th></tr></thead>
<tbody><tr><td>□</td><td>□</td><td>□</td><td>□</td><td>□</td><td>□</td></tr></tbody></table>
`:`<div class="info">
報價廠商：${cfg['廠商名稱']||'獨品工坊'}&nbsp;&nbsp;負責人：${cfg['負責人']||'李安晟'}<br>
統一編號：${cfg['統一編號']||'95323326'}&nbsp;&nbsp;電話：${cfg['電話']||'0919726434'}<br>
匯款：${cfg['匯款銀行']||'玉山銀行 808 台中分行'}<br>
戶名：${cfg['匯款戶名']||'獨品工坊 李安晟'}&nbsp;&nbsp;帳號：${cfg['匯款帳號']||'1366940043038'}<br>
報價 LINE：${cfg['LINE']||'kingpig6'}
</div>`}
</body></html>`;

  const blob    = Utilities.newBlob(html, MimeType.HTML, fileName + '.html');
  const pdfBlob = blob.getAs(MimeType.PDF);
  pdfBlob.setName(fileName);
  const subFolder = getSubFolder(type, yearMonth);

  // 刪除同前綴舊檔，避免重複
  const prefix = type === 'invoice'
    ? `請款單_${yearMonth}_${customer}`
    : fileName.replace('.pdf', '');
  const existingFiles = subFolder.getFiles();
  while (existingFiles.hasNext()) {
    const f = existingFiles.next();
    if (f.getName().startsWith(prefix)) f.setTrashed(true);
  }

  const file = subFolder.createFile(pdfBlob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // 請款單：更新 請款單狀態
  if (type === 'invoice') {
    itemIds.forEach(id => {
      updateRow('工作項目', id, { '請款單狀態': '已開單' });
    });
  }

  return { success: true, url: file.getUrl(), name: fileName };
}

// ── 取得雲端 PDF 網址 ───────────────────────
function getPDFUrl(itemId, type) {
  const sheet = ss.getSheetByName('工作項目');
  if (!sheet) return { url: null };
  const all = sheet.getDataRange().getValues();
  const headers = all[0];
  let item = null;
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][0]) === String(itemId)) {
      item = {};
      headers.forEach((h, ci) => { item[h] = all[i][ci]; });
      break;
    }
  }
  if (!item) return { url: null };

  const customer = item['客戶'] || '';
  let prefix, yearMonth;

  if (type === 'invoice') {
    const d = item['完工日期'] ? new Date(item['完工日期']) : new Date();
    yearMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    prefix = `請款單_${yearMonth}_${customer}`;
  } else {
    const d = item['開單日期'] ? new Date(item['開單日期']) : new Date();
    yearMonth = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const orderNo = item['訂單編號'] || item['工作ID'];
    prefix = `生產工單_${orderNo}_${customer}`;
  }

  const subFolder = getSubFolder(type, yearMonth);
  const files = subFolder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().startsWith(prefix)) {
      return { url: f.getUrl(), name: f.getName() };
    }
  }
  return { url: null };
}

// ── 取得根資料夾 ────────────────────────────
function getRootFolder() {
  const folders = DriveApp.getFoldersByName('獨品工坊開單');
  return folders.hasNext() ? folders.next() : DriveApp.createFolder('獨品工坊開單');
}

// ── 取得或建立子資料夾（含年月層）───────────
function getSubFolder(type, yearMonth) {
  const root = getRootFolder();
  const typeName = type === 'invoice' ? '請款單' : '生產工單';
  const typeFolders = root.getFoldersByName(typeName);
  const typeFolder = typeFolders.hasNext() ? typeFolders.next() : root.createFolder(typeName);
  if (!yearMonth) return typeFolder;
  const monthFolders = typeFolder.getFoldersByName(yearMonth);
  return monthFolders.hasNext() ? monthFolders.next() : typeFolder.createFolder(yearMonth);
}

// ── 上傳品項完工照片 ─────────────────────────
function uploadItemPhoto(itemId, base64, fileName) {
  const matches = base64.match(/^data:(.+);base64,(.+)$/);
  if (!matches) return { error: '圖片格式錯誤' };
  const mimeType = matches[1];
  const data = matches[2];

  const root = getRootFolder();
  const pr = root.getFoldersByName('完工照片');
  const photoRoot = pr.hasNext() ? pr.next() : root.createFolder('完工照片');
  const of = photoRoot.getFoldersByName(String(itemId));
  const itemFolder = of.hasNext() ? of.next() : photoRoot.createFolder(String(itemId));

  const blob = Utilities.newBlob(Utilities.base64Decode(data), mimeType, fileName || 'photo.jpg');
  const file = itemFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const imageUrl = `https://lh3.googleusercontent.com/d/${file.getId()}`;

  // 更新 工作項目 的完工照片欄位
  const sheet = ss.getSheetByName('工作項目');
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  let photoCol = headers.indexOf('完工照片');
  if (photoCol === -1) {
    photoCol = headers.length;
    sheet.getRange(1, photoCol + 1).setValue('完工照片');
  }
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(itemId)) {
      const existing = rows[i][photoCol] ? rows[i][photoCol] + ',' : '';
      sheet.getRange(i + 1, photoCol + 1).setValue(existing + imageUrl);
      break;
    }
  }
  return { success: true, url: imageUrl };
}

// ── 哈客 2026-06 訂單匯入（執行後可刪除）────
function importHakerJune2026() {
  const today = '2026-06-15';
  const ts = Date.now();

  const orders = [
    // ── 新竹哈客部品 ──────────────────────────
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'V2 寶寶藍',               規格: 'M/L', 備註: '' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'RX7X 寶寶藍',             規格: 'M/L', 備註: '' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'V2 粉芒星',               規格: 'M/L', 備註: '' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'RX7X 粉芒星',             規格: 'M/L', 備註: '' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: '黑雪花烤鴨尾',            規格: '',     備註: '×10 件' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'RX7X 黑五星',             規格: 'L',    備註: '完工寄新竹店，需告知帽子製造年份' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'RX7X 黑五芒星',           規格: 'L',    備註: '預計6月底完成，完工後新竹店自取' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N1', 品名: 'RX7X 粉芒星',             規格: 'M',    備註: '拼7月初完工，完工寄新竹店' },
    // 客訂直寄歸新竹
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N2', 品名: 'RX7X 黑芒星客製化屋簷',  規格: 'L',    備註: '客人已寄件，完工後直接寄回客人' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N2', 品名: '客製化大眼',              規格: '',     備註: '眼睛要紅色，已寄出有貼便條紙' },
    { 客戶: '新竹哈客部品', 訂單編號: '20260615-HK-N2', 品名: 'RX7X 黑芒星屋簷（全新）', 規格: 'XL',  備註: '帽子寄來時確認配件是否裝好，完工後黑貓宅配寄出' },
    // ── 哈客高雄部品 ──────────────────────────
    { 客戶: '哈客高雄部品', 訂單編號: '20260615-HK-K1', 品名: 'V2 寶寶藍',               規格: 'M/L', 備註: '' },
    { 客戶: '哈客高雄部品', 訂單編號: '20260615-HK-K1', 品名: 'V2 寶寶藍',               規格: 'XL',  備註: '' },
    { 客戶: '哈客高雄部品', 訂單編號: '20260615-HK-K1', 品名: 'RX7X 寶寶藍',             規格: 'XL',  備註: '' },
    { 客戶: '哈客高雄部品', 訂單編號: '20260615-HK-K1', 品名: 'RX7X 粉芒星',             規格: 'XL',  備註: '' },
    { 客戶: '哈客高雄部品', 訂單編號: '20260615-HK-K1', 品名: 'RX7X 粉芒星',             規格: 'M/L', 備註: '' },
    { 客戶: '哈客高雄部品', 訂單編號: '20260615-HK-K1', 品名: '黑花烤鴨尾',              規格: '',     備註: '×10 件' },
  ];

  const HEADERS = [
    '工作ID','訂單編號','客戶','開單日期','品名','規格','數量','單價','金額',
    '交貨期限','進度','完工日期','收款狀態','車號','負責師傅','備註','完工照片','請款單狀態'
  ];
  const sheet = ss.getSheetByName('工作項目');
  if (!sheet) { Logger.log('找不到工作項目工作表'); return; }

  const rows = orders.map((o, i) => HEADERS.map(h => {
    switch(h) {
      case '工作ID':     return 'W' + (ts + i).toString();
      case '訂單編號':   return o.訂單編號;
      case '客戶':       return o.客戶;
      case '開單日期':   return today;
      case '品名':       return o.品名;
      case '規格':       return o.規格;
      case '數量':       return 1;
      case '單價':       return 0;
      case '金額':       return 0;
      case '交貨期限':   return '';
      case '進度':       return '待施工';
      case '完工日期':   return '';
      case '收款狀態':   return '未收款';
      case '車號':       return '';
      case '負責師傅':   return '';
      case '備註':       return o.備註;
      case '完工照片':   return '';
      case '請款單狀態': return '';
      default: return '';
    }
  }));

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  Logger.log(`匯入完成！共新增 ${rows.length} 筆工作項目。`);
}

// ── 哈客 2026-06 訂單匯入 END ────────────────
// 使用方式：在 Apps Script 介面選擇 migrateToWorkItems，按執行
function migrateToWorkItems() {
  const HEADERS = [
    '工作ID','訂單編號','客戶','開單日期','品名','規格','數量','單價','金額',
    '交貨期限','進度','完工日期','收款狀態','車號','負責師傅','備註','完工照片','請款單狀態'
  ];

  // 建立或清空「工作項目」工作表
  let wiSheet = ss.getSheetByName('工作項目');
  if (!wiSheet) {
    wiSheet = ss.insertSheet('工作項目');
  } else {
    wiSheet.clearContents();
  }
  wiSheet.appendRow(HEADERS);

  // 讀取舊資料
  const orderSheet = ss.getSheetByName('訂單');
  const itemSheet  = ss.getSheetByName('品項');
  if (!orderSheet || !itemSheet) {
    Logger.log('找不到「訂單」或「品項」工作表，請確認名稱正確。');
    return;
  }

  const orderRows    = orderSheet.getDataRange().getValues();
  const orderHeaders = orderRows[0];
  const orders = {};
  for (let i = 1; i < orderRows.length; i++) {
    const o = {};
    orderHeaders.forEach((h, ci) => { o[h] = orderRows[i][ci]; });
    orders[String(o['訂單編號'])] = o;
  }

  const itemRows    = itemSheet.getDataRange().getValues();
  const itemHeaders = itemRows[0];

  // 一次組好所有列，最後一次寫入（大幅提速）
  const allRows = [];
  const ts = Date.now();

  for (let i = 1; i < itemRows.length; i++) {
    const it = {};
    itemHeaders.forEach((h, ci) => { it[h] = itemRows[i][ci]; });
    const o = orders[String(it['訂單編號'])] || {};

    let 進度 = it['進度'] || '';
    if (!進度) 進度 = (o['狀態'] === '完工交貨') ? '完成' : '待施工';

    const 完工日期 = (進度 === '完成' && o['完工日期']) ? formatDateGs(o['完工日期']) : '';

    let 收款狀態 = o['收款狀態'] || '未收款';
    if (收款狀態 === '收款訂金') 收款狀態 = '未收款';

    allRows.push(HEADERS.map(h => {
      switch(h) {
        case '工作ID':     return 'W' + (ts + i).toString();
        case '訂單編號':   return it['訂單編號'] || '';
        case '客戶':       return o['客戶'] || '';
        case '開單日期':   return o['開單日期'] ? formatDateGs(o['開單日期']) : '';
        case '品名':       return it['品名'] || '';
        case '規格':       return it['規格'] || '';
        case '數量':       return Number(it['數量']) || 0;
        case '單價':       return Number(it['單價']) || 0;
        case '金額':       return (Number(it['數量']) || 0) * (Number(it['單價']) || 0);
        case '交貨期限':   return o['交貨期限'] ? formatDateGs(o['交貨期限']) : '';
        case '進度':       return 進度;
        case '完工日期':   return 完工日期;
        case '收款狀態':   return 收款狀態;
        case '車號':       return it['車號'] || '';
        case '負責師傅':   return it['負責師傅'] || '';
        case '備註':       return it['備註'] || o['備註'] || '';
        case '完工照片':   return it['完工照片'] || o['完工照片'] || '';
        case '請款單狀態': return '';
        default: return '';
      }
    }));
  }

  // 一次性批次寫入
  if (allRows.length > 0) {
    wiSheet.getRange(2, 1, allRows.length, HEADERS.length).setValues(allRows);
  }

  Logger.log(`搬移完成！共轉入 ${allRows.length} 筆工作項目。`);
  return `搬移完成！共轉入 ${allRows.length} 筆工作項目。`;
}

function formatDateGs(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

// ── Claude AI 語音解析 ───────────────────────
function parseVoiceWithAI(text, customers) {
  const key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!key) return { error: '未設定 CLAUDE_API_KEY' };

  const customerList = (customers || []).join('、') || '（無）';
  const prompt = `你是一個訂單助手，請從以下語音辨識文字中萃取工作項目資訊，回傳 JSON。

現有客戶清單：${customerList}

語音內容：「${text}」

今天日期：${new Date().toISOString().slice(0,10)}

請回傳以下 JSON 格式（若無法辨識某欄位則留空字串）：
{
  "customer": "客戶名稱（從現有客戶清單中選，若無相符則填辨識到的名稱）",
  "deadline": "交貨期限（YYYY-MM-DD 格式，如說下週五/月底/六月底請依今天日期推算）",
  "items": [
    {
      "name": "品名",
      "spec": "規格",
      "qty": 數量數字,
      "price": 單價數字,
      "plate": "車號",
      "worker": "負責師傅",
      "note": "備註"
    }
  ]
}

只回傳 JSON，不要其他說明文字。`;

  const response = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    payload: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    }),
    muteHttpExceptions: true
  });

  const rawText = response.getContentText();
  const json = JSON.parse(rawText);
  if (json.error) return { error: json.error.type + ': ' + json.error.message };
  if (!json.content || !json.content[0]) return { error: '空回應：' + rawText };

  try {
    const clean = json.content[0].text.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { success: true, data: parsed };
  } catch (e) {
    return { error: 'JSON 解析失敗：' + json.content[0].text };
  }
}
