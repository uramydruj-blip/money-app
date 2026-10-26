const { chromium } = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'uk-UA' });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
  await page.goto('http://127.0.0.1:8731/index.html?demo=1&cur=UAH&bg=aurora&lite=off'); await page.waitForTimeout(2600);
  await page.evaluate(() => window.__app.flashBg('inc')); await page.waitForTimeout(140);
  await page.screenshot({ path: 'screens/flash-green.png' }); await page.waitForTimeout(1000);
  await page.click('[data-go="history"]'); await page.waitForTimeout(400);
  await page.click('#mode-seg [data-m="inc"]'); await page.waitForTimeout(700);
  await page.screenshot({ path: 'screens/income-stats.png' });
  await page.screenshot({ path: 'screens/income-stats-full.png', fullPage: true });
  await page.click('#mode-seg [data-m="cmp"]'); await page.waitForTimeout(700);
  await page.screenshot({ path: 'screens/compare-stats.png' });
  console.log('errors:', errs); await browser.close();
})();
