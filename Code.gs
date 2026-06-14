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

  // 取得品項
  const itemSheet = ss.getSheetByName('品項');
  const itemRows = itemSheet.getDataRange().getValues();
  const itemHeaders = itemRows[0];
  const items = [];
  for (let i = 1; i < itemRows.length; i++) {
    if (String(itemRows[i][1]) === String(orderNo)) {
      const it = {};
      itemHeaders.forEach((h, ci) => { it[h] = itemRows[i][ci]; });
      items.push(it);
    }
  }

  // 取得設定
  const cfg = getSettings().data;

  // 計算
  const subtotal = items.reduce((s, it) => s + (Number(it['數量']) * Number(it['單價'])), 0);
  const taxRate = Number(cfg['稅率'] || 0);
  const total = subtotal * (1 + taxRate);
  const d = new Date(order['開單日期']);
  const roc = d.getFullYear() - 1911;
  const month = d.getMonth() + 1;
  const day = d.getDate();

  // 品項列
  const itemRows2 = items.map(it => `
    <tr>
      <td>${it['品名'] || ''}</td>
      <td>${it['規格'] || ''}</td>
      <td style="text-align:center">${it['數量']}</td>
      <td style="text-align:right">$${Number(it['單價']).toLocaleString()}</td>
      <td style="text-align:right">$${(Number(it['數量']) * Number(it['單價'])).toLocaleString()}</td>
      ${type === 'work' ? `<td>${it['車號'] || ''}</td><td>${it['負責師傅'] || ''}</td>` : ''}
    </tr>`).join('');

  const extraHeaders = type === 'work'
    ? '<th>車號</th><th>負責師傅</th>'
    : '';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: 'Noto Sans TC', Arial, sans-serif; color:#000; padding:32px; font-size:13px; }
  h2 { text-align:center; font-size:18px; margin-bottom:16px; }
  .header { display:flex; justify-content:space-between; margin-bottom:12px; }
  table { width:100%; border-collapse:collapse; margin-bottom:16px; }
  th,td { border:1px solid #999; padding:6px 8px; }
  th { background:#f3f4f6; }
  .totals { text-align:right; margin-bottom:16px; }
  .info { font-size:12px; line-height:2; border-top:1px solid #ccc; padding-top:12px; }
  ${type === 'work' ? '.process { margin-top:20px; } .process td { width:14%; text-align:center; }' : ''}
</style></head><body>
<h2>${month} 月${type === 'work' ? '生產工單' : '請款單'}</h2>
<div class="header">
  <div>客戶：<strong>${order['客戶'] || ''}</strong></div>
  <div>中華民國 ${roc} 年 ${month} 月 ${day} 日</div>
</div>
<table>
  <thead><tr>
    <th>品名</th><th>規格</th><th>數量</th><th>單價</th><th>金額</th>${extraHeaders}
  </tr></thead>
  <tbody>${itemRows2}</tbody>
</table>
<div class="totals">
  <div>未稅總和：<strong>$${subtotal.toLocaleString()}</strong></div>
  ${type !== 'work' ? `<div style="font-size:16px;font-weight:bold;">總額（新台幣）：$${total.toLocaleString()}</div>` : ''}
</div>
${type === 'work' ? `
<table class="process">
  <thead><tr><th colspan="6">製程進度</th></tr>
  <tr><td>設計稿</td><td>噴底</td><td>彩繪</td><td>烤漆</td><td>品檢</td><td>出貨</td></tr></thead>
  <tbody><tr><td>□</td><td>□</td><td>□</td><td>□</td><td>□</td><td>□</td></tr></tbody>
</table>` : `
<div class="info">
  報價廠商：${cfg['廠商名稱'] || '獨品工坊'}&nbsp;&nbsp;&nbsp;負責人：${cfg['負責人'] || '李安晟'}<br>
  統一編號：${cfg['統一編號'] || '95323326'}&nbsp;&nbsp;&nbsp;電話：${cfg['電話'] || '0919726434'}<br>
  匯款：${cfg['匯款銀行'] || '玉山銀行 808 台中分行'}<br>
  戶名：${cfg['匯款戶名'] || '獨品工坊 李安晟'}&nbsp;&nbsp;&nbsp;帳號：${cfg['匯款帳號'] || '1366940043038'}<br>
  報價 LINE：${cfg['LINE'] || 'kingpig6'}
</div>`}
</body></html>`;

  // 產生 PDF blob
  const blob = Utilities.newBlob(html, MimeType.HTML, orderNo + '.html');
  const pdfBlob = blob.getAs(MimeType.PDF);
  const label = type === 'work' ? '生產工單' : '請款單';
  const fileName = `${label}_${orderNo}_${order['客戶']}.pdf`;
  pdfBlob.setName(fileName);

  // 找或建立「獨品工坊開單」資料夾
  const folder = getDriveFolder();

  // 覆蓋：若已有同名檔案先刪除
  const existing = folder.getFilesByName(fileName);
  while (existing.hasNext()) existing.next().setTrashed(true);

  // 存新檔
  const file = folder.createFile(pdfBlob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return { success: true, url: file.getUrl(), name: fileName };
}

// ── 取得雲端硬碟中的 PDF 網址（沒有回傳 null）──
function getPDFUrl(orderNo, type) {
  const folder = getDriveFolder();
  // 需要客戶名稱來組出檔名，先搜尋前綴
  const label = type === 'work' ? '生產工單' : '請款單';
  const prefix = `${label}_${orderNo}_`;
  const files = folder.getFiles();
  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().startsWith(prefix)) {
      return { url: f.getUrl(), name: f.getName() };
    }
  }
  return { url: null };
}

// ── 取得或建立資料夾 ────────────────────────
function getDriveFolder() {
  const folders = DriveApp.getFoldersByName('獨品工坊開單');
  return folders.hasNext() ? folders.next() : DriveApp.createFolder('獨品工坊開單');
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
