/* Budget logic: pure functions, no DOM. Works in the browser (window.BudgetLogic) and in Node (require). */
(function (root) {
  'use strict';

  // ---------- Latvia 2026 payroll constants (employee insured in all social insurance types) ----------
  // Sources: VID / PwC Latvia 2026 payroll guide.
  const TAX2026 = {
    vsaoiEmployee: 0.105,        // employee social insurance
    vsaoiEmployer: 0.2359,       // employer social insurance (for employer cost display)
    riskFee: 0.36,               // employer business risk fee per month
    iinRate: 0.255,              // personal income tax, monthly withholding
    iinHighRate: 0.33,           // applies to annual income above threshold (settled in annual declaration)
    highThresholdAnnual: 105300, // EUR per year
    nonTaxableMin: 550,          // fixed non-taxable minimum per month in 2026
    dependent: 250,              // relief per dependent per month
    disabilityI_II: 154,
    disabilityIII: 120,
    minWage: 780
  };

  const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const num = (x) => { const n = parseFloat(String(x ?? '').replace(',', '.')); return isFinite(n) ? n : 0; };

  /** Gross (bruto) monthly salary to net (neto), Latvia 2026. */
  function salaryNet(gross, opts) {
    opts = opts || {};
    const t = TAX2026;
    const g = Math.max(0, num(gross));
    const taxBook = opts.taxBook !== false;
    const deps = Math.max(0, parseInt(opts.dependents, 10) || 0);
    const dis = opts.disability || 'none';
    const vsaoi = r2(g * t.vsaoiEmployee);
    let relief = 0;
    if (taxBook) {
      relief += t.nonTaxableMin + deps * t.dependent;
      if (dis === 'I-II') relief += t.disabilityI_II;
      if (dis === 'III') relief += t.disabilityIII;
    }
    const taxable = Math.max(0, g - vsaoi - relief);
    const iin = r2(taxable * t.iinRate);
    const net = r2(g - vsaoi - iin);
    // Extra 7.5% (33% minus 25.5%) on the yearly part above 105 300 EUR, paid with the annual declaration.
    const annualGross = g * 12;
    const annualExtra = r2(Math.max(0, annualGross - t.highThresholdAnnual) * (t.iinHighRate - t.iinRate));
    const employerCost = r2(g * (1 + t.vsaoiEmployer) + (g > 0 ? t.riskFee : 0));
    return {
      gross: r2(g), vsaoi, relief: r2(Math.min(relief, Math.max(0, g - vsaoi))), taxable: r2(taxable), iin, net,
      annualExtra, netAfterAnnualExtra: r2(net - annualExtra / 12), employerCost,
      effectiveRate: g > 0 ? (g - net) / g : 0
    };
  }

  // ---------- Dates (YYYY-MM-DD strings, timezone safe) ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
  const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
  const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  const todayStr = (now) => { now = now || new Date(); return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()); };
  const payDateIn = (y, m0, payDay) => ymd(new Date(Date.UTC(y, m0, Math.min(payDay, daysInMonth(y, m0)))));

  /** Budget period containing date s: from pay date to the day before the next pay date. */
  function periodFor(s, payDay) {
    payDay = Math.min(31, Math.max(1, parseInt(payDay, 10) || 1));
    const d = parse(s);
    let y = d.getUTCFullYear(), m = d.getUTCMonth();
    let start = payDateIn(y, m, payDay);
    if (s < start) { m--; if (m < 0) { m = 11; y--; } start = payDateIn(y, m, payDay); }
    let ny = y, nm = m + 1; if (nm > 11) { nm = 0; ny++; }
    const next = payDateIn(ny, nm, payDay);
    return { start, end: addDays(next, -1), next };
  }

  /** Income kind: 'salary' (final salary), 'advance' (part of salary paid early) or 'other'. */
  function incomeKind(i) {
    if (i.kind) return i.kind;
    if (/^advance$|^avanss$/i.test(i.source || '')) return 'advance';
    if (/^salary$|^alga$/i.test(i.source || '')) return 'salary';
    return 'other';
  }

  function sumByDay(items) {
    const map = {};
    for (const it of items) { if (it.ignored) continue; map[it.date] = (map[it.date] || 0) + num(it.amount); }
    return map;
  }
  function sumRange(map, a, b) {
    let s = 0;
    for (const k in map) if (k >= a && k <= b) s += map[k];
    return r2(s);
  }

  /**
   * Walk every budget period from the start date until today and apply the carry rules:
   *  - Overspend (negative leftover) is carried in full to the next period, every time.
   *  - Surplus rolls over to the next period once. If that rollover is still unspent when the
   *    next period closes, what is left of it goes to savings; that period's own surplus rolls on.
   *  - Savings per closed period = monthly saving + rollover sent to savings.
   *  - Current period (live): saved = monthly saving minus any overspend so far.
   */
  function buildLedger(state, today) {
    const s = state.settings;
    const payDay = s.payDay || 1;
    const S = num(s.monthlySaving);
    const spentByDay = sumByDay(state.expenses || []);
    const incomeByDay = sumByDay(state.incomes || []);
    const adjByDay = sumByDay(state.adjustments || []); // rebalances: change the allowance, never count as spend/income
    const statsFrom = s.statsFrom || s.startDate || today;
    const isHoliday = makeHolidayCheck(s.vacations);
    const periods = [];
    let savedTotal = num(s.startingSaved);
    let carry = num(s.openingCarry);
    if (!s.startDate || s.startDate > today) return { periods, savedTotal, current: null, spentByDay, incomeByDay, adjByDay, statsFrom, isHoliday };
    let p = periodFor(s.startDate, payDay);
    let guard = 0;
    while (p.start <= today && guard++ < 1200) {
      const isCurrent = today >= p.start && today <= p.end;
      // Salary rules: an advance is part of the salary, so until the final salary arrives the
      // expected salary is still used (advance counts toward it). Other income adds on top.
      let salary = 0, advance = 0, other = 0, hasSalary = false;
      for (const it of state.incomes || []) {
        if (it.ignored || it.date < p.start || it.date > p.end) continue;
        const k = incomeKind(it), a = num(it.amount);
        if (k === 'salary') { salary += a; hasSalary = true; } else if (k === 'advance') advance += a; else other += a;
      }
      const exp = s.useExpected ? num(s.expectedNet) : 0;
      let income = r2(salary + advance + other);
      let incomeExpected = false, salaryToCome = 0;
      if (exp > 0 && !hasSalary && advance < exp) {
        incomeExpected = true; salaryToCome = r2(exp - advance);
        income = r2(other + exp);
      }
      const base = r2(income - S);
      const rolloverIn = Math.max(0, carry);
      const adjust = sumRange(adjByDay, p.start, p.end);
      const effectiveBase = r2(base + carry);
      const effective = r2(effectiveBase + adjust);
      const spent = sumRange(spentByDay, p.start, p.end);
      const leftover = r2(effective - spent);
      const per = Object.assign({}, p, { income, incomeExpected, salaryToCome, advance: r2(advance), saving: S, base, carryIn: r2(carry), rolloverIn: r2(rolloverIn), adjust, effectiveBase, effective, spent, leftover, isCurrent });
      if (!isCurrent) {
        let toSavings = 0, carryOut;
        if (leftover < 0) carryOut = leftover;
        else { toSavings = Math.min(rolloverIn, leftover); carryOut = leftover - toSavings; }
        per.toSavings = r2(toSavings); per.carryOut = r2(carryOut); per.saved = r2(S + toSavings);
        carry = carryOut;
      } else {
        const over = Math.max(0, spent - effective);
        per.overspend = r2(over); per.saved = r2(S - over);
      }
      savedTotal += per.saved;
      periods.push(per);
      p = periodFor(p.next, payDay);
    }
    return { periods, savedTotal: r2(savedTotal), current: periods.find((x) => x.isCurrent) || null, spentByDay, incomeByDay, adjByDay, statsFrom, isHoliday };
  }

  const isWeekend = (d) => { const w = parse(d).getUTCDay(); return w === 0 || w === 6; };

  /**
   * "Is this date a holiday?" A day is a holiday only when BOTH are true:
   * it's a Saturday or Sunday, and it falls inside a vacation mode date range [{from, to}].
   */
  function makeHolidayCheck(vacations) {
    const ranges = (vacations || []).filter((v) => v && v.from && v.to).map((v) => (v.from <= v.to ? [v.from, v.to] : [v.to, v.from]));
    return (d) => isWeekend(d) && ranges.some(([a, b]) => d >= a && d <= b);
  }

  /** Number of budget (non-holiday) days from a to b inclusive. */
  function budgetDaysBetween(a, b, isHoliday) {
    let n = 0;
    for (let d = a; d <= b; d = addDays(d, 1)) if (!isHoliday(d)) n++;
    return n;
  }

  /**
   * Day by day allowance inside one period: what was left at the start of the day divided by the
   * budget days left (holidays don't count, they get 0). Spending on a holiday still comes off what's
   * left. A rebalance counts from its own day onward. `plan` is the even-pace share used for statistics;
   * it's set on the first counted day (stats start) and reset whenever a rebalance happens.
   */
  function dailySeries(per, spentByDay, upTo, adjByDay, statsFrom, isHoliday) {
    adjByDay = adjByDay || {};
    isHoliday = isHoliday || (() => false);
    const out = [];
    let before = 0;
    let eff = per.effectiveBase !== undefined ? per.effectiveBase : per.effective;
    let planRate = null;
    const anchor = statsFrom && statsFrom > per.start ? statsFrom : per.start;
    let budgetLeft = budgetDaysBetween(per.start, per.end, isHoliday); // budget days from d to period end
    for (let d = per.start; d <= per.end && d <= upTo; d = addDays(d, 1)) {
      const adj = adjByDay[d] || 0;
      eff += adj;
      const holiday = isHoliday(d);
      const daysLeft = diffDays(d, per.end) + 1;
      const available = eff - before;
      const allow = holiday ? 0 : available / Math.max(1, budgetLeft);
      if (d === anchor || (adj && d > anchor)) planRate = budgetLeft > 0 ? available / budgetLeft : 0;
      const plan = planRate === null ? null : (holiday ? 0 : planRate);
      const spent = spentByDay[d] || 0;
      out.push({ date: d, allow: r2(allow), plan, spent: r2(spent), diff: r2(spent - allow), cum: r2(before + spent), before: r2(before), daysLeft, budgetDaysLeft: budgetLeft, holiday });
      before += spent;
      if (!holiday) budgetLeft--;
    }
    return out;
  }

  /** Today's numbers for the big display. */
  function todayStatus(ledger, today) {
    const per = ledger.current;
    if (!per) return null;
    const isHoliday = ledger.isHoliday || (() => false);
    const series = dailySeries(per, ledger.spentByDay, today, ledger.adjByDay, ledger.statsFrom, isHoliday);
    const t = series[series.length - 1];
    const remainingMonth = r2(per.effective - per.spent);
    // next budget (non-holiday) day after today, and its allowance if nothing else is spent today
    let next = null;
    for (let d = addDays(today, 1); d <= per.end; d = addDays(d, 1)) {
      if (!isHoliday(d)) { next = d; break; }
    }
    // Preview of the next budget day: assume today's budget gets spent in full. Overspending lowers it
    // right away; money left unspent today only raises it once the day is over (the real calculation
    // tomorrow uses what was actually spent).
    const usedToday = Math.max(t.spent, t.allow);
    const nextAllowance = next ? r2((per.effective - t.before - usedToday) / budgetDaysBetween(next, per.end, isHoliday)) : null;
    return {
      period: per, holiday: t.holiday, dailyAllowance: t.allow, spentToday: t.spent, leftToday: r2(t.allow - t.spent),
      daysLeft: t.daysLeft, budgetDaysLeft: t.budgetDaysLeft, remainingMonth,
      nextDate: next, nextAllowance, nextIsTomorrow: next === addDays(today, 1),
      tomorrow: next === addDays(today, 1) ? nextAllowance : null // kept for older screens
    };
  }

  /** All counted days (with allowance) in a date range, across periods. Days before the stats start are left out. */
  function daysInRange(ledger, from, to, today) {
    const out = [];
    if (ledger.statsFrom && ledger.statsFrom > from) from = ledger.statsFrom;
    for (const per of ledger.periods) {
      if (per.end < from || per.start > to) continue;
      for (const d of dailySeries(per, ledger.spentByDay, today, ledger.adjByDay, ledger.statsFrom, ledger.isHoliday)) if (d.date >= from && d.date <= to) out.push(Object.assign({ periodStart: per.start }, d));
    }
    return out;
  }

  /** Amount to store so that what's left to spend this period becomes `target`. */
  function rebalanceDelta(ledger, target) {
    const per = ledger.current;
    if (!per) return 0;
    return r2(num(target) - (per.effective - per.spent));
  }

  function overUnderStats(days) {
    if (!days.length) return { days: 0, avgDiff: 0, totalSpent: 0, totalAllow: 0, pct: 0, overDays: 0, underDays: 0 };
    // avgDiff: spent minus that day's live allowance. pct: total spent vs the even-pace plan for those days.
    let sp = 0, al = 0, diff = 0, over = 0, under = 0;
    for (const d of days) { sp += d.spent; al += d.plan || 0; diff += d.diff; if (d.diff > 0.005) over++; else under++; }
    return {
      days: days.length, avgDiff: r2(diff / days.length), totalSpent: r2(sp), totalAllow: r2(al),
      pct: al > 0 ? (sp - al) / al : 0, overDays: over, underDays: under
    };
  }

  function projectGoal(ledger, settings) {
    const goal = num(settings.goal);
    const S = num(settings.monthlySaving);
    const saved = ledger.savedTotal;
    const pct = goal > 0 ? Math.min(1, Math.max(0, saved / goal)) : 0;
    const remaining = r2(goal - saved);
    if (goal <= 0) return { saved, goal, pct, remaining: 0, none: true };
    if (remaining <= 0) return { saved, goal, pct: 1, remaining: 0, reached: true };
    if (S <= 0 || !ledger.current) return { saved, goal, pct, remaining, never: true };
    const months = Math.ceil(remaining / S - 1e-9);
    let next = ledger.current.next;
    for (let i = 1; i < months; i++) next = periodFor(next, settings.payDay).next;
    return { saved, goal, pct, remaining, months, date: next };
  }

  // ---------- Places / merchants ----------
  function cleanPlace(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\b\d{4,6}\*+\d{2,6}\b/g, '')             // masked card numbers
      .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, '')  // dates
      .replace(/\b\d{2}:\d{2}(:\d{2})?\b/g, '')              // times
      .replace(/^(PIRKUMS|MAKSĀJUMS|MAKSAJUMS|KARTES DARĪJUMS|CARD PAYMENT|PURCHASE)\s*[:\-]?\s*/i, '')
      .replace(/\b\d{6,}\b/g, '')
      .replace(/\s+/g, ' ').replace(/^[\s,.;:\-]+|[\s,.;:\-]+$/g, '').trim();
    return s.slice(0, 60) || 'Unknown';
  }

  function topPlaces(expenses, from, to, aliases, limit) {
    aliases = aliases || {}; limit = limit || 8;
    const map = {};
    for (const e of expenses) {
      if (e.ignored || e.date < from || e.date > to) continue;
      const raw = e.place || 'Unknown';
      const key = aliases[raw] || raw;
      map[key] = (map[key] || 0) + num(e.amount);
    }
    const arr = Object.entries(map).map(([name, total]) => ({ name, total: r2(total) })).sort((a, b) => b.total - a.total);
    if (arr.length > limit) {
      const rest = arr.slice(limit - 1).reduce((s, x) => s + x.total, 0);
      return arr.slice(0, limit - 1).concat([{ name: 'Other', total: r2(rest) }]);
    }
    return arr;
  }

  // ---------- Bank (Enable Banking / PSD2 transaction format) ----------
  function txId(tx) {
    const a = tx.transaction_amount || {};
    return tx.transaction_id || tx.entry_reference ||
      ['h', tx.booking_date || tx.value_date, a.amount, tx.credit_debit_indicator, (tx.remittance_information || []).join('|'),
        (tx.creditor && tx.creditor.name) || '', (tx.debtor && tx.debtor.name) || ''].join('~');
  }

  function mapTransaction(tx) {
    const a = tx.transaction_amount || {};
    let amount = num(a.amount);
    let dir = tx.credit_debit_indicator;
    if (!dir) dir = amount < 0 ? 'DBIT' : 'CRDT';
    amount = Math.abs(amount);
    const date = tx.booking_date || tx.value_date || tx.transaction_date;
    const remit = (tx.remittance_information || []).join(' ');
    const counter = dir === 'DBIT' ? (tx.creditor && tx.creditor.name) : (tx.debtor && tx.debtor.name);
    const place = cleanPlace(counter || remit || tx.bank_transaction_code?.description || 'Unknown');
    return { bankId: txId(tx), dir: dir === 'DBIT' ? 'out' : 'in', amount: r2(amount), date, place, note: remit.slice(0, 140), pending: tx.status === 'PDNG' };
  }

  function matchesIgnore(m, rules) {
    const list = String(rules || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return false;
    const hay = (m.place + ' ' + m.note).toLowerCase();
    return list.some((k) => hay.includes(k));
  }

  // ---------- Live payments (phone notifications, e.g. Google Wallet) ----------
  const AMOUNT_RE = /(?:(€|EUR)\s?(\d{1,3}(?:[   .,]\d{3})*(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:[   .,]\d{3})*(?:[.,]\d{1,2})?)\s?(€|EUR))/i;
  const SKIP_RE = /declin|noraid|atteikt|fail|neizdev|refund|atmaks|return|atgriez|reversed|cancel|atcel|added to wallet|pievienot|ready to|verify|verific|apstiprin|top.?up|papildin/i;

  function parseAmount(raw) {
    let t = String(raw).replace(/[   ]/g, '');
    const lastComma = t.lastIndexOf(','), lastDot = t.lastIndexOf('.');
    if (lastComma >= 0 && lastDot >= 0) {
      const dec = Math.max(lastComma, lastDot);
      t = t.slice(0, dec).replace(/[.,]/g, '') + '.' + t.slice(dec + 1);
    } else if (lastComma >= 0 || lastDot >= 0) {
      const i = Math.max(lastComma, lastDot);
      const after = t.length - i - 1;
      t = after === 3 ? t.replace(/[.,]/g, '') : t.slice(0, i).replace(/[.,]/g, '') + '.' + t.slice(i + 1);
    }
    const n = parseFloat(t);
    return isFinite(n) ? r2(n) : 0;
  }

  /**
   * Turn a payment notification into { amount, place } or null.
   * Handles e.g. title "Rimi" + text "€12.40 with Visa ••1234", or "12,40 € pie Rimi".
   */
  function parsePaymentNotification(ev) {
    const title = String(ev.title || '').trim();
    const text = String(ev.text || '').trim();
    const all = title + ' \n ' + text;
    if (SKIP_RE.test(all)) return null;
    const m = all.match(AMOUNT_RE);
    if (!m) return null;
    const amount = parseAmount(m[2] || m[3]);
    if (!(amount > 0) || amount > 20000) return null;
    const tidy = (x) => String(x || '').replace(AMOUNT_RE, ' ')
      .replace(/\b(with|ar|using|via)\b.*$/i, '')               // "with Visa ••1234"
      .replace(/(visa|mastercard|maestro|amex)\b.*$/i, '')
      .replace(/[•*·]+\s*\d{2,4}/g, '')
      .replace(/\b(paid|payment|samaksāts|samaksats|maksājums|purchase|pirkums)\b[:]?/gi, '')
      .replace(/\s+/g, ' ').replace(/^[\s,.;:\-–]+|[\s,.;:\-–]+$/g, '').trim();
    let place = '';
    if (title && !AMOUNT_RE.test(title)) place = tidy(title);
    else {
      const src = AMOUNT_RE.test(title) ? title : text;
      const after = src.replace(AMOUNT_RE, ' ').match(/(?:^|\s)(?:at|pie|in|@|-|–)\s+(.+)/i);
      place = tidy(after ? after[1] : src);
      if (!place && src === title) place = tidy(text); // e.g. title "Paid €12", text "IKEA Riga"
    }
    return { amount, place: (place || 'Card payment').slice(0, 60) };
  }

  /**
   * Find an expense already logged (live from a notification, or typed by hand) that is the same
   * purchase as a bank transaction: same amount, within 3 days, not yet linked to the bank.
   */
  function findDuplicateForBank(expenses, m) {
    let best = null, bestGap = 99;
    for (const e of expenses) {
      if (e.bankId || e.ignored) continue;
      if (Math.abs(num(e.amount) - m.amount) > 0.005) continue;
      const gap = Math.abs(diffDays(e.date, m.date));
      if (gap <= 3 && gap < bestGap) { best = e; bestGap = gap; }
    }
    return best;
  }

  /** A live payment is a duplicate if the same amount was already logged that day within an hour. */
  function findDuplicateForLive(expenses, date, amount, timeMs) {
    return expenses.find((e) => !e.ignored && e.date === date && Math.abs(num(e.amount) - amount) <= 0.005 &&
      (e.bankId || (e.created && Math.abs(e.created - timeMs) <= 3600e3))) || null;
  }

  const api = {
    TAX2026, salaryNet, r2, num,
    pad, ymd, parse, addDays, diffDays, daysInMonth, todayStr, periodFor,
    incomeKind, sumByDay, sumRange, buildLedger, isWeekend, makeHolidayCheck, budgetDaysBetween, dailySeries, todayStatus, daysInRange, overUnderStats, rebalanceDelta, projectGoal,
    cleanPlace, topPlaces, txId, mapTransaction, matchesIgnore, parseAmount, parsePaymentNotification, findDuplicateForBank, findDuplicateForLive
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
