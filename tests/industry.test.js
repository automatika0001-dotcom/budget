// Run: node tests/industry.test.js   (merchant names taken from a real SEB statement, Oct 2025 to Oct 2026)
const I = require('../js/industry.js');
const assert = require('assert');
const cases = {
  groceries: ['RIMI SHM ORIGO (RIGA)', 'RIMI MR VIESTURA (DAUG', 'Rimi MR Centrala Staci', 'RIMI SM Lidonu (Riga)', 'MAXIMA LV R280', 'MAXIMA LV R015', 'TOP-VEIKALS-AGLONA', 'TOP-VEIKALS-SPOGI', 'VEIKALS TOP', 'VEIKALS TOP TERBATAS S', 'TOP veikals Roja', 'CITRO-VEIKALS-ROJA,ZVE', 'AIBE PERNAVAS', 'MEGO RIGA BRUNINIEKU 2', 'MEGO RIGA ROPAZU 72', 'MEGO RIGA CIEKURKALNA', 'Elvi-Ganibu dambis', 'ELLI V VEIKALS 5', 'KIPITIS-ROJA-SELGAS 4', 'VEIKALS-AGLONA', 'Master-veikals-Roja', 'BRIVIBAS IELA VEIKALS'],
  convenience: ['NARVESEN 1151', 'NARVESEN 760', 'TO GO TUNELIS C', 'To Go - Origo', 'JAUNA PERLE SIA'],
  nicotine: ['VEIKALS ECODUMAS'],
  eating: ['KAFEJNICA VOJAZ', 'HESBURGER 43014', 'LUDZU-KONDITOREJA-TC O', 'TWO LATTES'],
  delivery: ['WOLT'],
  taxi: ['BOLT.EUO2609140909'],
  transport: ['TALSU AUTOTRANSPORTS A', 'RigasStarptautiska aut', 'TUKUMA AUTO REISS', 'Daugavpils autobusu pa', 'Dautrans', 'DAUGAVPILS AUTOOSTA', 'RIGAS PAS.STACIJA 6.BI', 'STACIJAS DAUGAVPILS 1.', 'www.mobilly.lv', 'PYD*AS Rezeknes AP', 'HBLA044 Autoosta'],
  fuel: ['ASTARTE NAFTA 36, VISK', 'DUS AGLONA', 'DUS BULLU'],
  health: ['N14086 aptieka "Roja"', 'KASTANU APTIEKAS FILIA', 'APOTHEKA 11'],
  digital: ['Google One', 'Google Play Apps', 'HOSTINGER* HOSTINGER.C', 'PAYPAL *NAMECHEAP', 'ANTHROPIC* CLAUDE SUB', 'Wikimedia', 'www.ss.lv', 'LATVIJAS UNIVERSITATES MATEMATIKAS UN INFORMATIKAS INSTITUTS'],
  games: ['PAYPAL *STEAM GAMES'],
  online: ['TEMU.COM', 'PAYPAL *ALIPAY EUR', 'PC-WAREHOUSE', 'MOL*FACTRA LTD'],
  clothing: ['HUMANA/HUMANA, MARIJAS'],
  home: ['WURTH, DAUGAVPILS 2'],
  sport: ['gymlatvija.lv'],
  post: ['mana.omniva.lv', 'OMNIVA ROJA 9136'],
  fees: ['SEB banka'],
  cash: ["BRINK'S ATM LATVIA"],
  finance: ['Revolut Ramp']
};
let n = 0;
for (const [id, names] of Object.entries(cases)) for (const nm of names) { assert.strictEqual(I.classify(nm, ''), id, nm); n++; }
// left for later on purpose: unknown shops
for (const nm of ['SIA AMBER DISTRIBUTIO', 'MILLENIUMS SIA', 'KAC-Pragas', 'JAUNA VECRIGA SIA']) assert.strictEqual(I.classify(nm, ''), null, nm);
assert.strictEqual(I.classify('JURIS DUNDARS', 'Mobilais maksājums'), 'people');
// chart totals and export
const ex = [{ date: '2026-10-01', amount: 6.3, place: 'TALSU AUTOTRANSPORTS A' }, { date: '2026-10-02', amount: 3, place: 'NARVESEN 1151' }, { date: '2026-10-02', amount: 30, place: 'KAC-Pragas', note: 'card, "quoted"', bankId: 'b' }, { date: '2026-09-01', amount: 99, place: 'RIMI' }];
const t = I.byIndustry(ex, '2026-10-01', '2026-10-31');
assert.deepStrictEqual(t.map((x) => [x.id, x.total]), [['transport', 6.3], ['convenience', 3], ['other', 30]]);
const c = I.unclassifiedCsv(ex);
assert.strictEqual(c.count, 1); assert.ok(c.csv.includes('2026-10-02,30.00,KAC-Pragas,"card, ""quoted""",yes'));
assert.strictEqual(I.classify('MEGOveikals Dzirnavu', ''), 'groceries');
assert.strictEqual(I.classify('NARVESENS 12', ''), 'convenience');
assert.strictEqual(I.brandKey('JAUNA VECRIGA SIA'), 'VECRIGA');
// fuzzy brand keys and the user's own classification
assert.strictEqual(I.brandKey('MEGO RIGA BRUNINIEKU 2'), 'MEGO');
assert.strictEqual(I.brandKey('PAYPAL *STEAM GAMES'), 'STEAM');
assert.strictEqual(I.brandKey('N14086 aptieka "Roja"'), 'APTIEKA');
assert.strictEqual(I.brandKey('SIA AMBER DISTRIBUTIO'), 'AMBER');
assert.ok(I.keysMatch('MEGO', 'MEGOVEIKALS') && I.keysMatch('MILLENIUMS', 'MILLENNIUMS') && !I.keysMatch('KAC', 'KAFE') && !I.keysMatch('MEGO', 'MAXIMA'));
const cfg = { custom: [{ id: 'c_kiosk', name: 'Snacks', color: '#123456' }], map: { KAC: 'c_kiosk', AMBER: 'convenience' } };
assert.strictEqual(I.classify('KAC-Pragas', '', cfg), 'c_kiosk');
assert.strictEqual(I.classify('KACPRAGAS NEW', '', cfg), 'c_kiosk'); // fuzzy: same brand, different spelling
assert.strictEqual(I.classify('SIA AMBER DISTRIBUTIO 2', '', cfg), 'convenience');
assert.strictEqual(I.classify('MEGOveikals Dzirnavu', '', { custom: [], map: { MEGO: 'eating' } }), 'eating'); // user rule wins over built-in
assert.strictEqual(I.classify('KAC-Pragas', '', { custom: [], map: { KAC: 'deleted_custom' } }), null); // rule to a removed industry is ignored
const g = I.unclassifiedGroups([{ date: 'x', amount: 2, place: 'MILLENIUMS SIA' }, { date: 'x', amount: 3, place: 'Milleniums' }, { date: 'x', amount: 9, place: 'Roja' }, { date: 'x', amount: 1, place: 'RIMI' }]);
assert.deepStrictEqual(g.map((x) => [x.key, x.count, x.total]), [['ROJA', 1, 9], ['MILLENIUMS', 2, 5]]);
assert.ok(I.byIndustry([{ date: '2026-10-01', amount: 5, place: 'KAC-Pragas' }], '2026-10-01', '2026-10-31', cfg)[0].name === 'Snacks');
console.log(`ok  ${n} statement merchants classified; ${I.INDUSTRIES.length} industries`);
