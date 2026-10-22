/**
 * Vercel Serverless Function – שיגור מכתב ההתרעה עם קובץ PDF מצורף.
 *
 * ספקי שליחה (לפי משתני הסביבה המוגדרים):
 *   - Resend:  RESEND_API_KEY
 *   - SMTP:    SMTP_HOST, SMTP_PORT (ברירת מחדל 587), SMTP_USER, SMTP_PASS, SMTP_SECURE ('true' לפורט 465)
 * משתני סביבה נוספים:
 *   - MAIL_FROM                  (חובה) כתובת השולח, לדוגמה: "מכתבי התרעה <notices@example.org>"
 *   - NOTICE_API_TOKEN           (מומלץ) קוד גישה שהאפליקציה חייבת לשלוח בשדה token
 *   - ALLOWED_RECIPIENT_DOMAINS  רשימת דומיינים מותרים לנמענים, מופרדת בפסיקים
 *                                (ברירת מחדל: הדומיינים של גורמי הנמענים המובנים באפליקציה)
 *   - ALLOWED_ORIGIN             מקור (Origin) נוסף המורשה לקרוא לשרת (CORS). ברירת מחדל: אותו מקור בלבד.
 *
 * בקשה (POST, JSON): { mode, to, cc, subject, textBody, htmlBody, pdfBase64, filename, replyTo?, token? }
 * תשובה:            { status: 'ok', mode } | { status: 'error', message }
 *
 * הערה: יצירת טיוטה (mode: 'draft') אפשרית רק בחשבון Gmail אישי – דרך Google Apps Script.
 */
'use strict';

const DEFAULT_ALLOWED_DOMAINS = ['poalim.co.il', 'labor.gov.il', 'boi.org.il', 'histadrut.org.il'];
const EMAIL_RE = /^[^\s@,;<>"]+@([^\s@,;<>"]+\.[^\s@,;<>"]+)$/;
const MAX_PDF_BYTES = 4 * 1024 * 1024;
const MAX_RECIPIENTS = 25;

function send(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function toList(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))];
}

function allowedDomains() {
  const env = process.env.ALLOWED_RECIPIENT_DOMAINS;
  return (env ? env.split(',') : DEFAULT_ALLOWED_DOMAINS).map(d => d.trim().toLowerCase()).filter(Boolean);
}

function isAllowedAddress(addr, domains) {
  const m = EMAIL_RE.exec(addr);
  if (!m) return false;
  const domain = m[1].toLowerCase();
  return domains.some(d => domain === d || domain.endsWith(`.${d}`));
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function sendWithResend(msg) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: msg.from,
      to: msg.to,
      cc: msg.cc.length ? msg.cc : undefined,
      reply_to: msg.replyTo || undefined,
      subject: msg.subject,
      text: msg.text,
      html: msg.html || undefined,
      attachments: [{ filename: msg.filename, content: msg.pdfBase64 }]
    })
  });
  if (!r.ok) throw new Error(`Resend: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

async function sendWithSmtp(msg) {
  const nodemailer = require('nodemailer');
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({
    from: msg.from,
    to: msg.to,
    cc: msg.cc,
    replyTo: msg.replyTo || undefined,
    subject: msg.subject,
    text: msg.text,
    html: msg.html || undefined,
    attachments: [{ filename: msg.filename, content: Buffer.from(msg.pdfBase64, 'base64'), contentType: 'application/pdf' }]
  });
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin;
  if (origin && process.env.ALLOWED_ORIGIN && origin === process.env.ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'POST') return send(res, 405, { status: 'error', message: 'Method not allowed' });

  let data;
  try { data = await readJsonBody(req); } catch (e) { return send(res, 400, { status: 'error', message: 'גוף הבקשה אינו JSON תקין' }); }

  if (process.env.NOTICE_API_TOKEN && data.token !== process.env.NOTICE_API_TOKEN) {
    return send(res, 401, { status: 'error', message: 'קוד הגישה שגוי או חסר' });
  }
  if (data.mode !== 'send') {
    return send(res, 400, { status: 'error', message: 'יצירת טיוטה ב-Gmail זמינה רק דרך Google Apps Script בחשבון האישי. בשרת זה ניתן לשלוח בלבד.' });
  }
  if (!process.env.MAIL_FROM || !(process.env.RESEND_API_KEY || process.env.SMTP_HOST)) {
    return send(res, 500, { status: 'error', message: 'השרת אינו מוגדר לשליחת דוא"ל (MAIL_FROM + RESEND_API_KEY או SMTP_*)' });
  }

  const to = toList(data.to);
  const cc = toList(data.cc);
  const domains = allowedDomains();
  if (!to.length) return send(res, 400, { status: 'error', message: 'לא הוגדרו נמענים (To)' });
  if (to.length + cc.length > MAX_RECIPIENTS) return send(res, 400, { status: 'error', message: 'מספר הנמענים חורג מהמותר' });
  const rejected = [...to, ...cc].filter(a => !isAllowedAddress(a, domains));
  if (rejected.length) return send(res, 400, { status: 'error', message: `נמענים שאינם מורשים בשרת זה: ${rejected.join(', ')}` });

  const subject = String(data.subject || '').trim();
  if (!subject || subject.length > 400) return send(res, 400, { status: 'error', message: 'שורת נושא חסרה או ארוכה מדי' });

  const pdfBase64 = String(data.pdfBase64 || '');
  const pdf = Buffer.from(pdfBase64, 'base64');
  if (!pdf.length || pdf.subarray(0, 4).toString('latin1') !== '%PDF') return send(res, 400, { status: 'error', message: 'קובץ ה-PDF חסר או פגום' });
  if (pdf.length > MAX_PDF_BYTES) return send(res, 413, { status: 'error', message: 'קובץ ה-PDF גדול מדי' });

  const replyTo = EMAIL_RE.test(String(data.replyTo || '').trim()) ? String(data.replyTo).trim() : '';
  const filename = String(data.filename || 'Poalim_Legal_Notice.pdf').replace(/[^\w.\-]/g, '_').slice(0, 120);

  const msg = {
    from: process.env.MAIL_FROM, to, cc, replyTo, subject,
    text: String(data.textBody || ''), html: String(data.htmlBody || ''),
    pdfBase64, filename
  };

  try {
    if (process.env.RESEND_API_KEY) await sendWithResend(msg);
    else await sendWithSmtp(msg);
    return send(res, 200, { status: 'ok', mode: 'send' });
  } catch (err) {
    return send(res, 502, { status: 'error', message: `השליחה נכשלה: ${err.message}` });
  }
};
