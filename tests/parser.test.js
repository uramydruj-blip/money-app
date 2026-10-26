const assert = require('assert');
const { parse } = require('../parser.js');
const cases = [
  ['витратив 50 на автобус', 'expense', 50, 'transport'],
  ['кава 80', 'expense', 80, 'food'],
  ['плюс 2000 зарплата', 'income', 2000, null],
  ['додай 500', 'income', 500, null],
  ['мінус 120 їжа', 'expense', 120, 'food'],
  ['потратил 200 на еду', 'expense', 200, 'food'],
  ['таксі 150', 'expense', 150, 'transport'],
  ['маршрутка двадцять', 'expense', 20, 'transport'],
  ['кіно 250', 'expense', 250, 'fun'],
  ['бар 600', 'expense', 600, 'fun'],
  ['кафе 340,50', 'expense', 340.5, 'cafe'],
  ['поповнив телефон на 100', 'expense', 100, 'comms'],
  ['аптека 1 250', 'expense', 1250, 'health'],
  ['оренда квартири 12000', 'expense', 12000, 'housing'],
  ['купив кросівки за 3 тисячі', 'expense', 3000, 'shopping'],
  ['заплатил за интернет триста', 'expense', 300, 'comms'],
  ['получил зарплату 25000', 'income', 25000, null],
  ['плюс дві тисячі п\'ятсот', 'income', 2500, null],
  ['потратил сто пятьдесят на такси', 'expense', 150, 'transport'],
  ['кофе 65', 'expense', 65, 'food'],
  ['+300 кешбек', 'income', 300, null],
  ['-90 метро', 'expense', 90, 'transport'],
  ['додай півтори тисячі', 'income', 1500, null],
  ['продукти в сільпо 845', 'expense', 845, 'food'],
  ['витратила 70 гривень на щось', 'expense', 70, 'other'],
  ['ресторан 1.2к', 'expense', 1200, 'cafe'],
  ['комуналка 2300', 'expense', 2300, 'housing'],
];
const curCases = [
  ['кава 3 євро', 'expense', 3, 'food', 'EUR'],
  ['витратив 20 доларів на таксі', 'expense', 20, 'transport', 'USD'],
  ['плюс 500 баксів', 'income', 500, null, 'USD'],
  ['$15 кіно', 'expense', 15, 'fun', 'USD'],
  ['10€ кафе', 'expense', 10, 'cafe', 'EUR'],
  ['потратил 50 долларов на одежду', 'expense', 50, 'shopping', 'USD'],
  ['получил 300 евро зарплата', 'income', 300, null, 'EUR'],
  ['мінус 120 гривень їжа', 'expense', 120, 'food', 'UAH'],
  ['потратил сто гривен на такси', 'expense', 100, 'transport', 'UAH'],
  ['додай двісті доларів', 'income', 200, null, 'USD'],
  ['кава 80', 'expense', 80, 'food', null],
];
for (const c of curCases) cases.push(c);
// джерела надходжень: [фраза, тип, сума, категорія, валюта, джерело]
const srcCases = [
  ['плюс 2000 зарплата', 'income', 2000, null, undefined, 'salary'],
  ['отримав аванс 5000', 'income', 5000, null, undefined, 'salary'],
  ['замовлення на fiverr 150 доларів', 'income', 150, null, 'USD', 'freelance'],
  ['клієнт заплатив 3000', 'income', 3000, null, undefined, 'freelance'],
  ['заработал на фрилансе 300 долларов', 'income', 300, null, 'USD', 'freelance'],
  ['подарували 1000', 'income', 1000, null, undefined, 'gift'],
  ['мне подарили 50 евро', 'income', 50, null, 'EUR', 'gift'],
  ['продав велосипед 4500', 'income', 4500, null, undefined, 'sale'],
  ['продал телефон за 8000', 'income', 8000, null, undefined, 'sale'],
  ['кешбек 120', 'income', 120, null, undefined, 'cashback'],
  ['проценты по депозиту 350', 'income', 350, null, undefined, 'cashback'],
  ['перекинули 700', 'income', 700, null, undefined, 'transfer'],
  ['получил перевод 2000', 'income', 2000, null, undefined, 'transfer'],
  ['плюс 500', 'income', 500, null, undefined, 'iother'],
  ['получил премию 4000', 'income', 4000, null, undefined, 'salary'],
];
for (const c of srcCases) cases.push(c);
let pass = 0, fail = 0;
for (const [phrase, type, amount, cat, cur, src] of cases) {
  const r = parse(phrase);
  try {
    assert.strictEqual(r.ok, true, 'ok');
    assert.strictEqual(r.type, type, 'type');
    assert.strictEqual(r.amount, amount, 'amount');
    assert.strictEqual(r.category, cat, 'category');
    if (cur !== undefined) assert.strictEqual(r.currency, cur, 'currency');
    if (src !== undefined) assert.strictEqual(r.source, src, 'source');
    pass++; console.log('✓', phrase.padEnd(40), JSON.stringify({ t: r.type, a: r.amount, cur: r.currency, c: r.category, s: r.source, n: r.note }));
  } catch (e) { fail++; console.log('✗', phrase.padEnd(40), e.message, JSON.stringify(r)); }
}
const bad = parse('просто текст без суми');
if (bad.ok) { fail++; console.log('✗ no-amount phrase should not be ok'); } else { pass++; console.log('✓ no-amount phrase rejected'); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
