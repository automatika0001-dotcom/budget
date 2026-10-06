// Run: node tests/logic.test.js
const L = require('../js/logic.js');
const assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} != ${b}`);

t('salary 1500 gross, tax book, no dependents', () => {
  const s = L.salaryNet(1500, { taxBook: true });
  near(s.vsaoi, 157.5, 'vsaoi');
  near(s.iin, (1500 - 157.5 - 550) * 0.255, 'iin');
  near(s.net, 1140.41, 'net');
});
t('salary below non-taxable min pays no IIN', () => {
  const s = L.salaryNet(600, {}); near(s.iin, 0, 'iin'); near(s.net, 537, 'net');
});
t('dependents and no tax book', () => {
  near(L.salaryNet(2000, { dependents: 1 }).iin, (2000 - 210 - 800) * 0.255, 'dep');
  near(L.salaryNet(2000, { taxBook: false }).iin, (2000 - 210) * 0.255, 'nobook');
});
t('annual 33% estimate above 105300', () => {
  near(L.salaryNet(10000, {}).annualExtra, (120000 - 105300) * 0.075, 'extra');
});

t('periods follow pay day and clamp short months', () => {
  assert.deepStrictEqual(L.periodFor('2026-10-06', 10), { start: '2026-09-10', end: '2026-10-09', next: '2026-10-10' });
  assert.deepStrictEqual(L.periodFor('2026-02-15', 31), { start: '2026-01-31', end: '2026-02-27', next: '2026-02-28' });
  assert.deepStrictEqual(L.periodFor('2026-12-20', 15), { start: '2026-12-15', end: '2027-01-14', next: '2027-01-15' });
});

function st(expenses, incomes, extra) {
  return { settings: Object.assign({ payDay: 1, monthlySaving: 500, goal: 20000, startDate: '2026-01-01' }, extra || {}), expenses, incomes };
}
const inc = (date, amount) => ({ date, amount });
const ex = (date, amount) => ({ date, amount, place: 'X' });

t('overspend carries to next month every time and savings stay at S for closed months', () => {
  const s = st([ex('2026-01-05', 1100), ex('2026-02-05', 1000)], [inc('2026-01-01', 1500), inc('2026-02-01', 1500), inc('2026-03-01', 1500)]);
  const L1 = L.buildLedger(s, '2026-03-02');
  const [jan, feb, mar] = L1.periods;
  near(jan.effective, 1000, 'jan eff'); near(jan.carryOut, -100, 'jan debt');
  near(feb.effective, 900, 'feb eff'); near(feb.carryOut, -100, 'feb debt');
  near(mar.effective, 900, 'mar eff');
  near(L1.savedTotal, 1500, 'saved');
});
t('surplus rolls over once, leftover of rollover goes to savings', () => {
  const s = st([ex('2026-01-05', 800), ex('2026-02-05', 1000)], [inc('2026-01-01', 1500), inc('2026-02-01', 1500), inc('2026-03-01', 1500)]);
  const L1 = L.buildLedger(s, '2026-03-02');
  const [jan, feb, mar] = L1.periods;
  near(jan.carryOut, 200, 'jan rollover');
  near(feb.effective, 1200, 'feb eff');
  near(feb.toSavings, 200, 'feb rollover to savings');
  near(feb.carryOut, 0, 'feb carry');
  near(mar.carryIn, 0, 'mar carry');
  near(L1.savedTotal, 500 + 700 + 500, 'saved');
});
t('partly spent rollover: only the rest goes to savings, own surplus rolls', () => {
  const s = st([ex('2026-01-05', 800), ex('2026-02-05', 1100)], [inc('2026-01-01', 1500), inc('2026-02-01', 1500), inc('2026-03-01', 1500)]);
  const [, feb, mar] = L.buildLedger(s, '2026-03-02').periods;
  near(feb.leftover, 100, 'left'); near(feb.toSavings, 100, 'to sav'); near(mar.carryIn, 0, 'carry');
});
t('live overspend reduces this month savings', () => {
  const s = st([ex('2026-01-05', 1200)], [inc('2026-01-01', 1500)]);
  const led = L.buildLedger(s, '2026-01-10');
  near(led.current.saved, 300, 'live saved'); near(led.savedTotal, 300, 'total');
});
t('daily allowance = remaining / days left, updates after spending', () => {
  const s = st([ex('2026-01-01', 100), ex('2026-01-02', 20)], [inc('2026-01-01', 1430)]); // effective 930, 31 days
  const led = L.buildLedger(s, '2026-01-02');
  const ts = L.todayStatus(led, '2026-01-02');
  near(ts.dailyAllowance, (930 - 100) / 30, 'daily'); near(ts.leftToday, (930 - 100) / 30 - 20, 'left today');
});
t('goal projection', () => {
  const s = st([], [inc('2026-01-01', 1500)], { startingSaved: 1000 });
  const led = L.buildLedger(s, '2026-01-10');
  const g = L.projectGoal(led, s.settings);
  near(g.saved, 1500, 'saved'); assert.strictEqual(g.months, 37); assert.strictEqual(g.date, '2029-02-01');
});
t('expected income fills months with no logged income', () => {
  const s = st([], [], { useExpected: true, expectedNet: 1400 });
  near(L.buildLedger(s, '2026-01-03').current.effective, 900, 'eff');
});
t('bank transaction mapping', () => {
  const m = L.mapTransaction({ transaction_amount: { amount: '12.30', currency: 'EUR' }, credit_debit_indicator: 'DBIT', booking_date: '2026-10-05', remittance_information: ['PIRKUMS 4567**1234 05.10.2026 RIMI TEIKA'], status: 'BOOK' });
  assert.strictEqual(m.dir, 'out'); near(m.amount, 12.3, 'amt'); assert.strictEqual(m.place, 'RIMI TEIKA');
});
console.log(`\n${n} tests passed`);
