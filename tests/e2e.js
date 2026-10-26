// Headless E2E (поза Telegram → localStorage). node tests/e2e.js
const { chromium } = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const URL = process.env.APP_URL || 'http://127.0.0.1:8731/index.html';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✓', m); } else { fail++; console.log('✗', m); } };
(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'uk-UA' });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(e.message));
  const rateReq = []; page.on('response', r => { if (/bank\.gov\.ua|er-api/.test(r.url())) rateReq.push([r.url(), r.status(), r.headers()['access-control-allow-origin']]); });
  await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(2500);

  // 1. курси (CORS з браузера)
  const r = await page.evaluate(() => window.__app.Rates.get());
  console.log('  rate responses:', JSON.stringify(rateReq));
  ok(r.src === 'nbu' && r.USD > 20 && r.EUR > 20 && r.ts > 0, `курси НБУ з браузера: USD=${r.USD} EUR=${r.EUR} src=${r.src}`);
  const cors2 = await page.evaluate(async () => { const j = await (await fetch('https://open.er-api.com/v6/latest/UAH')).json(); return j.result; });
  ok(cors2 === 'success', 'запасне джерело open.er-api.com доступне з браузера (CORS)');
  ok(/Курс НБУ: 1\$ = .* ₴, 1€ = .* ₴ · оновлено \d\d:\d\d/.test(await page.textContent('#rates-line')), 'рядок курсу: ' + await page.textContent('#rates-line'));

  // 2. дохід
  await page.click('#btn-income'); await page.waitForTimeout(350);
  await page.fill('#tx-amount', '5000'); await page.click('#tx-srcs [data-c="salary"]'); await page.fill('#tx-note', 'Зарплата'); await page.click('#tx-save');
  await page.waitForTimeout(150);
  const mid1 = await page.evaluate(() => window.__app.Odo.value());
  await page.waitForTimeout(2200);
  const end1 = await page.evaluate(() => window.__app.Odo.value());
  ok(mid1 > 0 && mid1 < 5000 && end1 === 5000, `одометр крутиться вгору: mid=${mid1.toFixed(1)} → ${end1}`);
  ok(await page.evaluate(() => window.__app.balance()) === 500000, 'баланс 5000 ₴');

  // 3. витрата (грн) + витрата в $
  await page.click('#btn-expense'); await page.waitForTimeout(350);
  await page.fill('#tx-amount', '240'); await page.click('#tx-cats [data-c="transport"]'); await page.click('#tx-save');
  await page.waitForTimeout(150);
  const mid2 = await page.evaluate(() => window.__app.Odo.value());
  await page.waitForTimeout(2200);
  ok(mid2 < 5000 && mid2 > 4760, `одометр крутиться вниз: mid=${mid2.toFixed(1)} → ${await page.evaluate(() => window.__app.Odo.value())}`);
  await page.click('#btn-expense'); await page.waitForTimeout(350);
  await page.click('#tx-curseg [data-cc="USD"]'); await page.fill('#tx-amount', '10');
  const hint = await page.textContent('#tx-conv');
  await page.click('#tx-cats [data-c="fun"]'); await page.click('#tx-save'); await page.waitForTimeout(2200);
  const usdTx = await page.evaluate(() => window.__app.state.tx.find(t => t.oc === 'USD'));
  ok(usdTx && usdTx.oa === 1000 && usdTx.a === Math.round(1000 * r.USD), `витрата 10 $ → ${usdTx && usdTx.a / 100} ₴ (підказка: ${hint})`);
  // голос/текст: "кава 3 євро"
  await page.click('#btn-mic'); await page.waitForTimeout(350);
  await page.fill('#voice-text', 'кава 3 євро'); await page.press('#voice-text', 'Enter'); await page.waitForTimeout(300);
  ok((await page.textContent('#cf-cur')) === '€' && (await page.$eval('#cf-curseg .on', e => e.dataset.cc)) === 'EUR', 'картка підтвердження: валюта € розпізнана');
  await page.click('#cf-save'); await page.waitForTimeout(2200);
  const eurTx = await page.evaluate(() => window.__app.state.tx.find(t => t.oc === 'EUR'));
  ok(eurTx && eurTx.c === 'food' && eurTx.a === Math.round(300 * r.EUR), `«кава 3 євро» збережено: їжа, ${eurTx && eurTx.a / 100} ₴`);

  const bal = await page.evaluate(() => window.__app.balance());
  const expBal = 500000 - 24000 - Math.round(1000 * r.USD) - Math.round(300 * r.EUR);
  const fmt = (c) => new Intl.NumberFormat('uk-UA', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 }).format(c / 100);
  ok(bal === expBal, `баланс після операцій = ${bal / 100} ₴`);

  // 4. історія
  await page.click('[data-go="history"]'); await page.waitForTimeout(700);
  const t = await page.evaluate(() => ({ exp: document.querySelector('#sum-exp').textContent, inc: document.querySelector('#sum-inc').textContent, cats: [...document.querySelectorAll('.cat-row')].map(x => x.innerText.replace(/\s+/g, ' ')) }));
  const totalExp = 500000 - expBal;
  ok(t.exp.includes(fmt(totalExp)), `історія: витрати ${t.exp} (очік. ${fmt(totalExp)})`);
  ok(t.inc.includes('5') && t.inc.startsWith('+'), 'історія: доходи ' + t.inc);
  ok(t.cats.length === 3, 'категорій 3: ' + t.cats.join(' | '));
  const pctSum = await page.evaluate(() => [...document.querySelectorAll('.cat-sum small')].reduce((s, e) => s + parseInt(e.textContent), 0));
  ok(pctSum >= 99 && pctSum <= 101, 'сума відсотків ≈ 100: ' + pctSum);
  // 4b. надходження: ще 2 доходи (голосом/текстом і через шторку), перевіряємо статистику
  await page.click('#scr-history [data-back]'); await page.waitForTimeout(300);
  await page.click('#btn-mic'); await page.waitForTimeout(350);
  await page.fill('#voice-text', 'замовлення на fiverr 150 доларів'); await page.press('#voice-text', 'Enter'); await page.waitForTimeout(300);
  ok((await page.$eval('#cf-srcs .chip.on', e => e.dataset.c)) === 'freelance', 'голос: джерело «Фріланс» визначено');
  await page.click('#cf-save'); await page.waitForTimeout(400);
  await page.click('#btn-income'); await page.waitForTimeout(350);
  await page.click('#tx-curseg [data-cc="UAH"]'); await page.fill('#tx-amount', '800'); await page.click('#tx-srcs [data-c="gift"]'); await page.click('#tx-save'); await page.waitForTimeout(2200);
  const flashSeen = await page.evaluate(() => document.querySelector('#flash').className);
  await page.click('[data-go="history"]'); await page.waitForTimeout(400);
  await page.click('#mode-seg [data-m="inc"]'); await page.waitForTimeout(400);
  const fl = Math.round(15000 * r.USD);
  const incTotal = 500000 + fl + 80000;
  const st = await page.evaluate(() => ({ total: document.querySelector('#donut-inc-total').textContent, rows: [...document.querySelectorAll('#src-list .cat-row')].map(x => x.innerText.replace(/\s+/g, ' ')), count: document.querySelector('#inc-count').textContent, max: document.querySelector('#inc-max').textContent, bars: document.querySelectorAll('#inc-bars rect').length, avg: document.querySelector('#inc-avg').textContent }));
  ok(st.total.includes(fmt(incTotal)), `надходження разом ${st.total} (очік. ${fmt(incTotal)})`);
  ok(st.rows.length === 3 && st.rows[0].includes('Фріланс') && st.rows[1].includes('Зарплата') && st.rows[2].includes('Подарунок'), 'джерела: ' + st.rows.join(' | '));
  ok(st.count === '3' && st.max.includes(fmt(fl)), `кількість 3, найбільше ${st.max}`);
  const days = await page.evaluate(() => Math.max(1, Math.ceil((Date.now() - new Date(new Date().getFullYear(), new Date().getMonth(), 1)) / 864e5)));
  ok(st.avg.includes(fmt(Math.round(incTotal / days))), `середнє/день ${st.avg} (${days} дн.)`);
  ok(st.bars >= 1, 'стовпчики надходжень по днях: ' + st.bars);
  await page.click('#mode-seg [data-m="cmp"]'); await page.waitForTimeout(400);
  const expTotal = 500000 - expBal; const netT = incTotal - expTotal;
  const cmp = await page.evaluate(() => ({ net: document.querySelector('#cmp-net').textContent, rate: document.querySelector('#cmp-rate').textContent, rows: document.querySelectorAll('#cmp-prev .cmp-row').length, rects: document.querySelectorAll('#cmp-bars rect').length }));
  ok(cmp.net.includes(fmt(netT)) && cmp.rate === Math.round(netT / incTotal * 100) + '%', `порівняння: результат ${cmp.net}, норма заощаджень ${cmp.rate}`);
  ok(cmp.rows === 3 && cmp.rects >= 2, 'порівняння з попереднім періодом: 3 рядки, стовпчики ' + cmp.rects);
  await page.click('#scr-history [data-back]'); await page.waitForTimeout(300);

  // 5. перемикання валюти показу
  await page.click('#cur-switch [data-cc="EUR"]'); await page.waitForTimeout(150);
  const midE = await page.evaluate(() => window.__app.Odo.value());
  await page.waitForTimeout(2200);
  const endE = await page.evaluate(() => window.__app.Odo.value());
  const bal2 = await page.evaluate(() => window.__app.balance());
  ok(endE === Math.trunc(Math.round(bal2 / r.EUR) / 100) && midE > endE, `перемикання на €: цифри прокрутились ${midE.toFixed(0)} → ${endE} €`);
  ok((await page.textContent('#odo-cur')) === '€' && (await page.textContent('#st-month')).includes('€') && (await page.textContent('#ie-inc')).includes('€'), 'усі суми на головній у €');
  await page.reload(); await page.waitForTimeout(1500);
  ok((await page.textContent('#odo-cur')) === '€', 'валюта показу запам’ятовується після перезапуску');
  // офлайн: кеш курсів
  await ctx.setOffline(true);
  const off = await page.evaluate(async () => { const r = await window.__app.Rates.refresh(true); return { src: r.src, usd: r.USD, cached: JSON.parse(localStorage.getItem('ma_rates')).USD }; });
  await ctx.setOffline(false);
  ok(off.src === 'nbu' && off.usd === r.USD && off.cached === r.USD, 'офлайн: обидва джерела недоступні → працює кеш курсів');

  ok(errs.length === 0, 'немає JS-помилок ' + (errs.join('; ')));
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
