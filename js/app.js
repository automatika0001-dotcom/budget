/* CBudget: UI layer. All data stays on the phone (localStorage); export a backup from Settings. */
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
      useExpected: true, expectedNet: 0, statsFrom: null, liveEnabled: true, vacations: [],
      salary: { gross: 0, taxBook: true, dependents: 0, disability: 'none' }, currency: 'EUR',
      bank: { workerUrl: '', token: '', provider: 'eb', bankName: 'SEB', country: 'LV', sessionId: '', accounts: [], validUntil: '', lastSync: '', importIncome: true, ignore: '', pendingState: '', pendingMode: '', pendingSince: 0, plaidId: '', plaidSecret: '' },
      backup: { pass: '', id: '', codeSaved: false, hasPassword: false },
      account: { uid: '', secret: '' }, country: '',
      us: { state: '', filing: 'single', dependents: 0, gross: 0, per: 'year', pretaxMonth: 0 },
      aliases: {}
    },
    expenses: [], incomes: [], adjustments: [], ignoredBankIds: [], liveSeen: [], liveLog: []
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
  let saveSeq = 0;
  function save() {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    saveSeq++;
    if (!bkmeta.dirty) { bkmeta.dirty = true; saveMeta(); }
  }
  // Backup bookkeeping lives outside the budget data (so restoring a backup never overwrites it).
  const META_KEY = 'budget.bkmeta';
  let bkmeta = (() => { try { return JSON.parse(localStorage.getItem(META_KEY)) || {}; } catch (e) { return {}; } })();
  function saveMeta() { try { localStorage.setItem(META_KEY, JSON.stringify(bkmeta)); } catch (e) {} }
  const BB = window.BudgetBackup;
  const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
  // Every install gets its own automatic ID and secret on the shared server: no sign up, no passwords to type.
  if (!state.settings.account.uid) { state.settings.account = { uid: hex(16), secret: hex(32) }; localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  const DEFAULT_BRIDGE = (window.BUDGET_CONFIG && window.BUDGET_CONFIG.bridge) || '';
  const bridgeUrl = () => state.settings.bank.workerUrl || DEFAULT_BRIDGE;
  const isOwner = () => !!state.settings.bank.token;
  function authHeaders(cfg) {
    const c = cfg || { token: state.settings.bank.token, uid: state.settings.account.uid, secret: state.settings.account.secret };
    return c.token ? { authorization: 'Bearer ' + c.token } : { authorization: 'Bearer ' + c.secret, 'x-user': c.uid };
  }
  const backupKey = () => state.settings.backup.pass || state.settings.account.secret;
  const recoveryCode = () => BB.makeRecoveryCode({ workerUrl: bridgeUrl(), token: state.settings.bank.token, uid: state.settings.account.uid, secret: state.settings.account.secret });

  const ui = { tab: 'today', statsMode: 'month', statsOffset: 0, calOffset: 0, charts: {} };
  let ledger, today;

  // ---------------- helpers ----------------
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  let fmtEUR, fmtEUR0, SYM = '€';
  function setCurrency() {
    const usd = state.settings.currency === 'USD';
    SYM = usd ? '$' : '€';
    fmtEUR = new Intl.NumberFormat(usd ? 'en-US' : 'lv-LV', { style: 'currency', currency: usd ? 'USD' : 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
    fmtEUR0 = new Intl.NumberFormat(usd ? 'en-US' : 'lv-LV', { maximumFractionDigits: 0 });
  }
  setCurrency();
  const money = (x) => fmtEUR.format(L.r2(x || 0) || 0);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  const bankLabel = () => (state.settings.bank.provider === 'plaid' ? 'AFCU' : state.settings.bank.bankName || 'Bank');
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
      <div class="meta"><div class="title">${esc(title)}${kind === 'income' && (e.kind || L.incomeKind(e)) === 'advance' && !/advance/i.test(title) ? '<span class="tag">advance</span>' : ''}${e.liveId ? '<span class="tag">live</span>' : ''}${e.bankId ? `<span class="tag">${esc(bankLabel())}</span>` : ''}</div>
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

  function euroBig(x) {
    const a = Math.abs(x);
    return `${fmtEUR0.format(Math.floor(a))}<span class="cur">${state.settings.currency === 'USD' ? '.' : ','}${String(Math.round((a - Math.floor(a)) * 100)).padStart(2, '0')} ${SYM}</span>`;
  }

  function nextBoxHtml(ts) {
    if (ts.nextAllowance === null) return ts.daysLeft > 1 || ts.holiday ? `<div class="tomorrow"><span>No budget days left before pay day (${dShort(ts.period.next)})</span></div>` : '';
    const label = ts.nextIsTomorrow ? "Tomorrow you'll have" : `Next budget day, ${dShort(ts.nextDate)}`;
    if (ts.holiday) return `<div class="tomorrow up"><span>${label}</span><b class="num">${money(ts.nextAllowance)}</b></div>`;
    const d = L.r2(ts.nextAllowance - ts.dailyAllowance);
    const cls = d > 0.005 ? 'up' : d < -0.005 ? 'down' : 'same';
    const trend = cls === 'same' ? 'same as today' : `${d > 0 ? '▲' : '▼'} ${money(Math.abs(d))}`;
    return `<div class="tomorrow ${cls}"><span>${label}</span><b class="num">${money(ts.nextAllowance)}</b><span class="trend">${trend}</span></div>`;
  }

  function heroHtml(ts, over) {
    if (ts.holiday) {
      const spent = ts.spentToday > 0;
      return `<div class="card hero holiday ${spent ? 'over' : ''}">
        <div class="caption">Vacation mode</div>
        <div class="big holiday-word">HOLIDAY!</div>
        ${spent ? `<div class="holiday-over num">Over budget: ${money(ts.spentToday)}</div>` : '<div class="small muted" style="margin-bottom:6px">Today has no budget. Enjoy it.</div>'}
        ${nextBoxHtml(ts)}
      </div>`;
    }
    return `<div class="card hero ${over ? 'over' : ''}">
        <div class="caption">${over ? 'Over today\'s budget by' : 'You can spend today'}</div>
        <div class="big num ${over ? 'bad' : ''}">${euroBig(ts.leftToday)}</div>
        <div class="chips">
          <span class="chip">Daily budget <b class="num">${money(ts.dailyAllowance)}</b></span>
          <span class="chip">Spent today <b class="num">${money(ts.spentToday)}</b></span>
        </div>
        ${nextBoxHtml(ts)}
      </div>`;
  }

  function formulaHtml(ts) {
    const hol = (state.settings.vacations || []).length > 0;
    if (ts.holiday) {
      const n = ts.budgetDaysLeft;
      return `<div class="formula num">Holiday today (budget 0 ${SYM}). ${money(ts.remainingMonth)} left ÷ ${n} budget day${n === 1 ? '' : 's'} after the holiday</div>`;
    }
    const n = ts.budgetDaysLeft;
    return `<div class="formula num">${money(ts.remainingMonth + ts.spentToday)} left this morning ÷ ${n} ${hol ? 'budget ' : ''}day${n === 1 ? '' : 's'} = <b>${money(ts.dailyAllowance)}</b> a day${hol && n !== ts.daysLeft ? ' (holidays skipped)' : ''}</div>`;
  }

  function weekendCount(x) {
    let n = 0;
    for (let d = x.from; d <= x.to; d = L.addDays(d, 1)) if (L.isWeekend(d)) n++;
    return n;
  }

  function vacationHtml() {
    const v = (state.settings.vacations || []).slice().sort((a, b) => a.from.localeCompare(b.from));
    const plus7 = L.addDays(today, 7);
    return `<details class="card" id="vacCard" ${ui.vacOpen ? 'open' : ''}>
        <summary><h2>Vacation mode${v.some((x) => x.to >= today) ? ' <span class="tag">on</span>' : ''}</h2><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></summary>
        <p class="small muted" style="margin-top:0">Saturdays and Sundays inside these dates get a 0 ${SYM} budget; their share goes to your other days. Anything you still spend then counts.</p>
        <div class="field-row">
          <div class="field"><label>From</label><input id="vcFrom" type="date" value="${today}"></div>
          <div class="field"><label>To</label><input id="vcTo" type="date" value="${plus7}"></div>
        </div>
        <button class="btn primary block" id="vcAdd">Add holiday</button>
        ${v.length ? `<div class="list" style="margin-top:12px">${v.map((x) => `<div class="row"><span>${dShort(x.from)} to ${dShort(x.to)} <span class="muted small">(${weekendCount(x)} weekend day${weekendCount(x) === 1 ? '' : 's'})</span></span><button class="btn ghost small vc-del" data-id="${x.id}" style="padding:4px 10px">Remove</button></div>`).join('')}</div>` : ''}
      </details>`;
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
      ${isIOS && !isStandalone() && !localStorage.getItem('budget.hideInstall') ? `<div class="banner" id="installTip"><b>Install on iPhone:</b> tap the Share button in Safari, then <b>Add to Home Screen</b>, and open CBudget from your home screen. Enter your data only there: the Safari tab and the home screen app keep separate data. <a href="#" id="hideTip">Hide</a></div>` : ''}
      ${!isOwner() && state.settings.startDate && !state.settings.backup.hasPassword ? `<div class="banner" id="pwTip"><b>Set a password</b> so you can get your budget back if you delete the app or change phone. <a href="#" id="pwSet">Set it</a></div>` : ''}
            ${consentDays !== null && consentDays <= 7 ? `<div class="banner bad">${esc(bankLabel())} connection expires in ${Math.max(0, consentDays)} days. Reconnect in Settings.</div>` : ''}
      ${heroHtml(ts, over)}

      <div class="quick">
        <button class="btn primary" id="qExp">+ Expense</button>
        <button class="btn" id="qInc">+ Income</button>
      </div>

      <div class="card">
        <h2>This month</h2>
        <div class="row"><span class="label">Left of monthly allowance</span><b class="num ${ts.remainingMonth < 0 ? 'bad' : ''}">${money(ts.remainingMonth)}</b></div>
        <div style="margin:10px 0 6px" class="bar"><i class="${spentPct >= 1 ? 'bad' : ''}" style="width:${(spentPct * 100).toFixed(1)}%"></i><span class="pace" style="left:${(pacePct * 100).toFixed(1)}%"></span></div>
        <div class="small muted" style="display:flex;justify-content:space-between"><span>Spent ${money(per.spent)} of ${money(per.effective)}</span><span>${ts.daysLeft} day${ts.daysLeft === 1 ? '' : 's'} left</span></div>
        ${formulaHtml(ts)}
        ${statusLine()}
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
        <div class="field"><label>Actually left to spend, ${SYM}</label><input id="rbAmt" class="amount-input num" inputmode="decimal" placeholder="${fmtEUR0.format(Math.round(ts.remainingMonth))}"><div class="hint">The app currently thinks: ${money(ts.remainingMonth)}</div></div>
        <button class="btn primary block" id="rbSet">Set balance</button>
        ${rebals.length ? `<div class="list" style="margin-top:12px">${rebals.map((a) => `<div class="row"><span class="label">${dShort(a.date)} · set to ${money(a.target)}</span><span><span class="num">${signed(a.amount)}</span> <button class="btn ghost small rb-undo" data-id="${a.id}" style="padding:4px 10px;margin-left:6px">Undo</button></span></div>`).join('')}</div>` : ''}
      </details>

      <div class="card">
        <h2>Today</h2>
        <div class="list">${todays.length ? todays.map((e) => itemRow(e, 'expense')).join('') : '<div class="empty">Nothing spent today</div>'}</div>
      </div>
      ${recent.length ? `<div class="card"><h2>Recent</h2><div class="list">${recent.map((e) => itemRow(e, 'expense')).join('')}</div></div>` : ''}
      ${vacationHtml()}
    `;
    $('#qExp').onclick = () => openExpense(null);
    const ps = $('#pwSet'); if (ps) ps.onclick = (ev) => { ev.preventDefault(); openPasswordSheet(); };
    const ht = $('#hideTip'); if (ht) ht.onclick = (ev) => { ev.preventDefault(); try { localStorage.setItem('budget.hideInstall', '1'); } catch (e) {} $('#installTip').remove(); };
    $('#qInc').onclick = () => openIncome(null);
    $('#vacCard').addEventListener('toggle', (e) => (ui.vacOpen = e.target.open));
    $('#vcAdd').onclick = () => {
      let a = $('#vcFrom').value, b = $('#vcTo').value;
      if (!a || !b) return toast('Pick both dates');
      if (a > b) [a, b] = [b, a];
      state.settings.vacations = (state.settings.vacations || []).concat([{ id: uid(), from: a, to: b }]);
      ui.vacOpen = true; save(); render(); toast(`Holiday ${dShort(a)} to ${dShort(b)} added`);
    };
    $$('.vc-del', v).forEach((b) => (b.onclick = () => {
      state.settings.vacations = state.settings.vacations.filter((x) => x.id !== b.dataset.id); ui.vacOpen = true; save(); render(); toast('Holiday removed');
    }));
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

  function ago(iso) {
    if (!iso) return 'never';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    return h < 24 ? h + ' h ago' : dShort(iso.slice(0, 10));
  }
  function statusLine() {
    const bk = state.settings.bank, parts = [];
    if (bk.sessionId) parts.push(syncing ? bankLabel() + ' syncing…' : bankLabel() + ' synced ' + ago(bk.lastSync));
    if (backupReady()) parts.push(bkmeta.conflict ? '<span class="bad">Backup paused</span>' : bkmeta.error ? '<span class="bad">Backup failed</span>' : bkmeta.lastOkMs ? 'Backed up ' + ago(new Date(bkmeta.lastOkMs).toISOString()) : 'Backup pending');
    if (liveAvailable()) parts.push(liveAccess() && state.settings.liveEnabled ? '<span class="good">● Live payments on</span>' : 'Live payments off');
    return parts.length ? `<div class="status-line" id="statusLine">${parts.join(' · ')}</div>` : '';
  }
  function refreshStatus() { const el = $('#statusLine'); if (el) el.outerHTML = statusLine(); }

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
      if (ledger.isHoliday && ledger.isHoliday(ds)) cls += ' holiday';
      cells += `<div class="${cls}" data-date="${ds}"><span class="d">${d}</span><span class="s num">${sp ? fmtEUR0.format(Math.round(sp)) : ''}</span></div>`;
    }
    const inc = L.sumRange(ledger.incomeByDay, first, last);
    v.innerHTML = `
      <div class="navrow"><button class="icon-btn" id="calPrev"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>
        <span class="lbl">${MONTHS_LONG[m]} ${y}</span>
        <button class="icon-btn" id="calNext"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button></div>
      <div class="card"><div class="cal">${cells}</div>
        <div class="legend" style="margin-top:12px"><span><i style="background:#17291f"></i>Under daily budget</span><span><i style="background:#331a18"></i>Over</span><span><span style="color:var(--accent)">${SYM}</span> Pay day</span>${(state.settings.vacations || []).length ? '<span><i style="background:transparent;border:1px dashed #6ab8f2"></i>Holiday</span>' : ''}</div></div>
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
      ${info ? `<div class="chips" style="margin-bottom:12px">${info.holiday ? '<span class="chip" style="color:#6ab8f2"><b>HOLIDAY</b></span>' : ''}<span class="chip">Daily budget <b class="num">${money(info.allow)}</b></span>
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
    const showCalc = state.settings.currency !== 'USD';
    v.innerHTML = `
      ${showCalc ? `<details class="card" id="calcCard" ${sal.gross ? '' : 'open'}>
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
      </details>` : ''}

      ${showCalc ? '' : `<details class="card" id="usCalcCard" ${state.settings.us.gross ? '' : 'open'}>
        <summary><h2>Salary calculator 2026 (USA)</h2><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></summary>
        ${usSalaryHtml()}
        <div class="actions" style="margin-top:12px"><button class="btn primary" id="usExpected">Use as expected income</button></div>
      </details>`}

      <div class="card">
        <h2>Add money received</h2>
        <div class="field"><label>Amount (net, what arrived), ${SYM}</label><input id="iAmt" class="amount-input num" inputmode="decimal" placeholder="0,00"></div>
        <div class="field-row">
          <div class="field"><label>Source</label><select id="iSrc">${[['Salary', 'Salary (full / final)'], ['Advance', 'Salary advance (avanss)'], ['Bonus', 'Bonus'], ['Side job', 'Side job'], ['Gift', 'Gift'], ['Refund', 'Refund'], ['Other', 'Other']].map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
          <div class="field"><label>Date</label><input id="iDate" type="date" value="${today}"></div>
        </div>
        <button class="btn primary block" id="iAdd">Add income</button>
      </div>

      <div class="card">
        <h2>Expected salary</h2>
        <div class="toggle"><span>Use expected net salary when a month has no logged income</span><input type="checkbox" id="useExp" ${state.settings.useExpected ? 'checked' : ''}></div>
        <div class="field"><label>Expected net per month, ${SYM}</label><input id="expNet" class="num" inputmode="decimal" value="${state.settings.expectedNet || ''}"></div>
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
    if (showCalc) {
    ['#sGross', '#sDeps'].forEach((s) => $(s).addEventListener('input', calc));
    ['#sBook', '#sDis'].forEach((s) => $(s).addEventListener('change', calc));
    calc();
    $('#sExpected').onclick = () => { state.settings.expectedNet = calc().net; state.settings.useExpected = true; save(); toast('Expected income set to ' + money(state.settings.expectedNet)); render(); };
    $('#sLog').onclick = () => { const r = calc(); if (!r.net) return; state.incomes.push({ id: uid(), date: today, amount: r.net, source: 'Salary', kind: 'salary', note: 'From calculator' }); save(); toast('Logged ' + money(r.net)); render(); };
    }
    $('#iAdd').onclick = () => {
      const amt = L.num($('#iAmt').value); if (amt <= 0) return toast('Enter an amount');
      const src = $('#iSrc').value;
      const kind = src === 'Salary' ? 'salary' : src === 'Advance' ? 'advance' : 'other';
      state.incomes.push({ id: uid(), date: $('#iDate').value || today, amount: L.r2(amt), source: src, kind, note: '' }); save();
      toast(kind === 'advance' ? 'Advance added, salary expectation kept' : 'Income added'); render();
    };
    if (!showCalc) {
      const usCalc = bindUsSalary(v);
      $('#usExpected').onclick = () => { const r = usCalc(); if (!r.gross) return toast('Enter salary and state'); state.settings.expectedNet = r.netMonth; state.settings.useExpected = true; save(); toast('Expected income set to ' + money(r.netMonth)); render(); };
    }
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
        y: { beginAtZero: true, grid: { color: grid }, ticks: { color: muted, callback: (v) => fmtEUR0.format(v) + ' ' + SYM } }
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
        <div class="field"><label>Savings goal, ${SYM}</label><input id="gGoal" class="num" inputmode="decimal" value="${s.goal}"></div>
        <div class="field"><label>Save each month, ${SYM}</label><input id="gMonthly" class="num" inputmode="decimal" value="${s.monthlySaving}"></div>
        <div class="field"><label>Already saved before starting, ${SYM}</label><input id="gStart" class="num" inputmode="decimal" value="${s.startingSaved}"></div>
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
    openSheet(`<h3>${isNew ? 'New expense' : 'Edit expense'}${e.bankId ? `<span class="tag">from ${esc(bankLabel())}</span>` : ''}</h3>
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
        const rec = Object.assign(item || { id: uid(), created: Date.now() }, { amount: L.r2(amt), place: $('#ePlace', b).value.trim() || 'Unknown', date: $('#eDate', b).value || today, note: $('#eNote', b).value.trim() });
        if (isNew) state.expenses.push(rec);
        else if (rec.bankId) rec.edited = true; // your edit wins over later bank updates
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
    openSheet(`<h3>${isNew ? 'New income' : 'Edit income'}${e.bankId ? `<span class="tag">from ${esc(bankLabel())}</span>` : ''}</h3>
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

  // ---------------- first-run setup, one step at a time ----------------
  const WZ_KEY = 'budget.wizard';
  let wz = null;
  const PLAID = { signup: 'https://dashboard.plaid.com/signup', api: 'https://dashboard.plaid.com/developers/api', keys: 'https://dashboard.plaid.com/developers/keys' };
  const wzSteps = () => (wz.country === 'US'
    ? ['country', 'password', 'plaidSignup', 'plaidRedirect', 'plaidKeys', 'connect', 'salaryUS', 'savings']
    : wz.country === 'LV' ? ['country', 'password', 'salaryLV', 'savings'] : ['country', 'x', 'x', 'x']);
  function wzSave() { try { localStorage.setItem(WZ_KEY, JSON.stringify({ step: wz.step, country: wz.country })); } catch (e) {} }
  function openOnboarding() {
    let saved = null; try { saved = JSON.parse(localStorage.getItem(WZ_KEY)); } catch (e) {}
    wz = { step: 0, country: state.settings.country || '', ...(saved || {}), open: true };
    wzRender();
  }
  function wzGo(delta) { wz.step = Math.max(0, Math.min(wzSteps().length - 1, wz.step + delta)); wzSave(); wzRender(); }
  const copyBtn = (id, value) => `<div class="copyrow"><input id="${id}" value="${esc(value)}" readonly><button class="btn" type="button" data-copy="${id}">Copy</button></div>`;
  const linkBtn = (href, label, primary) => `<a class="btn ${primary ? 'primary' : ''} block" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗</a>`;
  const pasteField = (id, label, value) => `<div class="field"><label>${label}</label><div class="copyrow"><input id="${id}" value="${esc(value)}" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"><button class="btn" type="button" data-paste="${id}">Paste</button></div></div>`;
  function bindCopyPaste(b) {
    $$('[data-copy]', b).forEach((x) => (x.onclick = async () => {
      const inp = $('#' + x.dataset.copy, b);
      try { await navigator.clipboard.writeText(inp.value); x.textContent = 'Copied ✓'; } catch (e) { inp.select(); document.execCommand && document.execCommand('copy'); x.textContent = 'Copied ✓'; }
      setTimeout(() => (x.textContent = 'Copy'), 2000);
    }));
    $$('[data-paste]', b).forEach((x) => (x.onclick = async () => {
      const inp = $('#' + x.dataset.paste, b);
      try { inp.value = (await navigator.clipboard.readText()).trim(); inp.dispatchEvent(new Event('change')); } catch (e) { inp.focus(); toast('Long-press the box and tap Paste'); }
    }));
  }

  function wzRender() {
    const s = state.settings, bk = s.bank;
    const steps = wzSteps(), id = steps[wz.step], total = steps.length;
    const last = wz.step === total - 1;
    const top = `<div class="wz-top"><span class="small muted">Step ${wz.step + 1}${wz.country ? ` of ${total}` : ''}</span><div class="wz-bar"><i style="width:${Math.round(((wz.step + 1) / total) * 100)}%"></i></div></div>`;
    let body = '', nextLabel = last ? 'Start budgeting' : 'Next', canSkip = '';
    if (id === 'country') {
      body = `<h3>Where do you live?</h3>
        <p class="small muted">This sets your currency and how your take-home pay is calculated.</p>
        <button class="choice ${wz.country === 'LV' ? 'on' : ''}" data-c="LV"><b>Latvia</b><span>Euro · Latvian salary taxes</span></button>
        <button class="choice ${wz.country === 'US' ? 'on' : ''}" data-c="US"><b>United States</b><span>Dollar · federal and state taxes · America First CU bank sync</span></button>
        <div class="actions" style="margin-top:14px"><button class="btn ghost block" id="oRestore">I already used CBudget: restore my backup</button></div>`;
      nextLabel = '';
    } else if (id === 'password') {
      body = s.backup.hasPassword
        ? `<h3>Password</h3><div class="banner">Password set ✓ Your budget is backed up automatically.</div>`
        : `<h3>Create a password</h3>
        <p class="small muted">Your budget is backed up automatically and encrypted with this password. You only need it if you delete the app or get a new phone.</p>
        <div class="field"><label>Password (8+ characters)</label><input id="wzPw" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></div>
        <p class="small muted">Use something unique and write it down. Nobody can reset it: if it's forgotten, the backup can't be opened.</p>`;
    } else if (id === 'plaidSignup') {
      body = `<h3>Create a free Plaid account</h3>
        <p class="small muted">Plaid is the service that lets CBudget read your America First Credit Union transactions. It's free for personal use (up to 10 bank logins).</p>
        ${linkBtn(PLAID.signup, 'Open Plaid sign up', true)}
        <p class="small muted" style="margin-top:12px">Sign up with your email. If Plaid asks what you're building, choose a personal budgeting app for your own accounts. Then come back here and tap Next.</p>`;
      canSkip = 'Skip bank connection';
    } else if (id === 'plaidRedirect') {
      body = `<h3>Allow CBudget in Plaid</h3>
        <p class="small muted">1. Copy this address:</p>${copyBtn('wzRedir', PLAID_REDIRECT())}
        <p class="small muted" style="margin-top:12px">2. Open Plaid's API page, find <b>Allowed redirect URIs</b>, paste it, and tap <b>Save</b>.</p>
        ${linkBtn(PLAID.api, 'Open Plaid API page', true)}`;
      canSkip = 'Skip bank connection';
    } else if (id === 'plaidKeys') {
      body = `<h3>Copy your two Plaid keys</h3>
        <p class="small muted">Open Plaid's Keys page. Copy <b>client_id</b> and the <b>Production</b> secret, and paste each one below.</p>
        ${linkBtn(PLAID.keys, 'Open Plaid Keys page', true)}
        <div style="margin-top:12px">${pasteField('wzPid', 'client_id', bk.plaidId)}${pasteField('wzPsec', 'Production secret', bk.plaidSecret)}</div>`;
      canSkip = 'Skip bank connection';
    } else if (id === 'connect') {
      const done = !!bk.sessionId && bk.provider === 'plaid';
      body = `<h3>Connect America First CU</h3>
        ${done ? `<div class="banner">Connected ✓ ${bk.accounts.length} account${bk.accounts.length === 1 ? '' : 's'}. Your spending will fill in by itself.</div>`
          : wz.linkUrl ? `<p class="small muted">Tap the button, log in to America First, then come back here. This page notices the connection by itself.</p>${linkBtn(wz.linkUrl, 'Open bank login', true)}<div class="actions" style="margin-top:10px"><button class="btn ghost block" id="wzCheck">I finished, check now</button></div>`
          : `<p class="small muted">Log in to your bank once. CBudget only gets read access to your transactions.</p><button class="btn primary block" id="wzConnect">Connect America First CU</button>`}`;
      if (!done) canSkip = 'Skip for now';
    } else if (id === 'salaryUS') {
      body = `<h3>Your salary</h3><p class="small muted">Your take-home pay sets your monthly budget.</p>${usSalaryHtml()}
        <div class="field"><label>Pay day (day of month the money arrives)</label><input id="wzPay" inputmode="numeric" value="${s.payDay}"></div>`;
    } else if (id === 'salaryLV') {
      body = `<h3>Your salary</h3><p class="small muted">Your take-home (neto) pay sets your monthly budget.</p>
        <div class="field"><label>Gross monthly salary (bruto), €</label><input id="wzGross" inputmode="decimal" value="${s.salary.gross || ''}"></div>
        <div class="toggle"><span>Tax book submitted (algas nodokļa grāmatiņa)</span><input type="checkbox" id="wzBook" ${s.salary.taxBook ? 'checked' : ''}></div>
        <div class="field"><label>Dependents</label><input id="wzDeps" inputmode="numeric" value="${s.salary.dependents || 0}"></div>
        <div class="netbox" id="wzNet"></div>
        <div class="field"><label>Pay day (day of month salary arrives)</label><input id="wzPay" inputmode="numeric" value="${s.payDay}"></div>`;
    } else if (id === 'savings') {
      body = `<h3>Savings</h3><p class="small muted">What you put aside each month is taken out before your daily budget.</p>
        <div class="field"><label>Save per month, ${SYM}</label><input id="wzSave" inputmode="decimal" value="${s.monthlySaving}"></div>
        <div class="field"><label>Savings goal, ${SYM}</label><input id="wzGoal" inputmode="decimal" value="${s.goal}"></div>
        <div class="field"><label>Already saved, ${SYM}</label><input id="wzStart" inputmode="decimal" value="${s.startingSaved || 0}"></div>`;
    }
    const nav = `<div class="wz-nav">${wz.step > 0 ? '<button class="btn ghost" id="wzBack">Back</button>' : '<span></span>'}${nextLabel ? `<button class="btn primary" id="wzNext">${nextLabel}</button>` : ''}</div>
      ${canSkip ? `<button class="linkbtn" id="wzSkip">${canSkip}</button>` : ''}`;
    openSheet(top + body + nav, (b) => {
      bindCopyPaste(b);
      const back = $('#wzBack', b); if (back) back.onclick = () => wzGo(-1);
      const skip = $('#wzSkip', b); if (skip) skip.onclick = () => { wz.step = wzSteps().indexOf('salaryUS'); wzSave(); wzRender(); };
      const next = $('#wzNext', b);
      if (id === 'country') {
        $$('.choice', b).forEach((x) => (x.onclick = () => {
          wz.country = x.dataset.c; s.country = wz.country; s.currency = wz.country === 'US' ? 'USD' : 'EUR';
          if (wz.country === 'US') { bk.provider = 'plaid'; bk.bankName = 'America First CU'; bk.country = 'US'; }
          setCurrency(); save(); wzGo(1);
        }));
        $('#oRestore', b).onclick = () => { wz.open = false; openRestore(); };
      }
      if (id === 'password') {
        next.onclick = async () => {
          if (s.backup.hasPassword) return wzGo(1);
          next.disabled = true; next.textContent = 'Setting up…';
          try { await setPassword($('#wzPw', b).value); wzGo(1); }
          catch (e) { toast(e.message, 5000); next.disabled = false; next.textContent = 'Next'; }
        };
        return;
      }
      if (id === 'plaidKeys') {
        const read = () => { bk.plaidId = $('#wzPid', b).value.trim(); bk.plaidSecret = $('#wzPsec', b).value.trim(); save(); };
        $('#wzPid', b).onchange = read; $('#wzPsec', b).onchange = read;
        next.onclick = () => { read(); if (!bk.plaidId || !bk.plaidSecret) return toast('Paste both keys first'); wzGo(1); };
        return;
      }
      if (id === 'connect') {
        const c = $('#wzConnect', b);
        if (c) c.onclick = async () => {
          try {
            c.disabled = true; c.textContent = 'Preparing…';
            const r = await bridge('/plaid/start', {});
            bk.pendingState = 'plaid'; bk.pendingMode = 'worker'; bk.pendingSince = Date.now(); save();
            wz.linkUrl = r.url; startClaimPolling(); wzRender();
          } catch (e) { toast(e.message, 6000); c.disabled = false; c.textContent = 'Connect America First CU'; }
        };
        const ck = $('#wzCheck', b); if (ck) ck.onclick = async () => { if (!(await checkClaim())) toast('Not finished yet'); };
        next.onclick = () => (bk.sessionId ? wzGo(1) : toast('Connect first, or tap Skip for now'));
        return;
      }
      const readPay = () => { const p = $('#wzPay', b); if (p) s.payDay = Math.min(31, Math.max(1, parseInt(p.value, 10) || 1)); };
      if (id === 'salaryUS') {
        const calc = bindUsSalary(b);
        next.onclick = () => { const r = calc(); if (!r.gross) return toast('Enter your salary'); readPay(); s.expectedNet = r.netMonth; s.useExpected = true; save(); wzGo(1); };
        return;
      }
      if (id === 'salaryLV') {
        const calc = () => {
          s.salary.gross = L.num($('#wzGross', b).value); s.salary.taxBook = $('#wzBook', b).checked; s.salary.dependents = parseInt($('#wzDeps', b).value, 10) || 0;
          const r = L.salaryNet(s.salary.gross, s.salary);
          $('#wzNet', b).innerHTML = s.salary.gross ? `Take-home <b class="num">${money(r.net)}</b> / month` : 'Enter your gross salary';
          return r;
        };
        ['#wzGross', '#wzDeps'].forEach((q) => ($(q, b).oninput = calc)); $('#wzBook', b).onchange = calc; calc();
        next.onclick = () => { const r = calc(); if (!s.salary.gross) return toast('Enter your salary'); readPay(); s.expectedNet = r.net; s.useExpected = true; save(); wzGo(1); };
        return;
      }
      if (id === 'savings') {
        next.onclick = () => {
          s.monthlySaving = L.num($('#wzSave', b).value); s.goal = L.num($('#wzGoal', b).value); s.startingSaved = L.num($('#wzStart', b).value);
          s.backup.id = s.backup.id || uid() + uid();
          s.startDate = today; s.statsFrom = today; save();
          try { localStorage.removeItem(WZ_KEY); } catch (e) {}
          wz.open = false; closeSheet(); render(); toast('All set');
          setTimeout(() => runBackup(false), 500);
          if (state.settings.bank.sessionId) bankSync(false);
        };
        return;
      }
      if (next) next.onclick = () => wzGo(1);
    });
  }

  // ---------------- US salary form (setup + Income tab) ----------------
  function usSalaryHtml() {
    const u = state.settings.us;
    const states = window.USTax.stateList();
    return `<div class="field"><label>State</label><select id="usState"><option value="">Choose your state</option>${states.map((x) => `<option value="${x.code}" ${u.state === x.code ? 'selected' : ''}>${esc(x.name)}${x.none ? ' (no state income tax)' : ''}</option>`).join('')}</select></div>
      <div class="field-row">
        <div class="field"><label>Filing status</label><select id="usFiling"><option value="single" ${u.filing === 'single' ? 'selected' : ''}>Single</option><option value="married" ${u.filing === 'married' ? 'selected' : ''}>Married, joint</option><option value="head" ${u.filing === 'head' ? 'selected' : ''}>Head of household</option></select></div>
        <div class="field"><label>Kids / dependents</label><input id="usDeps" inputmode="numeric" value="${u.dependents || 0}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Gross pay (before tax), $</label><input id="usGross" inputmode="decimal" value="${u.gross || ''}" placeholder="e.g. 60000"></div>
        <div class="field"><label>Per</label><select id="usPer"><option value="year" ${u.per === 'year' ? 'selected' : ''}>Year</option><option value="month" ${u.per === 'month' ? 'selected' : ''}>Month</option><option value="biweek" ${u.per === 'biweek' ? 'selected' : ''}>2 weeks</option><option value="week" ${u.per === 'week' ? 'selected' : ''}>Week</option></select></div>
      </div>
      <div class="field"><label>401k / health insurance taken from pay, $ per month <span class="muted">optional</span></label><input id="usPre" inputmode="decimal" value="${u.pretaxMonth || ''}"></div>
      <div class="netbox" id="usOut"></div>`;
  }
  function bindUsSalary(b) {
    const u = state.settings.us;
    const calc = () => {
      u.state = $('#usState', b).value; u.filing = $('#usFiling', b).value; u.dependents = parseInt($('#usDeps', b).value, 10) || 0;
      u.gross = L.num($('#usGross', b).value); u.per = $('#usPer', b).value; u.pretaxMonth = L.num($('#usPre', b).value); save();
      const year = u.gross * (window.USTax.PER_YEAR[u.per] || 1);
      const r = window.USTax.usNet(year, { state: u.state, filing: u.filing, dependents: u.dependents, pretax: u.pretaxMonth * 12 });
      const m = (x) => money(x / 12);
      $('#usOut', b).innerHTML = !year ? 'Enter your gross pay' : !u.state ? 'Choose your state' : `
        <div class="row"><span class="label">Gross</span><span class="num">${m(r.gross)}</span></div>
        ${r.pretax ? `<div class="row"><span class="label">401k / health</span><span class="num">-${m(r.pretax)}</span></div>` : ''}
        <div class="row"><span class="label">Federal income tax</span><span class="num">-${m(r.federal)}</span></div>
        <div class="row"><span class="label">Social Security + Medicare</span><span class="num">-${m(r.socialSecurity + r.medicare)}</span></div>
        <div class="row"><span class="label">${esc(window.USTax.STATES[u.state].n)} income tax</span><span class="num">-${m(r.state)}</span></div>
        <div class="row total"><span>Take-home per month</span><span class="num good" style="font-size:20px">${money(r.netMonth)}</span></div>
        <div class="small muted" style="margin-top:4px">2026 estimate. City/local taxes and state disability deductions are not included.</div>`;
      return year && u.state ? r : { gross: 0 };
    };
    ['#usState', '#usFiling', '#usPer'].forEach((q) => ($(q, b).onchange = calc));
    ['#usDeps', '#usGross', '#usPre'].forEach((q) => ($(q, b).oninput = calc));
    calc();
    return calc;
  }

  function openSettings() {
    const s = state.settings, bk = s.bank;
    const connected = !!bk.sessionId;
    if (!isOwner() && bk.provider !== 'plaid') { bk.provider = 'plaid'; bk.bankName = 'America First CU'; bk.country = 'US'; }
    const plaidMode = bk.provider === 'plaid';
    const label = bankLabel();
    const lastBk = bkmeta.lastOkMs ? `${dShort(L.todayStr(new Date(bkmeta.lastOkMs)))} ${new Date(bkmeta.lastOkMs).toTimeString().slice(0, 5)}` : 'never';
    openSheet(`<h3>Settings</h3>
      <div class="field"><label>Pay day</label><input id="stPay" inputmode="numeric" value="${s.payDay}"><div class="hint">Budget months run from this day to the day before the next pay day.</div></div>
      <div class="field"><label>Budget start date</label><input id="stStart" type="date" value="${s.startDate || today}"><div class="hint">Months before this are ignored.</div></div>
      <div class="field"><label>Statistics start date</label><input id="stStats" type="date" value="${s.statsFrom || s.startDate || today}"><div class="hint">Days before this don't count in any graph or average.</div></div>
      <div class="field"><label>Opening carry, ${SYM} (negative = debt to make up)</label><input id="stCarry" inputmode="decimal" value="${s.openingCarry || 0}"></div>
      <div class="field"><label>Currency</label><select id="stCur"><option value="EUR" ${s.currency === 'USD' ? '' : 'selected'}>Euro (€)</option><option value="USD" ${s.currency === 'USD' ? 'selected' : ''}>US dollar ($)</option></select></div>

      <h3 style="margin-top:22px">Backup</h3>
      <div class="small ${bkmeta.error || bkmeta.conflict ? 'bad' : 'muted'}" style="margin-bottom:10px">${backupReady()
        ? (bkmeta.conflict ? 'Paused: a backup from another install already exists. Restore it, or replace it with this phone\'s data (buttons below).' : `Automatic and encrypted · last backup ${lastBk}${bkmeta.error ? ' · last error: ' + esc(bkmeta.error) : ''}`)
        : 'Starts automatically after setup.'}</div>
      <div class="actions">${isOwner() ? '' : `<button class="btn primary" id="bpPw">${s.backup.hasPassword ? 'Change password' : 'Set password'}</button>`}<button class="btn" id="bpNow">Back up now</button></div>
      <div class="hint" style="margin-bottom:8px">${isOwner() ? 'Owner backup: restore with your owner password and passphrase.' : s.backup.hasPassword ? 'Deleted the app or new phone? Choose Restore on the first screen and enter your password.' : 'Set a password so you can restore your budget on a new phone.'}</div>
      ${bkmeta.conflict ? '<div class="actions"><button class="btn danger" id="bpReplace">Replace the old backup with this phone</button><button class="btn" id="bpRestore">Restore it</button></div>' : ''}
      <details style="margin:8px 0"><summary class="small muted" style="cursor:pointer">Advanced: extra passphrase, own server</summary>
        <div class="field" style="margin-top:10px;${isOwner() ? '' : 'display:none'}"><label>Owner backup passphrase <span class="muted">8+ characters</span></label><input id="bpPass" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" value="${esc(s.backup.pass)}" autocomplete="off"><div class="hint">If set, restoring needs the recovery code AND this passphrase. If you forget it, the backup cannot be opened.</div></div>
        <div class="field"><label>Server URL <span class="muted">empty = CBudget server</span></label><input id="bkUrl" value="${esc(bk.workerUrl)}" placeholder="${esc(DEFAULT_BRIDGE)}" autocapitalize="none" autocorrect="off"></div>
        <div class="field"><label>Owner password <span class="muted">app owner only</span></label><input id="bkTok" type="password" value="${esc(bk.token)}"></div>
      </details>

      <h3 style="margin-top:22px">Bank sync</h3>
      ${isOwner() ? `<div class="field"><label>Bank</label><select id="bkProv"><option value="eb" ${plaidMode ? '' : 'selected'}>SEB (Latvia)</option><option value="plaid" ${plaidMode ? 'selected' : ''}>America First Credit Union (USA)</option></select></div>` : '<div class="small" style="margin-bottom:6px">America First Credit Union (USA)</div>'}
      ${plaidMode ? plaidKeysHtml() : ''}
      <div class="small muted" style="margin-bottom:10px">${connected ? `Connected · ${bk.accounts.length} account(s) · last sync ${bk.lastSync ? dShort(bk.lastSync.slice(0, 10)) + ' ' + bk.lastSync.slice(11, 16) : 'never'}${bk.validUntil ? ' · consent until ' + dShort(bk.validUntil.slice(0, 10)) : ''}` : bk.pendingState ? 'Waiting for the bank login to finish…' : 'Not connected.'}</div>
      <div class="toggle"><span>Import incoming payments as income</span><input type="checkbox" id="bkInc" ${bk.importIncome ? 'checked' : ''}></div>
      <div class="field"><label>Ignore transactions containing (comma separated)</label><input id="bkIgn" value="${esc(bk.ignore)}" placeholder="own transfer, savings, your name"></div>
      <div class="actions"><button class="btn primary" id="bkConnect">${connected ? 'Reconnect ' + label : 'Connect ' + label}</button>${connected ? '<button class="btn" id="bkSync">Sync now</button>' : ''}${bk.pendingState ? '<button class="btn" id="bkCheck">I finished, check now</button>' : ''}</div>

      ${liveSettingsHtml()}
      <h3 style="margin-top:22px">Data</h3>
      <div class="actions"><button class="btn" id="dExport">Export backup file</button><button class="btn" id="dImport">Import backup file</button></div>
      <input type="file" id="dFile" accept="application/json" hidden>
      <div class="actions"><button class="btn ghost" id="dUpdate">Check for update</button><button class="btn danger" id="dReset">Erase all</button></div>
      <p class="small muted" style="text-align:center;margin-top:16px">Version ${esc(window.APP_VERSION || 'dev')} · data on this device + encrypted backup${isOwner() ? ' · owner' : ''}</p>`, (b) => {
      const readBridge = () => {
        bk.workerUrl = $('#bkUrl', b).value.trim().replace(/\/+$/, ''); bk.token = $('#bkTok', b).value.trim();
        const p = $('#bpPass', b).value;
        if (p && p.length < 8) { toast('Passphrase needs 8+ characters'); return; }
        if (p !== s.backup.pass) { s.backup.pass = p; bkmeta.dirty = true; saveMeta(); }
        save();
      };
      $('#stPay', b).onchange = (e) => { s.payDay = Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)); save(); render(); };
      $('#stStart', b).onchange = (e) => { s.startDate = e.target.value || today; save(); render(); };
      $('#stStats', b).onchange = (e) => { s.statsFrom = e.target.value || s.startDate; save(); render(); };
      $('#stCarry', b).onchange = (e) => { s.openingCarry = L.num(e.target.value); save(); render(); };
      $('#stCur', b).onchange = (e) => { s.currency = e.target.value; setCurrency(); save(); render(); openSettings(); };
      $('#bkUrl', b).onchange = readBridge; $('#bkTok', b).onchange = readBridge;
      $('#bpPass', b).onchange = () => { readBridge(); setTimeout(() => runBackup(true), 200); };
      $('#bpNow', b).onclick = async () => {
        readBridge();
        if (!backupReady()) return toast('Backup starts after setup');
        toast('Backing up…'); await runBackup(true);
        toast(bkmeta.conflict ? 'A backup from another install exists: restore it or replace it' : bkmeta.error ? 'Backup failed: ' + bkmeta.error : 'Backed up', 5000); openSettings();
      };
      const rs = $('#bpRestore', b); if (rs) rs.onclick = () => openRestore(true);
      const rp = $('#bpReplace', b);
      if (rp) rp.onclick = async () => { if (!confirm('Replace the existing backup with the data on this phone?')) return; await runBackup(true, true); toast(bkmeta.error ? 'Backup failed: ' + bkmeta.error : 'Backup replaced'); openSettings(); };
      const pw = $('#bpPw', b); if (pw) pw.onclick = () => openPasswordSheet();
      const pv = $('#bkProv', b); if (pv) pv.onchange = (e) => {
        bk.provider = e.target.value;
        if (bk.provider === 'plaid') { bk.bankName = 'America First CU'; bk.country = 'US'; } else { bk.bankName = 'SEB'; bk.country = 'LV'; }
        bk.sessionId = ''; bk.accounts = []; bk.validUntil = ''; bk.lastSync = ''; bk.pendingState = '';
        save(); render(); openSettings();
      };
      $('#bkInc', b).onchange = (e) => { bk.importIncome = e.target.checked; save(); };
      $('#bkIgn', b).onchange = (e) => { bk.ignore = e.target.value; save(); };
      const readKeys = plaidMode ? bindPlaidKeys(b) : () => {};
      $('#bkConnect', b).onclick = () => {
        readBridge(); readKeys();
        if (plaidMode && (!bk.plaidId || !bk.plaidSecret)) return toast('Paste your Plaid client_id and secret first', 4000);
        bankConnect();
      };
      if (connected) $('#bkSync', b).onclick = () => { closeSheet(); bankSync(true); };
      const ck = $('#bkCheck', b); if (ck) ck.onclick = async () => { const ok = await checkClaim(); toast(ok ? 'Connected' : 'Not finished yet'); if (ok) openSettings(); };
      bindLiveSettings(b);
      $('#dExport', b).onclick = exportData;
      $('#dImport', b).onclick = () => $('#dFile', b).click();
      $('#dFile', b).onchange = (e) => importData(e.target.files[0]);
      $('#dUpdate', b).onclick = checkUpdate;
      $('#dReset', b).onclick = () => {
        if (prompt('Type ERASE to delete all budget data on this device (your cloud backup is kept)') === 'ERASE') { localStorage.removeItem(STORE_KEY); localStorage.removeItem(META_KEY); localStorage.removeItem('budget.wizard'); bkmeta = {}; state = load(); setCurrency(); closeSheet(); render(); setTimeout(openOnboarding, 300); }
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
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
    } catch (e) {}
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

  const PLAID_REDIRECT = () => bridgeUrl() + '/plaid/link';
  function plaidKeysHtml() {
    const bk = state.settings.bank;
    return `<details ${bk.plaidId && bk.plaidSecret ? '' : 'open'} style="margin-bottom:10px"><summary class="small muted" style="cursor:pointer">Your Plaid keys ${bk.plaidId && bk.plaidSecret ? '(saved)' : '(needed once)'}</summary>
      <ol class="small muted" style="padding-left:18px;margin:8px 0">
        <li>Sign up free at <b>dashboard.plaid.com</b> (Trial plan).</li>
        <li>Developers &gt; Keys: copy <b>client_id</b> and the <b>Production secret</b> into the boxes below.</li>
        <li>Developers &gt; API &gt; Allowed redirect URIs: add the address below (tap Copy).</li>
      </ol>
      <div class="field"><label>Plaid client_id</label><input id="pkId" value="${esc(bk.plaidId)}" autocapitalize="none" autocorrect="off" spellcheck="false"></div>
      <div class="field"><label>Plaid Production secret</label><input id="pkSec" type="text" value="${esc(bk.plaidSecret)}" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></div>
      <div class="field"><label>Redirect URI for Plaid</label><div style="display:flex;gap:8px"><input id="pkRedir" value="${esc(PLAID_REDIRECT())}" readonly><button class="btn" id="pkCopy" type="button">Copy</button></div></div>
    </details>`;
  }
  function bindPlaidKeys(b) {
    const bk = state.settings.bank;
    const read = () => { bk.plaidId = $('#pkId', b).value.trim(); bk.plaidSecret = $('#pkSec', b).value.trim(); save(); };
    $('#pkId', b).onchange = read; $('#pkSec', b).onchange = read;
    $('#pkCopy', b).onclick = async () => { try { await navigator.clipboard.writeText(PLAID_REDIRECT()); toast('Copied'); } catch (e) { $('#pkRedir', b).select(); } };
    return read;
  }

  // Move this install's server data (backup, bank link) to the account that belongs to the password.
  async function setPassword(pw) {
    if (!pw || pw.length < 8) throw new Error('Password needs at least 8 characters');
    const acc = await BB.deriveAccount(pw);
    if (acc.uid !== state.settings.account.uid) {
      try { await bridge('/account/move', acc); }
      catch (e) { if (/already in use/i.test(e.message)) throw new Error('That password is already taken. Choose a different one.'); throw e; }
      state.settings.account = acc;
    }
    state.settings.backup.hasPassword = true; state.settings.backup.pass = ''; save();
    bkmeta.dirty = true; saveMeta();
    if (state.settings.startDate) await runBackup(true, true); // re-encrypt the backup with the new password right away
  }
  function openPasswordSheet() {
    const has = state.settings.backup.hasPassword;
    openSheet(`<h3>${has ? 'Change password' : 'Set a password'}</h3>
      <p class="small muted">Your password brings your budget back if you delete the app or get a new phone. Nobody can reset it, so write it down.</p>
      <div class="field"><label>${has ? 'New password' : 'Password'} (8+ characters)</label><input id="pwNew" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></div>
      <button class="btn primary block" id="pwGo">Save password</button>`, (b) => {
      $('#pwGo', b).onclick = async () => {
        const btn = $('#pwGo', b); btn.disabled = true; btn.textContent = 'Saving…';
        try { await setPassword($('#pwNew', b).value); closeSheet(); render(); toast('Password saved'); }
        catch (e) { toast(e.message, 5000); btn.disabled = false; btn.textContent = 'Save password'; }
      };
    });
  }
  async function copyRecoveryCode() {
    const code = recoveryCode();
    let ok = false;
    try { await navigator.clipboard.writeText(code); ok = true; } catch (e) {}
    if (!ok) prompt('Copy this recovery code and keep it safe:', code);
    else toast('Recovery code copied. Paste it into your notes.', 4000);
    state.settings.backup.codeSaved = true; save(); render();
  }
  function openConnectPrompt() {
    openSheet(`<h3>Connect your bank?</h3>
      <p class="small muted">Link America First Credit Union and your spending fills in by itself. You can also do it later in Settings.</p>
      ${plaidKeysHtml()}
      <button class="btn primary block" id="cpGo">Connect America First CU</button>
      <div class="actions" style="margin-top:10px"><button class="btn ghost block" id="cpLater">Later</button></div>`, (b) => {
      const readKeys = bindPlaidKeys(b);
      $('#cpGo', b).onclick = () => {
        readKeys();
        const bk = state.settings.bank; bk.provider = 'plaid'; bk.bankName = 'America First CU'; bk.country = 'US'; save();
        if (!bk.plaidId || !bk.plaidSecret) return toast('Paste your Plaid client_id and secret first', 4000);
        bankConnect();
      };
      $('#cpLater', b).onclick = closeSheet;
    });
  }

  // ---------------- encrypted cloud backup (your Worker, one slot, at most 3 a day) ----------------
  // On by default for everyone: encrypted with your own passphrase if you set one, otherwise with this install's secret.
  const backupReady = () => !!(bridgeUrl() && (isOwner() || state.settings.account.uid) && backupKey() && backupKey().length >= 8 && state.settings.startDate);
  let backingUp = false;
  async function runBackup(force, override) {
    if (backingUp || !BB || !backupReady() || !navigator.onLine) return;
    if (bkmeta.conflict && !override) return; // paused until the user restores or replaces the other backup
    const now = Date.now(), day = L.todayStr();
    if (!BB.shouldBackup(bkmeta, now, day, force)) return;
    backingUp = true; refreshStatus();
    try {
      const cfg = state.settings.backup;
      if (!cfg.id) { cfg.id = uid() + uid(); save(); }
      if (!bkmeta.lastOkMs && !override) {
        // First upload from this install: never silently overwrite a backup that belongs to an earlier install.
        const info = await bridge('/backup/info', {});
        if (info.exists && info.id !== cfg.id) { bkmeta.conflict = info.savedAt || 1; saveMeta(); return; }
      }
      const seq = saveSeq;
      const snap = JSON.parse(JSON.stringify(state));
      const blob = await BB.encrypt({ app: 'budzets', savedAt: new Date().toISOString(), state: snap }, backupKey());
      await bridge('/backup/put', { blob, id: cfg.id });
      bkmeta = BB.afterBackup(bkmeta, now, day);
      delete bkmeta.conflict;
      if (saveSeq !== seq) bkmeta.dirty = true; // changed while uploading: back up again next time
      saveMeta();
    } catch (e) { bkmeta.error = e.message; saveMeta(); }
    finally { backingUp = false; refreshStatus(); }
  }

  // c: { workerUrl, token, uid, secret } from a recovery code (or the current install)
  async function restoreFromBackup(c, pass) {
    const url = c.workerUrl || DEFAULT_BRIDGE;
    const res = await fetch(url + '/backup/get', { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(c) }, body: '{}' });
    const data = await res.json().catch(() => ({}));
    if (res.status === 404) throw new Error('No backup found');
    if (res.status === 401) throw new Error('Wrong password');
    if (!res.ok) throw new Error(data.error || ('Server error ' + res.status));
    let payload;
    try { payload = await BB.decrypt(data.blob, pass || c.secret); }
    catch (e) { throw new Error(pass ? 'Wrong passphrase' : 'Wrong password'); }
    if (!payload || !payload.state || !Array.isArray(payload.state.expenses)) throw new Error('Backup is not a budget backup');
    state = migrate(payload.state);
    state.settings.bank.workerUrl = url === DEFAULT_BRIDGE ? '' : url;
    state.settings.bank.token = c.token || '';
    if (c.uid) state.settings.account = { uid: c.uid, secret: c.secret };
    state.settings.backup.pass = pass || '';
    state.settings.backup.codeSaved = true;
    if (data.id) state.settings.backup.id = data.id;
    setCurrency(); save();
    bkmeta = { dirty: false, lastOkMs: Date.now(), day: L.todayStr(), count: 1 }; saveMeta(); // just restored: nothing new to upload
    return payload;
  }

  function openRestore(fromSettings) {
    openSheet(`<h3>Restore your budget</h3>
      <div class="small muted" style="margin-bottom:10px">Enter the password you set. Your latest backup replaces the data on this device.</div>
      <div class="field"><label>Password</label><input id="rcPw" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></div>
      <button class="btn primary block" id="rcGo">Restore</button>
      <details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">App owner</summary>
        <div class="field" style="margin-top:10px"><label>Owner password</label><input id="rcTok" type="password"></div>
        <div class="field"><label>Owner backup passphrase</label><input id="rcPass" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off"></div>
      </details>
      <div class="actions" style="margin-top:10px"><button class="btn ghost block" id="rcBack">Cancel</button></div>`, (b) => {
      $('#rcBack', b).onclick = () => { closeSheet(); if (needsSetup()) setTimeout(openOnboarding, 100); };
      $('#rcGo', b).onclick = async () => {
        const btn = $('#rcGo', b);
        try {
          const tok = $('#rcTok', b).value.trim();
          let c, pass = '';
          if (tok) { c = { workerUrl: bridgeUrl(), token: tok, uid: state.settings.account.uid, secret: state.settings.account.secret }; pass = $('#rcPass', b).value; }
          else { btn.disabled = true; btn.textContent = 'Checking…'; c = await BB.deriveAccount($('#rcPw', b).value); c.workerUrl = ''; }
          if (state.expenses.length && !confirm('This replaces the data currently on this device. Continue?')) return;
          const payload = await restoreFromBackup(c, pass);
          if (!tok) state.settings.backup.hasPassword = true;
          save();
          try { localStorage.removeItem(WZ_KEY); } catch (e) {}
          closeSheet(); render(); toast(`Restored backup from ${dShort(String(payload.savedAt || today).slice(0, 10))} (${state.expenses.length} expenses)`, 5000);
          checkClaim(); autoSync();
        } catch (e) {
          toast(/No backup found/.test(e.message) ? 'No backup found for that password' : e.message, 5000);
          btn.disabled = false; btn.textContent = 'Restore';
        }
      };
    });
  }

  // ---------------- bank sync (via your Cloudflare Worker + Enable Banking) ----------------
  async function bridge(path, body) {
    const bk = state.settings.bank;
    if (!bridgeUrl()) throw new Error('No server set');
    const b = { ...(body || {}) };
    if (path.startsWith('/plaid/') && bk.plaidId && bk.plaidSecret) b.plaid = { client_id: bk.plaidId, secret: bk.plaidSecret };
    const res = await fetch(bridgeUrl() + path, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(b)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || ('Bridge error ' + res.status));
    return data;
  }

  // On iPhone the browser that shows the bank login is not the home screen app, so the login finishes on your
  // Worker's own page and the app collects the result. Elsewhere the old redirect-back flow still works.
  const useWorkerCallback = () => state.settings.bank.provider === 'plaid' || isIOS || isStandalone();

  async function bankConnect() {
    const bk = state.settings.bank;
    try {
      if (!bridgeUrl()) throw new Error('No server set');
      if (bk.provider === 'eb' && !isOwner()) bk.provider = 'plaid';
      let url;
      if (bk.provider === 'plaid') {
        const r = await bridge('/plaid/start', {});
        url = r.url; bk.pendingState = 'plaid'; bk.pendingMode = 'worker';
      } else if (useWorkerCallback()) {
        const st = uid() + uid();
        const r = await bridge('/start', { redirect_url: bridgeUrl() + '/callback', state: st, bank: bk.bankName, country: bk.country });
        url = r.url; bk.pendingState = st; bk.pendingMode = 'worker';
      } else {
        const st = uid();
        bk.pendingState = st; bk.pendingMode = 'redirect'; save();
        const r = await bridge('/start', { redirect_url: location.origin + location.pathname, state: st, bank: bk.bankName, country: bk.country });
        location.href = r.url; // bank login (Smart-ID), then back here with ?code=
        return;
      }
      bk.pendingSince = Date.now(); save();
      // A real link the user taps: browsers only open the bank login reliably from a tap.
      openSheet(`<h3>Connect ${esc(bankLabel())}</h3>
        <p class="small muted">Tap the button, log in at your bank, then come back to CBudget. It picks up the connection by itself.</p>
        <a class="btn primary block" href="${esc(url)}" target="_blank" rel="noopener" id="bkOpen">Open bank login</a>
        <div class="actions" style="margin-top:10px"><button class="btn ghost block" id="bkDone">I finished, check now</button></div>`, (bd) => {
        $('#bkDone', bd).onclick = async () => { const ok = await checkClaim(); toast(ok ? 'Connected' : 'Not finished yet'); if (ok) closeSheet(); };
      });
      startClaimPolling();
    } catch (e) { toast(e.message, 5000); }
  }

  function applySession(r) {
    const bk = state.settings.bank;
    if (bk.provider === 'plaid') {
      const accs = (r.accounts || []).filter((a) => a.type === 'depository');
      const checking = accs.filter((a) => a.subtype === 'checking');
      bk.accounts = (checking.length ? checking : accs).map((a) => ({ uid: a.uid, iban: a.mask ? '••' + a.mask : '', name: a.name || '' }));
      bk.sessionId = 'plaid'; bk.validUntil = '';
    } else {
      bk.sessionId = r.session_id;
      bk.accounts = (r.accounts || []).map((a) => ({ uid: a.uid, iban: a.account_id && a.account_id.iban, name: a.name || a.product || '' }));
      bk.validUntil = (r.access && r.access.valid_until) || '';
    }
    bk.pendingState = ''; bk.pendingMode = ''; save();
    toast(`${bankLabel()} connected (${bk.accounts.length} account${bk.accounts.length === 1 ? '' : 's'})`);
    return bankSync(true);
  }

  // Asks the Worker whether the bank login in the browser has finished.
  let claiming = false;
  async function checkClaim() {
    const bk = state.settings.bank;
    if (claiming || !bk.pendingState || bk.pendingMode !== 'worker' || !bridgeUrl()) return false;
    claiming = true;
    try {
      if (bk.pendingState === 'plaid') {
        const r = await bridge('/plaid/status', {});
        if (!r.connected || (r.connectedAt || 0) < (bk.pendingSince || 0)) return false;
        await applySession(r);
      } else {
        const r = await bridge('/claim', { state: bk.pendingState });
        if (r.status === 'waiting') return false;
        if (r.error) { bk.pendingState = ''; bk.pendingMode = ''; save(); toast('Bank connection failed: ' + r.error, 6000); return false; }
        await applySession(r);
      }
      if ($('#bkOpen')) closeSheet();
      if (wz && wz.open) { wz.linkUrl = ''; wzRender(); }
      return true;
    } catch (e) { return false; }
    finally { claiming = false; }
  }
  // Only while a bank login is in progress (max 15 minutes) and the app is on screen: no background cost.
  let claimTimer = null;
  function startClaimPolling() {
    clearInterval(claimTimer);
    claimTimer = setInterval(async () => {
      const bk = state.settings.bank;
      if (!bk.pendingState || bk.pendingMode !== 'worker' || Date.now() - (bk.pendingSince || 0) > 15 * 60e3) { clearInterval(claimTimer); return; }
      if (document.visibilityState !== 'visible') return;
      if (await checkClaim()) clearInterval(claimTimer);
    }, 3000);
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
      await applySession(r);
    } catch (e) { toast('Could not finish connecting: ' + e.message, 6000); }
  }

  let syncing = false;
  async function bankSync(manual) {
    const bk = state.settings.bank;
    if (syncing || !bk.sessionId || !bridgeUrl()) return;
    syncing = true; refreshStatus();
    try {
      const start = state.settings.startDate || today;
      let from = bk.lastSync ? L.addDays(bk.lastSync.slice(0, 10), -5) : start;
      if (from < start) from = start;
      const plaidMode = bk.provider === 'plaid';
      const mapped = [];
      for (const acc of bk.accounts) {
        // present: you opened the app yourself, so the bank's 4-per-day background limit doesn't apply (SEB).
        // refresh: ask Plaid to fetch fresh data from the bank now (the Worker limits this to once per 15 minutes).
        const r = await bridge(plaidMode ? '/plaid/transactions' : '/transactions', { account_uid: acc.uid, date_from: from, present: true, refresh: true });
        for (const tx of r.transactions || []) mapped.push(L.mapTransaction(tx));
      }
      // Same purchase already logged live (Google Wallet) or by hand? It is linked instead of added twice.
      const res = L.applyBankTransactions(state, mapped, {
        start, from, ignore: bk.ignore, importIncome: bk.importIncome, withPending: plaidMode,
        newId: uid, kindOf: (rec) => guessKind(rec, state.settings)
      });
      const added = res.added, addedIn = res.addedIn, matched = res.matched;
      bk.lastSync = new Date().toISOString(); save();
      syncing = false; render();
      if (manual || added || addedIn) toast(added || addedIn ? `Imported ${added} expense${added === 1 ? '' : 's'}${addedIn ? `, ${addedIn} income` : ''}${matched ? ` (${matched} already logged)` : ''}` : 'Up to date');
    } catch (e) {
      if (/expired|session|consent|401|403/i.test(e.message)) toast(bankLabel() + ' access expired. Reconnect in Settings.', 6000);
      else if (manual) toast('Sync failed: ' + e.message, 5000);
    } finally { syncing = false; refreshStatus(); }
  }
  // Sync whenever the app is opened or brought back from the background, at most every 5 minutes.
  // Nothing runs while the app is in the background, so there is no battery cost.
  const SYNC_GAP_MS = 5 * 60e3;
  function autoSync() {
    const bk = state.settings.bank;
    if (!bk.sessionId || !navigator.onLine) return;
    if (!bk.lastSync || Date.now() - Date.parse(bk.lastSync) > SYNC_GAP_MS) bankSync(false);
  }

  // ---------------- live payments (Google Wallet notifications, Android app only) ----------------
  const AB = () => window.AndroidBridge;
  const liveAvailable = () => !!(AB() && AB().peekPaymentEvents);
  const liveAccess = () => { try { return liveAvailable() && AB().hasNotificationAccess(); } catch (e) { return false; } };

  function processLive(fromNotification) {
    if (!liveAvailable() || !state.settings.startDate) return;
    let events = [];
    try { events = JSON.parse(AB().peekPaymentEvents() || '[]'); } catch (e) { return; }
    if (!events.length) return;
    const seen = new Set(state.liveSeen);
    const done = [];
    let lastAdded = null, addedCount = 0;
    for (const ev of events) {
      done.push(ev.id);
      if (seen.has(ev.id)) continue;
      seen.add(ev.id); state.liveSeen.push(ev.id);
      const t = new Date(ev.time || Date.now());
      const date = L.todayStr(t);
      const parsed = state.settings.liveEnabled ? L.parsePaymentNotification(ev) : null;
      let result = 'not a payment';
      if (!state.settings.liveEnabled) result = 'live payments off';
      else if (parsed && date < state.settings.startDate) result = 'before budget start';
      else if (parsed && L.findDuplicateForLive(state.expenses, date, parsed.amount, t.getTime())) result = 'duplicate, skipped';
      else if (parsed) {
        const rec = { id: uid(), date, amount: parsed.amount, place: parsed.place, note: 'Google Wallet', liveId: ev.id, created: t.getTime() };
        state.expenses.push(rec); lastAdded = rec; addedCount++;
        result = 'added ' + money(parsed.amount) + ' · ' + parsed.place;
      }
      state.liveLog.unshift({ time: t.toISOString(), title: ev.title || '', text: ev.text || '', result });
    }
    state.liveSeen = state.liveSeen.slice(-400);
    state.liveLog = state.liveLog.slice(0, 15);
    save();
    try { AB().ackPaymentEvents(done.join(',')); } catch (e) {}
    if (addedCount) {
      render();
      toast(addedCount === 1 ? `Logged ${money(lastAdded.amount)} · ${lastAdded.place}` : `Logged ${addedCount} payments`);
    }
  }

  function liveSettingsHtml() {
    if (!AB()) return '';
    if (!liveAvailable()) return `<h3 style="margin-top:22px">Live payments</h3><div class="banner">Install the new APK from your GitHub Releases page to log Google Wallet payments instantly.</div>`;
    const on = liveAccess();
    const s = state.settings;
    return `<h3 style="margin-top:22px">Live payments (Google Wallet)</h3>
      <div class="small ${on ? 'good' : 'muted'}" style="margin-bottom:10px">${on ? '● Notification access granted. Payments are logged the moment Wallet shows them.' : 'Off. CBudget needs Notification access to see Google Wallet payment notifications.'}</div>
      ${on ? '' : `<div class="small muted" style="margin-bottom:10px">If the switch is greyed out ("Restricted setting"): tap <b>App info</b>, then the ⋮ menu (top right), <b>Allow restricted settings</b>, then come back and tap <b>Turn on</b> again.</div>`}
      <div class="actions"><button class="btn ${on ? 'ghost' : 'primary'}" id="lvAccess">${on ? 'Notification access' : 'Turn on'}</button><button class="btn ghost" id="lvInfo">App info</button></div>
      <div class="toggle" style="margin-top:8px"><span>Log payments from notifications</span><input type="checkbox" id="lvOn" ${s.liveEnabled ? 'checked' : ''}></div>
      <details style="margin-bottom:8px"><summary class="small muted" style="cursor:pointer">Advanced: watched apps and recent notifications</summary>
        <div class="field" style="margin-top:10px"><label>Watched apps (package names, comma separated)</label><input id="lvPk" value="${esc(AB().getWatchedPackages())}"><div class="hint">Google Wallet is com.google.android.apps.walletnfcrel</div></div>
        <div class="list">${state.liveLog.length ? state.liveLog.map((l) => `<div class="row" style="flex-direction:column;align-items:flex-start;gap:2px"><span class="small"><b>${esc(l.title)}</b> ${esc(l.text)}</span><span class="small muted">${dShort(L.todayStr(new Date(l.time)))} ${new Date(l.time).toTimeString().slice(0, 5)} · ${esc(l.result)}</span></div>`).join('') : '<div class="empty">No payment notifications seen yet</div>'}</div>
      </details>`;
  }
  function bindLiveSettings(b) {
    if (!liveAvailable()) return;
    $('#lvAccess', b).onclick = () => AB().openNotificationAccess();
    $('#lvInfo', b).onclick = () => AB().openAppInfo();
    $('#lvOn', b).onchange = (e) => { state.settings.liveEnabled = e.target.checked; AB().setLiveEnabled(e.target.checked); save(); render(); };
    $('#lvPk', b).onchange = (e) => AB().setWatchedPackages(e.target.value.trim());
  }

  // Called by the Android app: on returning from the background, and when a payment notification arrives.
  window.__onResume = function () {
    if (L.todayStr() !== today) render();
    processLive(false);
    autoSync();
    runBackup(false);
    if (!$('#sheet').hidden && $('#lvAccess')) openSettings(); // refresh access status after visiting Android settings
    else refreshStatus();
  };
  window.__onLivePayment = function () { processLive(true); };

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
    $('#sheetBackdrop').onclick = closeSheet;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
    // refresh numbers when the day changes or the app returns to the foreground
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { if (L.todayStr() !== today) render(); autoSync(); checkClaim(); runBackup(false); }
      else runBackup(false); // leaving the app: upload now if something changed and the 8 hour gap has passed
    });
    setInterval(() => { if (L.todayStr() !== today) render(); }, 60000);
    { const raw = localStorage.getItem(STORE_KEY); if (raw && raw !== JSON.stringify(state)) { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } } // persist any data migration (without marking the backup dirty)
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    render();
    setupSW();
    processLive(false);
    if (liveAvailable()) { try { AB().setLiveEnabled(state.settings.liveEnabled !== false); } catch (e) {} }
    handleBankRedirect().then(autoSync);
    if (state.settings.bank.pendingMode === 'worker') { checkClaim(); startClaimPolling(); }
    setTimeout(() => runBackup(false), 2500);
    setInterval(() => runBackup(false), 30 * 60e3);
    setInterval(refreshStatus, 60000); // keeps "synced x min ago" fresh; paused in the background
    if (needsSetup()) setTimeout(openOnboarding, 300);
  }
  boot();
})();
