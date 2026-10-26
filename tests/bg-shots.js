const { chromium } = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  for (const [bg, f] of [['aurora', 'bg-a'], ['particles', 'bg-b'], ['carbon', 'bg-c']]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'uk-UA' });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(`http://127.0.0.1:8731/index.html?demo=1&cur=UAH&bg=${bg}&lite=off`); await page.waitForTimeout(2800);
    await page.screenshot({ path: `screens/${f}.png` }); console.log(f, 'errors:', errs.length); await ctx.close();
  }
  await browser.close();
})();
