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
// 訂單：訂單編號|客戶|開單日期|交貨期限|狀態|備註|收款狀態
// 客戶：客戶名稱|聯絡人|電話|統一編號|地址|備註
// 品項：品項ID|訂單編號|品名|規格|數量|單價|金額|車號|負責師傅
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

    let result;
    switch (action) {
      case 'getAll':    result = getAll(sheet); break;
      case 'add':       result = addRow(sheet, body.data); break;
      case 'update':    result = updateRow(sheet, body.key, body.data); break;
      case 'delete':    result = deleteRow(sheet, body.key); break;
      case 'getSettings': result = getSettings(); break;
      case 'saveSettings': result = saveSettings(body.data); break;
      case 'generatePDF': result = generateInvoicePDF(body.orderNo, body.type); break;
      case 'getPDFUrl':   result = getPDFUrl(body.orderNo, body.type); break;
      case 'uploadPhoto': result = uploadPhoto(body.orderNo, body.base64, body.fileName); break;
      case 'parseVoice':  result = parseVoiceWithAI(body.text, body.customers); break;
      default:          result = { error: 'Unknown action: ' + action };
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
  for (let i = 1; i < all.length; i++) {
    if (String(all[i][0]) === String(key)) {
      headers.forEach((h, ci) => {
        if (data[h] !== undefined) sheet.getRange(i + 1, ci + 1).setValue(data[h]);
      });
      return { success: true };
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

// ── 設定：讀取（轉成 key-value 物件）────────
function getSettings() {
  const sheet = ss.getSheetByName('設定');
  if (!sheet) return { data: {} };
  const rows = sheet.getDataRange().getValues();
  const obj = {};
  rows.forEach(r => { if (r[0]) obj[r[0]] = r[1]; });
  return { data: obj };
}

// ── 產生請款單 PDF 存到雲端硬碟 ─────────────
function generateInvoicePDF(orderNo, type) {
  // 取得訂單
  const orderSheet = ss.getSheetByName('訂單');
  const orderRows = orderSheet.getDataRange().getValues();
  const orderHeaders = orderRows[0];
  let order = null;
  for (let i = 1; i < orderRows.length; i++) {
    if (String(orderRows[i][0]) === String(orderNo)) {
      order = {};
      orderHeaders.forEach((h, ci) => { order[h] = orderRows[i][ci]; });
      break;
    }
  }
  if (!order) return { error: '找不到訂單：' + orderNo };

  const customer = order['客戶'] || '';
  const cfg = getSettings().data;

  // 請款單以「完工日期月份」為基準；生產工單以開單日期顯示
  const dateRef = (type === 'invoice' && order['完工日期'])
    ? new Date(order['完工日期'])
    : new Date(order['開單日期']);
  const roc   = dateRef.getFullYear() - 1911;
  const month = dateRef.getMonth() + 1;
  const yyyymm = `${dateRef.getFullYear()}${String(month).padStart(2,'0')}`;

  let items = [];
  let fileName = '';

  if (type === 'invoice') {
    // ── 請款單：合併同月同客戶「完工交貨」訂單品項 ──
    const allOrderRows = orderSheet.getDataRange().getValues();
    const allOrderHeaders = allOrderRows[0];
    const sameMonthOrders = [];
    for (let i = 1; i < allOrderRows.length; i++) {
      const o2 = {};
      allOrderHeaders.forEach((h, ci) => { o2[h] = allOrderRows[i][ci]; });
      if (o2['狀態'] !== '完工交貨') continue;       // 未完工不列入
      if (o2['客戶'] !== customer) continue;
      // 以完工日期月份判斷
      const dRef2 = o2['完工日期'] ? new Date(o2['完工日期']) : new Date(o2['開單日期']);
      const oym = `${dRef2.getFullYear()}${String(dRef2.getMonth()+1).padStart(2,'0')}`;
      if (oym === yyyymm) sameMonthOrders.push(String(o2['訂單編號']));
    }
    const itemSheet = ss.getSheetByName('品項');
    const itemRows = itemSheet.getDataRange().getValues();
    const itemHeaders = itemRows[0];
    for (let i = 1; i < itemRows.length; i++) {
      if (sameMonthOrders.includes(String(itemRows[i][1]))) {
        const it = {};
        itemHeaders.forEach((h, ci) => { it[h] = itemRows[i][ci]; });
        items.push(it);
      }
    }
    fileName = `請款單_${yyyymm}_${customer}.pdf`;
  } else {
    // ── 生產工單：只含此訂單品項 ──
    const itemSheet = ss.getSheetByName('品項');
    const itemRows = itemSheet.getDataRange().getValues();
    const itemHeaders = itemRows[0];
    for (let i = 1; i < itemRows.length; i++) {
      if (String(itemRows[i][1]) === String(orderNo)) {
        const it = {};
        itemHeaders.forEach((h, ci) => { it[h] = itemRows[i][ci]; });
        items.push(it);
      }
    }
    fileName = `生產工單_${orderNo}_${customer}.pdf`;
  }

  const subtotal = items.reduce((s, it) => s + (Number(it['數量']) * Number(it['單價'])), 0);
  const taxRate = Number(cfg['稅率'] || 0);
  const total = subtotal * (1 + taxRate);
  const day = dateRef.getDate();
  const label = type === 'work' ? '生產工單' : '請款單';

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

  // 產生 PDF，存入對應子資料夾，覆蓋舊檔
  const blob = Utilities.newBlob(html, MimeType.HTML, fileName + '.html');
  const pdfBlob = blob.getAs(MimeType.PDF);
  pdfBlob.setName(fileName);
  const subFolder = getSubFolder(type);

  // 刪除同前綴的所有舊檔（避免重複）
  const prefix = type === 'invoice'
    ? fileName.replace('.pdf', '')   // 請款單_YYYYMM_客戶
    : `生產工單_${orderNo}_`;        // 生產工單_訂單編號_
  const existingFiles = subFolder.getFiles();
  while (existingFiles.hasNext()) {
    const f = existingFiles.next();
    if (f.getName().startsWith(prefix)) f.setTrashed(true);
  }

  const file = subFolder.createFile(pdfBlob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { success: true, url: file.getUrl(), name: fileName };
}

// ── 取得雲端 PDF 網址（沒有回傳 null）────────
function getPDFUrl(orderNo, type) {
  const subFolder = getSubFolder(type);
  let prefix = '';

  if (type === 'invoice') {
    const orderSheet = ss.getSheetByName('訂單');
    const rows = orderSheet.getDataRange().getValues();
    const headers = rows[0];
    for (let i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(orderNo)) {
        const completedDate = rows[i][headers.indexOf('完工日期')];
        const d = completedDate ? new Date(completedDate) : new Date(rows[i][headers.indexOf('開單日期')]);
        const yyyymm = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}`;
        const customer = rows[i][headers.indexOf('客戶')];
        prefix = `請款單_${yyyymm}_${customer}`;
        break;
      }
    }
  } else {
    prefix = `生產工單_${orderNo}_`;
  }

  if (!prefix) return { url: null };

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

// ── 取得或建立子資料夾 ───────────────────────
function getSubFolder(type) {
  const root = getRootFolder();
  const subName = type === 'invoice' ? '請款單' : '生產工單';
  const subs = root.getFoldersByName(subName);
  return subs.hasNext() ? subs.next() : root.createFolder(subName);
}

// ── 上傳完工照片到 Google Drive ──────────────
function uploadPhoto(orderNo, base64, fileName) {
  // base64 格式：data:image/jpeg;base64,/9j/...
  const matches = base64.match(/^data:(.+);base64,(.+)$/);
  if (!matches) return { error: '圖片格式錯誤' };
  const mimeType = matches[1];
  const data = matches[2];

  // 存到「獨品工坊開單/完工照片/訂單編號/」
  const root = getRootFolder();
  let photoRoot;
  const pr = root.getFoldersByName('完工照片');
  photoRoot = pr.hasNext() ? pr.next() : root.createFolder('完工照片');
  let orderFolder;
  const of = photoRoot.getFoldersByName(orderNo);
  orderFolder = of.hasNext() ? of.next() : photoRoot.createFolder(orderNo);

  const blob = Utilities.newBlob(Utilities.base64Decode(data), mimeType, fileName || 'photo.jpg');
  const file = orderFolder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  // 取得直接顯示用的圖片網址
  const imageUrl = `https://lh3.googleusercontent.com/d/${file.getId()}`;

  // 更新訂單的「完工照片」欄位（附加）
  const sheet = ss.getSheetByName('訂單');
  const rows = sheet.getDataRange().getValues();
  const headers = rows[0];
  const photoCol = headers.indexOf('完工照片');
  if (photoCol === -1) return { error: '試算表缺少「完工照片」欄位' };

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(orderNo)) {
      const existing = rows[i][photoCol] ? rows[i][photoCol] + ',' : '';
      sheet.getRange(i + 1, photoCol + 1).setValue(existing + imageUrl);
      break;
    }
  }

  return { success: true, url: imageUrl };
}

// ── Claude AI 語音解析 ───────────────────────
function parseVoiceWithAI(text, customers) {
  const key = PropertiesService.getScriptProperties().getProperty('CLAUDE_API_KEY');
  if (!key) return { error: '未設定 CLAUDE_API_KEY' };

  const customerList = (customers || []).join('、') || '（無）';
  const prompt = `你是一個訂單助手，請從以下語音辨識文字中萃取訂單品項資訊，回傳 JSON。

現有客戶清單：${customerList}

語音內容：「${text}」

請回傳以下 JSON 格式（若無法辨識某欄位則留空字串）：
{
  "customer": "客戶名稱（從現有客戶清單中選，若無相符則填辨識到的名稱）",
  "items": [
    {
      "name": "品名",
      "spec": "規格",
      "qty": 數量數字,
      "price": 單價數字,
      "plate": "車號",
      "worker": "負責師傅"
    }
  ],
  "note": "備註"
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

  const json = JSON.parse(response.getContentText());
  if (json.error) return { error: json.error.message };

  try {
    const parsed = JSON.parse(json.content[0].text);
    return { success: true, data: parsed };
  } catch (e) {
    return { error: 'AI 回傳格式錯誤：' + json.content[0].text };
  }
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
