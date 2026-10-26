// Тести стійкості даних: збої, пошкодження, злиття, нестабільний CloudStorage (фейковий Telegram).
const { chromium } = require('/tmp/mapw/node_modules/playwright-core');
const exe = process.env.HOME + '/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome';
const URL = 'http://127.0.0.1:8731/index.html';
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('✓', m); } else { fail++; console.log('✗', m); } };
const FAKE_TG = `
(function(){
  const LS = localStorage, P = 'fc_';
  const failNow = () => { const n = +(LS.getItem('fc_fail') || 0); if (n > 0) { LS.setItem('fc_fail', n - 1); return true; } return false; };
  const later = (f) => setTimeout(f, 15);
  const CloudStorage = {
    setItem(k, v, cb) { later(() => { if (failNow()) return cb && cb('FAKE_NETWORK_ERROR'); LS.setItem(P + k, v); LS.setItem('fc_writes', +(LS.getItem('fc_writes')||0) + 1); cb && cb(null, true); }); },
    getItem(k, cb) { later(() => cb(null, LS.getItem(P + k) || '')); },
    getItems(keys, cb) { later(() => { const o = {}; keys.forEach(k => o[k] = LS.getItem(P + k) || ''); cb(null, o); }); },
    removeItems(keys, cb) { later(() => { keys.forEach(k => LS.removeItem(P + k)); cb && cb(null, true); }); },
    getKeys(cb) { later(() => cb(null, Object.keys(LS).filter(k => k.startsWith(P) && k !== 'fc_fail' && k !== 'fc_writes').map(k => k.slice(P.length)))); },
  };
  const noop = () => {};
  window.Telegram = { WebApp: { initData: 'query_id=fake', version: '8.0', platform: 'android', isVersionAtLeast: () => true,
    ready: noop, expand: noop, setHeaderColor: noop, setBackgroundColor: noop, setBottomBarColor: noop, disableVerticalSwipes: noop,
    BackButton: { show: noop, hide: noop, onClick: noop }, HapticFeedback: { impactOccurred: noop, notificationOccurred: noop, selectionChanged: noop },
    onEvent: noop, addToHomeScreen: noop, checkHomeScreenStatus: (cb) => cb('unknown'), showConfirm: (m, cb) => cb(true), openTelegramLink: noop, CloudStorage } };
})();`;

(async () => {
  const browser = await chromium.launch({ executablePath: exe });
  // ================= A. Поза Telegram (localStorage) =================
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await ctx.route(/telegram-web-app\.js/, r => r.fulfill({ body: '/* offline stub */', contentType: 'application/javascript' }));
    await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(800);
    const add = (t, a, c) => page.evaluate(([t, a, c]) => window.__app.addTx({ id: 'id' + Math.random().toString(36).slice(2), t, a, oc: 'UAH', oa: a, c, n: 'test', d: Date.now() }), [t, a, c]);
    const bal = () => page.evaluate(() => window.__app.balance());
    const damage = async (fn) => { await page.goto('http://127.0.0.1:8731/tests/'); await page.evaluate(fn); await page.goto(URL); await page.waitForTimeout(900); };
    await add('income', 1000000, 'salary'); await add('expense', 25000, 'food'); await add('expense', 4050, 'transport');
    const B1 = await bal(); ok(B1 === 970950, 'A1: 3 операції, баланс 9 709,50 ₴');
    // A2: «краш» одразу після запису — reload без жодного очікування
    await page.evaluate(() => { window.__app.addTx({ id: 'crash1', t: 'expense', a: 950, oc: 'UAH', oa: 950, c: 'cafe', n: 'kill', d: Date.now() }); location.reload(); });
    await page.waitForLoadState('load'); await page.waitForTimeout(900);
    ok(await bal() === B1 - 950, 'A2: перезапуск одразу після збереження (до async-синхронізації) — запис на місці');
    const B2 = B1 - 950;
    // A3: основний ключ пошкоджено (сміття)
    await damage(() => localStorage.setItem('ma_db', '{"v":2,"rows":"[[broken'));
    ok(await bal() === B2, 'A3: ma_db = сміття → відновлено, баланс збережено');
    await page.waitForFunction(() => /відновлено/i.test(document.querySelector('#toast-text').textContent), null, { timeout: 4000 }).catch(() => {});
    ok(/відновлено/i.test(await page.textContent('#toast-text')), 'A3: користувачу показано повідомлення: «' + await page.textContent('#toast-text') + '»');
    // A4: невідповідність контрольної суми (підмінено суму в журналі)
    await damage(() => { const o = JSON.parse(localStorage.getItem('ma_db')); o.rows = o.rows.replace('1000000', '9000000'); localStorage.setItem('ma_db', JSON.stringify(o)); });
    ok(await bal() === B2, 'A4: checksum mismatch → підмінені дані відкинуто, баланс правильний');
    // A5: журнал пошкоджено І друга копія (хмара/ключі місяців) знищена → автокопія
    await damage(() => { localStorage.setItem('ma_db', 'garbage'); Object.keys(localStorage).filter(k => /^ma_(meta|m\d{6}_\d+)$/.test(k)).forEach(k => localStorage.removeItem(k)); });
    ok(await bal() === B2, 'A5: журнал + віддалена копія втрачені → відновлено з автокопії (ma_bak_0)');
    ok(await page.evaluate(() => Object.keys(localStorage).some(k => /^ma_m\d{6}_0$/.test(k))), 'A5: віддалена копія перезаписана після відновлення');
    // A6: видалення не воскресає після злиття з автокопією/віддаленим
    const victim = await page.evaluate(() => window.__app.state.tx.find(t => t.id === 'crash1').id);
    await page.evaluate((id) => window.__app.deleteTx(id), victim); await page.waitForTimeout(200);
    await page.reload(); await page.waitForTimeout(900);
    ok(await bal() === B2 + 950 && !(await page.evaluate(() => window.__app.state.tx.some(t => t.id === 'crash1'))), 'A6: видалений запис не повертається після перезапуску (надгробок)');
    // A7: недописаний місяць у віддаленій копії (обірваний запис чанка) → журнал перемагає, місяць перезаписано
    await damage(() => { const k = Object.keys(localStorage).find(k => /^ma_m\d{6}_0$/.test(k)); localStorage.setItem(k, localStorage.getItem(k).slice(0, 40)); });
    const st = await page.evaluate(() => window.__app.Store.status());
    ok(await bal() === B2 + 950 && st.pending === 0, 'A7: обірваний чанк у віддаленій копії → дані з журналу, ресинк завершено (pending=0)');
    ok(await page.evaluate(() => window.__app.Store.snapshots().length) >= 1, 'A8: автокопій: ' + await page.evaluate(() => window.__app.Store.snapshots().length) + ' (макс. 3)');
    ok(errs.length === 0, 'A: без JS-помилок ' + errs.join('; '));
    await ctx.close();
  }
  // ================= B. Telegram (фейковий WebApp, нестабільний CloudStorage) =================
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.route(/telegram-web-app\.js/, r => r.fulfill({ body: FAKE_TG, contentType: 'application/javascript' }));
    const page = await ctx.newPage(); const errs = []; page.on('pageerror', e => errs.push(e.message));
    await page.goto(URL); await page.evaluate(() => localStorage.clear()); await page.reload(); await page.waitForTimeout(800);
    ok(await page.evaluate(() => window.__app.Store.kind.startsWith('Telegram CloudStorage')), 'B0: режим Telegram CloudStorage (фейк)');
    const bal = () => page.evaluate(() => window.__app.balance());
    // B1: хмара падає 2 рази → повтор із backoff, доки не підтвердиться
    await page.evaluate(() => localStorage.setItem('fc_fail', '2'));
    await page.evaluate(() => { window.__app.addTx({ id: 'tg1', t: 'income', a: 500000, oc: 'UAH', oa: 500000, c: 'salary', n: '', d: Date.now() }); window.__app.addTx({ id: 'tg2', t: 'expense', a: 12000, oc: 'UAH', oa: 12000, c: 'food', n: '', d: Date.now() }); });
    await page.waitForTimeout(300);
    const s1 = await page.evaluate(() => window.__app.Store.status());
    ok(s1.pending > 0 && s1.attempt >= 1, `B1: перші записи в хмару впали (pending=${s1.pending}, спроба #${s1.attempt}: ${s1.lastError})`);
    await page.waitForFunction(() => window.__app.Store.status().pending === 0, null, { timeout: 20000 });
    ok(true, 'B1: після повторів усе підтверджено в CloudStorage (pending=0)');
    // B2: «краш» під час офлайну хмари: додаємо, хмара лежить, перезапуск
    await page.evaluate(() => localStorage.setItem('fc_fail', '1000'));
    await page.evaluate(() => { window.__app.addTx({ id: 'tg3', t: 'expense', a: 3000, oc: 'UAH', oa: 3000, c: 'transport', n: 'bus', d: Date.now() }); location.reload(); });
    await page.waitForLoadState('load'); await page.waitForTimeout(800);
    ok(await bal() === 485000, 'B2: краш при недоступній хмарі → запис збережено локально (журнал), баланс 4 850 ₴');
    ok(await page.evaluate(() => JSON.parse(localStorage.getItem('ma_pending')).months.length) > 0, 'B2: черга синхронізації пережила перезапуск');
    await page.evaluate(() => localStorage.setItem('fc_fail', '0'));
    await page.evaluate(() => window.__app.Store.sync());
    await page.waitForFunction(() => window.__app.Store.status().pending === 0, null, { timeout: 70000 });
    ok(true, 'B2: хмара повернулась → черга дозалита');
    // B3: «новий телефон»: локальних даних немає, лише хмара
    await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('ma_')).forEach(k => localStorage.removeItem(k)));
    await page.reload(); await page.waitForTimeout(900);
    ok(await bal() === 485000, 'B3: чистий пристрій → усі 3 операції з CloudStorage');
    // B4: злиття: на «іншому пристрої» в хмарі з’явився запис, а локально — інший, ще не синхронізований
    await page.evaluate(() => localStorage.setItem('fc_fail', '1000'));
    await page.evaluate(() => window.__app.addTx({ id: 'localOnly', t: 'expense', a: 1000, oc: 'UAH', oa: 1000, c: 'cafe', n: '', d: Date.now() }));
    await page.waitForTimeout(200);
    // запис від іншого пристрою прямо в хмару (через ту саму упаковку)
    await page.evaluate(() => {
      const S = window.__app.Store; const meta = JSON.parse(localStorage.getItem('fc_meta'));
      const mk = Object.keys(meta.m)[0]; let s = ''; for (let i = 0; i < meta.m[mk]; i++) s += localStorage.getItem('fc_m' + mk + '_' + i);
      const rows = JSON.parse(s); rows.push(S._pack({ id: 'otherDevice', t: 'income', a: 77700, c: 'gift', n: 'з іншого телефону', d: Date.now(), oc: 'UAH', oa: 77700, u: Date.now() }));
      const str = JSON.stringify(rows); localStorage.setItem('fc_m' + mk + '_0', str); meta.m[mk] = 1; meta.h[mk] = S._hash(str); localStorage.setItem('fc_meta', JSON.stringify(meta));
    });
    await page.evaluate(() => localStorage.setItem('fc_fail', '0'));
    await page.reload(); await page.waitForTimeout(900);
    await page.waitForFunction(() => window.__app.Store.status().pending === 0, null, { timeout: 20000 });
    const ids = await page.evaluate(() => window.__app.state.tx.map(t => t.id).sort());
    ok(ids.includes('localOnly') && ids.includes('otherDevice') && await bal() === 485000 - 1000 + 77700, 'B4: злиття за id: і локальний, і «чужий» запис збережені → ' + ids.join(','));
    const cloudHas = await page.evaluate(() => { const meta = JSON.parse(localStorage.getItem('fc_meta')); const mk = Object.keys(meta.m)[0]; let s = ''; for (let i = 0; i < meta.m[mk]; i++) s += localStorage.getItem('fc_m' + mk + '_' + i); return JSON.parse(s).map(r => r[0]); });
    ok(cloudHas.includes('localOnly') && cloudHas.includes('otherDevice'), 'B4: хмара після злиття містить обидва записи');
    ok(errs.length === 0, 'B: без JS-помилок ' + errs.join('; '));
    await ctx.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); process.exit(fail ? 1 : 0);
})();
