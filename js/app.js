/* Budžets: UI layer. All data stays on the phone (localStorage); export a backup from Settings. */
(function () {
  'use strict';
  const L = window.BudgetLogic;
  const STORE_KEY = 'budget.v1';
  const DATA_VERSION = 1;

  // ---------------- state ----------------
  const defaults = () => ({
    v: DATA_VERSION,
    settings: {
      payDay: 10, monthlySaving: 500, goal: 20000, startingSaved: 0, openingCarry: 0, startDate: null,
      useExpected: true, expectedNet: 0, statsFrom: null,
      salary: { gross: 0, taxBook: true, dependents: 0, disability: 'none' },
      bank: { workerUrl: '', token: '', bankName: 'SEB', country: 'LV', sessionId: '', accounts: [], validUntil: '', lastSync: '', importIncome: true, ignore: '', pendingState: '' },
      aliases: {}
    },
    expenses: [], incomes: [], adjustments: [], ignoredBankIds: []
  });

  function deepMerge(base, extra) {
    for (const k in extra) {
      if (extra[k] && typeof extra[k] === 'object' && !Array.isArray(extra[k]) && base[k] && typeof base[k] === 'object') deepMerge(base[k], extra[k]);
      else base[k] = extra[k];
    }
    return base;
  }
  function migrate(s) {
    // Future schema changes go here, keyed on s.v. Old data is always merged over current defaults.
    const out = deepMerge(defaults(), s || {});
    // v1.3: give every income a kind (salary / advance / other) so advances don't cancel the expected salary
    (out.incomes || []).forEach((i) => { if (!i.kind) i.kind = guessKind(i, out.settings); });
    // v1.2: statistics ignore days before 6 Oct 2026 (or the budget start date, whichever is later)
    if (!out.settings.statsFrom && out.settings.startDate) out.settings.statsFrom = out.settings.startDate > '2026-10-06' ? out.settings.startDate : '2026-10-06';
    out.v = DATA_VERSION;
    return out;
  }
  function guessKind(i, settings) {
    const k = L.incomeKind(i);
    if (k !== 'other') return k;
    // bank imports: a large incoming payment is almost certainly the salary
    const exp = L.num(settings.expectedNet);
    return i.bankId && exp > 0 && L.num(i.amount) >= exp * 0.5 ? 'salary' : 'other';
  }

  function load() {
    try { const raw = localStorage.getItem(STORE_KEY); return migrate(raw ? JSON.parse(raw) : null); }
    catch (e) { console.error(e); return defaults(); }
  }
  let state = load();
  function save() { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }

  const ui = { tab: 'today', statsMode: 'month', statsOffset: 0, calOffset: 0, charts: {} };
  let ledger, today;

  // ---------------- helpers ----------------
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const fmtEUR = new Intl.NumberFormat('lv-LV', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtEUR0 = new Intl.NumberFormat('lv-LV', { maximumFractionDigits: 0 });
  const money = (x) => fmtEUR.format(L.r2(x || 0) || 0);
  const signed = (x) => (x > 0 ? '+' : '') + money(x);
  const pct = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dShort = (s) => { const d = L.parse(s); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]; };
  const dLong = (s) => { const d = L.parse(s); return d.getUTCDate() + ' ' + MONTHS_LONG[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms || 2600);
  }

  // ---------------- core render ----------------
  function recompute() {
    today = L.todayStr();
    ledger = L.buildLedger(state, today);
  }

  function render() {
    recompute();
    const titles = { today: 'Today', calendar: 'Calendar', money: 'Income', stats: 'Statistics', goal: 'Savings goal' };
    $('#viewTitle').textContent = titles[ui.tab];
    const per = ledger.current;
    $('#periodLabel').textContent = per ? `${dShort(per.start)} to ${dShort(per.end)}` : 'Budget';
    $('#syncBtn').hidden = !(state.settings.bank.workerUrl && state.settings.bank.sessionId);
    $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + ui.tab));
    $$('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
    Object.values(ui.charts).forEach((c) => c.destroy()); ui.charts = {};
    ({ today: renderToday, calendar: renderCalendar, money: renderMoney, stats: renderStats, goal: renderGoal })[ui.tab]();
  }

  function needsSetup() { return !state.settings.startDate; }

  // ---------------- TODAY ----------------
  function itemRow(e, kind) {
    const initial = esc((e.place || e.source || '?').trim().charAt(0).toUpperCase());
    const title = kind === 'income' ? (e.source || 'Income') : (e.place || 'Expense');
    return `<div class="item" data-kind="${kind}" data-id="${e.id}">
      <div class="dot">${initial}</div>
      <div class="meta"><div class="title">${esc(title)}${kind === 'income' && (e.kind || L.incomeKind(e)) === 'advance' && !/advance/i.test(title) ? '<span class="tag">advance</span>' : ''}${e.bankId ? '<span class="tag">SEB</span>' : ''}</div>
      <div class="sub">${dShort(e.date)}${e.note ? ' · ' + esc(e.note) : ''}</div></div>
      <div class="amt num ${kind === 'income' ? 'good' : ''}">${kind === 'income' ? '+' : '-'}${money(e.amount)}</div></div>`;
  }

  function bindItems(root) {
    $$('.item[data-id]', root).forEach((el) => el.addEventListener('click', () => {
      const list = el.dataset.kind === 'income' ? state.incomes : state.expenses;
      const it = list.find((x) => x.id === el.dataset.id);
      if (it) (el.dataset.kind === 'income' ? openIncome : openExpense)(it);
    }));
  }

  function renderToday() {
    const v = $('#view-today');
    if (needsSetup()) {
      v.innerHTML = `<div class="card hero"><div class="caption">Welcome</div><div class="big" style="font-size:40px">Let's set up your budget</div>
        <p class="muted">Pay day, salary and savings goal. Takes 30 seconds.</p><button class="btn primary block" id="setupGo">Start</button></div>`;
      $('#setupGo').onclick = openOnboarding;
      return;
    }
    const ts = L.todayStatus(ledger, today);
    const per = ts.period;
    const over = ts.leftToday < 0;
    const spentPct = per.effective > 0 ? Math.min(1, per.spent / per.effective) : 1;
    const totalDays = L.diffDays(per.start, per.end) + 1;
    const pacePct = (L.diffDays(per.start, today) + 1) / totalDays;
    const todays = state.expenses.filter((e) => e.date === today);
    const recent = state.expenses.filter((e) => e.date !== today).sort((a, b) => (b.date + b.id).localeCompare(a.date + a.id)).slice(0, 6);
    const bank = state.settings.bank;
    const consentDays = bank.validUntil ? L.diffDays(today, bank.validUntil.slice(0, 10)) : null;
    const rebals = (state.adjustments || []).filter((a) => a.date >= per.start && a.date <= per.end).sort((a, b) => b.date.localeCompare(a.date));

    v.innerHTML = `
      ${per.incomeExpected ? `<div class="banner">${per.advance > 0 ? `Advance ${money(per.advance)} received. Still expecting ${money(per.salaryToCome)} of salary.` : `Using expected salary ${money(per.salaryToCome)} until you log this month's salary.`}</div>` : ''}
      ${per.income === 0 ? `<div class="banner bad">No income logged for this period yet. Add it in Income.</div>` : ''}
      ${consentDays !== null && consentDays <= 7 ? `<div class="banner bad">SEB connection expires in ${Math.max(0, consentDays)} days. Reconnect in Settings.</div>` : ''}
      <div class="card hero ${over ? 'over' : ''}">
        <div class="caption">${over ? 'Over today\'s budget by' : 'You can spend today'}</div>
        <div class="big num ${over ? 'bad' : ''}">${fmtEUR0.format(Math.floor(Math.abs(ts.leftToday)))}<span class="cur">,${String(Math.round((Math.abs(ts.leftToday) - Math.floor(Math.abs(ts.leftToday))) * 100)).padStart(2, '0')} €</span></div>
        <div class="chips">
          <span class="chip">Daily budget <b class="num">${money(ts.dailyAllowance)}</b></span>
          <span class="chip">Spent today <b class="num">${money(ts.spentToday)}</b></span>
        </div>
        ${ts.tomorrow !== null ? `<div class="tomorrow ${ts.tomorrow >= ts.dailyAllowance ? 'up' : 'down'}">
          <span>Tomorrow you'll have</span><b class="num">${money(ts.tomorrow)}</b>
          <span class="trend">${ts.tomorrow >= ts.dailyAllowance ? '▲' : '▼'} ${money(Math.abs(ts.tomorrow - ts.dailyAllowance))}</span></div>` : ''}
      </div>

      <div class="quick">
        <button class="btn primary" id="qExp">+ Expense</button>
        <button class="btn" id="qInc">+ Income</button>
      </div>

      <div class="card">
        <h2>This month</h2>
        <div class="row"><span class="label">Left of monthly allowance</span><b class="num ${ts.remainingMonth < 0 ? 'bad' : ''}">${money(ts.remainingMonth)}</b></div>
        <div style="margin:10px 0 6px" class="bar"><i class="${spentPct >= 1 ? 'bad' : ''}" style="width:${(spentPct * 100).toFixed(1)}%"></i><span class="pace" style="left:${(pacePct * 100).toFixed(1)}%"></span></div>
        <div class="small muted" style="display:flex;justify-content:space-between"><span>Spent ${money(per.spent)} of ${money(per.effective)}</span><span>${ts.daysLeft} day${ts.daysLeft === 1 ? '' : 's'} left</span></div>
      </div>

      <div class="card">
        <h2>Monthly allowance</h2>
        <div class="row"><span class="label">Income (net)${per.incomeExpected ? ' <span class="tag">expected</span>' : ''}</span><span class="num">${money(per.income)}</span></div>
        ${per.advance > 0 ? `<div class="row"><span class="label small">of which advance received${per.incomeExpected ? ', ' + money(per.salaryToCome) + ' still to come' : ''}</span><span class="num small muted">${money(per.advance)}</span></div>` : ''}
        <div class="row"><span class="label">Savings</span><span class="num">-${money(per.saving)}</span></div>
        ${per.carryIn ? `<div class="row"><span class="label">${per.carryIn < 0 ? 'Overspend from last month' : 'Rollover from last month'}</span><span class="num ${per.carryIn < 0 ? 'bad' : 'good'}">${signed(per.carryIn)}</span></div>` : ''}
        ${per.adjust ? `<div class="row"><span class="label">Rebalance</span><span class="num">${signed(per.adjust)}</span></div>` : ''}
        <div class="row total"><span>Allowance</span><span class="num">${money(per.effective)}</span></div>
      </div>

      <details class="card" id="rebalCard">
        <summary><h2>Rebalance</h2><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></summary>
        <p class="small muted" style="margin-top:0">Set how much you really have left to spend until pay day (${dShort(per.next)}). Fixes differences with your bank. It is not counted as spending or income and doesn't show in statistics.</p>
        <div class="field"><label>Actually left to spend, €</label><input id="rbAmt" class="amount-input num" inputmode="decimal" placeholder="${fmtEUR0.format(Math.round(ts.remainingMonth))}"><div class="hint">The app currently thinks: ${money(ts.remainingMonth)}</div></div>
        <button class="btn primary block" id="rbSet">Set balance</button>
        ${rebals.length ? `<div class="list" style="margin-top:12px">${rebals.map((a) => `<div class="row"><span class="label">${dShort(a.date)} · set to ${money(a.target)}</span><span><span class="num">${signed(a.amount)}</span> <button class="btn ghost small rb-undo" data-id="${a.id}" style="padding:4px 10px;margin-left:6px">Undo</button></span></div>`).join('')}</div>` : ''}
      </details>

      <div class="card">
        <h2>Today</h2>
        <div class="list">${todays.length ? todays.map((e) => itemRow(e, 'expense')).join('') : '<div class="empty">Nothing spent today</div>'}</div>
      </div>
      ${recent.length ? `<div class="card"><h2>Recent</h2><div class="list">${recent.map((e) => itemRow(e, 'expense')).join('')}</div></div>` : ''}
    `;
    $('#qExp').onclick = () => openExpense(null);
    $('#qInc').onclick = () => openIncome(null);
    $('#rbSet').onclick = () => {
      const raw = $('#rbAmt').value.trim();
      if (raw === '') return toast('Enter how much you have left');
      const target = L.num(raw);
      const delta = L.rebalanceDelta(ledger, target);
      if (Math.abs(delta) < 0.005) return toast('Already matches');
      state.adjustments.push({ id: uid(), date: today, amount: delta, target: L.r2(target) });
      save(); render(); toast('Balance set to ' + money(target));
    };
    $$('.rb-undo', v).forEach((b) => (b.onclick = () => {
      state.adjustments = state.adjustments.filter((a) => a.id !== b.dataset.id); save(); render(); toast('Rebalance removed');
    }));
    bindItems(v);
  }

  // ---------------- CALENDAR ----------------
  function renderCalendar() {
    const v = $('#view-calendar');
    const base = L.parse(today);
    let y = base.getUTCFullYear(), m = base.getUTCMonth() + ui.calOffset;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    const first = `${y}-${L.pad(m + 1)}-01`;
    const last = `${y}-${L.pad(m + 1)}-${L.pad(L.daysInMonth(y, m))}`;
    const days = Object.fromEntries(L.daysInRange(ledger, first, last, today).map((d) => [d.date, d]));
    const startDow = (L.parse(first).getUTCDay() + 6) % 7; // Monday first
    let cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => `<div class="dow">${d}</div>`).join('');
    for (let i = 0; i < startDow; i++) cells += '<div></div>';
    let monthSpent = 0;
    const payDay = Math.min(state.settings.payDay, L.daysInMonth(y, m));
    for (let d = 1; d <= L.daysInMonth(y, m); d++) {
      const ds = `${y}-${L.pad(m + 1)}-${L.pad(d)}`;
      const sp = ledger.spentByDay[ds] || 0;
      monthSpent += sp;
      const info = days[ds];
      let cls = 'day';
      if (ds === today) cls += ' today';
      if (info && ds <= today) cls += info.diff > 0.005 ? ' over' : ' under';
      if (d === payDay) cls += ' payday';
      cells += `<div class="${cls}" data-date="${ds}"><span class="d">${d}</span><span class="s num">${sp ? fmtEUR0.format(Math.round(sp)) : ''}</span></div>`;
    }
    const inc = L.sumRange(ledger.incomeByDay, first, last);
    v.innerHTML = `
      <div class="navrow"><button class="icon-btn" id="calPrev"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="lbl">${MONTHS_LONG[m]} ${y}</span>
        <button class="icon-btn" id="calNext"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button></div>
      <div class="card"><div class="cal">${cells}</div>
        <div class="legend" style="margin-top:12px"><span><i style="background:#17291f"></i>Under daily budget</span><span><i style="background:#331a18"></i>Over</span><span><span style="color:var(--accent)">€</span> Pay day</span></div></div>
      <div class="stat-grid">
        <div class="stat"><div class="k">Spent in ${MONTHS[m]}</div><div class="v num">${money(monthSpent)}</div></div>
        <div class="stat"><div class="k">Income in ${MONTHS[m]}</div><div class="v num good">${money(inc)}</div></div>
      </div>
      <p class="small muted" style="text-align:center">Tap a day to see or add expenses.</p>`;
    $('#calPrev').onclick = () => { ui.calOffset--; render(); };
    $('#calNext').onclick = () => { ui.calOffset++; render(); };
    $$('.cal .day', v).forEach((el) => el.addEventListener('click', () => openDay(el.dataset.date)));
  }

  function openDay(date) {
    const ex = state.expenses.filter((e) => e.date === date);
    const inc = state.incomes.filter((e) => e.date === date);
    const info = L.daysInRange(ledger, date, date, today)[0];
    openSheet(`<h3>${dLong(date)}</h3>
      ${info ? `<div class="chips" style="margin-bottom:12px"><span class="chip">Daily budget <b class="num">${money(info.allow)}</b></span>
        <span class="chip">Spent <b class="num">${money(info.spent)}</b></span>
        <span class="chip ${info.diff > 0 ? 'bad' : 'good'}"><b class="num">${info.diff > 0 ? 'Over ' : 'Under '}${money(Math.abs(info.diff))}</b></span></div>` : ''}
      <div class="list">${ex.map((e) => itemRow(e, 'expense')).join('')}${inc.map((e) => itemRow(e, 'income')).join('')}${!ex.length && !inc.length ? '<div class="empty">No entries</div>' : ''}</div>
      <div class="actions"><button class="btn primary" id="dayAdd">+ Expense</button><button class="btn" id="dayInc">+ Income</button></div>`, (body) => {
      bindItems(body);
      $('#dayAdd', body).onclick = () => openExpense(null, date);
      $('#dayInc', body).onclick = () => openIncome(null, date);
    });
  }

  // ---------------- INCOME / SALARY ----------------
  function renderMoney() {
    const v = $('#view-money');
    const sal = state.settings.salary;
    const per = ledger.current;
    const list = state.incomes.slice().sort((a, b) => b.date.localeCompare(a.date));
    v.innerHTML = `
      <details class="card" id="calcCard" ${sal.gross ? '' : 'open'}>
        <summary><h2>Salary calculator 2026</h2><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></summary>
        <div class="field"><label>Gross monthly salary (bruto), €</label><input id="sGross" class="num" inputmode="decimal" value="${sal.gross || ''}" placeholder="e.g. 2000"></div>
        <div class="toggle"><span>Tax book submitted (algas nodokļa grāmatiņa)</span><input type="checkbox" id="sBook" ${sal.taxBook ? 'checked' : ''}></div>
        <div class="field-row">
          <div class="field"><label>Dependents</label><input id="sDeps" inputmode="numeric" value="${sal.dependents || 0}"></div>
          <div class="field"><label>Disability group</label><select id="sDis">
            <option value="none" ${sal.disability === 'none' ? 'selected' : ''}>None</option>
            <option value="I-II" ${sal.disability === 'I-II' ? 'selected' : ''}>I or II</option>
            <option value="III" ${sal.disability === 'III' ? 'selected' : ''}>III</option></select></div>
        </div>
        <div id="calcOut"></div>
        <div class="actions" style="margin-top:12px"><button class="btn" id="sExpected">Use as expected income</button><button class="btn primary" id="sLog">Log as income today</button></div>
      </details>

      <div class="card">
        <h2>Add money received</h2>
        <div class="field"><label>Amount (net, what arrived), €</label><input id="iAmt" class="amount-input num" inputmode="decimal" placeholder="0,00"></div>
        <div class="field-row">
          <div class="field"><label>Source</label><select id="iSrc">${[['Salary', 'Salary (full / final)'], ['Advance', 'Salary advance (avanss)'], ['Bonus', 'Bonus'], ['Side job', 'Side job'], ['Gift', 'Gift'], ['Refund', 'Refund'], ['Other', 'Other']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input id="iDate" type="date" value="${today}"></div>
        </div>
        <button class="btn primary block" id="iAdd">Add income</button>
      </div>

      <div class="card">
        <h2>Expected salary</h2>
        <div class="toggle"><span>Use expected net salary when a month has no logged income</span><input type="checkbox" id="useExp" ${state.settings.useExpected ? 'checked' : ''}></div>
        <div class="field"><label>Expected net per month, €</label><input id="expNet" class="num" inputmode="decimal" value="${state.settings.expectedNet || ''}"></div>
        ${per ? `<div class="small muted">This period (${dShort(per.start)} to ${dShort(per.end)}): ${money(L.sumRange(ledger.incomeByDay, per.start, per.end))} logged.</div>` : ''}
      </div>

      <div class="card"><h2>Income history</h2><div class="list">${list.length ? list.slice(0, 40).map((e) => itemRow(e, 'income')).join('') : '<div class="empty">No income logged yet</div>'}</div></div>`;

    const calc = () => {
      sal.gross = L.num($('#sGross').value); sal.taxBook = $('#sBook').checked;
      sal.dependents = parseInt($('#sDeps').value, 10) || 0; sal.disability = $('#sDis').value; save();
      const r = L.salaryNet(sal.gross, sal);
      $('#calcOut').innerHTML = `
        <div class="row"><span class="label">Social insurance 10.5%</span><span class="num">-${money(r.vsaoi)}</span></div>
        <div class="row"><span class="label">Tax free (non-taxable min + reliefs)</span><span class="num">${money(r.relief)}</span></div>
        <div class="row"><span class="label">Income tax 25.5% on ${money(r.taxable)}</span><span class="num">-${money(r.iin)}</span></div>
        <div class="row total"><span>Net (neto)</span><span class="num good" style="font-size:20px">${money(r.net)}</span></div>
        ${r.annualExtra > 0 ? `<div class="row"><span class="label warn">Extra 7.5% on yearly income above 105 300 € (paid with annual declaration)</span><span class="num warn">-${money(r.annualExtra)}/yr</span></div>` : ''}
        <div class="small muted" style="margin-top:6px">Effective deduction ${(r.effectiveRate * 100).toFixed(1)}% · employer total cost ${money(r.employerCost)}</div>`;
      return r;
    };
    ['#sGross', '#sDeps'].forEach((s) => $(s).addEventListener('input', calc));
    ['#sBook', '#sDis'].forEach((s) => $(s).addEventListener('change', calc));
    calc();
    $('#sExpected').onclick = () => { state.settings.expectedNet = calc().net; state.settings.useExpected = true; save(); toast('Expected income set to ' + money(state.settings.expectedNet)); render(); };
    $('#sLog').onclick = () => { const r = calc(); if (!r.net) return; state.incomes.push({ id: uid(), date: today, amount: r.net, source: 'Salary', kind: 'salary', note: 'From calculator' }); save(); toast('Logged ' + money(r.net)); render(); };
    $('#iAdd').onclick = () => {
      const amt = L.num($('#iAmt').value); if (amt <= 0) return toast('Enter an amount');
      const src = $('#iSrc').value;
      const kind = src === 'Salary' ? 'salary' : src === 'Advance' ? 'advance' : 'other';
      state.incomes.push({ id: uid(), date: $('#iDate').value || today, amount: L.r2(amt), source: src, kind, note: '' }); save();
      toast(kind === 'advance' ? 'Advance added, salary expectation kept' : 'Income added'); render();
    };
    $('#useExp').onchange = (e) => { state.settings.useExpected = e.target.checked; save(); recompute(); };
    $('#expNet').onchange = (e) => { state.settings.expectedNet = L.num(e.target.value); save(); recompute(); };
    bindItems(v);
  }

  // ---------------- STATS ----------------
  function chartBase() {
    const grid = css('--line'), muted = css('--muted');
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { color: muted, boxWidth: 12, usePointStyle: true } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.parsed.y)}` } } },
      scales: {
        x: { grid: { display: false }, ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: muted, callback: (v) => fmtEUR0.format(v) + ' €' } }
      }
    };
  }

  // draw a dot on the most recent value so short ranges (even a single day) stay visible
  const lastDot = (ctx) => { const data = ctx.dataset.data; let last = -1; data.forEach((v, i) => { if (v !== null && v !== undefined) last = i; }); return ctx.dataIndex === last ? 4 : 0; };

  function renderStats() {
    const v = $('#view-stats');
    if (!ledger.current) { v.innerHTML = '<div class="empty">Finish setup to see statistics.</div>'; return; }
    let from, to, label, days, chart1;
    if (ui.statsMode === 'month') {
      const idx = Math.max(0, ledger.periods.length - 1 + ui.statsOffset);
      ui.statsOffset = idx - (ledger.periods.length - 1);
      const per = ledger.periods[idx];
      from = per.start; to = per.end; label = `${dShort(per.start)} to ${dShort(per.end)}`;
      days = L.daysInRange(ledger, from, to, today);
      // Only days from the statistics start count; the chart starts there.
      const startD = ledger.statsFrom > per.start ? ledger.statsFrom : per.start;
      const all = []; for (let d = startD; d <= to; d = L.addDays(d, 1)) all.push(d);
      const before0 = days.length ? days[0].before : 0;
      const limit = L.r2(per.effective - before0);
      const cum = {}; days.forEach((d) => (cum[d.date] = L.r2(d.cum - before0)));
      const n = all.length || 1;
      chart1 = {
        type: 'line',
        data: { labels: all.map(dShort), datasets: [
          { label: 'Spent (cumulative)', data: all.map((d) => (d <= today ? cum[d] ?? null : null)), borderColor: css('--accent'), backgroundColor: 'rgba(200,242,106,.12)', fill: true, tension: .25, pointRadius: lastDot, pointBackgroundColor: css('--accent'), borderWidth: 2.5 },
          { label: 'Monthly limit', data: all.map(() => limit), borderColor: css('--bad'), borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 },
          { label: 'Even pace', data: all.map((_, i) => L.r2(limit * (i + 1) / n)), borderColor: css('--muted'), borderDash: [2, 4], pointRadius: 0, borderWidth: 1 }
        ] }
      };
    } else {
      const y = L.parse(today).getUTCFullYear() + ui.statsOffset;
      from = `${y}-01-01`; to = `${y}-12-31`; label = String(y);
      days = L.daysInRange(ledger, from, to, today);
      const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
      const all = []; for (let d = from; d <= to; d = L.addDays(d, 1)) all.push(d);
      let cs = 0, cl = 0, lastPlan = 0;
      const spentSeries = [], limitSeries = [];
      for (const d of all) {
        const p = ledger.periods.find((pp) => d >= pp.start && d <= pp.end);
        const counted = p && d >= ledger.statsFrom;
        if (byDate[d]) { lastPlan = byDate[d].plan || 0; cl += lastPlan; cs += byDate[d].spent; }
        else if (counted && d > today) cl += lastPlan; // rest of the current month at its planned pace
        spentSeries.push(counted && d <= today ? L.r2(cs) : null);
        limitSeries.push(counted ? L.r2(cl) : null);
      }
      chart1 = {
        type: 'line',
        data: { labels: all.map(dShort), datasets: [
          { label: 'Spent (cumulative)', data: spentSeries, borderColor: css('--accent'), backgroundColor: 'rgba(200,242,106,.12)', fill: true, tension: .2, pointRadius: lastDot, pointBackgroundColor: css('--accent'), borderWidth: 2.5 },
          { label: 'Allowance (cumulative)', data: limitSeries, borderColor: css('--bad'), borderDash: [6, 4], pointRadius: 0, borderWidth: 1.5 }
        ] }
      };
    }
    const st = L.overUnderStats(days.filter((d) => d.date <= today));
    const places = L.topPlaces(state.expenses, from > ledger.statsFrom ? from : ledger.statsFrom, to, state.settings.aliases, 8);
    const placeTotal = places.reduce((s, p) => s + p.total, 0);
    const palette = ['#c8f26a', '#5fd3a0', '#6ab8f2', '#b48cf2', '#f2a65f', '#f26a9a', '#f5c35b', '#7b8a84'];

    v.innerHTML = `
      <div class="seg"><button data-m="month" class="${ui.statsMode === 'month' ? 'on' : ''}">Month</button><button data-m="year" class="${ui.statsMode === 'year' ? 'on' : ''}">Year</button></div>
      <div class="navrow"><button class="icon-btn" id="stPrev"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="lbl">${label}</span>
        <button class="icon-btn" id="stNext" ${ui.statsOffset >= 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button></div>
      ${ledger.statsFrom > from ? `<div class="small muted" style="text-align:center">Statistics count from ${dLong(ledger.statsFrom)}</div>` : ''}
      <div class="card"><h2>Spending over time</h2><div class="chart-box"><canvas id="c1"></canvas></div></div>
      <div class="card"><h2>Where the money went</h2>
        ${places.length ? `<div class="chart-box pie"><canvas id="c2"></canvas></div>
        <div class="list" style="margin-top:10px">${places.map((p, i) => `<div class="row"><span><i style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${palette[i % 8]};margin-right:8px"></i>${esc(p.name)}</span><span class="num">${money(p.total)} <span class="muted small">${((p.total / placeTotal) * 100).toFixed(0)}%</span></span></div>`).join('')}</div>`
        : '<div class="empty">No expenses in this range</div>'}
      </div>
      <div class="card"><h2>Daily budget: over / under</h2>
        <div class="stat-grid" style="margin-bottom:12px">
          <div class="stat"><div class="k">Average per day</div><div class="v num ${st.avgDiff > 0 ? 'bad' : 'good'}">${st.avgDiff > 0 ? 'Over ' : 'Under '}${money(Math.abs(st.avgDiff))}</div></div>
          <div class="stat"><div class="k">Total vs budget</div><div class="v num ${st.pct > 0 ? 'bad' : 'good'}">${pct(st.pct)}</div></div>
          <div class="stat"><div class="k">Days over</div><div class="v num bad">${st.overDays}</div></div>
          <div class="stat"><div class="k">Days under</div><div class="v num good">${st.underDays}</div></div>
        </div>
        <div class="chart-box"><canvas id="c3"></canvas></div>
        <div class="small muted" style="margin-top:8px">Bars above zero = overspent that day's budget. Spent ${money(st.totalSpent)} vs planned ${money(st.totalAllow)} at even pace over ${st.days} days.</div>
      </div>`;

    $$('.seg button', v).forEach((b) => (b.onclick = () => { ui.statsMode = b.dataset.m; ui.statsOffset = 0; render(); }));
    $('#stPrev').onclick = () => { ui.statsOffset--; render(); };
    $('#stNext').onclick = () => { if (ui.statsOffset < 0) { ui.statsOffset++; render(); } };

    const base1 = chartBase();
    ui.charts.c1 = new Chart($('#c1'), Object.assign(chart1, { options: base1 }));

    if (places.length) {
      ui.charts.c2 = new Chart($('#c2'), {
        type: 'doughnut',
        data: { labels: places.map((p) => p.name), datasets: [{ data: places.map((p) => p.total), backgroundColor: palette, borderColor: css('--surface'), borderWidth: 3 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: false, cutout: '62%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.label}: ${money(c.parsed)}` } } } }
      });
    }

    let labels3, data3;
    if (ui.statsMode === 'month') {
      const d3 = days.filter((d) => d.date <= today);
      labels3 = d3.map((d) => dShort(d.date)); data3 = d3.map((d) => d.diff);
    } else {
      const byM = new Array(12).fill(null);
      days.filter((d) => d.date <= today).forEach((d) => { const mm = L.parse(d.date).getUTCMonth(); byM[mm] = L.r2((byM[mm] || 0) + d.diff); });
      labels3 = MONTHS; data3 = byM;
    }
    const o3 = chartBase(); o3.plugins.legend = { display: false };
    o3.plugins.tooltip = { callbacks: { label: (c) => (c.parsed.y > 0 ? 'Over ' : 'Under ') + money(Math.abs(c.parsed.y)) } };
    ui.charts.c3 = new Chart($('#c3'), {
      type: 'bar',
      data: { labels: labels3, datasets: [{ label: 'Difference', data: data3, backgroundColor: data3.map((x) => (x > 0 ? css('--bad') : css('--good'))), borderRadius: 4 }] },
      options: o3
    });
  }

  // ---------------- GOAL ----------------
  function renderGoal() {
    const v = $('#view-goal');
    const s = state.settings;
    if (needsSetup()) { v.innerHTML = '<div class="empty">Finish setup first.</div>'; return; }
    const g = L.projectGoal(ledger, s);
    const per = ledger.current;
    const hist = ledger.periods.slice().reverse();
    const reachTxt = g.reached ? 'Goal reached!' : g.never ? 'Set a monthly saving' : dLong(g.date);
    v.innerHTML = `
      <div class="card hero">
        <div class="caption">You'll reach ${money(g.goal)} on</div>
        <div class="goal-big">${reachTxt}</div>
        ${g.months ? `<div class="muted small" style="margin-bottom:12px">${g.months} more pay day${g.months === 1 ? '' : 's'} at ${money(s.monthlySaving)} per month</div>` : ''}
        <div class="bar" style="height:14px"><i style="width:${(g.pct * 100).toFixed(1)}%"></i></div>
        <div class="small" style="display:flex;justify-content:space-between;margin-top:8px"><span class="num"><b>${money(g.saved)}</b> saved</span><span class="num muted">${(g.pct * 100).toFixed(1)}% · ${money(g.remaining)} to go</span></div>
      </div>
      ${per ? `<div class="card"><h2>This month (live)</h2>
        <div class="row"><span class="label">Planned saving</span><span class="num">${money(s.monthlySaving)}</span></div>
        ${per.overspend > 0 ? `<div class="row"><span class="label">Overspend so far</span><span class="num bad">-${money(per.overspend)}</span></div>` : ''}
        <div class="row total"><span>Saved this month</span><span class="num ${per.saved < s.monthlySaving ? 'bad' : 'good'}">${money(per.saved)}</span></div>
        ${per.rolloverIn > 0 ? `<div class="small muted" style="margin-top:6px">If ${money(per.rolloverIn)} of last month's rollover is still unspent on ${dShort(per.next)}, it moves to savings.</div>` : ''}
      </div>` : ''}
      <div class="card"><h2>Goal settings</h2>
        <div class="field"><label>Savings goal, €</label><input id="gGoal" class="num" inputmode="decimal" value="${s.goal}"></div>
        <div class="field"><label>Save each month, €</label><input id="gMonthly" class="num" inputmode="decimal" value="${s.monthlySaving}"></div>
        <div class="field"><label>Already saved before starting, €</label><input id="gStart" class="num" inputmode="decimal" value="${s.startingSaved}"></div>
      </div>
      <div class="card"><h2>History</h2><div class="table-wrap"><table class="hist num">
        <tr><th>Period</th><th>Allowance</th><th>Spent</th><th>Carried</th><th>Saved</th></tr>
        ${hist.map((p) => `<tr><td>${dShort(p.start)}${p.isCurrent ? ' <span class="tag">now</span>' : ''}</td><td>${fmtEUR0.format(p.effective)}</td><td>${fmtEUR0.format(p.spent)}</td>
          <td class="${(p.carryOut ?? 0) < 0 ? 'bad' : (p.carryOut ?? 0) > 0 ? 'good' : ''}">${p.isCurrent ? '…' : fmtEUR0.format(p.carryOut)}</td><td>${fmtEUR0.format(p.saved)}</td></tr>`).join('')}
      </table></div></div>`;
    const bind = (id, key) => ($(id).onchange = (e) => { s[key] = L.num(e.target.value); save(); render(); });
    bind('#gGoal', 'goal'); bind('#gMonthly', 'monthlySaving'); bind('#gStart', 'startingSaved');
  }

  // ---------------- SHEETS ----------------
  function openSheet(html, onMount) {
    $('#sheetBody').innerHTML = html;
    $('#sheet').hidden = false; $('#sheetBackdrop').hidden = false;
    if (onMount) onMount($('#sheetBody'));
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheetBackdrop').hidden = true; $('#sheetBody').innerHTML = ''; }

  function recentPlaces() {
    const counts = {};
    state.expenses.slice(-200).forEach((e) => { if (e.place) counts[e.place] = (counts[e.place] || 0) + 1; });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
  }

  function openExpense(item, date) {
    const isNew = !item;
    const e = item || { date: date || today, amount: '', place: '', note: '' };
    openSheet(`<h3>${isNew ? 'New expense' : 'Edit expense'}${e.bankId ? '<span class="tag">from SEB</span>' : ''}</h3>
      <div class="field"><input id="eAmt" class="amount-input num" inputmode="decimal" placeholder="0,00" value="${e.amount || ''}"></div>
      <div class="field"><label>Where</label><input id="ePlace" list="placeList" value="${esc(e.place)}" placeholder="Rimi, Circle K, Wolt…">
        <datalist id="placeList">${recentPlaces().map((p) => `<option value="${esc(p)}">`).join('')}</datalist>
        <div class="place-suggest">${recentPlaces().slice(0, 6).map((p) => `<button type="button" data-p="${esc(p)}">${esc(p)}</button>`).join('')}</div></div>
      <div class="field-row">
        <div class="field"><label>Date</label><input id="eDate" type="date" value="${e.date}"></div>
        <div class="field"><label>Note</label><input id="eNote" value="${esc(e.note)}"></div>
      </div>
      <div class="actions">${isNew ? '' : '<button class="btn danger" id="eDel">Delete</button>'}<button class="btn primary" id="eSave">Save</button></div>`, (b) => {
      setTimeout(() => isNew && $('#eAmt', b).focus(), 50);
      $$('.place-suggest button', b).forEach((x) => (x.onclick = () => ($('#ePlace', b).value = x.dataset.p)));
      $('#eSave', b).onclick = () => {
        const amt = L.num($('#eAmt', b).value);
        if (amt <= 0) return toast('Enter an amount');
        const rec = Object.assign(item || { id: uid() }, { amount: L.r2(amt), place: $('#ePlace', b).value.trim() || 'Unknown', date: $('#eDate', b).value || today, note: $('#eNote', b).value.trim() });
        if (isNew) state.expenses.push(rec);
        save(); closeSheet(); render(); toast(isNew ? 'Saved' : 'Updated');
      };
      if (!isNew) $('#eDel', b).onclick = () => {
        if (item.bankId) state.ignoredBankIds.push(item.bankId);
        state.expenses = state.expenses.filter((x) => x.id !== item.id); save(); closeSheet(); render(); toast('Deleted');
      };
    });
  }

  function openIncome(item, date) {
    const isNew = !item;
    const e = item || { date: date || today, amount: '', source: 'Salary', kind: 'salary', note: '' };
    const kind = e.kind || L.incomeKind(e);
    openSheet(`<h3>${isNew ? 'New income' : 'Edit income'}${e.bankId ? '<span class="tag">from SEB</span>' : ''}</h3>
      <div class="field"><input id="nAmt" class="amount-input num" inputmode="decimal" placeholder="0,00" value="${e.amount || ''}"></div>
      <div class="field-row">
        <div class="field"><label>Source</label><input id="nSrc" list="srcList" value="${esc(e.source)}"><datalist id="srcList">${['Salary', 'Advance', 'Bonus', 'Side job', 'Gift', 'Refund', 'Other'].map((s) => `<option value="${s}">`).join('')}</datalist></div>
        <div class="field"><label>Date</label><input id="nDate" type="date" value="${e.date}"></div>
      </div>
      <div class="field"><label>Counts as</label><select id="nKind">
        <option value="salary" ${kind === 'salary' ? 'selected' : ''}>Salary (full / final)</option>
        <option value="advance" ${kind === 'advance' ? 'selected' : ''}>Salary advance (part of salary)</option>
        <option value="other" ${kind === 'other' ? 'selected' : ''}>Other income (on top of salary)</option></select>
        <div class="hint">An advance keeps the expected salary until the final salary arrives.</div></div>
      <div class="field"><label>Note</label><input id="nNote" value="${esc(e.note)}"></div>
      <div class="actions">${isNew ? '' : '<button class="btn danger" id="nDel">Delete</button>'}<button class="btn primary" id="nSave">Save</button></div>`, (b) => {
      $('#nSrc', b).addEventListener('change', () => { const v = $('#nSrc', b).value.trim().toLowerCase(); if (v === 'advance') $('#nKind', b).value = 'advance'; else if (v === 'salary') $('#nKind', b).value = 'salary'; });
      setTimeout(() => isNew && $('#nAmt', b).focus(), 50);
      $('#nSave', b).onclick = () => {
        const amt = L.num($('#nAmt', b).value);
        if (amt <= 0) return toast('Enter an amount');
        const rec = Object.assign(item || { id: uid() }, { amount: L.r2(amt), source: $('#nSrc', b).value.trim() || 'Income', kind: $('#nKind', b).value, date: $('#nDate', b).value || today, note: $('#nNote', b).value.trim() });
        if (isNew) state.incomes.push(rec);
        save(); closeSheet(); render(); toast('Saved');
      };
      if (!isNew) $('#nDel', b).onclick = () => {
        if (item.bankId) state.ignoredBankIds.push(item.bankId);
        state.incomes = state.incomes.filter((x) => x.id !== item.id); save(); closeSheet(); render(); toast('Deleted');
      };
    });
  }

  function openOnboarding() {
    const s = state.settings;
    openSheet(`<h3>Set up</h3>
      <div class="field"><label>Pay day (day of month salary arrives)</label><input id="oPay" inputmode="numeric" value="${s.payDay}"></div>
      <div class="field"><label>Gross monthly salary (bruto), € <span class="muted">optional</span></label><input id="oGross" inputmode="decimal" value="${s.salary.gross || ''}"><div class="hint" id="oNet"></div></div>
      <div class="field-row">
        <div class="field"><label>Save per month, €</label><input id="oSave" inputmode="decimal" value="${s.monthlySaving}"></div>
        <div class="field"><label>Savings goal, €</label><input id="oGoal" inputmode="decimal" value="${s.goal}"></div>
      </div>
      <div class="field"><label>Already saved, €</label><input id="oStart" inputmode="decimal" value="${s.startingSaved || 0}"></div>
      <button class="btn primary block" id="oGo">Start budgeting</button>`, (b) => {
      const showNet = () => { const g = L.num($('#oGross', b).value); $('#oNet', b).textContent = g ? 'Net after 2026 taxes: ' + money(L.salaryNet(g, s.salary).net) : ''; };
      $('#oGross', b).oninput = showNet; showNet();
      $('#oGo', b).onclick = () => {
        s.payDay = Math.min(31, Math.max(1, parseInt($('#oPay', b).value, 10) || 1));
        s.salary.gross = L.num($('#oGross', b).value);
        if (s.salary.gross) { s.expectedNet = L.salaryNet(s.salary.gross, s.salary).net; s.useExpected = true; }
        s.monthlySaving = L.num($('#oSave', b).value); s.goal = L.num($('#oGoal', b).value); s.startingSaved = L.num($('#oStart', b).value);
        s.startDate = today; s.statsFrom = today; save(); closeSheet(); render(); toast('All set');
      };
    });
  }

  function openSettings() {
    const s = state.settings, bk = s.bank;
    const connected = !!bk.sessionId;
    openSheet(`<h3>Settings</h3>
      <div class="field"><label>Pay day</label><input id="stPay" inputmode="numeric" value="${s.payDay}"><div class="hint">Budget months run from this day to the day before the next pay day.</div></div>
      <div class="field"><label>Budget start date</label><input id="stStart" type="date" value="${s.startDate || today}"><div class="hint">Months before this are ignored.</div></div>
      <div class="field"><label>Statistics start date</label><input id="stStats" type="date" value="${s.statsFrom || s.startDate || today}"><div class="hint">Days before this don't count in any graph or average.</div></div>
      <div class="field"><label>Opening carry, € (negative = debt to make up)</label><input id="stCarry" inputmode="decimal" value="${s.openingCarry || 0}"></div>

      <h3 style="margin-top:22px">SEB bank sync</h3>
      <div class="small muted" style="margin-bottom:10px">${connected ? `Connected · ${bk.accounts.length} account(s) · last sync ${bk.lastSync ? dShort(bk.lastSync.slice(0, 10)) + ' ' + bk.lastSync.slice(11, 16) : 'never'}${bk.validUntil ? ' · consent until ' + dShort(bk.validUntil.slice(0, 10)) : ''}` : 'Not connected. See README for the 10 minute setup.'}</div>
      <div class="field"><label>Bridge URL (your Cloudflare Worker)</label><input id="bkUrl" value="${esc(bk.workerUrl)}" placeholder="https://budget-bridge.yourname.workers.dev"></div>
      <div class="field"><label>Bridge password</label><input id="bkTok" type="password" value="${esc(bk.token)}"></div>
      <div class="toggle"><span>Import incoming payments as income</span><input type="checkbox" id="bkInc" ${bk.importIncome ? 'checked' : ''}></div>
      <div class="field"><label>Ignore transactions containing (comma separated)</label><input id="bkIgn" value="${esc(bk.ignore)}" placeholder="own transfer, savings, your name"></div>
      <div class="actions"><button class="btn primary" id="bkConnect">${connected ? 'Reconnect SEB' : 'Connect SEB'}</button>${connected ? '<button class="btn" id="bkSync">Sync now</button>' : ''}</div>

      <h3 style="margin-top:22px">Data</h3>
      <div class="actions"><button class="btn" id="dExport">Export backup</button><button class="btn" id="dImport">Import backup</button></div>
      <input type="file" id="dFile" accept="application/json" hidden>
      <div class="actions"><button class="btn ghost" id="dUpdate">Check for update</button><button class="btn danger" id="dReset">Erase all</button></div>
      <p class="small muted" style="text-align:center;margin-top:16px">Version ${esc(window.APP_VERSION || 'dev')} · data stored on this phone only</p>`, (b) => {
      $('#stPay', b).onchange = (e) => { s.payDay = Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)); save(); render(); };
      $('#stStart', b).onchange = (e) => { s.startDate = e.target.value || today; save(); render(); };
      $('#stStats', b).onchange = (e) => { s.statsFrom = e.target.value || s.startDate; save(); render(); };
      $('#stCarry', b).onchange = (e) => { s.openingCarry = L.num(e.target.value); save(); render(); };
      $('#bkUrl', b).onchange = (e) => { bk.workerUrl = e.target.value.trim().replace(/\/+$/, ''); save(); };
      $('#bkTok', b).onchange = (e) => { bk.token = e.target.value.trim(); save(); };
      $('#bkInc', b).onchange = (e) => { bk.importIncome = e.target.checked; save(); };
      $('#bkIgn', b).onchange = (e) => { bk.ignore = e.target.value; save(); };
      $('#bkConnect', b).onclick = () => { bk.workerUrl = $('#bkUrl', b).value.trim().replace(/\/+$/, ''); bk.token = $('#bkTok', b).value.trim(); save(); bankConnect(); };
      if (connected) $('#bkSync', b).onclick = () => { closeSheet(); bankSync(true); };
      $('#dExport', b).onclick = exportData;
      $('#dImport', b).onclick = () => $('#dFile', b).click();
      $('#dFile', b).onchange = (e) => importData(e.target.files[0]);
      $('#dUpdate', b).onclick = checkUpdate;
      $('#dReset', b).onclick = () => {
        if (prompt('Type ERASE to delete all budget data on this phone') === 'ERASE') { localStorage.removeItem(STORE_KEY); state = load(); closeSheet(); render(); }
      };
    });
  }

  // ---------------- backup ----------------
  function exportData() {
    const name = `budget-backup-${today}.json`;
    if (window.AndroidBridge && window.AndroidBridge.saveFile) {
      const where = window.AndroidBridge.saveFile(name, JSON.stringify(state, null, 1));
      return toast(where.startsWith('ERROR') ? 'Backup failed: ' + where.slice(7) : 'Saved to ' + where, 4000);
    }
    const blob = new Blob([JSON.stringify(state, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function importData(file) {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (!data.settings || !Array.isArray(data.expenses)) throw new Error('Not a budget backup');
        if (!confirm(`Replace current data with backup (${data.expenses.length} expenses, ${data.incomes.length} incomes)?`)) return;
        state = migrate(data); save(); closeSheet(); render(); toast('Backup restored');
      } catch (e) { toast('Import failed: ' + e.message); }
    };
    r.readAsText(file);
  }

  // ---------------- bank sync (via your Cloudflare Worker + Enable Banking) ----------------
  async function bridge(path, body) {
    const bk = state.settings.bank;
    if (!bk.workerUrl) throw new Error('Set the bridge URL in Settings');
    const res = await fetch(bk.workerUrl + path, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bk.token },
      body: JSON.stringify(body || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || ('Bridge error ' + res.status));
    return data;
  }

  async function bankConnect() {
    const bk = state.settings.bank;
    try {
      const st = uid();
      bk.pendingState = st; save();
      const redirect = location.origin + location.pathname;
      const r = await bridge('/start', { redirect_url: redirect, state: st, bank: bk.bankName, country: bk.country });
      location.href = r.url; // SEB login (Smart-ID), then back here with ?code=
    } catch (e) { toast(e.message, 5000); }
  }

  async function handleBankRedirect() {
    const p = new URLSearchParams(location.search);
    const code = p.get('code'), st = p.get('state'), err = p.get('error');
    if (!code && !err) return;
    history.replaceState(null, '', location.pathname);
    const bk = state.settings.bank;
    if (err) return toast('Bank connection cancelled: ' + (p.get('error_description') || err), 5000);
    if (bk.pendingState && st !== bk.pendingState) return toast('Bank connection state mismatch, try again', 5000);
    try {
      const r = await bridge('/session', { code });
      bk.sessionId = r.session_id;
      bk.accounts = (r.accounts || []).map((a) => ({ uid: a.uid, iban: a.account_id && a.account_id.iban, name: a.name || a.product || '' }));
      bk.validUntil = (r.access && r.access.valid_until) || '';
      bk.pendingState = ''; save();
      toast(`SEB connected (${bk.accounts.length} account${bk.accounts.length === 1 ? '' : 's'})`);
      await bankSync(true);
    } catch (e) { toast('Could not finish connecting: ' + e.message, 6000); }
  }

  let syncing = false;
  async function bankSync(manual) {
    const bk = state.settings.bank;
    if (syncing || !bk.sessionId || !bk.workerUrl) return;
    syncing = true; $('#syncBtn').classList.add('spin');
    try {
      const start = state.settings.startDate || today;
      let from = bk.lastSync ? L.addDays(bk.lastSync.slice(0, 10), -5) : start;
      if (from < start) from = start;
      const known = new Set([...state.expenses, ...state.incomes].map((x) => x.bankId).filter(Boolean).concat(state.ignoredBankIds));
      let added = 0, addedIn = 0;
      for (const acc of bk.accounts) {
        const r = await bridge('/transactions', { account_uid: acc.uid, date_from: from });
        for (const tx of r.transactions || []) {
          const m = L.mapTransaction(tx);
          if (!m.date || m.pending || m.date < start || known.has(m.bankId)) continue;
          known.add(m.bankId);
          if (L.matchesIgnore(m, bk.ignore)) continue;
          if (m.dir === 'out') { state.expenses.push({ id: uid(), date: m.date, amount: m.amount, place: m.place, note: m.note, bankId: m.bankId }); added++; }
          else if (bk.importIncome) { const rec = { id: uid(), date: m.date, amount: m.amount, source: m.place, note: m.note, bankId: m.bankId }; rec.kind = guessKind(rec, state.settings); state.incomes.push(rec); addedIn++; }
        }
      }
      bk.lastSync = new Date().toISOString(); save(); render();
      if (manual || added || addedIn) toast(added || addedIn ? `Imported ${added} expense${added === 1 ? '' : 's'}${addedIn ? `, ${addedIn} income` : ''}` : 'Up to date');
    } catch (e) {
      if (/expired|session|consent|401|403/i.test(e.message)) toast('SEB access expired. Reconnect in Settings.', 6000);
      else if (manual) toast('Sync failed: ' + e.message, 5000);
    } finally { syncing = false; $('#syncBtn').classList.remove('spin'); }
  }
  function autoSync() {
    const bk = state.settings.bank;
    if (!bk.sessionId) return;
    // PSD2 allows ~4 background fetches per day, so auto sync at most every 3 hours.
    if (!bk.lastSync || Date.now() - Date.parse(bk.lastSync) > 3 * 3600e3) bankSync(false);
  }

  // ---------------- updates (service worker) ----------------
  let swReg = null;
  async function checkUpdate() {
    if (!swReg) return toast('Update check is not available here');
    toast('Checking for update…');
    await swReg.update();
    setTimeout(() => { if (!swReg.installing && !swReg.waiting) toast('You have the latest version (' + (window.APP_VERSION || 'dev') + ')'); }, 2500);
  }
  function setupSW() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller; // false on the very first install
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !hadController) return;
      reloading = true; sessionStorage.setItem('justUpdated', '1'); location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      swReg = reg;
      // check for a new version whenever the app comes back to the foreground
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
    }).catch((e) => console.warn('SW failed', e));
    if (sessionStorage.getItem('justUpdated')) { sessionStorage.removeItem('justUpdated'); setTimeout(() => toast('Updated to version ' + (window.APP_VERSION || '')), 400); }
  }

  // Android back button (called by the native app): close panel, then go to Today, then exit.
  window.__onBack = function () {
    if (!$('#sheet').hidden) { closeSheet(); return true; }
    if (ui.tab !== 'today') { ui.tab = 'today'; window.scrollTo(0, 0); render(); return true; }
    return false;
  };

  // ---------------- boot ----------------
  function boot() {
    $$('.tabbar button').forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; window.scrollTo(0, 0); render(); }));
    $('#fab').onclick = () => (needsSetup() ? openOnboarding() : openExpense(null));
    $('#settingsBtn').onclick = openSettings;
    $('#syncBtn').onclick = () => bankSync(true);
    $('#sheetBackdrop').onclick = closeSheet;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    // refresh numbers when the day changes or the app returns to the foreground
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (L.todayStr() !== today) render(); autoSync(); } });
    setInterval(() => { if (L.todayStr() !== today) render(); }, 60000);
    if (localStorage.getItem(STORE_KEY)) save(); // persist any data migration
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
    setupSW();
    handleBankRedirect().then(autoSync);
    if (needsSetup()) setTimeout(openOnboarding, 300);
  }
  boot();
})();
