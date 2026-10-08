/* Industry classification for card payments, built from real SEB statement merchant names (Latvia, 2025-2026).
   Rules match the shop name (and the bank's payment text) and are checked top to bottom, first match wins.
   Unknown shops stay "Unclassified": export them from Stats and add rules here. */
(function (root) {
  'use strict';
  const INDUSTRIES = [
    { id: 'groceries', name: 'Groceries', color: '#c8f26a' },
    { id: 'convenience', name: 'Kiosks & convenience', color: '#9fd356' },
    { id: 'eating', name: 'Cafes & fast food', color: '#f2a65f' },
    { id: 'nicotine', name: 'Nicotine & vape', color: '#c2603a' },
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
    // nicotine (before groceries: these names contain "VEIKALS")
    [/ECODUMAS|ECO DUMAS|VAPE|VAPOR|TABAKA|TOBACCO|IQOS|SMOKE|NIKOTIN|ELFBAR|E-CIG/, 'nicotine'],
    // groceries and supermarkets
    [/\bRIMI\b|MAXIMA|\bLIDL\b|\bELVI\b|ELLI V VEIKALS|\bTOP\b|TOP-VEIKALS|VEIKALS TOP|CITRO|\bAIBE\b|\bMEGO\b|\bLATS\b|\bSPAR\b|ARTIMA|KIPITIS|KĪPĪTIS|MASTER-VEIKALS|VEIKALS-|BRIVIBAS IELA VEIKALS|PRISMA/, 'groceries'],
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

  // ---------- fuzzy shop matching ----------
  // A shop's "brand key" is its first meaningful word: "MEGO RIGA BRUNINIEKU 2" -> MEGO, "PAYPAL *STEAM GAMES" -> STEAM,
  // "N14086 aptieka Roja" -> APTIEKA. Keys match when one starts with the other (MEGO ~ MEGOVEIKALS) or differ by one letter.
  const STOP = new Set(['VEIKALS', 'VEIKALI', 'SIA', 'AS', 'IK', 'UAB', 'OU', 'LTD', 'INC', 'GMBH', 'SHOP', 'STORE', 'THE', 'RIGAS', 'RIGA', 'LV', 'LVA',
    'WWW', 'COM', 'JAUNA', 'JAUNS', 'VECA', 'LIELA', 'MAZA', 'PAYPAL', 'PYD', 'MOL', 'SUMUP', 'SQ', 'ZETTLE', 'TC', 'SHM', 'MR', 'SM', 'FILIA', 'FILIALE', 'UN', 'AND']);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  function brandKey(place) {
    const toks = norm(place).split(' ').filter((t) => t && !/\d/.test(t));
    for (const t of toks) if (t.length >= 3 && !STOP.has(t)) return t;
    return toks[0] || norm(place);
  }
  function lev(a, b) {
    const m = a.length, n = b.length; let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function keysMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const [sh, lo] = a.length <= b.length ? [a, b] : [b, a];
    if (sh.length >= 3 && lo.startsWith(sh)) return true;
    return sh.length >= 5 && Math.abs(a.length - b.length) <= 1 && lev(a, b) <= 1;
  }

  // cfg (optional, the user's own classification): { custom: [{ id, name, color }], map: { BRANDKEY: industryId } }
  function userIndustry(place, cfg) {
    if (!cfg || !cfg.map) return null;
    const k = brandKey(place);
    if (cfg.map[k]) return cfg.map[k];
    for (const key in cfg.map) if (keysMatch(k, key)) return cfg.map[key];
    return null;
  }
  // Known brands (4+ letters) matched fuzzily by brand key, so "MEGOveikals" or "NARVESENS" still count.
  const BRANDS = {
    groceries: ['RIMI', 'MAXIMA', 'LIDL', 'ELVI', 'CITRO', 'AIBE', 'MEGO', 'KIPITIS', 'SPAR', 'ARTIMA', 'PRISMA', 'TOPVEIKALS'],
    convenience: ['NARVESEN', 'INMEDIO', 'PRESSPOINT', 'TOGO'],
    eating: ['HESBURGER', 'MCDONALDS', 'KAFEJNICA', 'KONDITOREJA', 'STARBUCKS', 'SUBWAY', 'LATTES'],
    nicotine: ['ECODUMAS', 'IQOS', 'VAPE'],
    delivery: ['WOLT', 'GLOVO'],
    taxi: ['BOLT', 'UBER', 'FORUS'],
    transport: ['MOBILLY', 'DAUTRANS', 'AUTOOSTA', 'AUTOTRANSPORTS', 'RIGASSTARPTAUTISKA', 'FLIXBUS', 'ECOLINES'],
    fuel: ['NESTE', 'VIADA', 'VIRSI', 'ASTARTE', 'CIRCLE', 'GOTIKA'],
    health: ['APTIEKA', 'APOTHEKA', 'BENU'],
    digital: ['HOSTINGER', 'NAMECHEAP', 'ANTHROPIC', 'GOOGLE', 'SPOTIFY', 'NETFLIX', 'WIKIMEDIA'],
    games: ['STEAM'],
    online: ['TEMU', 'ALIEXPRESS', 'ALIPAY', 'AMAZON', 'WAREHOUSE'],
    clothing: ['HUMANA', 'SINSAY', 'PEPCO', 'LINDEX', 'DEICHMANN', 'SPORTLAND'],
    home: ['WURTH', 'SENUKAI', 'JYSK', 'IKEA'],
    sport: ['GYMLATVIJA', 'MYFITNESS', 'LEMONGYM'],
    post: ['OMNIVA', 'VENIPAK', 'SMARTPOSTI']
  };
  const BRAND_LIST = Object.entries(BRANDS).flatMap(([id, keys]) => keys.map((k) => [k, id]));
  function classify(place, note, cfg) {
    const u = userIndustry(place, cfg);
    if (u && (BY_ID[u] || (cfg.custom || []).some((c) => c.id === u))) return u;
    const bk = brandKey(place);
    for (const [k, id] of BRAND_LIST) if (bk.length >= 4 && keysMatch(bk, k)) return id;
    const hay = (String(place || '') + ' | ' + String(note || '')).toUpperCase();
    for (const [re, id] of RULES) if (re.test(hay)) return id;
    return null;
  }
  const placeOf = (e) => e.bankPlace || e.place;
  function classifyExpense(e, cfg) { return classify(placeOf(e), e.note, cfg); }

  /** Built-in industries plus the user's own, "Unclassified" last. */
  function allIndustries(cfg) {
    const list = INDUSTRIES.filter((x) => x.id !== 'other').concat((cfg && cfg.custom) || []);
    return list.concat([BY_ID.other]);
  }

  /** Totals per industry for expenses in [from, to]. Unknown ones go to "other". */
  function byIndustry(expenses, from, to, cfg) {
    const names = Object.fromEntries(allIndustries(cfg).map((x) => [x.id, x]));
    const t = {};
    for (const e of expenses) {
      if (e.ignored || e.date < from || e.date > to) continue;
      let id = classifyExpense(e, cfg) || 'other';
      if (!names[id]) id = 'other';
      t[id] = (t[id] || 0) + (+e.amount || 0);
    }
    return Object.keys(t).map((id) => ({ id, name: names[id].name, color: names[id].color, total: Math.round(t[id] * 100) / 100 }))
      .filter((x) => x.total > 0).sort((a, b) => (a.id === 'other') - (b.id === 'other') || b.total - a.total);
  }

  /** Unclassified payments grouped by shop brand: [{ key, name, count, total }], biggest first. */
  function unclassifiedGroups(expenses, cfg) {
    const g = {};
    for (const e of expenses) {
      if (e.ignored || classifyExpense(e, cfg)) continue;
      const k = brandKey(placeOf(e)) || '?';
      const x = g[k] || (g[k] = { key: k, names: {}, count: 0, total: 0 });
      x.count++; x.total += +e.amount || 0;
      const nm = String(placeOf(e) || '?').trim(); x.names[nm] = (x.names[nm] || 0) + 1;
    }
    return Object.values(g).map((x) => ({ key: x.key, name: Object.entries(x.names).sort((a, b) => b[1] - a[1])[0][0], count: x.count, total: Math.round(x.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total);
  }

  const csvCell = (v) => { const s = String(v ?? ''); return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  /** CSV of every expense whose shop isn't classified yet (one row per payment). */
  function unclassifiedCsv(expenses, cfg) {
    const rows = expenses.filter((e) => !e.ignored && !classifyExpense(e, cfg)).sort((a, b) => a.date.localeCompare(b.date));
    const lines = [['date', 'amount', 'establishment', 'bank_text', 'from_bank'].join(',')];
    for (const e of rows) lines.push([e.date, (+e.amount).toFixed(2), csvCell(placeOf(e)), csvCell(e.note), e.bankId ? 'yes' : 'no'].join(','));
    return { csv: lines.join('\n') + '\n', count: rows.length, shops: new Set(rows.map((e) => brandKey(placeOf(e)))).size };
  }

  const api = { INDUSTRIES, RULES, brandKey, keysMatch, classify, classifyExpense, allIndustries, byIndustry, unclassifiedGroups, unclassifiedCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Industry = api;
})(typeof window !== 'undefined' ? window : globalThis);
