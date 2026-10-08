// Run: node tests/ustax.test.js
const T = require('../js/ustax.js');
const assert = require('assert');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.011, `${msg}: ${a} != ${b}`);

t('all 50 states + DC present', () => assert.strictEqual(Object.keys(T.STATES).length, 51));
t('Nevada single 60k: federal + FICA only', () => {
  const r = T.usNet(60000, { state: 'NV', filing: 'single' });
  near(r.federal, 1240 + (43900 - 12400) * 0.12, 'federal'); // 5020
  near(r.socialSecurity, 3720, 'ss'); near(r.medicare, 870, 'medicare'); near(r.state, 0, 'state');
  near(r.net, 60000 - 5020 - 3720 - 870, 'net'); near(r.netMonth, 50390 / 12, 'month');
});
t('federal married 120k', () => {
  const r = T.usNet(120000, { state: 'TX', filing: 'married' });
  near(r.federal, 2480 + (87800 - 24800) * 0.12, 'federal'); // taxable 87,800
});
t('child credit 2 kids reduces federal', () => {
  const a = T.usNet(80000, { state: 'NV', filing: 'married' }), b = T.usNet(80000, { state: 'NV', filing: 'married', dependents: 2 });
  near(a.federal - b.federal, 4400, 'ctc');
});
t('Social Security stops at the 184,500 wage base; extra Medicare above 200k', () => {
  const r = T.usNet(300000, { state: 'NV', filing: 'single' });
  near(r.socialSecurity, 184500 * 0.062, 'ss'); near(r.medicare, 300000 * 0.0145 + 100000 * 0.009, 'med');
});
t('California single 60k with exemption credit', () => {
  const r = T.usNet(60000, { state: 'CA', filing: 'single' });
  near(r.state, 110.79 + 303.70 + 607.52 + 780.48 - 153, 'ca');
});
t('Utah flat 4.5% minus credit', () => near(T.usNet(50000, { state: 'UT' }).state, 50000 * 0.045 - 966, 'ut'));
t('Ohio: nothing below 26,050 after exemption', () => {
  near(T.usNet(28000, { state: 'OH' }).state, 0, 'oh low');
  near(T.usNet(50000, { state: 'OH' }).state, (50000 - 2400 - 26050) * 0.0275, 'oh');
});
t('pre-tax 401k lowers income tax but not FICA', () => {
  const a = T.usNet(70000, { state: 'NV' }), b = T.usNet(70000, { state: 'NV', pretax: 6000 });
  near(a.socialSecurity, b.socialSecurity, 'fica same'); near(a.federal - b.federal, 3500 * 0.22 + 2500 * 0.12, 'fed lower'); // 53,900 taxable drops to 47,900, across the 22% line
  near(b.net, 70000 - 6000 - b.federal - b.socialSecurity - b.medicare, 'net excludes the 401k money');
});
t('zero and garbage input are safe', () => { assert.strictEqual(T.usNet(0, {}).net, 0); assert.strictEqual(T.usNet('x', { state: 'ZZ' }).net, 0); });
console.log(`${n} US tax tests passed`);
