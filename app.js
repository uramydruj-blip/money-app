/* Бухгалтерія — Telegram Mini App. Повністю статичний, без сервера. */
'use strict';
(function () {
const tg = window.Telegram && window.Telegram.WebApp;
const inTG = !!(tg && tg.initData);
const ver = (v) => !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v));
const P = window.MoneyParser;
const CATS = P.CATEGORIES;
const CAT = Object.fromEntries(CATS.map(c => [c.id, c]));
const SRCS = P.SOURCES;
const SRC = Object.fromEntries(SRCS.map(c => [c.id, c]));
const CURRENCIES = { UAH: '₴', EUR: '€', USD: '$' };
const CUR_NAMES = { UAH: 'Гривня ₴', EUR: 'Євро €', USD: 'Долар $' };
const CUR_ORDER = ['UAH', 'EUR', 'USD'];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = { tx: [], dead: [], settings: { cur: 'UAH' }, period: 'month', catFilter: null, srcFilter: null, mode: 'exp' };

/* ---------------- Telegram ---------------- */
const H = {
  impact(s = 'light') { try { ver('6.1') && tg.HapticFeedback.impactOccurred(s); } catch (e) {} },
  notify(t = 'success') { try { ver('6.1') && tg.HapticFeedback.notificationOccurred(t); } catch (e) {} },
  select() { try { ver('6.1') && tg.HapticFeedback.selectionChanged(); } catch (e) {} },
};
if (tg) {
  try { tg.ready(); tg.expand(); } catch (e) {}
  try { if (ver('6.1')) { tg.setHeaderColor('#111315'); tg.setBackgroundColor('#111315'); } } catch (e) {}
  try { if (ver('7.10')) tg.setBottomBarColor('#111315'); } catch (e) {}
  try { if (ver('7.7')) tg.disableVerticalSwipes(); } catch (e) {}
}
if (inTG) document.body.classList.add('tg');

/* ---------------- Сховище (стійке до збоїв) ----------------
   1) WAL: на КОЖНУ зміну синхронно пишемо все в localStorage (ma_db, з контрольною сумою) — ДО будь-якого async.
   2) Черга синхронізації (ma_pending): місяці, які ще не підтверджені в CloudStorage; повтор із backoff, доки не підтвердиться.
   3) Віддалене сховище: Telegram CloudStorage (по місяцях, чанки ≤4000 симв., хеш місяця в meta) або, поза Telegram,
      та сама схема ключами в localStorage (друга копія).
   4) Старт: WAL (або автокопія, якщо WAL пошкоджено) + віддалене → злиття за id/u (оновлено), видалення — «надгробки».
   5) Автокопії: 3 останні знімки (ma_bak_0..2), ротація при старті та не частіше ніж раз на 10 хв. */
const Store = (() => {
  const cloud = inTG && ver('6.9') && tg.CloudStorage;
  const LS = 'ma_', WAL = 'ma_db', PEND = 'ma_pending', BAK = 'ma_bak_', NBAK = 3, CHUNK = 4000, TOMB_TTL = 180 * 864e5;
  const cb = (fn) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 10000); fn((e, v) => { clearTimeout(t); e ? rej(e) : res(v); }); });
  const api = cloud ? {
    kind: 'Telegram CloudStorage + локальний журнал',
    get: (keys) => keys.length ? cb(f => tg.CloudStorage.getItems(keys, f)).then(v => v || {}) : Promise.resolve({}),
    set: (k, v) => cb(f => tg.CloudStorage.setItem(k, v, f)),
    del: (keys) => keys.length ? cb(f => tg.CloudStorage.removeItems(keys, f)) : Promise.resolve(true),
  } : {
    kind: 'localStorage (браузер) + журнал',
    get: async (keys) => Object.fromEntries(keys.map(k => [k, localStorage.getItem(LS + k) || ''])),
    set: async (k, v) => localStorage.setItem(LS + k, v),
    del: async (keys) => keys.forEach(k => localStorage.removeItem(LS + k)),
  };
  const hash = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
  const monthKey = (ts) => { const d = new Date(ts); return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'); };
  const pack = (t) => [t.id, t.t === 'income' ? 'i' : 'e', t.a, t.c || '', t.n || '', Math.round(t.d / 1000), t.oc || 'UAH', t.oa != null ? t.oa : t.a, t.u || t.d, t.x ? 1 : 0];
  const unpack = (r) => ({ id: r[0], t: r[1] === 'i' ? 'income' : 'expense', a: r[2], c: r[3] || null, n: r[4] || '', d: r[5] * 1000, oc: r[6] || 'UAH', oa: r[6] ? r[7] : r[2], u: r[8] || r[5] * 1000, x: r[9] ? 1 : 0 });
  let meta = { v: 2, cur: 'UAH', m: {}, h: {} };
  let all = [];                 // усі записи, включно з надгробками
  let settings = { cur: 'UAH' };
  const listeners = [];

  // ---------- локальний журнал ----------
  function writeWAL() {
    const rows = JSON.stringify(all.map(pack));
    const body = JSON.stringify({ v: 2, at: Date.now(), settings, rows, sum: hash(rows) });
    try { localStorage.setItem(WAL, body); } catch (e) { console.error('WAL write failed', e); }
  }
  function parseDB(raw) { // повертає {tx, settings, at} або null, якщо пошкоджено
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || typeof o.rows !== 'string' || hash(o.rows) !== o.sum) throw new Error('checksum mismatch');
    return { tx: JSON.parse(o.rows).map(unpack), settings: o.settings || {}, at: o.at || 0 };
  }
  function readSnapshots() {
    const out = [];
    for (let i = 0; i < NBAK; i++) { try { const d = parseDB(localStorage.getItem(BAK + i)); if (d) out.push(Object.assign(d, { i })); } catch (e) { /* пошкоджена копія — пропускаємо */ } }
    return out;
  }
  function snapshot(force) {
    const raw = localStorage.getItem(WAL); if (!raw) return;
    let newest = null; try { newest = JSON.parse(localStorage.getItem(BAK + 0) || 'null'); } catch (e) {}
    let cur = null; try { cur = JSON.parse(raw); } catch (e) { return; }
    if (newest && newest.sum === cur.sum) return;                    // нічого не змінилось
    if (!force && newest && Date.now() - (newest.at || 0) < 10 * 60e3) return;
    try { for (let i = NBAK - 1; i > 0; i--) { const p = localStorage.getItem(BAK + (i - 1)); if (p) localStorage.setItem(BAK + i, p); } localStorage.setItem(BAK + 0, raw); } catch (e) { console.warn('snapshot', e); }
  }
  // ---------- черга синхронізації ----------
  const readPending = () => { try { return JSON.parse(localStorage.getItem(PEND) || '{"months":[],"meta":false}'); } catch (e) { return { months: [], meta: true }; } };
  const writePending = (p) => localStorage.setItem(PEND, JSON.stringify(p));
  function markPending(months, metaToo = true) {
    const p = readPending(); for (const m of months) if (!p.months.includes(m)) p.months.push(m); if (metaToo) p.meta = true; writePending(p);
  }
  let syncing = false, attempt = 0, retryT = 0, lastError = '';
  async function writeMonth(mk) {
    const rows = all.filter(t => monthKey(t.d) === mk).sort((a, b) => a.d - b.d).map(pack);
    const str = rows.length ? JSON.stringify(rows) : '';
    const n = Math.ceil(str.length / CHUNK);
    for (let i = 0; i < n; i++) await api.set(`m${mk}_${i}`, str.slice(i * CHUNK, (i + 1) * CHUNK));
    const old = meta.m[mk] || 0, stale = [];
    for (let i = n; i < old; i++) stale.push(`m${mk}_${i}`);
    await api.del(stale);
    if (n) { meta.m[mk] = n; meta.h[mk] = hash(str); } else { delete meta.m[mk]; delete meta.h[mk]; }
  }
  async function sync() {
    if (syncing) return; syncing = true; clearTimeout(retryT);
    try {
      let p = readPending();
      while (p.months.length || p.meta) {
        for (const mk of p.months.slice()) {
          await writeMonth(mk);
          const q = readPending(); q.months = q.months.filter(x => x !== mk); q.meta = true; writePending(q);
        }
        meta.cur = settings.cur; meta.bg = settings.bg; meta.lite = settings.lite; meta.su = settings.u || 0;
        await api.set('meta', JSON.stringify(meta));
        const q = readPending(); q.meta = false; writePending(q);
        p = readPending();
      }
      attempt = 0; lastError = '';
    } catch (e) {
      attempt++; lastError = String(e && e.message || e);
      const wait = Math.min(60000, 1000 * Math.pow(2, attempt));
      console.warn('sync failed, retry in', wait, e); retryT = setTimeout(sync, wait);
    } finally { syncing = false; listeners.forEach(f => f(status())); }
  }
  const status = () => { const p = readPending(); return { pending: p.months.length + (p.meta ? 1 : 0), attempt, lastError }; };

  // ---------- віддалене завантаження ----------
  async function loadRemote() {
    const { meta: raw } = await api.get(['meta']);
    if (!raw) return null;
    const rm = JSON.parse(raw); rm.m = rm.m || {}; rm.h = rm.h || {};
    const keys = []; for (const [mk, n] of Object.entries(rm.m)) for (let i = 0; i < n; i++) keys.push(`m${mk}_${i}`);
    const vals = {}; for (let i = 0; i < keys.length; i += 50) Object.assign(vals, await api.get(keys.slice(i, i + 50)));
    const tx = [], bad = [];
    for (const [mk, n] of Object.entries(rm.m)) {
      let s = ''; for (let i = 0; i < n; i++) s += vals[`m${mk}_${i}`] || '';
      if (rm.h[mk] && hash(s) !== rm.h[mk]) { bad.push(mk); continue; }      // недописаний/пошкоджений місяць — довіряємо журналу
      try { JSON.parse(s || '[]').forEach(r => tx.push(unpack(r))); } catch (e) { bad.push(mk); }
    }
    return { meta: rm, tx, bad, settings: { cur: rm.cur, bg: rm.bg, lite: rm.lite, u: rm.su || 0 } };
  }
  function merge(...lists) {
    const m = new Map();
    for (const list of lists) for (const t of list) { const o = m.get(t.id); if (!o || (t.u || 0) > (o.u || 0)) m.set(t.id, t); }
    const now = Date.now();
    return [...m.values()].filter(t => !(t.x && now - (t.u || 0) > TOMB_TTL));
  }

  async function init() {
    let local = null, restored = null;
    try { local = parseDB(localStorage.getItem(WAL)); }
    catch (e) {
      console.warn('WAL corrupted:', e.message);
      const snaps = readSnapshots(); if (snaps.length) { local = snaps[0]; restored = 'snapshot'; }
      else restored = 'remote';
    }
    let remote = null;
    try { remote = await loadRemote(); } catch (e) { console.warn('remote load failed', e); }
    if (remote) meta = Object.assign(meta, remote.meta);
    all = merge(remote ? remote.tx : [], local ? local.tx : []);
    // налаштування: новіші перемагають
    const ls = local ? local.settings : null, rs = remote ? remote.settings : null;
    settings = Object.assign({ cur: 'UAH' }, (ls && rs) ? ((rs.u || 0) > (ls.u || 0) ? rs : ls) : (ls || rs || {}));
    // що треба дозалити в хмару: місяці, де злите ≠ віддалене
    const months = new Set(all.map(t => monthKey(t.d)));
    for (const mk of Object.keys(meta.m || {})) months.add(mk);
    const diff = [];
    for (const mk of months) {
      const rows = all.filter(t => monthKey(t.d) === mk).sort((a, b) => a.d - b.d).map(pack);
      const h = rows.length ? hash(JSON.stringify(rows)) : undefined;
      if (!remote || meta.h[mk] !== h || (remote.bad || []).includes(mk)) diff.push(mk);
    }
    if (diff.length) markPending(diff);
    writeWAL(); snapshot(true);
    setTimeout(sync, 300);
    return { tx: all.filter(t => !t.x), dead: all.filter(t => t.x), settings, restored };
  }
  function commit(months, list, s) {
    all = list; settings = s;
    writeWAL();                       // синхронно, до будь-якого await
    markPending(months, true);
    snapshot(false);
    sync();
  }
  async function wipe() {
    snapshot(true);                   // копія перед видаленням — можна відновити
    const keys = ['meta']; for (const [mk, n] of Object.entries(meta.m || {})) for (let i = 0; i < n; i++) keys.push(`m${mk}_${i}`);
    all = []; meta = { v: 2, cur: settings.cur, m: {}, h: {} }; writeWAL(); writePending({ months: [], meta: true });
    try { await api.del(keys); } catch (e) {} sync();
  }
  function restoreSnapshot(i) {
    const snaps = readSnapshots(); const s = snaps.find(x => x.i === i) || snaps[0]; if (!s) return null;
    // відновлюємо з копії, але надгробки/новіші записи з поточних даних не губимо: копія лише додає записи
    all = merge(all, s.tx.map(t => Object.assign({}, t, { u: Math.max(t.u || 0, 1) })));
    const months = [...new Set(all.map(t => monthKey(t.d)))];
    commit(months, all, settings);
    return { tx: all.filter(t => !t.x), dead: all.filter(t => t.x) };
  }
  const kvGet = async (k) => { try { return (await api.get([k]))[k] || ''; } catch (e) { return ''; } };
  const kvSet = (k, v) => api.set(k, v).catch(() => {});
  // збереження при згортанні/закритті (журнал уже записаний синхронно; тут — спроба догнати хмару)
  const flush = () => { writeWAL(); sync(); };
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else sync(); });
  addEventListener('pagehide', flush);
  addEventListener('online', () => sync());
  return { init, commit, wipe, sync, flush, status, restoreSnapshot, snapshots: readSnapshots, monthKey, kvGet, kvSet, onStatus: (f) => listeners.push(f), kind: api.kind, _hash: hash, _pack: pack };
})();

/* ---------------- Форматування ---------------- */
const sym = (cc) => CURRENCIES[cc || state.settings.cur] || cc;
/* ---------------- Курси валют: НБУ → open.er-api.com → кеш → вбудовані ---------------- */
const Rates = (() => {
  const KEY = 'ma_rates', TTL = 3 * 3600e3;
  const FALLBACK = { USD: 45.2021, EUR: 50.5766, ts: 0, date: '26.10.2026', src: 'builtin' }; // НБУ 26.10.2026, лише якщо ніколи не було мережі
  let r = null;
  try { r = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
  if (!r || !r.USD || !r.EUR) r = Object.assign({}, FALLBACK);
  const listeners = [];
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function fromNBU() {
    const res = await withTimeout(fetch('https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?json', { cache: 'no-store' }), 8000);
    const j = await res.json(); const g = (cc) => (j.find(x => x.cc === cc) || {}).rate;
    if (!g('USD') || !g('EUR')) throw new Error('NBU: no data');
    return { USD: g('USD'), EUR: g('EUR'), date: (j.find(x => x.cc === 'USD') || {}).exchangedate, src: 'nbu' };
  }
  async function fromER() {
    const res = await withTimeout(fetch('https://open.er-api.com/v6/latest/UAH', { cache: 'no-store' }), 8000);
    const j = await res.json(); if (j.result !== 'success') throw new Error('er-api: ' + j.result);
    return { USD: 1 / j.rates.USD, EUR: 1 / j.rates.EUR, date: '', src: 'er-api' };
  }
  function store(n) { r = Object.assign(n, { ts: Date.now() }); try { localStorage.setItem(KEY, JSON.stringify(r)); } catch (e) {} Store.kvSet('rates', JSON.stringify(r)); listeners.forEach(f => f(r)); }
  async function refresh(force) {
    if (!force && r.ts && Date.now() - r.ts < TTL) return r;
    for (const src of [fromNBU, fromER]) { try { store(await src()); return r; } catch (e) { console.warn('rates', e.message); } }
    return r; // офлайн — працюємо з кешем
  }
  async function hydrate() { // якщо локального кешу немає — беремо з CloudStorage
    if (r.ts) return; try { const c = JSON.parse(await Store.kvGet('rates') || 'null'); if (c && c.USD && c.EUR && c.ts > (r.ts || 0)) { r = c; localStorage.setItem(KEY, JSON.stringify(r)); } } catch (e) {}
  }
  const rate = (cc) => cc === 'UAH' || !cc ? 1 : r[cc];
  return { refresh, hydrate, rate, get: () => r, on: (f) => listeners.push(f) };
})();
const toDisp = (uahCents, cc) => uahCents / Rates.rate(cc || state.settings.cur);           // UAH-копійки → центи валюти показу
const fromCur = (cents, cc) => Math.round(cents * Rates.rate(cc));                           // центи валюти → UAH-копійки
function fmtRaw(cents, cc, sign = false) {
  const v = cents / 100, abs = Math.abs(v);
  const dec = Math.round(abs * 100) % 100 !== 0;
  const s = new Intl.NumberFormat('uk-UA', { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: 2 }).format(abs);
  const pre = sign ? (Math.round(v * 100) < 0 ? '−' : Math.round(v * 100) > 0 ? '+' : '') : (Math.round(v * 100) < 0 ? '−' : '');
  return pre + s + '\u00a0' + sym(cc);
}
// fmt: приймає UAH-копійки, показує у вибраній валюті (з округленням до цілих для великих сум в €/$ не робимо — показуємо копійки)
function fmt(uahCents, sign = false) { return fmtRaw(Math.round(toDisp(uahCents)), state.settings.cur, sign); }
const toCents = (v) => Math.round(parseFloat(String(v).replace(/\s/g, '').replace(',', '.')) * 100);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const balance = () => state.tx.reduce((s, t) => s + (t.t === 'income' ? t.a : -t.a), 0);

/* ---------------- Одометр (цифри, що прокручуються) ---------------- */
const Odo = (() => {
  const box = $('#odo'); let cur = 0, raf = 0, nd = 0, neg = false;
  function build(digits) {
    if (digits === nd) return; nd = digits; box.innerHTML = '';
    const sign = document.createElement('span'); sign.className = 'sg'; sign.textContent = '−'; box.appendChild(sign);
    for (let p = digits - 1; p >= 0; p--) {
      const d = document.createElement('span'); d.className = 'dg'; d.dataset.p = p;
      d.innerHTML = '<span class="strip">' + '0123456789'.split('').concat('0').map(x => `<span>${x}</span>`).join('') + '</span>';
      box.appendChild(d);
      if (p > 0 && p % 3 === 0) { const g = document.createElement('span'); g.className = 'gs'; g.dataset.p = p; box.appendChild(g); }
    }
  }
  function render(v) {
    const a = Math.abs(v);
    box.querySelector('.sg').style.display = v < -0.5 ? '' : 'none';
    for (const d of box.querySelectorAll('.dg')) {
      const p = +d.dataset.p, Pw = Math.pow(10, p);
      let pos;
      if (p === 0) pos = a % 10;
      else { const dig = Math.floor(a / Pw) % 10, lower = a % Pw; pos = dig + Math.max(0, lower - (Pw - 1)); }
      d.firstChild.style.transform = `translateY(${(-pos * 1.08).toFixed(4)}em)`;
      d.classList.toggle('lead', p > 0 && a < Pw);
    }
    for (const g of box.querySelectorAll('.gs')) g.classList.toggle('lead', a < Math.pow(10, +g.dataset.p));
  }
  function set(cents, animate = true) {
    const to = cents / 100;
    const centsPart = Math.round(Math.abs(cents)) % 100;
    $('#odo-cents').textContent = centsPart ? ',' + String(centsPart).padStart(2, '0') : '';
    const toI = Math.trunc(to);
    const from = cur;
    build(Math.max(String(Math.floor(Math.abs(from))).length, String(Math.abs(toI)).length, 1));
    cancelAnimationFrame(raf);
    if (!animate || from === toI) { cur = toI; render(cur); return; }
    const dur = Math.min(1800, 900 + Math.log10(Math.abs(toI - from) + 1) * 180), t0 = performance.now();
    const ease = (k) => 1 - Math.pow(1 - k, 4);
    const step = (now) => {
      const k = Math.min(1, (now - t0) / dur);
      cur = from + (toI - from) * ease(k); render(cur);
      if (k < 1) raf = requestAnimationFrame(step); else { cur = toI; render(cur); raf = 0; }
    };
    raf = requestAnimationFrame(step);
  }
  return { set, value: () => cur };
})();

function flashBg(kind) {
  const f = $('#flash'); f.className = 'flash ' + kind; void f.offsetWidth; f.classList.add('go');
  clearTimeout(flashBg.t); flashBg.t = setTimeout(() => { f.className = 'flash'; }, 950);
  H.impact(kind === 'inc' ? 'medium' : 'light');
}
function showBalance(animate = true, delta = 0) {
  const b = balance();
  Odo.set(Math.round(toDisp(b)), animate); renderSpark();
  $('#odo-cur').textContent = sym();
  if (animate && delta) {
    flashBg(delta > 0 ? 'inc' : 'exp');
    const d = $('#delta'); d.className = 'delta'; void d.offsetWidth;
    d.textContent = fmt(delta, true); d.classList.add(delta > 0 ? 'up' : 'down');
    const row = $('.odo-row'); row.classList.remove('flash-up', 'flash-down'); void row.offsetWidth;
    row.classList.add(delta > 0 ? 'flash-up' : 'flash-down'); setTimeout(() => row.classList.remove('flash-up', 'flash-down'), 900);
  }
}

/* ---------------- Спарклайн балансу (30 днів) ---------------- */
function renderSpark() {
  const svg = $('#spark'); if (!svg) return;
  const DAYS = 30, now = new Date(); const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const sorted = state.tx.slice().sort((a, b) => a.d - b.d);
  const pts = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const cut = end - i * 864e5; let b = 0;
    for (const t of sorted) { if (t.d >= cut) break; b += t.t === 'income' ? t.a : -t.a; }
    pts.push(b);
  }
  const min = Math.min(0, ...pts), max = Math.max(...pts, 1), W = 300, Hh = 64, pad = 6;
  const xy = pts.map((v, i) => [i * W / (DAYS - 1), pad + (Hh - 2 * pad) * (1 - (v - min) / (max - min || 1))]);
  const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('');
  const [lx, ly] = xy[xy.length - 1];
  svg.innerHTML = `<defs><linearGradient id="sg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#c9925a" stop-opacity=".28"/><stop offset="1" stop-color="#c9925a" stop-opacity="0"/></linearGradient></defs>
    <path d="${line}L${W} ${Hh}L0 ${Hh}Z" fill="url(#sg)"/><path d="${line}" class="spark-line"/>
    <circle cx="${lx}" cy="${ly}" r="3.5" class="spark-dot"/>`;
  $('#spark-from').textContent = new Date(end - DAYS * 864e5).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }) + ': ' + fmt(pts[0]);
  $('#spark-max').textContent = 'макс ' + fmt(Math.max(...pts));
}

/* ---------------- Періоди і статистика ---------------- */
function periodStart(p) {
  const n = new Date();
  if (p === 'today') return new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
  if (p === 'week') { const d = new Date(n.getFullYear(), n.getMonth(), n.getDate()); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return d.getTime(); }
  if (p === 'month') return new Date(n.getFullYear(), n.getMonth(), 1).getTime();
  return 0;
}
const inPeriod = (p) => { const s = periodStart(p); return state.tx.filter(t => t.d >= s); };
function byCategory(list) {
  const m = {}; let total = 0;
  for (const t of list) if (t.t === 'expense') { const c = t.c || 'other'; m[c] = (m[c] || 0) + t.a; total += t.a; }
  const rows = Object.entries(m).map(([c, a]) => ({ c, a, pct: total ? a / total * 100 : 0 })).sort((a, b) => b.a - a.a);
  return { rows, total };
}
const pctStr = (p) => (p < 1 && p > 0 ? '<1' : Math.round(p)) + '%';

/* ---------------- Рендер ---------------- */
function txAmt(t) { const sg = t.t === 'income' ? 1 : -1; return (t.oc || 'UAH') === state.settings.cur ? fmtRaw(sg * t.oa, t.oc, true) : fmt(sg * t.a, true); }
function txRow(t) {
  const inc = t.t === 'income', c = inc ? (SRC[t.c] || SRC.iother) : (CAT[t.c] || null);
  const title = t.n || (inc ? c.name : c ? c.name : 'Витрата');
  const time = new Date(t.d).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
  const sub = (c ? c.name : 'Інше') + ' · ' + time;
  return `<div class="tx" data-id="${t.id}"><button class="tx-del" data-del="${t.id}">Видалити</button>
    <div class="tx-in"><div class="tx-ico">${c ? c.icon : '📦'}</div>
    <div class="tx-main"><div class="tx-t">${esc(title)}</div><div class="tx-s">${sub}</div></div>
    <div class="tx-a ${inc ? 'inc' : ''}">${txAmt(t)}${t.oc && t.oc !== state.settings.cur ? `<small class="tx-orig">${fmtRaw(t.oa, t.oc)}</small>` : ''}</div></div></div>`;
}
function dayLabel(ts) {
  const d = new Date(ts), today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (diff === 0) return 'Сьогодні'; if (diff === 1) return 'Вчора';
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', weekday: 'short' });
}

function renderMain() {
  const today = byCategory(inPeriod('today')).total, month = byCategory(inPeriod('month'));
  $('#st-today').textContent = fmt(-today); $('#st-month').textContent = fmt(-month.total);
  const mInc = inPeriod('month').filter(t => t.t === 'income').reduce((s, t) => s + t.a, 0);
  const net = mInc - month.total; const sn = $('#st-net'); sn.textContent = fmt(net, true); sn.className = net >= 0 ? 'pos' : 'neg';
  $('#ie-inc').textContent = fmt(mInc, true); $('#ie-exp').textContent = fmt(-month.total);
  const sum = mInc + month.total;
  $('#ie-bar-inc').style.width = (sum ? mInc / sum * 100 : 50) + '%'; $('#ie-bar-exp').style.width = (sum ? month.total / sum * 100 : 50) + '%';
  $('#hero-month').textContent = new Date().toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' });
  const bar = $('#stack-bar'), leg = $('#stack-legend');
  if (!month.total) { bar.innerHTML = ''; leg.innerHTML = '<div class="empty" style="width:100%">Витрат цього місяця ще немає</div>'; }
  else {
    bar.innerHTML = month.rows.map(r => `<i style="width:${r.pct}%;background:${CAT[r.c].color}"></i>`).join('');
    leg.innerHTML = month.rows.slice(0, 5).map(r => `<span><i class="dot" style="background:${CAT[r.c].color}"></i>${CAT[r.c].icon} ${CAT[r.c].name} <b>${pctStr(r.pct)}</b></span>`).join('');
  }
  const recent = state.tx.slice().sort((a, b) => b.d - a.d).slice(0, 5);
  $('#recent').innerHTML = recent.length ? recent.map(txRow).join('') : '<div class="empty">Тут з’являться твої операції.<br>Натисни «+ Додати» або мікрофон.</div>';
}

/* ---- графіки та статистика ---- */
function drawDonut(svgEl, rows, map, sel) {
  const C = 2 * Math.PI * 62; let off = 0;
  let svg = `<circle cx="80" cy="80" r="62" fill="none" stroke="#1f2326" stroke-width="18"/>`;
  const gap = rows.length > 1 ? 2.5 : 0;
  for (const r of rows) {
    const len = C * r.pct / 100;
    svg += `<circle cx="80" cy="80" r="62" fill="none" stroke="${map[r.c].color}" stroke-width="18" stroke-dasharray="${Math.max(0, len - gap)} ${C}" stroke-dashoffset="${-off}" ${sel && sel !== r.c ? 'opacity=".3"' : ''}/>`;
    off += len;
  }
  svgEl.innerHTML = svg;
}
function groupRows(list, type, def) {
  const m = {}, cnt = {}; let total = 0;
  for (const t of list) if (t.t === type) { const c = t.c || def; m[c] = (m[c] || 0) + t.a; cnt[c] = (cnt[c] || 0) + 1; total += t.a; }
  return { rows: Object.entries(m).map(([c, a]) => ({ c, a, n: cnt[c], pct: total ? a / total * 100 : 0 })).sort((x, y) => y.a - x.a), total };
}
function rowsHTML(rows, map, sel, attr, sign) {
  return rows.map(r => { const c = map[r.c];
    return `<button class="cat-row ${sel === r.c ? 'sel' : ''}" ${attr}="${r.c}" style="width:100%;text-align:left">
      <div class="tx-ico">${c.icon}</div>
      <div class="cat-mid"><div class="cat-name">${c.name} <small>${r.n} оп.</small></div><div class="bar"><i style="width:${r.pct}%;background:${c.color}"></i></div></div>
      <div class="cat-sum ${sign > 0 ? 'pos' : ''}">${fmt(sign * r.a, sign > 0)}<small>${pctStr(r.pct)}</small></div></button>`; }).join('');
}
function opsHTML(ops, type) {
  let html = '', lastDay = ''; const dayTotals = {};
  for (const t of ops) { const k = new Date(t.d).toDateString(); dayTotals[k] = (dayTotals[k] || 0) + (t.t === 'income' ? t.a : -t.a); }
  for (const t of ops) {
    const k = new Date(t.d).toDateString();
    if (k !== lastDay) { html += `<div class="day"><span>${dayLabel(t.d)}</span><span>${dayTotals[k] ? fmt(dayTotals[k], type === 'income') : ''}</span></div>`; lastDay = k; }
    html += txRow(t);
  }
  return html || '<div class="empty">Немає операцій</div>';
}
const dayStart = (ts) => { const d = new Date(ts); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
function bucketsFor(p) {
  const n = new Date(), y = n.getFullYear(), m = n.getMonth(), d = n.getDate(), out = [];
  if (p === 'today') { for (let h = 0; h < 24; h += 3) out.push({ s: new Date(y, m, d, h).getTime(), e: new Date(y, m, d, h + 3).getTime(), l: h % 6 === 0 ? String(h).padStart(2, '0') + ':00' : '' }); return { b: out, unit: 'по 3 години' }; }
  if (p === 'week') { const s = new Date(periodStart('week')); const nm = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд']; for (let i = 0; i < 7; i++) out.push({ s: new Date(s.getFullYear(), s.getMonth(), s.getDate() + i).getTime(), e: new Date(s.getFullYear(), s.getMonth(), s.getDate() + i + 1).getTime(), l: nm[i] }); return { b: out, unit: 'по днях' }; }
  if (p === 'month') { const last = new Date(y, m + 1, 0).getDate(); for (let i = 1; i <= last; i++) out.push({ s: new Date(y, m, i).getTime(), e: new Date(y, m, i + 1).getTime(), l: (i === 1 || i % 5 === 0) ? String(i) : '' }); return { b: out, unit: 'по днях' }; }
  const first = state.tx.length ? Math.min(...state.tx.map(t => t.d)) : Date.now();
  const spanDays = (Date.now() - first) / 864e5;
  if (spanDays <= 120) { // тижні
    const f = new Date(first); const s = new Date(f.getFullYear(), f.getMonth(), f.getDate() - ((f.getDay() + 6) % 7));
    for (let i = 0; ; i++) { const st = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7 * i); if (st.getTime() > Date.now()) break; out.push({ s: st.getTime(), e: new Date(st.getFullYear(), st.getMonth(), st.getDate() + 7).getTime(), l: st.toLocaleDateString('uk-UA', { day: 'numeric', month: 'numeric' }) }); }
    return { b: out, unit: 'по тижнях' };
  }
  const f = new Date(first);
  for (let i = 0; ; i++) { const st = new Date(f.getFullYear(), f.getMonth() + i, 1); if (st.getTime() > Date.now()) break; out.push({ s: st.getTime(), e: new Date(st.getFullYear(), st.getMonth() + 1, 1).getTime(), l: st.toLocaleDateString('uk-UA', { month: 'short' }) }); }
  return { b: out, unit: 'по місяцях' };
}
function sumBuckets(b, list, type) {
  const v = new Array(b.length).fill(0);
  for (const t of list) if (t.t === type) { for (let i = 0; i < b.length; i++) if (t.d >= b[i].s && t.d < b[i].e) { v[i] += t.a; break; } }
  return v;
}
const shortNum = (uahCents) => { const v = Math.abs(toDisp(uahCents) / 100); return v >= 1e6 ? (v / 1e6).toFixed(1).replace('.0', '') + 'M' : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1).replace('.0', '') + 'k' : Math.round(v) + ''; };
function barsSVG(el, b, series) {
  const W = 320, H = +el.getAttribute('viewBox').split(' ')[3], top = 12, bottom = 18, left = 2, right = 26, ch = H - top - bottom, cw = W - left - right;
  const max = Math.max(1, ...series.flatMap(s => s.v)); const slot = cw / b.length, k = series.length;
  const bw = Math.max(1.5, Math.min(14, slot * (k > 1 ? 0.36 : 0.62)));
  let g = '';
  for (const f of [0.5, 1]) { const y = top + ch * (1 - f); g += `<line class="gl" x1="${left}" x2="${W - right + 4}" y1="${y}" y2="${y}"/><text class="gv" x="${W - right + 6}" y="${y + 3}">${shortNum(max * f)}</text>`; }
  g += `<line class="gl" x1="${left}" x2="${W - right + 4}" y1="${top + ch}" y2="${top + ch}"/>`;
  b.forEach((bk, i) => {
    const cx = left + slot * (i + .5);
    series.forEach((s, j) => { const v = s.v[i]; if (!v) return; const h = Math.max(1.5, ch * v / max); const x = cx - (k * bw + (k - 1) * 1.5) / 2 + j * (bw + 1.5);
      g += `<rect x="${x.toFixed(1)}" y="${(top + ch - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(2.5, bw / 2)}" fill="${s.color}" opacity=".85"/>`; });
    if (bk.l) g += `<text class="ax" x="${cx.toFixed(1)}" y="${H - 5}">${bk.l}</text>`;
  });
  el.innerHTML = g;
}
function elapsedDays(p) {
  const now = Date.now();
  if (p === 'all') { const f = state.tx.length ? Math.min(...state.tx.map(t => t.d)) : now; return Math.max(1, Math.ceil((now - dayStart(f)) / 864e5)); }
  return Math.max(1, Math.ceil((now - periodStart(p)) / 864e5));
}
function prevRange(p) {
  const now = Date.now(), s = periodStart(p), el = now - s;
  if (p === 'today') { const ps = new Date(s); ps.setDate(ps.getDate() - 1); return { s: ps.getTime(), e: ps.getTime() + el, label: 'вчора (до цієї ж години)' }; }
  if (p === 'week') { const ps = new Date(s); ps.setDate(ps.getDate() - 7); return { s: ps.getTime(), e: ps.getTime() + el, label: 'минулим тижнем (той самий відрізок)' }; }
  if (p === 'month') { const d = new Date(s); const ps = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime(); return { s: ps, e: Math.min(s, ps + el), label: 'минулим місяцем (ті самі дні)' }; }
  return null;
}
function pctChange(cur, prev) { if (!prev) return cur ? null : 0; return (cur - prev) / Math.abs(prev) * 100; }
function chip(ch, goodWhenUp) {
  if (ch === null) return '<span class="p">нове</span>';
  const up = ch > 0.5, down = ch < -0.5; const cls = !up && !down ? '' : (up === goodWhenUp ? 'good' : 'bad');
  return `<span class="p ${cls}">${up ? '↑' : down ? '↓' : '='} ${Math.abs(Math.round(ch))}%</span>`;
}

function renderHistory() {
  const list = inPeriod(state.period);
  const exp = groupRows(list, 'expense', 'other'), inc = groupRows(list, 'income', 'iother');
  $('#sum-exp').textContent = fmt(-exp.total); $('#sum-inc').textContent = fmt(inc.total, true);
  const net = inc.total - exp.total; const ne = $('#sum-net'); ne.textContent = fmt(net, true); ne.className = net >= 0 ? 'pos' : 'neg';
  $$('#mode-seg button').forEach(b => b.classList.toggle('on', b.dataset.m === state.mode));
  for (const m of ['exp', 'inc', 'cmp']) $('#view-' + m).classList.toggle('hidden', state.mode !== m);
  const sorted = list.slice().sort((a, b) => b.d - a.d);

  if (state.mode === 'exp') {
    $('#donut-total').textContent = fmt(exp.total);
    drawDonut($('#donut'), exp.rows, CAT, state.catFilter);
    $('#cat-list').innerHTML = exp.rows.length ? rowsHTML(exp.rows, CAT, state.catFilter, 'data-cat', -1) : '<div class="empty">За цей період витрат немає</div>';
    let ops = sorted;
    if (state.catFilter) ops = ops.filter(t => t.t === 'expense' && (t.c || 'other') === state.catFilter);
    $('#ops-title').textContent = state.catFilter ? `Операції · ${CAT[state.catFilter].icon} ${CAT[state.catFilter].name}` : 'Операції';
    $('#clear-filter').classList.toggle('hidden', !state.catFilter);
    $('#ops').innerHTML = opsHTML(ops, 'all');
  }
  if (state.mode === 'inc') {
    $('#donut-inc-total').textContent = fmt(inc.total, true);
    drawDonut($('#donut-inc'), inc.rows, SRC, state.srcFilter);
    $('#src-list').innerHTML = inc.rows.length ? rowsHTML(inc.rows, SRC, state.srcFilter, 'data-src', 1) : '<div class="empty">За цей період надходжень немає</div>';
    const { b, unit } = bucketsFor(state.period);
    $('#inc-bars-title').textContent = 'Надходження ' + unit;
    const incList = state.srcFilter ? list.filter(t => t.t === 'income' && (t.c || 'iother') === state.srcFilter) : list;
    barsSVG($('#inc-bars'), b, [{ v: sumBuckets(b, incList, 'income'), color: '#86a68f' }]);
    const incs = incList.filter(t => t.t === 'income'); const tot = incs.reduce((s, t) => s + t.a, 0);
    $('#inc-avg').textContent = fmt(Math.round(tot / elapsedDays(state.period)));
    const big = incs.reduce((m, t) => (!m || t.a > m.a ? t : m), null);
    $('#inc-max').textContent = big ? fmt(big.a, true) : '—';
    $('#inc-max-note').textContent = big ? (big.n || SRC[big.c || 'iother'].name) + ' · ' + new Date(big.d).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }) : '';
    $('#inc-count').textContent = incs.length;
    $('#inc-ops-title').textContent = state.srcFilter ? `Надходження · ${SRC[state.srcFilter].icon} ${SRC[state.srcFilter].name}` : 'Надходження';
    $('#clear-src').classList.toggle('hidden', !state.srcFilter);
    $('#inc-ops').innerHTML = opsHTML(sorted.filter(t => t.t === 'income' && (!state.srcFilter || (t.c || 'iother') === state.srcFilter)), 'income');
  }
  if (state.mode === 'cmp') {
    const { b, unit } = bucketsFor(state.period);
    $('#cmp-title').textContent = 'Надходження vs витрати ' + unit;
    barsSVG($('#cmp-bars'), b, [{ v: sumBuckets(b, list, 'income'), color: '#86a68f' }, { v: sumBuckets(b, list, 'expense'), color: '#b57a72' }]);
    const cn = $('#cmp-net'); cn.textContent = fmt(net, true); cn.className = net >= 0 ? 'pos' : 'neg';
    const rate = inc.total ? net / inc.total * 100 : null;
    $('#cmp-rate').textContent = rate === null ? '—' : Math.round(rate) + '%'; $('#cmp-rate').className = rate === null ? '' : rate >= 0 ? 'pos' : 'neg';
    $('#cmp-rate-bar').style.width = Math.max(0, Math.min(100, rate || 0)) + '%';
    $('#cmp-rate-note').textContent = rate === null ? 'Надходжень за період немає' : rate >= 20 ? 'Чудово: відкладаєш ≥20% надходжень' : rate >= 0 ? 'Залишається ' + Math.round(rate) + '% від надходжень' : 'Витрати перевищують надходження';
    const pr = prevRange(state.period);
    if (!pr) { $('#cmp-prev-title').textContent = 'Порівняння з попереднім періодом'; $('#cmp-prev').innerHTML = '<div class="empty">Для «Все» порівняння недоступне — обери тиждень або місяць</div>'; }
    else {
      const pl = state.tx.filter(t => t.d >= pr.s && t.d < pr.e);
      const pInc = pl.filter(t => t.t === 'income').reduce((s, t) => s + t.a, 0), pExp = pl.filter(t => t.t === 'expense').reduce((s, t) => s + t.a, 0), pNet = pInc - pExp;
      $('#cmp-prev-title').textContent = 'Порівняно з ' + pr.label;
      $('#cmp-prev').innerHTML = [
        ['Надходження', inc.total, pInc, true, 1], ['Витрати', exp.total, pExp, false, -1], ['Результат', net, pNet, true, 0],
      ].map(([n, c, p, good, sg]) => `<div class="cmp-row"><div>${n}<small>було ${sg === 0 ? fmt(p, true) : fmt(sg * p, sg > 0)}</small></div><div class="v">${sg === 0 ? fmt(c, true) : fmt(sg * c, sg > 0)}</div>${chip(pctChange(c, p), good)}</div>`).join('');
    }
  }
}

function renderSettings() {
  const s = $('#set-cur');
  s.innerHTML = CUR_ORDER.map(k => `<option value="${k}" ${k === state.settings.cur ? 'selected' : ''}>${CUR_NAMES[k]}</option>`).join('');
  $('#set-storage').textContent = Store.kind;
  $('#set-count').textContent = state.tx.length + ' · місяців: ' + new Set(state.tx.map(t => Store.monthKey(t.d))).size;
  updateHomeStatus(); renderBackupInfo();
}
function renderAll() { renderMain(); if (screen === 'history') renderHistory(); if (screen === 'settings') renderSettings(); }

/* ---------------- Навігація + BackButton ---------------- */
let screen = 'main'; const layers = [];
function go(name) {
  if (name === screen) return;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'scr-' + name));
  screen = name; window.scrollTo(0, 0);
  if (name === 'history') renderHistory(); if (name === 'settings') renderSettings();
  H.impact('light'); syncBack();
}
function back() {
  if (layers.length) return closeSheet();
  if (screen !== 'main') { go('main'); }
}
function syncBack() {
  if (!tg || !ver('6.1')) return;
  if (layers.length || screen !== 'main') tg.BackButton.show(); else tg.BackButton.hide();
}
if (tg && ver('6.1')) tg.BackButton.onClick(back);
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]'); if (g) { go(g.dataset.go); return; }
  if (e.target.closest('[data-back]')) back();
});

/* ---------------- Шторки ---------------- */
function openSheet(id) {
  const s = $('#' + id); layers.push(s); s.classList.add('on'); $('#scrim').classList.add('on'); syncBack(); BG.pause('sheet', true);
}
function closeSheet() {
  const s = layers.pop(); if (!s) return;
  s.classList.remove('on'); if (!layers.length) { $('#scrim').classList.remove('on'); BG.pause('sheet', false); }
  if (s.id === 'sheet-voice') Voice.stop();
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  syncBack();
}
$('#scrim').addEventListener('click', closeSheet);
// свайп вниз по ручці
$$('.sheet').forEach(sh => {
  let y0 = null;
  sh.addEventListener('touchstart', e => { if (sh.scrollTop <= 0 && e.target.closest('.grab, .sheet-title, .voice-top')) y0 = e.touches[0].clientY; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 == null) return; const dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transition = 'none'; sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sh.addEventListener('touchend', e => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; sh.style.transition = ''; sh.style.transform = ''; y0 = null; if (dy > 90) closeSheet(); });
});

/* ---------------- Шторка операції ---------------- */
const TX = { mode: 'add', type: 'expense', cat: null, src: null, id: null, cur: 'UAH', orig: null };
const lastInCur = () => { const c = localStorage.getItem('ma_incur'); return CURRENCIES[c] ? c : 'UAH'; };
function convHint(el, cents, cc) {
  if (!cents || cc === 'UAH') { el.textContent = cc === 'UAH' && cents ? '≈ ' + fmtRaw(Math.round(toDisp(cents, 'EUR')), 'EUR') + ' · ' + fmtRaw(Math.round(toDisp(cents, 'USD')), 'USD') : ''; return; }
  el.textContent = '≈ ' + fmtRaw(fromCur(cents, cc), 'UAH') + ' · 1' + sym(cc) + ' = ' + Rates.rate(cc).toFixed(2).replace('.', ',') + ' ₴';
}
function bindCurSeg(seg, get, set) {
  const paint = () => $$('button', seg).forEach(b => b.classList.toggle('on', b.dataset.cc === get()));
  seg.addEventListener('click', e => { const b = e.target.closest('[data-cc]'); if (!b) return; set(b.dataset.cc); H.select(); paint(); });
  return paint;
}
const paintTxCur = bindCurSeg($('#tx-curseg'), () => TX.cur, (cc) => { TX.cur = cc; $('#tx-cur').textContent = sym(cc); updTxConv(); });
function updTxConv() { convHint($('#tx-conv'), toCents($('#tx-amount').value) || 0, TX.cur); }
$('#tx-amount').addEventListener('input', updTxConv);
function catGrid(container, selected, onPick, chips = false, list = CATS) {
  container.innerHTML = list.map(c => chips
    ? `<button class="chip ${c.id === selected ? 'on' : ''}" data-c="${c.id}">${c.icon} ${c.name}</button>`
    : `<button class="cat-btn ${c.id === selected ? 'on' : ''}" data-c="${c.id}"><span class="e">${c.icon}</span>${c.name}</button>`).join('');
  container.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; $$('[data-c]', container).forEach(x => x.classList.toggle('on', x === b)); H.select(); onPick(b.dataset.c); };
}
const toLocalInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
function setTxType(type) {
  TX.type = type; const inc = type === 'income';
  $('#tx-sign').textContent = inc ? '+' : '−'; $('#tx-sign').classList.toggle('inc', inc);
  $('#tx-cats').classList.toggle('hidden', inc); $('#tx-srcs').classList.toggle('hidden', !inc); $('#tx-quick').classList.toggle('hidden', !inc || TX.mode === 'edit');
  $('#tx-note').placeholder = inc ? 'Звідки? (зарплата, подарунок…) — необов’язково' : 'Примітка (необов’язково)';
  $$('#tx-type button').forEach(b => b.classList.toggle('on', b.dataset.t === type));
  if (TX.mode === 'add') $('#tx-title').textContent = inc ? 'Поповнення балансу' : 'Нова витрата';
}
function openTx(mode, type, t) {
  TX.mode = mode; TX.id = t ? t.id : null; TX.cat = t && t.t === 'expense' ? t.c : null; TX.src = t && t.t === 'income' ? (t.c || 'iother') : null;
  $('#tx-type').classList.toggle('hidden', mode !== 'edit');
  $('#tx-delete').classList.toggle('hidden', mode !== 'edit');
  $('#tx-title').textContent = 'Редагування';
  setTxType(type);
  TX.cur = t ? (t.oc || 'UAH') : lastInCur(); TX.orig = t ? { oa: t.oa, oc: t.oc || 'UAH', a: t.a } : null;
  $('#tx-amount').value = t ? String((t.oa != null ? t.oa : t.a) / 100).replace('.', ',') : '';
  $('#tx-note').value = t ? t.n : ''; fitAmount($('#tx-amount'));
  $('#tx-date').value = toLocalInput(t ? t.d : Date.now());
  $('#tx-cur').textContent = sym(TX.cur); paintTxCur(); updTxConv();
  catGrid($('#tx-cats'), TX.cat, (c) => { TX.cat = c; });
  catGrid($('#tx-srcs'), TX.src, (c) => { TX.src = c; }, false, SRCS);
  openSheet('sheet-tx');
  if (mode === 'add') setTimeout(() => $('#tx-amount').focus(), 320);
}
$('#tx-type').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (b) { setTxType(b.dataset.t); H.select(); } });
$('#tx-quick').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (!b) return; const cur = parseFloat(($('#tx-amount').value || '0').replace(',', '.')) || 0; $('#tx-amount').value = String(cur + +b.dataset.q); fitAmount($('#tx-amount')); updTxConv(); H.select(); });
function fitAmount(inp) { inp.style.width = Math.max(2, (inp.value || inp.placeholder || '0').length + 0.6) + 'ch'; }
$$('.amount-field input').forEach(inp => inp.addEventListener('input', e => { e.target.value = e.target.value.replace(/[^\d.,]/g, ''); fitAmount(e.target); }));
$('#tx-save').addEventListener('click', () => {
  const a = toCents($('#tx-amount').value);
  if (!a || a <= 0) { H.notify('error'); shake($('#tx-amount')); return toast('Введи суму'); }
  if (TX.type === 'expense' && !TX.cat) { H.notify('error'); shake($('#tx-cats')); return toast('Обери категорію'); }
  const d = new Date($('#tx-date').value).getTime() || Date.now();
  // зберігаємо оригінал + гривневий еквівалент; при редагуванні без зміни суми/валюти — історичний курс не чіпаємо
  const keep = TX.orig && TX.orig.oa === a && TX.orig.oc === TX.cur;
  const rec = { id: TX.id || uid(), t: TX.type, a: keep ? TX.orig.a : fromCur(a, TX.cur), oc: TX.cur, oa: a, c: TX.type === 'expense' ? TX.cat : (TX.src || 'iother'), n: $('#tx-note').value.trim(), d };
  if (TX.mode === 'add') localStorage.setItem('ma_incur', TX.cur);
  closeSheet();
  if (TX.mode === 'edit') updateTx(rec); else addTx(rec);
});
$('#tx-delete').addEventListener('click', () => { const id = TX.id; closeSheet(); deleteTx(id); });
function shake(el) { el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 260 }); }

/* ---------------- CRUD ---------------- */
function persist(months) { return Store.commit(months, state.tx.concat(state.dead), state.settings); }
function addTx(rec) {
  rec.u = Date.now(); state.dead = state.dead.filter(t => t.id !== rec.id);
  state.tx.push(rec);
  H.notify('success');
  persist([Store.monthKey(rec.d)]);
  renderAll();
  if (screen !== 'main') go('main');
  setTimeout(() => showBalance(true, rec.t === 'income' ? rec.a : -rec.a), 120);
}
function updateTx(rec) {
  const i = state.tx.findIndex(t => t.id === rec.id); if (i < 0) return;
  const old = state.tx[i]; rec.u = Date.now(); state.tx[i] = rec;
  const delta = (rec.t === 'income' ? rec.a : -rec.a) - (old.t === 'income' ? old.a : -old.a);
  H.notify('success'); persist([Store.monthKey(old.d), Store.monthKey(rec.d)]); renderAll(); showBalance(true, delta); toast('Збережено');
}
function deleteTx(id) {
  const i = state.tx.findIndex(t => t.id === id); if (i < 0) return;
  const [old] = state.tx.splice(i, 1);
  state.dead.push(Object.assign({}, old, { x: 1, u: Date.now() }));          // «надгробок», щоб видалене не воскресло при злитті
  H.notify('warning'); persist([Store.monthKey(old.d)]); renderAll(); showBalance(true, old.t === 'income' ? -old.a : old.a);
  toast('Видалено', 'Повернути', () => { state.dead = state.dead.filter(t => t.id !== old.id); state.tx.push(Object.assign({}, old, { u: Date.now() })); persist([Store.monthKey(old.d)]); renderAll(); showBalance(true, old.t === 'income' ? old.a : -old.a); });
}

/* список: тап = редагувати, свайп вліво = видалити */
function bindList(container) {
  let sx = null, sy = null, row = null, dx = 0, swiping = false;
  container.addEventListener('touchstart', e => { const t = e.target.closest('.tx'); if (!t || e.target.closest('.tx-del')) return; row = t; sx = e.touches[0].clientX; sy = e.touches[0].clientY; dx = 0; swiping = false; $$('.tx-in', container).forEach(x => { if (x.parentNode !== t) { x.style.transform = ''; x.parentNode.classList.remove('swiped'); } }); }, { passive: true });
  container.addEventListener('touchmove', e => { if (!row) return; const mx = e.touches[0].clientX - sx, my = e.touches[0].clientY - sy; if (!swiping && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) swiping = true; if (swiping) { row.classList.add('swiped'); dx = Math.min(0, Math.max(-100, mx)); const inn = row.querySelector('.tx-in'); inn.style.transition = 'none'; inn.style.transform = `translateX(${dx}px)`; } }, { passive: true });
  container.addEventListener('touchend', () => { if (!row) return; const inn = row.querySelector('.tx-in'); inn.style.transition = ''; if (swiping) { inn.style.transform = dx < -50 ? 'translateX(-84px)' : ''; if (dx >= -50) { const rr = row; setTimeout(() => rr.classList.remove('swiped'), 220); } if (dx < -50) H.impact('light'); row.dataset.sw = '1'; setTimeout(() => delete row.dataset.sw, 50); } row = null; });
  container.addEventListener('click', e => {
    const del = e.target.closest('[data-del]'); if (del) { deleteTx(del.dataset.del); return; }
    const t = e.target.closest('.tx'); if (!t || t.dataset.sw) return;
    const inn = t.querySelector('.tx-in'); if (inn.style.transform && inn.style.transform !== 'none' && inn.style.transform !== '') { inn.style.transform = ''; setTimeout(() => t.classList.remove('swiped'), 220); return; }
    const rec = state.tx.find(x => x.id === t.dataset.id); if (rec) { H.impact('light'); openTx('edit', rec.t, rec); }
  });
}
bindList($('#recent')); bindList($('#ops')); bindList($('#inc-ops'));
$('#cat-list').addEventListener('click', e => { const b = e.target.closest('[data-cat]'); if (!b) return; state.catFilter = state.catFilter === b.dataset.cat ? null : b.dataset.cat; H.select(); renderHistory(); });
$('#clear-filter').addEventListener('click', () => { state.catFilter = null; renderHistory(); });
$('#mode-seg').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b || b.dataset.m === state.mode) return; state.mode = b.dataset.m; H.select(); renderHistory(); });
$('#src-list').addEventListener('click', e => { const b = e.target.closest('[data-src]'); if (!b) return; state.srcFilter = state.srcFilter === b.dataset.src ? null : b.dataset.src; H.select(); renderHistory(); });
$('#clear-src').addEventListener('click', () => { state.srcFilter = null; renderHistory(); });
$('#period-seg').addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (!b) return; state.period = b.dataset.p; $$('#period-seg button').forEach(x => x.classList.toggle('on', x === b)); H.select(); renderHistory(); });

$('#btn-income').addEventListener('click', () => { H.impact('medium'); openTx('add', 'income'); });
$('#btn-expense').addEventListener('click', () => { H.impact('medium'); openTx('add', 'expense'); });

/* ---------------- Голос ---------------- */
const Voice = (() => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const LANGS = ['uk-UA', 'ru-RU'];
  let rec = null, li = 0, listening = false, parsed = null, gotResult = false;
  const sheet = $('#sheet-voice'), status = $('#voice-status'), tr = $('#voice-transcript');
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (tg && tg.platform === 'ios');
  function caveat() {
    $('#voice-caveat').textContent = SR
      ? 'Голос розпізнає браузер/Android (uk-UA, запасна мова ru-RU). Якщо не спрацює — напиши фразу або продиктуй через мікрофон клавіатури.'
      : (isIOS ? 'На iPhone у Telegram голосове розпізнавання недоступне — натисни 🎤 на клавіатурі (диктування) і скажи фразу в поле. Голос через кнопку працює на Android.'
               : 'Розпізнавання голосу тут недоступне — напиши фразу (або продиктуй через клавіатуру). Голос через кнопку працює на Android.');
  }
  function setListening(on) { listening = on; sheet.classList.toggle('listening', on); }
  function start() {
    if (!SR) { status.textContent = 'Напиши фразу — я розберу її'; setTimeout(() => $('#voice-text').focus(), 350); return; }
    stop(); gotResult = false;
    try {
      rec = new SR(); rec.lang = LANGS[li]; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
      rec.onstart = () => { setListening(true); status.textContent = 'Слухаю… (' + (rec.lang === 'uk-UA' ? 'українська' : 'русский') + ')'; H.impact('light'); };
      rec.onresult = (e) => {
        let fin = '', interim = '', alts = [];
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) { fin += r[0].transcript; for (let j = 0; j < r.length; j++) alts.push(r[j].transcript); } else interim += r[0].transcript;
        }
        tr.innerHTML = esc(fin) + (interim ? ` <span class="interim">${esc(interim)}</span>` : '');
        if (fin) {
          gotResult = true;
          const best = alts.map(a => P.parse(a)).find(p => p.ok) || P.parse(fin);
          handle(best);
        }
      };
      rec.onerror = (e) => {
        setListening(false);
        if (e.error === 'language-not-supported' && li === 0) { li = 1; return start(); }
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') status.textContent = 'Немає доступу до мікрофона — напиши фразу нижче';
        else if (e.error === 'no-speech') status.textContent = 'Нічого не почув. Натисни ще раз';
        else if (e.error !== 'aborted') status.textContent = 'Помилка розпізнавання: ' + e.error;
      };
      rec.onend = () => { setListening(false); if (!gotResult && status.textContent.startsWith('Слухаю')) status.textContent = 'Натисни і говори'; };
      rec.start();
    } catch (err) { setListening(false); status.textContent = 'Голос недоступний — напиши фразу'; }
  }
  function stop() { if (rec) { try { rec.abort(); } catch (e) {} rec = null; } setListening(false); }
  function open() {
    parsed = null; tr.textContent = ''; $('#confirm').classList.add('hidden'); $('#voice-examples').classList.remove('hidden');
    $('#voice-text').value = ''; status.textContent = SR ? 'Натисни і говори' : 'Напиши фразу — я розберу її';
    caveat(); openSheet('sheet-voice'); start();
  }
  function handle(p) {
    stop(); parsed = p;
    if (!p.ok) { H.notify('error'); status.textContent = 'Не знайшов суму. Спробуй: «кава 80»'; return; }
    H.notify('success'); status.textContent = 'Перевір і збережи';
    showConfirm();
  }
  function showConfirm() {
    const p = parsed, inc = p.type === 'income';
    $('#voice-examples').classList.add('hidden');
    $('#confirm').classList.remove('hidden');
    $('#cf-badge').textContent = inc ? 'Дохід' : 'Витрата'; $('#cf-badge').classList.toggle('inc', inc);
    $('#cf-raw').textContent = '«' + p.raw + '»';
    $('#cf-sign').textContent = inc ? '+' : '−'; $('#cf-sign').classList.toggle('inc', inc);
    if (!p.cc) p.cc = p.currency || lastInCur();
    $('#cf-amount').value = String(p.amount).replace('.', ','); fitAmount($('#cf-amount')); $('#cf-cur').textContent = sym(p.cc); paintCfCur(); updCfConv();
    $('#cf-note').value = p.note || '';
    $('#cf-cats').classList.toggle('hidden', inc); $('#cf-srcs').classList.toggle('hidden', !inc);
    if (inc && !p.source) p.source = 'iother';
    catGrid($('#cf-srcs'), p.source, (c) => { parsed.source = c; }, true, SRCS);
    catGrid($('#cf-cats'), p.category || 'other', (c) => { parsed.category = c; }, true);
    const on = $('#cf-cats .chip.on'); on && on.scrollIntoView({ inline: 'center', block: 'nearest' });
  }
  const paintCfCur = bindCurSeg($('#cf-curseg'), () => parsed && parsed.cc, (cc) => { parsed.cc = cc; $('#cf-cur').textContent = sym(cc); updCfConv(); });
  function updCfConv() { convHint($('#cf-conv'), toCents($('#cf-amount').value) || 0, parsed ? parsed.cc : 'UAH'); }
  $('#cf-amount').addEventListener('input', updCfConv);
  $('#voice-mic').addEventListener('click', () => { if (listening) stop(); else { $('#confirm').classList.add('hidden'); $('#voice-examples').classList.remove('hidden'); tr.textContent = ''; li = 0; start(); } });
  $('#voice-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#voice-text').value.trim(); if (!v) return; tr.textContent = v; $('#voice-text').blur(); handle(P.parse(v)); });
  $('#voice-examples').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; $('#voice-text').value = b.textContent; tr.textContent = b.textContent; handle(P.parse(b.textContent)); });
  $('#cf-swap').addEventListener('click', () => { parsed.type = parsed.type === 'income' ? 'expense' : 'income'; if (parsed.type === 'expense' && !parsed.category) parsed.category = 'other'; H.select(); showConfirm(); });
  $('#cf-cancel').addEventListener('click', () => { parsed = null; $('#confirm').classList.add('hidden'); $('#voice-examples').classList.remove('hidden'); tr.textContent = ''; status.textContent = 'Натисни і говори'; });
  $('#cf-save').addEventListener('click', () => {
    const a = toCents($('#cf-amount').value); if (!a || a <= 0) { shake($('#cf-amount')); return; }
    const cc = parsed.cc || 'UAH';
    const rec = { id: uid(), t: parsed.type, a: fromCur(a, cc), oc: cc, oa: a, c: parsed.type === 'expense' ? (parsed.category || 'other') : (parsed.source || 'iother'), n: $('#cf-note').value.trim(), d: Date.now() };
    closeSheet(); addTx(rec);
  });
  return { open, stop, supported: !!SR, handleText: (s) => { tr.textContent = s; handle(P.parse(s)); } };
})();
$('#btn-mic').addEventListener('click', () => { H.impact('medium'); Voice.open(); });
if (!Voice.supported) $('#mic-hint').textContent = 'Мікрофон: напиши «кава 80» або продиктуй з клавіатури';

/* ---------------- На головний екран (Bot API 8.0+) ---------------- */
const homeSupported = () => !!(inTG && ver('8.0') && tg.addToHomeScreen);
function updateHomeStatus() {
  const st = $('#home-status'), b = $('#btn-home');
  if (!homeSupported()) { b.disabled = true; st.textContent = inTG ? 'Онови Telegram, щоб додати ярлик (потрібен Bot API 8.0+).' : 'Доступно лише всередині Telegram.'; return; }
  b.disabled = false;
  try { tg.checkHomeScreenStatus((s) => { st.textContent = s === 'added' ? '✓ Ярлик уже додано' : s === 'unsupported' ? 'Цей пристрій не підтримує ярлики' : ''; $('#btn-home-main').classList.toggle('hidden', s === 'added' || s === 'unsupported'); }); } catch (e) {}
}
function addHome() { if (!homeSupported()) return toast('Доступно в Telegram (Bot API 8.0+)'); H.impact('medium'); tg.addToHomeScreen(); }
$('#btn-home').addEventListener('click', addHome); $('#btn-home-main').addEventListener('click', addHome);
if (tg && tg.onEvent) { tg.onEvent('homeScreenAdded', () => { toast('Ярлик додано ✓'); updateHomeStatus(); $('#btn-home-main').classList.add('hidden'); }); }
if (homeSupported()) updateHomeStatus();

/* ---------------- Налаштування: валюта, експорт/імпорт ---------------- */
function setDisplayCur(cc) {
  if (!CURRENCIES[cc] || cc === state.settings.cur) return;
  const prev = state.settings.cur; state.settings.cur = cc; state.settings.u = Date.now(); H.select(); persist([]);
  $$('#cur-switch button').forEach(b => b.classList.toggle('on', b.dataset.cc === cc));
  $('#set-cur').value = cc; renderAll(); renderRates();
  // цифри прокручуються з поточного значення до сконвертованого
  $('#odo-cur').textContent = sym(); Odo.set(Math.round(toDisp(balance())), true); renderSpark();
}
$('#set-cur').addEventListener('change', (e) => setDisplayCur(e.target.value));
$('#cur-switch').addEventListener('click', (e) => { const b = e.target.closest('[data-cc]'); if (b) setDisplayCur(b.dataset.cc); });
function renderRates() {
  const r = Rates.get(), el = $('#rates-line'); if (!el) return;
  const n = (x) => x.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const src = r.src === 'nbu' ? 'Курс НБУ' : r.src === 'er-api' ? 'Курс (open.er-api)' : 'Курс НБУ (вбудований)';
  const when = r.ts ? new Date(r.ts).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' }) : '';
  const stale = r.ts && Date.now() - r.ts > 24 * 3600e3 ? ' · офлайн' : '';
  el.textContent = `${src}: 1$ = ${n(r.USD)} ₴, 1€ = ${n(r.EUR)} ₴` + (when ? ` · оновлено ${when}` : r.date ? ` · ${r.date}` : '') + stale;
}
Rates.on(() => { renderRates(); renderAll(); if (state.settings.cur !== 'UAH') { Odo.set(Math.round(toDisp(balance())), true); } });
function exportJSON() { return JSON.stringify({ app: 'buhgalteria', version: 1, exported: new Date().toISOString(), currency: state.settings.cur, rates: Rates.get(), transactions: state.tx.slice().sort((a, b) => a.d - b.d).map(t => ({ id: t.id, type: t.t, amount: t.a / 100, currency: 'UAH', original_amount: (t.oa != null ? t.oa : t.a) / 100, original_currency: t.oc || 'UAH', category: t.c, note: t.n, date: new Date(t.d).toISOString() })) }, null, 1); }
$('#btn-export').addEventListener('click', () => {
  const s = exportJSON(); const io = $('#io-text'); io.value = s; io.classList.remove('hidden'); $('#io-actions').classList.remove('hidden'); $('#btn-io-apply').classList.add('hidden');
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], { type: 'application/json' })); a.download = 'buhgalteria-' + new Date().toISOString().slice(0, 10) + '.json'; if (!inTG) a.click(); } catch (e) {}
  H.impact('light');
});
$('#btn-import').addEventListener('click', () => { const io = $('#io-text'); io.value = ''; io.classList.remove('hidden'); $('#io-actions').classList.remove('hidden'); $('#btn-io-apply').classList.remove('hidden'); io.focus(); });
$('#btn-io-copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#io-text').value); toast('Скопійовано'); } catch (e) { $('#io-text').select(); document.execCommand('copy'); toast('Скопійовано'); } });
$('#btn-io-file').addEventListener('click', () => $('#io-file').click());
$('#io-file').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) { $('#io-text').value = await f.text(); $('#btn-io-apply').classList.remove('hidden'); } });
$('#btn-io-apply').addEventListener('click', () => {
  let data; try { data = JSON.parse($('#io-text').value); } catch (e) { H.notify('error'); return toast('Невірний JSON'); }
  const list = Array.isArray(data) ? data : data.transactions;
  if (!Array.isArray(list)) return toast('Не знайдено transactions');
  const have = new Set(state.tx.map(t => t.id)); let added = 0; const months = [];
  for (const r of list) {
    const t = { id: String(r.id || uid()), t: (r.type || r.t) === 'income' ? 'income' : 'expense', a: Math.round((r.amount != null ? +r.amount * 100 : +r.a) || 0), c: null, n: String(r.note || r.n || ''), d: r.date ? new Date(r.date).getTime() : +r.d || Date.now() };
    if (t.t === 'expense') t.c = CAT[r.category || r.c] ? (r.category || r.c) : 'other'; else t.c = SRC[r.category || r.c] ? (r.category || r.c) : 'iother';
    t.oc = CURRENCIES[r.original_currency] ? r.original_currency : 'UAH'; t.oa = r.original_amount != null ? Math.round(+r.original_amount * 100) : t.a;
    if (!t.a || have.has(t.id)) continue; t.u = Date.now(); state.dead = state.dead.filter(x => x.id !== t.id); state.tx.push(t); have.add(t.id); months.push(Store.monthKey(t.d)); added++;
  }
  if (data.currency && CURRENCIES[data.currency]) state.settings.cur = data.currency;
  persist(months); renderAll(); showBalance(true); H.notify('success'); toast('Імпортовано: ' + added);
});
$('#btn-wipe').addEventListener('click', () => {
  const doWipe = async () => { await Store.wipe(); state.tx = []; state.dead = []; renderAll(); showBalance(true); toast('Дані видалено'); };
  if (inTG && ver('6.2')) tg.showConfirm('Видалити всі операції без можливості відновлення?', ok => ok && doWipe());
  else if (confirm('Видалити всі операції?')) doWipe();
});

/* ---------------- Фони ---------------- */
const BG = (() => {
  const body = document.body, cv = $('#bg-canvas');
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)');
  const lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4);
  const pauses = new Set(); let theme = 'aurora', lite = false;
  // ---- частинки: ≤36 точок, DPR ≤1.5 (1 в lite), 30 fps, пауза при прихованій сторінці/відкритій шторці
  let ctx, W, H, dpr, pts = [], raf = 0, last = 0, running = false;
  const LINE_STYLES = ['rgba(150,160,170,.05)', 'rgba(150,160,170,.10)', 'rgba(160,170,180,.16)'];
  function setupCanvas() {
    dpr = 1; // м'який фон не потребує ретіни — у 2–4 рази менше пікселів
    W = innerWidth; H = innerHeight; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx = cv.getContext('2d', { alpha: false }); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = lite ? 20 : Math.min(30, Math.round(W * H / 10000));
    if (pts.length !== n) pts = Array.from({ length: n }, (_, i) => ({ x: Math.random() * W, y: Math.random() * H, vx: (Math.random() - .5) * 9, vy: (Math.random() - .5) * 9, r: Math.random() * 1.3 + .6, a: i % 9 === 0 }));
  }
  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (now - last < 32) return; // ~30 fps
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    drawParticles(dt);
  }
  function drawParticles(dt) {
    ctx.fillStyle = '#111315'; ctx.fillRect(0, 0, W, H);
    const L = 120, L2 = L * L;
    for (const p of pts) { p.x += p.vx * dt; p.y += p.vy * dt; if (p.x < -10) p.x = W + 10; if (p.x > W + 10) p.x = -10; if (p.y < -10) p.y = H + 10; if (p.y > H + 10) p.y = -10; }
    // лінії групуємо у 3 відра прозорості → 3 stroke() на кадр замість сотень
    ctx.lineWidth = 1;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath(); const lo = k / 3, hi = (k + 1) / 3;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 < L2) { const s = 1 - d2 / L2; if (s >= lo && s < hi) { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); } }
      }
      ctx.strokeStyle = LINE_STYLES[k]; ctx.stroke();
    }
    ctx.fillStyle = 'rgba(175,183,190,.5)'; ctx.beginPath();
    for (const p of pts) if (!p.a) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, 6.283); }
    ctx.fill(); ctx.fillStyle = 'rgba(201,146,90,.7)'; ctx.beginPath();
    for (const p of pts) if (p.a) { ctx.moveTo(p.x + p.r, p.y); ctx.arc(p.x, p.y, p.r, 0, 6.283); }
    ctx.fill();
  }
  function update() {
    const shouldRun = theme === 'particles' && !pauses.size && !(reduce && reduce.matches);
    body.classList.toggle('paused', pauses.has('hidden')); body.classList.toggle('sheet-open', pauses.has('sheet'));
    if (theme === 'particles' && !ctx) setupCanvas();
    if (shouldRun && !running) { running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!shouldRun && running) { running = false; cancelAnimationFrame(raf); }
    if (theme === 'particles' && !running && ctx) drawParticles(0); // статичний кадр (reduced motion / пауза)
  }
  function set(t, l) {
    theme = ['aurora', 'particles', 'carbon'].includes(t) ? t : 'aurora';
    lite = l === 'on' ? true : l === 'off' ? false : !!lowEnd;
    body.dataset.bg = theme; body.classList.toggle('lite', lite);
    if (theme === 'particles') setupCanvas();
    update();
  }
  document.addEventListener('visibilitychange', () => { pause('hidden', document.hidden); });
  let rt = 0; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (theme === 'particles') { setupCanvas(); update(); } }, 200); });
  reduce && reduce.addEventListener && reduce.addEventListener('change', update);
  function pause(k, on) { on ? pauses.add(k) : pauses.delete(k); update(); }
  return { set, pause, lowEnd: !!lowEnd, isLite: () => lite, isRunning: () => running };
})();
function applyBg() {
  BG.set(state.settings.bg, state.settings.lite);
  $$('#set-bg button').forEach(b => b.classList.toggle('on', b.dataset.bg === (state.settings.bg || 'aurora')));
  $$('#set-lite button').forEach(b => b.classList.toggle('on', b.dataset.lite === (state.settings.lite || 'auto')));
  $('#lite-auto').textContent = (state.settings.lite || 'auto') === 'auto' ? (BG.lowEnd ? '(увімкнено: слабкий пристрій)' : '') : '';
}
$('#set-bg').addEventListener('click', e => { const b = e.target.closest('[data-bg]'); if (!b) return; state.settings.bg = b.dataset.bg; state.settings.u = Date.now(); localStorage.setItem('ma_bg', b.dataset.bg); H.select(); applyBg(); persist([]); });
$('#set-lite').addEventListener('click', e => { const b = e.target.closest('[data-lite]'); if (!b) return; state.settings.lite = b.dataset.lite; state.settings.u = Date.now(); localStorage.setItem('ma_lite', b.dataset.lite); H.select(); applyBg(); persist([]); });
// застосовуємо одразу (до завантаження CloudStorage), щоб не було «блимання»
state.settings.bg = localStorage.getItem('ma_bg') || 'aurora'; state.settings.lite = localStorage.getItem('ma_lite') || 'auto'; applyBg();

/* ---------------- Резервна копія: один дотик ---------------- */
async function backupExport() {
  const json = exportJSON(), name = 'buhgalteria-backup-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
  H.impact('medium');
  try { // Android/Chrome: системне «Поділитися» з файлом (можна вибрати Telegram → «Збережені»)
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Бухгалтерія — резервна копія' }); toast('Копію передано ✓'); return; }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  if (!inTG) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); toast('Файл збережено ✓'); return; }
  // всередині Telegram: копіюємо JSON; якщо короткий — відкриваємо «Поділитися» з текстом у чат
  let copied = false; try { await navigator.clipboard.writeText(json); copied = true; } catch (e) {}
  const io = $('#io-text'); io.value = json; io.classList.remove('hidden'); $('#io-actions').classList.remove('hidden'); $('#btn-io-apply').classList.add('hidden');
  if (json.length < 3000 && ver('6.1')) { tg.openTelegramLink('https://t.me/share/url?url=' + encodeURIComponent('Бухгалтерія: резервна копія') + '&text=' + encodeURIComponent(json)); }
  else toast(copied ? 'Скопійовано — встав у «Збережені» в Telegram' : 'Скопіюй текст нижче і збережи в «Збережені»');
}
$('#btn-backup').addEventListener('click', backupExport);
function renderBackupInfo() {
  const sn = Store.snapshots(); const st = Store.status();
  $('#snap-info').textContent = sn.length ? `(${sn.length}, остання ${new Date(sn[0].at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })})` : '(ще немає)';
  $('#btn-restore').disabled = !sn.length;
  $('#sync-status').textContent = st.pending ? (st.attempt ? `⏳ синхр. повтор #${st.attempt}` : '⏳ синхронізація…') : '✓ синхронізовано';
}
Store.onStatus(() => { if (screen === 'settings') renderBackupInfo(); });
$('#btn-restore').addEventListener('click', () => {
  const sn = Store.snapshots(); if (!sn.length) return;
  const go = () => { const r = Store.restoreSnapshot(sn[0].i); if (!r) return; state.tx = r.tx; state.dead = r.dead; renderAll(); showBalance(true); renderBackupInfo(); toast('Відновлено з автокопії (записи додано, нічого не видалено)'); };
  if (inTG && ver('6.2')) tg.showConfirm('Додати записи з останньої автокопії? Поточні дані не видаляються.', ok => ok && go()); else if (confirm('Відновити з автокопії?')) go();
});

/* ---------------- Тост ---------------- */
let toastT = 0;
function toast(text, action, fn) {
  const t = $('#toast'); $('#toast-text').textContent = text; const b = $('#toast-action'); b.textContent = action || '';
  b.onclick = () => { t.classList.remove('on'); fn && fn(); };
  t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), action ? 4500 : 2200);
}

/* ---------------- Демо-дані (?demo=1, лише для перегляду) ---------------- */
function demoData() {
  const now = new Date(), tx = []; const D = (daysAgo, h, m) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.getTime(); };
  const add = (t, a, c, n, d) => tx.push({ id: uid() + tx.length, t, a: a * 100, c, n, d });
  add('income', 28500, 'salary', 'Зарплата', D(20, 10, 5)); add('income', 4200, 'freelance', 'Логотип для клієнта', D(9, 18, 30));
  add('income', 6000, 'salary', 'Аванс', D(5, 10, 0)); add('income', 1500, 'gift', 'Від бабусі', D(13, 15, 0)); add('income', 2300, 'sale', 'Продав навушники на OLX', D(3, 12, 30));
  add('income', 186, 'cashback', 'Кешбек Monobank', D(1, 9, 0)); add('income', 700, 'transfer', 'Повернув борг Саша', D(2, 19, 40));
  // попередній місяць (для порівняння)
  add('income', 28500, 'salary', 'Зарплата', D(50, 10, 0)); add('income', 2500, 'freelance', 'Банер', D(40, 17, 0)); add('income', 120, 'cashback', 'Кешбек', D(33, 9, 0));
  add('expense', 9500, 'housing', 'Оренда квартири', D(49, 12, 0)); add('expense', 2100, 'housing', 'Комуналка', D(44, 9, 0)); add('expense', 3900, 'food', 'Продукти', D(38, 18, 0));
  add('expense', 1450, 'cafe', 'Кафе', D(36, 14, 0)); add('expense', 1600, 'transport', 'Бензин', D(35, 17, 0)); add('expense', 2600, 'shopping', 'Куртка', D(31, 13, 0)); add('expense', 900, 'fun', 'Концерт', D(30, 20, 0));
  add('expense', 9500, 'housing', 'Оренда квартири', D(19, 12, 0)); add('expense', 1840, 'housing', 'Комуналка', D(15, 9, 40));
  add('expense', 845, 'food', 'Продукти Сільпо', D(3, 19, 10)); add('expense', 1230, 'food', 'АТБ', D(8, 18, 2)); add('expense', 80, 'food', 'Кава', D(0, 8, 45));
  add('expense', 640, 'cafe', 'Піца з друзями', D(2, 20, 15)); add('expense', 320, 'cafe', 'Кафе', D(6, 13, 30));
  add('expense', 50, 'transport', 'Автобус', D(0, 9, 5)); add('expense', 240, 'transport', 'Таксі', D(1, 23, 40)); add('expense', 1100, 'transport', 'Бензин', D(5, 17, 20));
  add('expense', 450, 'fun', 'Кіно', D(4, 21, 0)); add('expense', 780, 'fun', 'Бар', D(2, 23, 10));
  add('expense', 1999, 'shopping', 'Кросівки', D(7, 15, 0)); add('expense', 250, 'comms', 'Київстар', D(10, 11, 0));
  add('expense', 386, 'health', 'Аптека', D(1, 14, 20)); add('expense', 120, 'food', 'Їжа', D(0, 13, 10));
  tx.forEach(t => { t.oc = 'UAH'; t.oa = t.a; });
  const fx = (t, oa, oc, c, n, d) => tx.push({ id: uid() + tx.length, t, a: fromCur(oa * 100, oc), oc, oa: oa * 100, c, n, d });
  fx('income', 150, 'USD', 'freelance', 'Upwork', D(12, 16, 0)); fx('expense', 12, 'EUR', 'fun', 'Spotify', D(11, 10, 0));
  return tx;
}

/* ---------------- Старт ---------------- */
(async function boot() {
  let data;
  try { data = await Store.init(); } catch (e) { console.error(e); data = { tx: [], dead: [], settings: { cur: 'UAH' } }; toast('Не вдалося завантажити дані'); }
  state.tx = data.tx; state.dead = data.dead || []; state.settings = data.settings;
  if (data.restored === 'snapshot') setTimeout(() => toast('Основні дані були пошкоджені — відновлено з автокопії ✓'), 600);
  else if (data.restored === 'remote') setTimeout(() => toast('Дані відновлено з хмари ✓'), 600);
  state.tx.forEach(t => { if (!t.oc) { t.oc = 'UAH'; t.oa = t.a; } if (t.t === 'income' && !SRC[t.c]) t.c = 'iother'; });
  if (!state.settings.bg) state.settings.bg = localStorage.getItem('ma_bg') || 'aurora';
  if (!state.settings.lite) state.settings.lite = localStorage.getItem('ma_lite') || 'auto';
  { const q = location.search; const mb = q.match(/bg=(aurora|particles|carbon)/), ml = q.match(/lite=(on|off|auto)/); if (mb) state.settings.bg = mb[1]; if (ml) state.settings.lite = ml[1]; }
  applyBg();
  await Rates.hydrate();
  $$('#cur-switch button').forEach(b => b.classList.toggle('on', b.dataset.cc === state.settings.cur));
  renderRates(); Rates.refresh(); setInterval(() => Rates.refresh(), 30 * 60e3); // кеш живе 3 год, перевірка кожні 30 хв
  window.addEventListener('online', () => Rates.refresh(true));
  if (/[?&]cur=(UAH|EUR|USD)/.test(location.search)) state.settings.cur = location.search.match(/cur=(UAH|EUR|USD)/)[1];
  $$('#cur-switch button').forEach(b => b.classList.toggle('on', b.dataset.cc === state.settings.cur));
  if (/[?&]demo=1/.test(location.search) && !state.tx.length) { state.tx = demoData(); persist(Array.from(new Set(state.tx.map(t => Store.monthKey(t.d))))); }
  renderAll();
  Odo.set(0, false);
  setTimeout(() => showBalance(true), 250);
  // Прямий запуск голосу: t.me/<bot>/money?startapp=voice (або ?startapp=voice / #voice у браузері)
  const startParam = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || new URLSearchParams(location.search).get('tgWebAppStartParam') || new URLSearchParams(location.search).get('startapp') || (location.hash === '#voice' ? 'voice' : '');
  if (startParam === 'voice') setTimeout(() => Voice.open(), 700);
  else if (startParam === 'expense') setTimeout(() => openTx('add', 'expense'), 700);
  else if (startParam === 'income') setTimeout(() => openTx('add', 'income'), 700);
  window.__app = { state, Store, deleteTx, BG, applyBg, flashBg, Odo, Rates, fmt, setDisplayCur, toDisp, Voice, P, balance, addTx, go, openTx, byCategory, inPeriod };
})();
})();
