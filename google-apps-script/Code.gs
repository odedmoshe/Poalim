/**
 * מחולל מכתבי התרעה משפטיים – שרת שיגור ב-Google Apps Script.
 *
 * הסקריפט נפרס בחשבון ה-Gmail האישי של העובד/ת, ולכן המייל נשלח (או נשמר כטיוטה)
 * מתיבת הדואר של העובד/ת עצמו/ה, עם קובץ ה-PDF החתום כקובץ מצורף.
 *
 * פריסה (פירוט מלא ב-README.md):
 *   1. script.google.com ← פרויקט חדש ← הדביקו את הקובץ הזה.
 *   2. (מומלץ מאוד) הגדרות הפרויקט ← Script properties ← NOTICE_ACCESS_TOKEN = קוד סודי.
 *   3. Deploy ← New deployment ← Web app ← Execute as: Me ← Who has access: Anyone.
 *   4. העתיקו את כתובת ה-Web App (מסתיימת ב-/exec) להגדרות השיגור באפליקציה.
 *
 * בקשה (POST, גוף JSON):
 *   { mode: 'draft' | 'send', to, cc, subject, textBody, htmlBody, pdfBase64, filename, replyTo?, token? }
 * תשובה:
 *   { status: 'ok', mode } | { status: 'error', message }
 */

var ACCESS_TOKEN_PROPERTY = 'NOTICE_ACCESS_TOKEN';
var MAX_PDF_BYTES = 20 * 1024 * 1024;
var EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ status: 'error', message: 'בקשה ריקה' });
    }
    var data = JSON.parse(e.postData.contents);

    var requiredToken = PropertiesService.getScriptProperties().getProperty(ACCESS_TOKEN_PROPERTY);
    if (requiredToken && data.token !== requiredToken) {
      return json_({ status: 'error', message: 'קוד הגישה שגוי או חסר' });
    }

    var to = normalizeList_(data.to);
    var cc = normalizeList_(data.cc);
    if (!to.length) return json_({ status: 'error', message: 'לא הוגדרו נמענים (To)' });
    var invalid = to.concat(cc).filter(function (addr) { return !EMAIL_RE.test(addr); });
    if (invalid.length) return json_({ status: 'error', message: 'כתובות לא תקינות: ' + invalid.join(', ') });
    if (!data.subject) return json_({ status: 'error', message: 'חסרה שורת נושא' });
    if (!data.pdfBase64) return json_({ status: 'error', message: 'חסר קובץ PDF' });

    var pdfBytes = Utilities.base64Decode(data.pdfBase64);
    if (pdfBytes.length > MAX_PDF_BYTES) return json_({ status: 'error', message: 'קובץ ה-PDF גדול מדי' });
    var pdfBlob = Utilities.newBlob(pdfBytes, 'application/pdf', data.filename || 'Poalim_Legal_Notice.pdf');

    var options = {
      cc: cc.join(','),
      htmlBody: data.htmlBody || '',
      attachments: [pdfBlob]
    };
    if (data.replyTo && EMAIL_RE.test(String(data.replyTo).trim())) options.replyTo = String(data.replyTo).trim();

    var mode = data.mode === 'send' ? 'send' : 'draft';
    if (mode === 'send') {
      GmailApp.sendEmail(to.join(','), data.subject, data.textBody || '', options);
    } else {
      GmailApp.createDraft(to.join(','), data.subject, data.textBody || '', options);
    }
    return json_({ status: 'ok', mode: mode });
  } catch (err) {
    return json_({ status: 'error', message: err.toString() });
  }
}

// בדיקת זמינות: פתיחת כתובת ה-Web App בדפדפן תחזיר status: ok
function doGet() {
  return json_({ status: 'ok', service: 'legal-notice-dispatch' });
}

function normalizeList_(value) {
  if (!value) return [];
  var list = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return list.map(function (s) { return String(s).trim(); }).filter(function (s) { return s; });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
