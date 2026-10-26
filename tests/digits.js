// Перевірка відображення цифр балансу на вузьких екранах (Android/iOS емуляція), кадри посеред анімації.
// node tests/digits.js <prefix> [engine=chromium|webkit]
const pw = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const prefix = process.argv[2] || 'digits';
const engine = process.argv[3] || 'chromium';
const URL = 'http://127.0.0.1:8731/index.html';
const DEV = {
  galaxyS8: { viewport: { width: 360, height: 740 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 9; SM-G950F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 Telegram-Android/11.0' },
  pixel5: { viewport: { width: 393, height: 851 }, deviceScaleFactor: 2.75, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36' },
  iphoneSE: { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
  iphone12: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' },
};
(async () => {
  const browser = engine === 'webkit' ? await pw.webkit.launch() : await pw.chromium.launch({ executablePath: exe });
  const report = [];
  const devs = engine === 'webkit' ? ['iphoneSE', 'iphone12'] : ['galaxyS8', 'pixel5', 'iphoneSE'];
  for (const dn of devs) {
    const o = Object.assign({}, DEV[dn]); if (engine === 'webkit') delete o.isMobile;
    const ctx = await browser.newContext(o);
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(URL + '?bg=aurora'); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(800);
    const cases = [['UAH', 12587050], ['UAH', 4550], ['EUR', 12587050], ['USD', 99999999], ['UAH', -32050]];
    for (const [cur, target] of cases) {
      await page.evaluate(([cur]) => window.__app.setDisplayCur(cur), [cur]); await page.waitForTimeout(100);
      // встановлюємо баланс через дохід/витрату на різницю
      const bal = await page.evaluate(() => window.__app.balance());
      const diff = target - bal; if (!diff) continue;
      await page.evaluate((d) => window.__app.addTx({ id: 'x' + Math.random(), t: d > 0 ? 'income' : 'expense', a: Math.abs(d), oc: 'UAH', oa: Math.abs(d), c: d > 0 ? 'iother' : 'other', n: '', d: Date.now() }), diff);
      await page.waitForTimeout(380);
      const mid = await page.evaluate(() => { const els = [...document.querySelectorAll('.odo-row > *')].filter(e => e.offsetWidth).map(e => e.getBoundingClientRect()); const r = { left: Math.min(...els.map(x => x.left)), right: Math.max(...els.map(x => x.right)) }; r.width = r.right - r.left; const _ = document.querySelector('.odo-row'), c = document.querySelector('.cluster').getBoundingClientRect(); return { rowW: r.width, rowL: r.left, rowR: r.right, cardL: c.left, cardR: c.right }; });
      if (dn === 'galaxyS8' && cur === 'UAH' && target === 12587050) await page.screenshot({ path: `screens/${prefix}-mid.png`, clip: { x: 0, y: 0, width: 360, height: 420 } });
      await page.waitForTimeout(2300);
      const fin = await page.evaluate(() => {
        const row = document.querySelector('.odo-row'), els = [...row.children].filter(e => e.offsetWidth).map(e => e.getBoundingClientRect()), r = { left: Math.min(...els.map(x => x.left)), right: Math.max(...els.map(x => x.right)) }, c = document.querySelector('.cluster').getBoundingClientRect();
        const shown = (window.__app.odoText ? window.__app.odoText() : row.innerText).replace(/\s+/g, '');
        return { text: shown, rowL: r.left, rowR: r.right, cardL: c.left, cardR: c.right, fs: getComputedStyle(document.querySelector('.odo')).fontSize };
      });
      const expect = await page.evaluate(() => { const v = Math.round(window.__app.toDisp(window.__app.balance())); return window.__app.fmt(window.__app.balance()).replace(/\s+/g, ''); });
      const fits = fin.rowL >= fin.cardL - 0.5 && fin.rowR <= fin.cardR + 0.5 && mid.rowL >= mid.cardL - 0.5 && mid.rowR <= mid.cardR + 0.5;
      report.push({ dev: dn, cur, expect, shown: fin.text, textOK: fin.text === expect, fitsCard: fits, fontSize: fin.fs, midRowW: Math.round(mid.rowW), cardW: Math.round(fin.cardR - fin.cardL) });
      if (dn === 'galaxyS8' && cur === 'UAH' && target === 12587050) await page.screenshot({ path: `screens/${prefix}-final.png`, clip: { x: 0, y: 0, width: 360, height: 420 } });
    }
    // поле суми: друкуємо значення як на клавіатурі, перевіряємо що текст не обрізаний
    await page.click('#btn-income'); await page.waitForTimeout(450);
    for (const val of ['258', '12500', '1250000', '99,50', '123456789']) {
      await page.fill('#tx-amount', ''); await page.click('#tx-amount'); await page.keyboard.type(val, { delay: 15 }); await page.waitForTimeout(80);
      const m = await page.evaluate(() => { const i = document.querySelector('#tx-amount'), f = i.closest('.amount-field').getBoundingClientRect(), r = i.getBoundingClientRect(); return { v: i.value, sw: i.scrollWidth, cw: i.clientWidth, sl: i.scrollLeft, fs: getComputedStyle(i).fontSize, inField: r.left >= f.left - .5 && r.right <= f.right + .5 }; });
      report.push({ dev: dn, input: val, value: m.v, noClip: m.sw <= m.cw + 1 && m.sl === 0, inField: m.inField, inputFont: m.fs });
      if (val === '258' || val === '1250000') await page.screenshot({ path: `screens/${prefix}-input-${dn}-${val}.png`, clip: { x: 0, y: Math.max(0, (await page.evaluate(() => document.querySelector('#tx-amount').getBoundingClientRect().top)) - 60), width: o.viewport.width, height: 160 } });
    }
    const inputs = await page.evaluate(() => [...document.querySelectorAll('#sheet-tx input, #sheet-voice input')].map(i => [i.id, parseFloat(getComputedStyle(i).fontSize)]));
    report.push({ dev: dn, inputsMinFontPx: Math.min(...inputs.map(x => x[1])), smallInputs: inputs.filter(x => x[1] < 16).map(x => x[0]).join(',') || '-', errors: errs.length });
    await ctx.close();
  }
  console.table(report);
  await browser.close();
})();
