const { chromium } = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:8731/index.html';
(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  const mk = async () => { const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'uk-UA' }); return [ctx, await ctx.newPage()]; };
  // fallback: НБУ заблоковано → open.er-api
  let [ctx, page] = await mk();
  await ctx.route(/bank\.gov\.ua/, r => r.abort());
  await page.goto(URL); await page.waitForTimeout(2500);
  const fb = await page.evaluate(() => window.__app.Rates.get());
  console.log((fb.src === 'er-api' ? '✓' : '✗') + ' fallback when NBU unreachable: src=' + fb.src + ' USD=' + fb.USD.toFixed(4) + ' EUR=' + fb.EUR.toFixed(4) + ' | ' + await page.textContent('#rates-line'));
  await ctx.close();
  // screenshots
  [ctx, page] = await mk();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL + '?demo=1'); await page.waitForTimeout(1500);
  await page.click('#cur-switch [data-cc="EUR"]'); await page.waitForTimeout(2400);
  await page.screenshot({ path: 'screens/1-main-v3.png' });
  await page.click('#cur-switch [data-cc="UAH"]'); await page.waitForTimeout(300);
  await page.click('#btn-expense'); await page.waitForTimeout(400);
  await page.click('#tx-curseg [data-cc="USD"]'); await page.fill('#tx-amount', '25'); await page.click('#tx-cats [data-c="shopping"]'); await page.fill('#tx-note', 'Навушники');
  await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(300);
  await page.screenshot({ path: 'screens/2-add-expense-v2.png' });
  console.log('errors:', errs);
  await browser.close();
})();
