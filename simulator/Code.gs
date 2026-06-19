/* ============================================================
 *  安全帽彩繪模擬器 — 下單寄信後端 (Google Apps Script)
 *  獨立於開單系統的 Code.gs。
 *
 *  部署：
 *    1. 新增一個 Apps Script 專案，貼上本檔。
 *    2. 在「專案設定 → 指令碼屬性」新增：
 *         ADMIN_EMAIL = 你要收訂單的信箱
 *    3. 部署 → 新增部署 → 類型「網頁應用程式」
 *         執行身分：我；誰可存取：所有人
 *    4. 複製部署網址，填到 config.js 的 apiUrl。
 * ============================================================ */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.action !== 'order') {
      return json({ error: 'unknown action' });
    }

    const adminEmail =
      PropertiesService.getScriptProperties().getProperty('ADMIN_EMAIL');
    if (!adminEmail) return json({ error: 'ADMIN_EMAIL 未設定' });

    // 將 Base64 設計圖還原成 PNG 附件
    const attachments = [];
    if (data.image) {
      const base64 = String(data.image).replace(/^data:image\/png;base64,/, '');
      const blob = Utilities.newBlob(
        Utilities.base64Decode(base64), 'image/png',
        '彩繪設計_' + nowStamp() + '.png'
      );
      attachments.push(blob);
    }

    const html =
      '<h2>新的安全帽彩繪訂單</h2>' +
      row('姓名', data.name) +
      row('電話', data.phone) +
      row('指定分店', data.store) +
      row('服務人員', data.staff) +
      row('備註', data.note) +
      row('選色參數', data.params) +
      '<p>還原設計連結：<a href="' + escapeHtml(data.shareUrl) + '">' +
        escapeHtml(data.shareUrl) + '</a></p>' +
      '<p>設計圖請見附件。</p>';

    MailApp.sendEmail({
      to: adminEmail,
      subject: '【彩繪模擬器】新訂單 — ' + (data.name || '') + ' / ' + (data.store || ''),
      htmlBody: html,
      attachments: attachments,
    });

    return json({ success: true });
  } catch (err) {
    return json({ error: String(err) });
  }
}

function doGet() {
  return json({ status: 'ok' });
}

/* ---------- 小工具 ---------- */
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function row(label, value) {
  return '<p><b>' + label + '：</b>' + escapeHtml(value || '—') + '</p>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nowStamp() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmmss');
}
