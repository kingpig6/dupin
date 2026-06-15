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
    const expected = PropertiesService.getScriptProperties().getProperty('API_SECRET');
    if (expected && secret !== expected) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'Unauthorized' })).setMimeType(ContentService.MimeType.JSON);
    }

    let result;
    switch (action) {
      case 'getAll':          result = getAll(sheet); break;
      case 'add':             result = addRow(sheet, body.data); break;
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
function addRow(sheetName, data) {
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: '工作表不存在：' + sheetName };
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const row = headers.map(h => data[h] !== undefined ? data[h] : '');
  sheet.appendRow(row);
  return { success: true };
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

// ── 一次性資料搬移（執行後可刪除）──────────
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
    SpreadsheetApp.getUi().alert('找不到「訂單」或「品項」工作表，請確認名稱正確。');
    return;
  }

  const orderRows   = orderSheet.getDataRange().getValues();
  const orderHeaders = orderRows[0];
  const orders = {};
  for (let i = 1; i < orderRows.length; i++) {
    const o = {};
    orderHeaders.forEach((h, ci) => { o[h] = orderRows[i][ci]; });
    orders[String(o['訂單編號'])] = o;
  }

  const itemRows    = itemSheet.getDataRange().getValues();
  const itemHeaders = itemRows[0];
  let count = 0;

  for (let i = 1; i < itemRows.length; i++) {
    const it = {};
    itemHeaders.forEach((h, ci) => { it[h] = itemRows[i][ci]; });
    const o = orders[String(it['訂單編號'])] || {};

    // 進度對應：舊品項無進度欄位時預設「待施工」；若訂單狀態=完工交貨則設「完成」
    let 進度 = it['進度'] || '';
    if (!進度) 進度 = (o['狀態'] === '完工交貨') ? '完成' : '待施工';

    // 完工日期
    const 完工日期 = (進度 === '完成' && o['完工日期']) ? formatDateGs(o['完工日期']) : '';

    // 收款狀態：從訂單繼承
    let 收款狀態 = o['收款狀態'] || '未收款';
    if (收款狀態 === '收款訂金') 收款狀態 = '未收款'; // 訂金視為未收款

    const row = HEADERS.map(h => {
      switch(h) {
        case '工作ID':     return 'W' + (Date.now() + count).toString() + i;
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
    });
    wiSheet.appendRow(row);
    count++;
    Utilities.sleep(50); // 避免超過配額
  }

  SpreadsheetApp.getUi().alert(`搬移完成！共轉入 ${count} 筆工作項目。`);
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
