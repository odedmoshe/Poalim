/*
 * בדיקות קבלה אוטומטיות (Playwright) – לפי רשימת הבדיקות במסמך האפיון:
 *   1. אין גלישה אופקית באף אחד מ-5 השלבים ברוחב 360x800.
 *   2. משטח החתימה קולט חתימה ומטמיע אותה בתצוגת ה-A4, ב-PDF ובקובץ ה-Word.
 *   3. כל כפתור בשלב 5 פותח מיד את #dispatch-hub-modal, מעתיק ללוח ומרנדר את תמונת ה-A4.
 *   4. שיגור בענן שולח PDF תקין (Base64) עם כל הנמענים.
 *
 * הרצה:  npm test   (דורש התקנת playwright: npm i -D playwright)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok }); console.log(`${ok ? '✅' : '❌'} ${name}${info ? ` — ${info}` : ''}`); };

function serve() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

(async () => {
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const launch = { headless: true };
  if (process.env.PW_CHROMIUM_PATH) launch.executablePath = process.env.PW_CHROMIUM_PATH;
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, hasTouch: true, locale: 'he-IL' });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.replace(/\/$/, '') });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));

  // שרת שיגור מדומה
  let cloudPayload = null;
  await page.route('https://notice-endpoint.test/**', async route => {
    cloudPayload = JSON.parse(route.request().postData() || '{}');
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ status: 'ok', mode: cloudPayload.mode }) });
  });

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });

  const overflow = () => page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  const gotoStep = n => page.click(`#stepper-nav [data-step="${n}"]`);

  // ---------- 1. גלישה אופקית (טופס ריק) ----------
  for (let n = 1; n <= 5; n++) {
    await gotoStep(n);
    await page.waitForTimeout(150);
    const { sw, iw } = await overflow();
    check(`שלב ${n}: אין גלישה אופקית (ריק)`, sw <= iw, `scrollWidth=${sw}, innerWidth=${iw}`);
  }

  // ---------- 2. חתימה ----------
  await gotoStep(1);
  await page.locator('#signature-canvas').scrollIntoViewIfNeeded();
  const box = await page.locator('#signature-canvas').boundingBox();
  await page.mouse.move(box.x + 30, box.y + 70);
  await page.mouse.down();
  for (let i = 1; i <= 25; i++) await page.mouse.move(box.x + 30 + i * 10, box.y + 70 + Math.sin(i / 2) * 25);
  await page.mouse.up();
  check('החתימה נקלטה', (await page.textContent('#signature-status')).includes('חתימה נקלטה'));

  // מילוי שדות (נתוני דוגמה ללא החתימה, ואז החתימה המקורית נשמרת? – ממלאים ידנית)
  await page.fill('#input-fullName', 'עובדת לדוגמה');
  await page.fill('#input-idNumber', '123456782');
  await page.fill('#input-role', 'בנקאי/ת לקוחות פרטיים');
  await page.selectOption('#input-district', 'מרכז');
  await page.fill('#input-branchName', 'סניף בדיקה');
  await page.fill('#input-branchNumber', '999');
  await gotoStep(2);
  await page.fill('#input-customRecipient', 'מנהלת הסניף – branch.manager.very.long.address@poalim.co.il');
  await gotoStep(3);
  for (const id of ['earlyArrival', 'overtime', 'clusterDutyOverload', 'staffCollapse', 'noBreaks', 'systemFailures', 'hygieneAndSuppliesCut']) await page.check(`#chk-${id}`);
  await page.fill('#input-earlyArrivalText', 'התייצבות קבועה בשעה 07:30');
  await page.click('#btn-add-log');
  await page.fill('#custom-logs input', 'שבוע 12/10 – 3 ימי פיצול עד 19:30');
  await gotoStep(4);
  for (const id of ['burnout', 'acutePhysicalSymptoms', 'medicalCare']) await page.check(`#chk-${id}`);

  // גלישה אופקית עם תוכן מלא
  for (let n = 1; n <= 5; n++) {
    await gotoStep(n);
    await page.waitForTimeout(150);
    const { sw, iw } = await overflow();
    check(`שלב ${n}: אין גלישה אופקית (מלא)`, sw <= iw, `scrollWidth=${sw}, innerWidth=${iw}`);
    const scrollTop = await page.evaluate(() => window.scrollY);
    check(`שלב ${n}: איפוס גלילה לראש השלב`, scrollTop === 0);
  }

  // שלב 5 – תצוגת A4 כוללת חתימה
  await gotoStep(5);
  check('תצוגת A4 כוללת את תמונת החתימה', await page.locator('#legal-document img[alt="חתימה"]').count() === 1);
  check('נוסח הסעיף כולל את הפירוט האישי', (await page.textContent('#legal-document')).includes('בשעות מוקדמות במיוחד (התייצבות קבועה בשעה 07:30), וזאת'));
  check('שורת שעות דינמית במכתב', (await page.textContent('#legal-document')).includes('חריגת שעות ועומס משמרות נוסף (1): שבוע 12/10'));

  // PDF
  const pdfInfo = await page.evaluate(async () => {
    const a = await generatePdfAssets();
    const html = renderLetterHTML(buildLetterModel(collectState()), { pdfMode: true });
    return { head: atob(a.base64.slice(0, 12)), pages: a.pages, size: a.blob.size, hasSig: html.includes('data:image/png'), fileOk: a.file instanceof File, img: a.imageUrl.slice(0, 22) };
  });
  check('PDF תקין הופק', pdfInfo.head.startsWith('%PDF') && pdfInfo.fileOk, `${pdfInfo.pages} עמודים, ${(pdfInfo.size / 1024).toFixed(0)}KB`);
  check('ה-PDF נבנה מהמסמך החתום', pdfInfo.hasSig);
  check('תמונת A4 הופקה', pdfInfo.img === 'data:image/jpeg;base64');

  // Word
  const word = await page.evaluate(async () => { const w = buildWordDocument(); return { text: await w.blob.text(), name: w.filename }; });
  check('קובץ Word כולל את החתימה המוטמעת', word.text.includes('Content-Type: image/png') && word.text.includes('Content-Location: file:///C:/notice/signature.png'), word.name);

  // ---------- 3. כפתורי שלב 5 ----------
  await page.evaluate(() => {
    localStorage.setItem('poalim_legal_notice_dispatch_v1', JSON.stringify({ url: 'https://notice-endpoint.test/exec', token: '' }));
    // מניעת ניווט אמיתי לקישורי mailto/intent/Gmail בבדיקה
    document.addEventListener('click', e => { const a = e.target.closest('a[href]'); if (a) e.preventDefault(); }, true);
  });
  const actions = await page.$$eval('#step-5 [data-action]', els => els.map(e => e.dataset.action));
  for (const action of actions) {
    await page.evaluate(() => navigator.clipboard.writeText(''));
    const t = await page.evaluate(a => {
      const el = document.querySelector(`#step-5 [data-action="${a}"]`);
      const t0 = performance.now();
      el.click();
      const visible = !document.getElementById('dispatch-hub-modal').hidden;
      return { ms: performance.now() - t0, visible };
    }, action);
    check(`[${action}] החלונית נפתחה מיידית`, t.visible && t.ms < 50, `${t.ms.toFixed(1)}ms`);
    await page.waitForTimeout(250);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const expectClip = action === 'share' ? 'mailbox.mashab@poalim.co.il' : 'מכתב התרעה משפטי';
    check(`[${action}] הועתק ללוח`, clip.includes(expectClip));
    await page.waitForSelector('#dispatch-preview-img:not([hidden])', { timeout: 30000 });
    check(`[${action}] תמונת A4 חתומה מוצגת`, (await page.getAttribute('#dispatch-preview-img', 'src')).startsWith('data:image/jpeg'));
    if (action === 'cloud-draft') {
      await page.waitForFunction(() => document.getElementById('hub-status').classList.contains('ok') || document.getElementById('hub-status').classList.contains('error'), null, { timeout: 30000 });
      const ok = cloudPayload && cloudPayload.mode === 'draft' && atob(cloudPayload.pdfBase64.slice(0, 8)).startsWith('%PDF') && cloudPayload.to.includes('mailbox.mashab@poalim.co.il') && cloudPayload.cc.includes('infops@boi.org.il') && cloudPayload.to.startsWith('branch.manager');
      check('[cloud-draft] נשלחו לשרת: PDF מצורף + To + CC + נושא + גוף', ok && !!cloudPayload.subject && !!cloudPayload.htmlBody && !!cloudPayload.textBody);
    }
    if (action === 'cloud-send') {
      check('[cloud-send] נדרש אישור לפני שליחה', await page.isVisible('#hub-confirm'));
      cloudPayload = null;
      await page.click('#hub-confirm-send');
      await page.waitForFunction(() => document.getElementById('hub-status').classList.contains('ok') || document.getElementById('hub-status').classList.contains('error'), null, { timeout: 30000 });
      check('[cloud-send] שיגור מלא הושלם', !!cloudPayload && cloudPayload.mode === 'send');
    }
    if (action === 'mailto') {
      const href = await page.getAttribute('#link-mailto', 'href');
      check('[mailto] קישור קומפקטי (<850 תווים) עם To, CC ו-Subject', href.length <= 850 && href.includes('cc=') && href.includes('subject='), `${href.length} תווים`);
      check('[mailto] target="_top"', (await page.getAttribute('#link-mailto', 'target')) === '_top');
    }
    if (action === 'intent') {
      const href = await page.getAttribute('#link-intent', 'href');
      check('[intent] קישור Intent ל-Gmail באנדרואיד', href.startsWith('intent:') && href.endsWith('package=com.google.android.gm;end'));
    }
    const { sw, iw } = await overflow();
    check(`[${action}] אין גלישה אופקית בחלונית`, sw <= iw);
    await page.click('#dispatch-hub-modal .hub-panel [data-hub-close]');
  }

  // שמירה אוטומטית ושחזור
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'networkidle' });
  const restored = await page.evaluate(() => ({ name: document.getElementById('input-fullName').value, sig: !!signatureDataUrl, logs: customHourLogs.length, chk: document.getElementById('chk-noBreaks').checked }));
  check('שחזור טיוטה מ-localStorage (שדות, תיבות, שורות, חתימה)', restored.name === 'עובדת לדוגמה' && restored.sig && restored.logs === 1 && restored.chk);

  if (process.env.SCREENSHOT_DIR) {
    await gotoStep(5);
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'mobile-step5.png'), fullPage: false });
    await gotoStep(1);
    await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, 'mobile-step1.png'), fullPage: false });
    const pdf = await page.evaluate(async () => (await generatePdfAssets()).base64);
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, 'notice.pdf'), Buffer.from(pdf, 'base64'));
    const img = await page.evaluate(async () => (await generatePdfAssets()).imageUrl);
    fs.writeFileSync(path.join(process.env.SCREENSHOT_DIR, 'notice.jpg'), Buffer.from(img.split(',')[1], 'base64'));
  }

  check('אין שגיאות JavaScript בדף', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  srv.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} בדיקות עברו`);
  process.exit(failed.length ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
