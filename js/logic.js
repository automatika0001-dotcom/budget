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
  // Salary and advance are recognised from the payer and the bank text ("Darba alga par 09.2026", "Avanss").
  function textKind(i) {
    const t = (String(i.source || '') + ' ' + String(i.note || '')).toLowerCase();
    if (/avans|advance|vorschuss/.test(t)) return 'advance';
    if (/\balga\b|\balgas\b|darba alg|izmaksu saraksts|salary|payroll|\bwages?\b/.test(t)) return 'salary';
    return null;
  }
  function incomeKind(i) {
    if (i.kind && i.kind !== 'other') return i.kind;
    return textKind(i) || i.kind || 'other';
  }
  // When an entry was created on this phone: ids start with the creation time (base 36).
  function createdAt(x) {
    if (x && x.created && +x.created > 1.6e12) return +x.created;
    const t = parseInt(String((x && x.id) || '').slice(0, 8), 36);
    return t > 1.6e12 && t < 4e12 ? t : (x && x.target !== undefined ? Infinity : 0);
  }
  // A salary paid up to 7 days before pay day (pay day on a weekend or holiday) is next month's money.
  // An advance is money you can spend from the day it arrives, so it always counts on its own date.
  // (The Stats "advance to next pay day" view still starts at an early advance, see payRange.)
  const EARLY_SALARY_DAYS = 7, EARLY_ADVANCE_DAYS = 15;
  function budgetDateOf(it, payDay) {
    if (incomeKind(it) !== 'salary') return it.date;
    const next = periodFor(it.date, payDay).next;
    return diffDays(it.date, next) <= EARLY_SALARY_DAYS ? next : it.date;
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
  /**
   * opts.isFixed(expense): fixed costs (rent, utilities). They come out of the month's money on their day
   * (so the daily allowance is recalculated without them) but never count as that day's spending.
   */
  function buildLedger(state, today, opts) {
    const s = state.settings;
    const payDay = s.payDay || 1;
    const S = num(s.monthlySaving);
    const isFixed = (opts && opts.isFixed) || (() => false);
    const closed = (opts && opts.closed) || {}; // locked results of finished months, by period start
    // A locked month only counts what it held when it was locked. Anything dated inside it that it didn't
    // include (a late bank booking, an entry added afterwards) counts in the next open month instead, on the
    // day it was added, so no money is ever lost.
    const lateMove = makeLateMover(closed, payDay, today);
    const incomesB = (state.incomes || []).filter((i) => !i.ignored)
      .map((i) => lateMove(Object.assign({}, i, { bdate: budgetDateOf(i, payDay) }), 'i', 'bdate'));
    const allExp = (state.expenses || []).filter((e) => !e.ignored).map((e) => lateMove(Object.assign({}, e), 'e', 'date'));
    // Reserved money: taken out of what's available from the day it is reserved until it is paid or cancelled
    // (not spending). When paid, the reserve is given back and the real payments count instead, whatever they
    // came to. Payments linked to a paid reserve come off the month's money but aren't that day's spending.
    const reserves = (state.reserves || []).filter((r) => r && num(r.amount) > 0 && r.date);
    const paidRes = new Set(reserves.filter((r) => reserveStatus(r) === 'paid').map((r) => r.id));
    const fromReserve = (e) => !!(e.reserveId && paidRes.has(e.reserveId));
    const resByDay = {};
    for (const r of reserves) {
      resByDay[r.date] = r2((resByDay[r.date] || 0) - num(r.amount));
      const rel = releaseDateOf(r);
      if (rel) resByDay[rel] = r2((resByDay[rel] || 0) + num(r.amount));
    }
    const paidByDay = sumByDay(allExp.filter(fromReserve));
    const spentByDay = sumByDay(allExp.filter((e) => !fromReserve(e) && !isFixed(e)));
    const fixedByDay = sumByDay(allExp.filter((e) => !fromReserve(e) && isFixed(e)));
    const more = { resByDay, paidByDay };
    const incomeByDay = sumByDay(state.incomes || []);
    const adjByDay = {}; // rebalances, worked out per month below: change the allowance, never count as spend/income
    const adjs = (state.adjustments || []).filter((a) => !a.ignored);
    const statsFrom = s.statsFrom || s.startDate || today;
    const isHoliday = makeHolidayCheck(s.vacations);
    const periods = [];
    let savedTotal = num(s.startingSaved);
    let carry = num(s.openingCarry);
    if (!s.startDate || s.startDate > today) return { periods, savedTotal, current: null, spentByDay, fixedByDay, incomeByDay, adjByDay, more, statsFrom, isHoliday };
    let p = periodFor(s.startDate, payDay);
    let guard = 0;
    while (p.start <= today && guard++ < 1200) {
      const isCurrent = today >= p.start && today <= p.end;
      const lock = closed[p.start];
      if (!isCurrent && lock && lock.end === p.end && lock.per) {
        // Finished month: its numbers are final. Only what it hands over (an overspend) reaches the next month.
        const per = Object.assign({}, lock.per, { isCurrent: false, locked: true, days: lock.days || [] });
        carry = num(per.carryOut);
        savedTotal += num(per.saved);
        periods.push(per);
        p = periodFor(p.next, payDay);
        continue;
      }
      // Salary rules: an advance is part of the salary, so until the final salary arrives the
      // expected salary is still used (advance counts toward it). Other income adds on top.
      // `before` (a time) limits it to entries that already existed then; used to replay rebalances.
      const exp = s.useExpected ? num(s.expectedNet) : 0;
      // Was this entry already part of the picture when the rebalance (made at time t on day d) was typed?
      // Bank money dated before that day was already in the account; anything else counts if it existed then.
      let rbDay = null;
      const knownAt = (it, t) => (it.bankId && rbDay && it.date < rbDay) || createdAt(it) <= t;
      const incomeOf = (before) => {
        let salary = 0, advance = 0, other = 0, hasSalary = false;
        for (const it of incomesB) {
          if (it.bdate < p.start || it.bdate > p.end) continue;
          if (before !== undefined && !knownAt(it, before)) continue;
          const k = incomeKind(it), a = num(it.amount);
          if (k === 'salary') { salary += a; hasSalary = true; } else if (k === 'advance') advance += a; else other += a;
        }
        let income = r2(salary + advance + other), incomeExpected = false, salaryToCome = 0;
        if (exp > 0 && !hasSalary && advance < exp) { incomeExpected = true; salaryToCome = r2(exp - advance); income = r2(other + exp); }
        return { income, incomeExpected, salaryToCome, advance };
      };
      const { income, incomeExpected, salaryToCome, advance } = incomeOf();
      // The month's money grows as income arrives: each payment counts from its own day, not from the
      // start of the month (with an expected salary the plan stands from day one instead).
      const incomeSteps = {};
      let incomeLater = 0;
      if (!incomeExpected) {
        for (const it of incomesB) {
          if (it.bdate < p.start || it.bdate > p.end || it.bdate <= p.start) continue;
          incomeSteps[it.bdate] = r2((incomeSteps[it.bdate] || 0) + num(it.amount));
          incomeLater += num(it.amount);
        }
      }
      const base = r2(income - S);
      const rolloverIn = Math.max(0, carry);
      const effectiveBase = r2(base + carry);
      // Rebalance = "on that day I had X left to spend". It is replayed against what was known at that moment,
      // so later setting changes don't distort it and money that arrives afterwards still counts on top.
      let adjust = 0;
      const pAdjs = adjs.filter((x) => x.date >= p.start && x.date <= p.end).sort((x, y) => createdAt(x) - createdAt(y) || (x.date < y.date ? -1 : 1));
      for (const x of pAdjs) {
        let delta = num(x.amount);
        if (x.target !== undefined && x.target !== null && createdAt(x) < Infinity) {
          const t = createdAt(x); rbDay = x.date;
          const spentThen = allExp.reduce((sum, e) => (e.date >= p.start && e.date <= p.end && knownAt(e, t) ? sum + num(e.amount) : sum), 0);
          let resThen = 0;
          for (const r of reserves) {
            if (r.date >= p.start && r.date <= p.end && createdAt(r) <= t) resThen -= num(r.amount);
            const rel = releaseDateOf(r);
            if (rel && rel >= p.start && rel <= p.end && (+r.releasedAt || 0) <= t) resThen += num(r.amount);
          }
          delta = r2(num(x.target) - (incomeOf(t).income - S + carry + adjust + resThen - spentThen));
        }
        adjust = r2(adjust + delta);
        adjByDay[x.date] = r2((adjByDay[x.date] || 0) + delta);
      }
      const reserve = sumRange(resByDay, p.start, p.end);
      const effective = r2(effectiveBase + adjust + reserve);
      const fixed = sumRange(fixedByDay, p.start, p.end);
      const daily = sumRange(spentByDay, p.start, p.end);
      const paidRes = sumRange(paidByDay, p.start, p.end);
      const spent = r2(daily + fixed + paidRes); // all money that went out this period
      const leftover = r2(effective - spent);
      const per = Object.assign({}, p, { incomeSteps, incomeLater: r2(incomeLater), income, incomeExpected, salaryToCome, advance: r2(advance), saving: S, base, carryIn: r2(carry), rolloverIn: r2(rolloverIn), adjust, effectiveBase, effective, reserve: r2(reserve), spent, daily: r2(daily), fixed: r2(fixed), paidRes: r2(paidRes), leftover, isCurrent });
      if (!isCurrent) {
        // Closed month: an overspend carries into the next month; anything left over goes to savings.
        let toSavings = 0, carryOut = 0;
        if (leftover < 0) carryOut = leftover;
        else toSavings = leftover;
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
    return { periods, savedTotal: r2(savedTotal), current: periods.find((x) => x.isCurrent) || null, spentByDay, fixedByDay, incomeByDay, adjByDay, more, statsFrom, isHoliday, items: { exp: allExp, inc: incomesB } };
  }

  // ---------- reserves ----------
  function reserveStatus(r) {
    if (!r || !r.releasedDate) return 'active';
    return r.cancelled ? 'cancelled' : 'paid';
  }
  // The reserve is given back on its release day (never before the day it was made).
  function releaseDateOf(r) {
    if (!r.releasedDate) return null;
    return r.releasedDate < r.date ? r.date : r.releasedDate;
  }

  // ---------- locked months ----------
  // Did the lock of month c include entry x? New locks list what they held; older ones go by when x was added.
  function lockHas(c, x, kind) {
    if (c.ids && c.ids[kind]) return c.ids[kind].indexOf(x.id) >= 0;
    const t = createdAt(x);
    return !(t > 0 && t < Infinity && c.lockedAt && t >= parse(c.lockedAt).getTime() + 86400000);
  }
  function makeLateMover(closed, payDay, today) {
    const locks = [];
    for (const k in closed) {
      const c = closed[k], p = c && c.start ? periodFor(c.start, payDay) : null;
      if (p && c.per && p.start === c.start && p.end === c.end && today > c.end) locks.push(c);
    }
    if (!locks.length) return (x) => x;
    const lockAt = (d) => locks.find((c) => d >= c.start && d <= c.end);
    return (x, kind, field) => {
      let c = lockAt(x[field]);
      if (!c || lockHas(c, x, kind)) return x;
      const t = createdAt(x);
      const added = t > 0 && t < Infinity ? todayStr(new Date(t)) : null;
      // walk to the next month that is open (or whose lock did include it)
      for (let g = 0; g < 600; g++) {
        const p = periodFor(c.end, payDay), n = periodFor(p.next, payDay);
        const nc = lockAt(n.start);
        if (nc && lockHas(nc, x, kind)) { x[field] = n.start; x.lateFrom = x.lateFrom || x.date; return x; }
        if (!nc) {
          const d = added && added > n.start ? (added < n.end ? added : n.end) : n.start;
          x.lateFrom = x.lateFrom || x.date; x[field] = d; if (field === 'bdate') x.date = d;
          return x;
        }
        c = nc;
      }
      return x;
    };
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
  function dailySeries(per, spentByDay, upTo, adjByDay, statsFrom, isHoliday, fixedByDay, more) {
    adjByDay = adjByDay || {};
    const resByDay = (more && more.resByDay) || {}, paidByDay = (more && more.paidByDay) || {};
    fixedByDay = fixedByDay || {};
    isHoliday = isHoliday || (() => false);
    const out = [];
    let before = 0;
    let eff = (per.effectiveBase !== undefined ? per.effectiveBase : per.effective) - (per.incomeLater || 0);
    const steps = per.incomeSteps || {};
    let planRate = null;
    const anchor = statsFrom && statsFrom > per.start ? statsFrom : per.start;
    let budgetLeft = budgetDaysBetween(per.start, per.end, isHoliday); // budget days from d to period end
    for (let d = per.start; d <= per.end && d <= upTo; d = addDays(d, 1)) {
      const adj = adjByDay[d] || 0;
      const fx = fixedByDay[d] || 0; // rent/utilities paid today: taken off the month's money before today's allowance
      const inc = steps[d] || 0; // income that arrived today
      const rz = resByDay[d] || 0, pd = paidByDay[d] || 0; // reserved (-) / released (+), paid from a reserve
      eff += adj - fx + inc + rz - pd;
      const holiday = isHoliday(d);
      const daysLeft = diffDays(d, per.end) + 1;
      const available = eff - before;
      const allow = holiday ? 0 : Math.max(0, available) / Math.max(1, budgetLeft); // money gone: 0, never negative
      if (d === anchor || ((adj || fx || inc || rz || pd) && d > anchor)) planRate = budgetLeft > 0 ? available / budgetLeft : 0;
      const plan = planRate === null ? null : (holiday ? 0 : planRate);
      const spent = spentByDay[d] || 0;
      out.push({ date: d, allow: r2(allow), plan, pool: r2(eff), income: r2(inc), reserve: r2(rz), paidRes: r2(pd), spent: r2(spent), fixed: r2(fx), diff: r2(spent - allow), cum: r2(before + spent), before: r2(before), daysLeft, budgetDaysLeft: budgetLeft, holiday });
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
    const series = dailySeries(per, ledger.spentByDay, today, ledger.adjByDay, ledger.statsFrom, isHoliday, ledger.fixedByDay, ledger.more);
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
    const nextAllowance = next ? r2(Math.max(0, t.pool - t.before - usedToday) / budgetDaysBetween(next, per.end, isHoliday)) : null;
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
      if (per.locked) { for (const d of per.days) if (d.date >= from && d.date <= to && d.date >= (ledger.statsFrom || '')) out.push(Object.assign({ periodStart: per.start }, d)); continue; }
      for (const d of dailySeries(per, ledger.spentByDay, today, ledger.adjByDay, ledger.statsFrom, ledger.isHoliday, ledger.fixedByDay, ledger.more)) if (d.date >= from && d.date <= to) out.push(Object.assign({ periodStart: per.start }, d));
    }
    return out;
  }

  // ---------- catch-up mode ----------
  /** Over and under the daily limit in [from, to]: what catch-up starts from. net > 0 = behind. */
  function overUnder(ledger, from, to, today) {
    let over = 0, under = 0;
    for (const d of daysInRange(ledger, from, to, today)) { if (d.diff > 0) over += d.diff; else under -= d.diff; }
    return { over: r2(over), under: r2(under), net: r2(over - under) };
  }
  /**
   * How far spending this pay month is ahead of the even pace, the same numbers as the Stats chart: what you'd
   * still have if you had spent evenly. Overspending already lowers the following days' budget, so adding up
   * every day's "over" would count the same money again and again; this counts it once.
   */
  function paceGap(ledger, today, upTo) {
    const per = ledger.current;
    if (!per) return { spent: 0, pace: 0, gap: 0 };
    const isHol = ledger.isHoliday || (() => false);
    const p0 = ledger.statsFrom > per.start ? ledger.statsFrom : per.start;
    if (p0 > today) return { spent: 0, pace: 0, gap: 0 };
    let S = 0, P = 0, Lm = 0;
    const last = upTo && upTo < today ? upTo : today;
    if (last < p0) return { spent: 0, pace: 0, gap: 0 };
    for (const d of daysInRange(ledger, p0, last, today)) {
      const Sb = S, pr = d.paidRes || 0;
      S += d.spent + pr; P += pr;
      Lm = Sb + pr + Math.max(0, d.pool !== undefined ? d.pool - d.before : 0);
    }
    const k = budgetDaysBetween(p0, last, isHol), K = Math.max(1, budgetDaysBetween(p0, per.end, isHol));
    const pace = P + Math.max(0, Lm - P) * (k / K);
    return { spent: r2(S), pace: r2(pace), gap: r2(S - pace) };
  }
  /** Budget days needed to pay back `debt` within `days`, when a day may give at most `cap` (budget minus minimum). */
  function catchupDays(debt, days, cap) {
    debt = num(debt); days = Math.max(1, parseInt(days, 10) || 1);
    if (debt <= 0) return 0;
    if (!(cap > 0.004)) return Infinity;
    return debt / days <= cap + 1e-9 ? days : Math.ceil(debt / cap - 1e-9);
  }
  /** The date after stepping n budget days (holidays skipped), counting `from` as the first. */
  function addBudgetDays(from, n, isHoliday) {
    isHoliday = isHoliday || (() => false);
    let d = from, left = n;
    for (let g = 0; g < 4000; g++) { if (!isHoliday(d)) { left--; if (left <= 0) return d; } d = addDays(d, 1); }
    return d;
  }
  /** A usual day's budget: this pay month's money without rent/utilities and reserve payments, per budget day. */
  function typicalDaily(ledger) {
    const per = ledger.current; if (!per) return 0;
    const n = Math.max(1, budgetDaysBetween(per.start, per.end, ledger.isHoliday || (() => false)));
    return Math.max(0, r2((per.effective - (per.fixed || 0) - (per.paidRes || 0)) / n));
  }
  /**
   * How much of the debt a day gives back. Two ways to set it up:
   *  - a timeframe (cfg.days): the debt left, spread over the budget days left in it;
   *  - a daily budget (cfg.budget): everything above that budget.
   * Either way a day's limit never goes under the minimum (cfg.min); then it just takes longer.
   */
  function catchupTake(cfg, isHol) {
    isHol = isHol || (() => false);
    const min = Math.max(0, num(cfg.min)), byBudget = num(cfg.budget) > 0;
    const floor = byBudget ? Math.max(min, num(cfg.budget)) : min;
    const end = addDays(cfg.start, Math.max(1, parseInt(cfg.days, 10) || 1) - 1);
    return (date, raw, debt, holiday) => {
      if (holiday || debt <= 0.004) return 0;
      const rem = byBudget ? 1 : date <= end ? Math.max(1, budgetDaysBetween(date, end, isHol)) : 1;
      return r2(Math.max(0, Math.min(debt / rem, raw - floor, debt)));
    };
  }
  /**
   * Day-by-day forecast from `from`: `avail` = this pay month's money left that morning, every day spent right up
   * to its lowered limit. What a day gives back stays in the month, so the normal budget creeps up meanwhile.
   * Later pay months use a usual day's budget.
   * Returns { date: last catch-up day, days: counted from `countFrom`, after: the daily budget once it's done },
   * or null when it can never be paid back (the minimum or budget is above what a usual day has).
   */
  function catchupForecast(ledger, take, debt, from, avail, countFrom) {
    const isHol = ledger.isHoliday || (() => false);
    const perEnd = ledger.current ? ledger.current.end : from, typ = typicalDaily(ledger);
    let dd = num(debt), a = num(avail), d = from;
    const afterOn = (day) => (day <= perEnd ? r2(Math.max(0, a) / Math.max(1, budgetDaysBetween(day, perEnd, isHol))) : typ);
    if (dd <= 0.004) return { date: null, days: 0, after: afterOn(from) };
    for (let g = 0; g < 3000; g++, d = addDays(d, 1)) {
      if (isHol(d)) continue;
      const inMonth = d <= perEnd;
      const raw = inMonth ? Math.max(0, a) / Math.max(1, budgetDaysBetween(d, perEnd, isHol)) : typ;
      const t = take(d, raw, dd, false);
      if (t <= 0.004 && !inMonth) return null;
      if (inMonth) a -= raw - t;
      dd = r2(dd - t);
      if (dd <= 0.004) return { date: d, days: diffDays(countFrom, d) + 1, after: afterOn(addDays(d, 1)) };
    }
    return null;
  }
  /**
   * Catch-up: each budget day from cfg.start gives part of the debt back by lowering that day's limit
   * (see catchupTake). After every day: debt += spent - normal budget, so spending under the normal budget pays it
   * back and going over adds to it. Today counts live: going over today's limit adds to what's missing right
   * away, and the forecast is redone from there. Ends when the debt is 0.
   */
  function catchupPlan(ledger, cfg, today) {
    if (!cfg || !cfg.on || !cfg.start || !(num(cfg.debt) > 0) || !ledger.current) return null;
    const isHol = ledger.isHoliday || (() => false);
    const take = catchupTake(cfg, isHol);
    let debt = num(cfg.debt);
    const byDay = {};
    let todayRow = null;
    for (const d of daysInRange(ledger, cfg.start, today, today)) {
      const tk = take(d.date, d.allow, debt, d.holiday);
      const row = { raw: d.allow, take: tk, limit: r2(d.allow - tk), debtBefore: r2(debt), spent: d.spent, holiday: d.holiday, avail: d.pool !== undefined ? d.pool - d.before : d.allow };
      byDay[d.date] = row;
      if (d.date === today) { todayRow = row; break; }
      debt = r2(debt + d.spent - d.allow);
      if (debt <= 0.004) { debt = 0; break; }
    }
    // live: today as if its limit gets used in full (or what was really spent, if more)
    let missing = debt, forecast = null;
    const t = todayRow;
    if (t && debt > 0.004) {
      const used = t.holiday ? t.spent : Math.max(t.spent, t.limit);
      missing = r2(Math.max(0, debt + used - t.raw));
      const availNext = t.avail - used;
      forecast = missing <= 0.004
        ? { date: today, days: 1, after: catchupForecast(ledger, take, 0, addDays(today, 1), availNext, today).after }
        : catchupForecast(ledger, take, missing, addDays(today, 1), availNext, today);
    }
    const done = debt <= 0.004;
    const nextLimit = (nextDate, nextRaw) => {
      if (!nextDate || done || !t) return nextRaw;
      return r2(nextRaw - take(nextDate, nextRaw, missing, isHol(nextDate)));
    };
    return { byDay, today: t, debt: r2(debt), missing: r2(missing), done, eta: forecast && forecast.date, etaDays: forecast ? forecast.days : null, after: forecast ? forecast.after : null, nextLimit, take };
  }

  /** Amount to store so that what's left to spend this period becomes `target`. */
  function rebalanceDelta(ledger, target) {
    const per = ledger.current;
    if (!per) return 0;
    return r2(num(target) - (per.effective - per.spent));
  }

  /**
   * Payday-to-payday window for the pay month that contains `date`. When that month's salary or advance
   * was paid early (before pay day), the window starts on the day it was paid and still runs to the next
   * month's pay day.
   */
  function payRange(state, date) {
    const payDay = state.settings.payDay || 1;
    const p = periodFor(date, payDay);
    let from = p.start;
    for (const it of state.incomes || []) {
      if (it.ignored || it.date >= p.start) continue;
      const k = incomeKind(it);
      const early = k === 'salary' ? budgetDateOf(it, payDay) === p.start : k === 'advance' && diffDays(it.date, p.start) <= EARLY_ADVANCE_DAYS;
      if (early && it.date < from) from = it.date;
    }
    return { from, start: p.start, end: p.end, next: p.next };
  }

  /** Months that ended at least `graceDays` ago (late bank bookings get a few days) and aren't locked yet. */
  function monthsToLock(ledger, today, graceDays) {
    const g = graceDays === undefined ? 3 : graceDays;
    return ledger.periods.filter((p) => !p.isCurrent && !p.locked && diffDays(p.end, today) >= g).map((p) => {
      const days = dailySeries(p, ledger.spentByDay, p.end, ledger.adjByDay, ledger.statsFrom, ledger.isHoliday, ledger.fixedByDay, ledger.more);
      const per = Object.assign({}, p); delete per.days; delete per.isCurrent; delete per.locked;
      const it = ledger.items || { exp: [], inc: [] };
      const ids = { e: it.exp.filter((e) => e.date >= p.start && e.date <= p.end).map((e) => e.id), i: it.inc.filter((i) => i.bdate >= p.start && i.bdate <= p.end).map((i) => i.id) };
      return { start: p.start, end: p.end, lockedAt: today, per, days, ids };
    });
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

  /**
   * Spending per shop in [from, to]. Payments of the same shop are grouped (keyFn, e.g. the brand, so
   * "DUS Bullu" and "DUS BULLU" are one). "Other" as a whole is under 1% of the total; every other
   * shop gets its own slice.
   */
  function topPlaces(expenses, from, to, aliases, minShare, keyFn) {
    aliases = aliases || {};
    minShare = typeof minShare === 'number' && minShare < 1 ? minShare : 0.01;
    const norm = (x) => String(x || '').toUpperCase().replace(/\s+/g, ' ').trim();
    keyFn = keyFn || norm;
    const groups = {};
    for (const e of expenses) {
      if (e.ignored || e.date < from || e.date > to) continue;
      const raw = String(e.place || 'Unknown').trim();
      const named = aliases[raw] || raw;
      const key = aliases[raw] ? 'A:' + named : keyFn(named) || norm(named);
      const g = groups[key] || (groups[key] = { total: 0, names: {} });
      g.total += num(e.amount);
      g.names[named] = (g.names[named] || 0) + 1;
    }
    const arr = Object.values(groups).map((g) => ({ name: Object.entries(g.names).sort((a, b) => b[1] - a[1])[0][0], total: r2(g.total) })).sort((a, b) => b.total - a.total);
    const total = arr.reduce((t, x) => t + x.total, 0);
    if (!total) return arr;
    // "Other" takes the smallest shops only while all of them together stay under 1% of the total.
    let cut = arr.length, acc = 0;
    while (cut > 0 && (acc + arr[cut - 1].total) / total < minShare) { acc += arr[cut - 1].total; cut--; }
    const small = arr.slice(cut);
    if (small.length < 2) return arr;
    return arr.slice(0, cut).concat([{ name: 'Other', total: r2(acc), other: true, count: small.length }]);
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
    return { bankId: txId(tx), dir: dir === 'DBIT' ? 'out' : 'in', amount: r2(amount), date, place, note: remit.slice(0, 140), pending: tx.status === 'PDNG', pendingRef: tx.pending_ref || null };
  }

  function matchesIgnore(m, rules) {
    const list = String(rules || '').split(/[,\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return false;
    const hay = (m.place + ' ' + m.note).toLowerCase();
    return list.some((k) => hay.includes(k));
  }

  // ---------- Live payments (phone notifications, e.g. Google Wallet) ----------
  const AMOUNT_RE = /(?:(?<![A-Za-z0-9.])(€|EUR)\s?(\d{1,3}(?:[   .,]\d{3})*(?:[.,]\d{1,2})?)(?![0-9]))|(?:(?<![A-Za-z0-9.,])(\d{1,3}(?:[   .,]\d{3})*(?:[.,]\d{1,2})?)\s?(€|EUR)(?![A-Za-z]))/i;
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
    const m = text.match(AMOUNT_RE) || title.match(AMOUNT_RE); // the amount line is the reliable one
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

  /**
   * Merge one sync's bank transactions into the data. Mutates data.expenses / data.incomes / data.ignoredBankIds.
   * withPending (Plaid): pending card payments are shown at once (tagged pending); when the bank finalises one,
   * the final transaction points back to it (pendingRef) and the same entry is updated instead of duplicated.
   * Pending entries the bank dropped (declined, expired) are removed, unless you edited them.
   */
  function applyBankTransactions(data, mapped, o) {
    const res = { added: 0, addedIn: 0, matched: 0, updated: 0, removed: 0 };
    const ignored = new Set(data.ignoredBankIds);
    const byBankId = new Map();
    for (const e of data.expenses) if (e.bankId) byBankId.set(e.bankId, e);
    for (const e of data.incomes) if (e.bankId) byBankId.set(e.bankId, e);
    const seenPending = new Set();
    // posted ones first, so a payment that is already final never gets added as pending
    const list = mapped.slice().sort((a, b) => (a.pending ? 1 : 0) - (b.pending ? 1 : 0));
    const finalisedRefs = new Set(list.filter((m) => !m.pending && m.pendingRef).map((m) => m.pendingRef));
    for (const m of list) {
      const early = m.dir === 'in' && o.earlyFrom && m.date >= o.earlyFrom && textKind({ source: m.place, note: m.note });
      if (!m.date || (m.date < o.start && !early)) continue;
      if (m.pending && (!o.withPending || m.dir !== 'out')) continue;
      if (m.pending) {
        seenPending.add(m.bankId);
        if (finalisedRefs.has(m.bankId) || ignored.has(m.bankId)) continue;
        const ex = byBankId.get(m.bankId);
        if (ex) { if (!ex.edited && (ex.amount !== m.amount || ex.date !== m.date)) { ex.amount = m.amount; ex.date = m.date; res.updated++; } continue; }
      } else {
        if (ignored.has(m.bankId) || byBankId.has(m.bankId)) continue;
        if (m.pendingRef && ignored.has(m.pendingRef)) { data.ignoredBankIds.push(m.bankId); ignored.add(m.bankId); continue; }
        const was = m.pendingRef && byBankId.get(m.pendingRef);
        if (was) { // the pending payment became final
          byBankId.delete(m.pendingRef); byBankId.set(m.bankId, was);
          was.bankId = m.bankId; delete was.pending;
          if (!was.edited) { was.amount = m.amount; was.date = m.date; }
          res.updated++; continue;
        }
      }
      if (matchesIgnore(m, o.ignore)) { continue; }
      if (m.dir === 'out') {
        const dup = findDuplicateForBank(data.expenses, m);
        if (dup) { dup.bankId = m.bankId; dup.bankPlace = m.place; byBankId.set(m.bankId, dup); res.matched++; continue; }
        const rec = { id: o.newId(), date: m.date, amount: m.amount, place: m.place, note: m.note, bankId: m.bankId };
        if (m.pending) rec.pending = true;
        data.expenses.push(rec); byBankId.set(m.bankId, rec); res.added++;
      } else if (o.importIncome) {
        const dupIn = findDuplicateForBank(data.incomes, m);
        if (dupIn) { dupIn.bankId = m.bankId; byBankId.set(m.bankId, dupIn); res.matched++; continue; }
        const rec = { id: o.newId(), date: m.date, amount: m.amount, source: m.place, note: m.note, bankId: m.bankId };
        if (o.kindOf) rec.kind = o.kindOf(rec);
        data.incomes.push(rec); byBankId.set(m.bankId, rec); res.addedIn++;
      }
    }
    if (o.withPending) {
      const before = data.expenses.length;
      data.expenses = data.expenses.filter((e) => !(e.pending && !e.edited && e.bankId && e.date >= o.from && !seenPending.has(e.bankId)));
      res.removed = before - data.expenses.length;
    }
    return res;
  }

  const api = {
    TAX2026, salaryNet, r2, num,
    pad, ymd, parse, addDays, diffDays, daysInMonth, todayStr, periodFor,
    incomeKind, textKind, budgetDateOf, payRange, reserveStatus, overUnder, paceGap, catchupDays, addBudgetDays, catchupPlan, catchupTake, catchupForecast, typicalDaily, releaseDateOf, createdAt, monthsToLock, sumByDay, sumRange, buildLedger, isWeekend, makeHolidayCheck, budgetDaysBetween, dailySeries, todayStatus, daysInRange, overUnderStats, rebalanceDelta, projectGoal,
    cleanPlace, topPlaces, txId, mapTransaction, matchesIgnore, parseAmount, parsePaymentNotification, findDuplicateForBank, findDuplicateForLive, applyBankTransactions
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
