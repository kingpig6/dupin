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
// 訂單：訂單編號|客戶|開單日期|交貨期限|狀態|收款狀態|備註
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
