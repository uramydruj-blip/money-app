// Скріншоти фонів + вимір FPS/long tasks з CPU throttling 4x
const { chromium } = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:8731/index.html';
(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  const rows = [];
  for (const [bg, file] of [['aurora', 'bg-a'], ['particles', 'bg-b'], ['carbon', 'bg-c']]) {
    for (const lite of ['off', 'on']) {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'uk-UA' });
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', e => errs.push(e.message));
      await page.addInitScript(() => { window.__lt = []; try { new PerformanceObserver(l => l.getEntries().forEach(e => window.__lt.push(e.duration))).observe({ type: 'longtask', buffered: true }); } catch (e) {} });
      await page.goto(`${URL}?demo=1&cur=UAH&bg=${bg}&lite=${lite}`); await page.waitForTimeout(2600);
      if (lite === 'off') await page.screenshot({ path: `screens/${file}.png` });
      const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.evaluate(() => { window.__lt.length = 0; });
      const measure = () => page.evaluate(() => new Promise(res => { let n = 0, worst = 0, prev = performance.now(); const t0 = prev; const f = (now) => { n++; worst = Math.max(worst, now - prev); prev = now; if (now - t0 < 4000) requestAnimationFrame(f); else res({ fps: n / ((now - t0) / 1000), worst }); }; requestAnimationFrame(f); }));
      const idle = await measure();
      const ltIdle = await page.evaluate(() => { const n = window.__lt.length, m = Math.max(0, ...window.__lt); window.__lt.length = 0; return { n, m }; });
      // під час прокрутки цифр (додаємо дохід через API застосунку)
      const p = measure();
      await page.evaluate(() => window.__app.addTx({ id: 'perf' + Math.random(), t: 'income', a: 123400, oc: 'UAH', oa: 123400, c: null, n: 'test', d: Date.now() }));
      const roll = await p;
      const lt = await page.evaluate(() => ({ n: window.__lt.length, max: Math.max(0, ...window.__lt), total: window.__lt.reduce((s, x) => s + x, 0) }));
      const running = await page.evaluate(() => ({ lite: window.__app.BG.isLite(), canvas: window.__app.BG.isRunning() }));
      // пауза при відкритій шторці
      await page.click('#btn-expense'); await page.waitForTimeout(300);
      const paused = await page.evaluate(() => ({ canvas: window.__app.BG.isRunning(), blob: getComputedStyle(document.querySelector('.b1')).animationPlayState }));
      rows.push({ bg, lite, idleFps: idle.fps.toFixed(1), idleWorstMs: idle.worst.toFixed(0), rollFps: roll.fps.toFixed(1), rollWorstMs: roll.worst.toFixed(0), idleLongTasks: ltIdle.n, rollLongTasks: lt.n, rollLongMaxMs: lt.max.toFixed(0), canvasRunning: running.canvas, sheetOpen_canvasRunning: paused.canvas, sheetOpen_blobAnim: paused.blob, errors: errs.length });
      await ctx.close();
    }
  }
  console.table(rows);
  await browser.close();
})();
