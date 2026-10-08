/* Industry classification for card payments, built from real SEB statement merchant names (Latvia, 2025-2026).
   Rules match the shop name (and the bank's payment text) and are checked top to bottom, first match wins.
   Unknown shops stay "Unclassified": export them from Stats and add rules here. */
(function (root) {
  'use strict';
  const INDUSTRIES = [
    { id: 'groceries', name: 'Groceries', color: '#c8f26a' },
    { id: 'convenience', name: 'Kiosks & convenience', color: '#9fd356' },
    { id: 'eating', name: 'Cafes & fast food', color: '#f2a65f' },
    { id: 'delivery', name: 'Food delivery', color: '#f5c35b' },
    { id: 'transport', name: 'Public transport', color: '#6ab8f2' },
    { id: 'taxi', name: 'Taxi & rides', color: '#4f8fd6' },
    { id: 'fuel', name: 'Fuel stations', color: '#7c6af2' },
    { id: 'health', name: 'Pharmacy & health', color: '#5fd3a0' },
    { id: 'digital', name: 'Apps & subscriptions', color: '#b48cf2' },
    { id: 'games', name: 'Games', color: '#d58cf2' },
    { id: 'online', name: 'Online shopping', color: '#f26a9a' },
    { id: 'clothing', name: 'Clothing', color: '#f28c8c' },
    { id: 'home', name: 'Hardware & home', color: '#c9a27a' },
    { id: 'sport', name: 'Sport & fitness', color: '#3fbfbf' },
    { id: 'post', name: 'Post & parcels', color: '#e0c060' },
    { id: 'utilities', name: 'Phone & utilities', color: '#8fa3b8' },
    { id: 'fees', name: 'Bank fees', color: '#a0a0a0' },
    { id: 'cash', name: 'Cash withdrawals', color: '#d9d9d9' },
    { id: 'people', name: 'Transfers to people', color: '#b8c4bf' },
    { id: 'finance', name: 'Crypto & finance', color: '#e6b422' },
    { id: 'other', name: 'Unclassified', color: '#5b6662' }
  ];
  const BY_ID = Object.fromEntries(INDUSTRIES.map((x) => [x.id, x]));

  // [pattern, industry]. Patterns run on the upper-cased "place + payment text".
  const RULES = [
    // money movements first
    [/BRINK'?S ATM|BANKOMAT|\bATM\b|IZMAKSA/, 'cash'],
    [/^SEB BANKA\b|VP\.M\.KOM|KOMISIJA PAR|SERVICE FEE/, 'fees'],
    [/MOBILAIS MAKS/, 'people'],
    [/REVOLUT RAMP|COINBASE|BINANCE|KRAKEN|BYBIT|MOONPAY/, 'finance'],
    // food delivery and rides (before generic food words)
    [/\bWOLT\b|BOLT\.EU\/?F|BOLT FOOD|FOODPANDA|GLOVO/, 'delivery'],
    [/BOLT\.EU|\bBOLT\b|UBER|FORUS|YANDEX GO|TAXI|TAKSOMETR/, 'taxi'],
    // public transport, stations, bus companies, parking
    [/AUTOTRANSPORT|AUTOOSTA|STARPTAUTISKA AUT|AUTO REISS|AUTOBUSU P|DAUTRANS|PAS\.?STACIJA|PASAZIERU|PASAŽIERU|VIVI\b|\bLDZ\b|STACIJAS |RIGAS SATIKSME|SATIKSME|MOBILLY|AUTOPARKS|REZEKNES AP|\bAP\/REZEKNE|NORDEKA|LUX EXPRESS|ECOLINES|FLIXBUS|AIRBALTIC|RYANAIR|WIZZ/, 'transport'],
    // fuel
    [/\bDUS\b|NAFTA|CIRCLE ?K|\bNESTE\b|\bVIADA\b|VIRSI|VIRŠI|GOTIKA|LUKOIL|ORLEN|KOOL/, 'fuel'],
    // groceries and supermarkets
    [/\bRIMI\b|MAXIMA|\bLIDL\b|\bELVI\b|ELLI V VEIKALS|\bTOP\b|TOP-VEIKALS|VEIKALS TOP|CITRO|\bAIBE\b|\bMEGO\b|\bLATS\b|\bSPAR\b|ARTIMA|KIPITIS|KĪPĪTIS|ECODUMAS|MASTER-VEIKALS|VEIKALS-|BRIVIBAS IELA VEIKALS|PRISMA/, 'groceries'],
    // kiosks, convenience, coffee-to-go
    [/NARVESEN|TO ?GO\b|TO GO -|INMEDIO|PRESSPOINT|JAUNA PERLE/, 'convenience'],
    // eating out
    [/KAFEJNICA|HESBURGER|MCDONALD|KFC|BURGER KING|SUBWAY|KONDITOREJA|LATTES|COFFEE|KAFIJA|CAFE|KAFE|PICA|PIZZA|LIDO\b|RESTORAN|BISTRO|STARBUCKS|BAKERY|MAIZNICA/, 'eating'],
    // pharmacy and health
    [/APTIEKA|APTIEKAS|APOTHEKA|\bBENU\b|MENESS APTIEKA|MĒNESS|SAULES APTIEKA|ZOBĀRST|ZOBARST|KLINIKA|KLĪNIKA|MEDICAL/, 'health'],
    // digital services, domains, apps
    [/GOOGLE ONE|GOOGLE PLAY|GOOGLE \*|APPLE\.COM|ITUNES|SPOTIFY|NETFLIX|YOUTUBE|HOSTINGER|NAMECHEAP|ANTHROPIC|OPENAI|CHATGPT|MICROSOFT|ADOBE|DROPBOX|ICLOUD|WIKIMEDIA|NIC\.LV|INFORMATIKAS INSTIT|WWW\.SS\.LV|\bSS\.LV|CANVA|NOTION|GITHUB|CLOUDFLARE|DISCORD/, 'digital'],
    [/STEAM|EPIC GAMES|PLAYSTATION|XBOX|NINTENDO|RIOT|BLIZZARD|ROBLOX/, 'games'],
    // online shopping
    [/TEMU|ALIEXPRESS|ALIPAY|AMAZON|EBAY|SHEIN|\bETSY\b|PIGU|220\.LV|PC-WAREHOUSE|PCWAREHOUSE|DATORIUMS|EURONICS|ELKOR|RD ELECTRONICS|\bMOL\*/, 'online'],
    // clothing
    [/HUMANA|H&M|\bZARA\b|RESERVED|SINSAY|PEPCO|LINDEX|DEICHMANN|SPORTLAND|NEW YORKER|MOTIVI|ABOUT YOU|ZALANDO/, 'clothing'],
    // hardware, DIY, home
    [/WURTH|WÜRTH|\bDEPO\b|K-SENUKAI|KESKO|BAUHAUS|JYSK|IKEA|DEPO DIY|MOKI VEZI|ELEKTRO/, 'home'],
    // sport and fitness
    [/GYMLATVIJA|MYFITNESS|MY FITNESS|LEMON GYM|\bGYM\b|FITNESS|SPORTA KLUBS|DECATHLON/, 'sport'],
    // post and parcels
    [/OMNIVA|\bDPD\b|DHL|LATVIJAS PASTS|VENIPAK|SMARTPOSTI|UNISEND|PAKOMAT/, 'post'],
    // phone, internet, utilities
    [/\bLMT\b|TELE2|\bBITE\b|\bTET\b|LATVENERGO|ELEKTRUM|ENEFIT|RIGAS UDENS|RĪGAS ŪDENS|GASO|ADVEN|EKO KURZEME|CLEANR|ZAAO|NAMU APSAIMNIEK/, 'utilities']
  ];

  function classify(place, note) {
    const hay = (String(place || '') + ' | ' + String(note || '')).toUpperCase();
    for (const [re, id] of RULES) if (re.test(hay)) return id;
    return null;
  }
  function classifyExpense(e) { return classify(e.bankPlace || e.place, e.note); }

  /** Totals per industry for expenses in [from, to]. Unknown ones go to "other". */
  function byIndustry(expenses, from, to) {
    const t = {};
    for (const e of expenses) {
      if (e.ignored || e.date < from || e.date > to) continue;
      const id = classifyExpense(e) || 'other';
      t[id] = (t[id] || 0) + (+e.amount || 0);
    }
    return Object.keys(t).map((id) => ({ id, name: BY_ID[id].name, color: BY_ID[id].color, total: Math.round(t[id] * 100) / 100 }))
      .filter((x) => x.total > 0).sort((a, b) => (a.id === 'other') - (b.id === 'other') || b.total - a.total);
  }

  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  /** CSV of every expense whose shop isn't classified yet (one row per payment). */
  function unclassifiedCsv(expenses) {
    const rows = expenses.filter((e) => !e.ignored && !classifyExpense(e)).sort((a, b) => a.date.localeCompare(b.date));
    const lines = [['date', 'amount', 'establishment', 'bank_text', 'from_bank'].join(',')];
    for (const e of rows) lines.push([e.date, (+e.amount).toFixed(2), csvCell(e.bankPlace || e.place), csvCell(e.note), e.bankId ? 'yes' : 'no'].join(','));
    return { csv: lines.join('\n') + '\n', count: rows.length, shops: new Set(rows.map((e) => (e.bankPlace || e.place || '').toUpperCase())).size };
  }

  const api = { INDUSTRIES, RULES, classify, classifyExpense, byIndustry, unclassifiedCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Industry = api;
})(typeof window !== 'undefined' ? window : globalThis);
