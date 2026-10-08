/*
 * Budget bridge: one small Cloudflare Worker per person. It
 *   1. keeps your bank keys off the phone and out of the public website (Enable Banking for SEB, Plaid for America First CU),
 *   2. finishes the bank login for the app (needed on iPhone, where the browser and the home screen app do not share storage),
 *   3. stores ONE encrypted backup of your budget (the app encrypts it; this Worker only ever sees scrambled data).
 *
 * Secrets / settings (Cloudflare: Settings > Variables and Secrets):
 *   APP_TOKEN        Any long random password; type the same one into the app's Settings
 *   ALLOWED_ORIGIN   Your app address, e.g. https://yourname.github.io  (no path, no trailing slash)
 *   EB_APP_ID        (SEB / Europe) Application ID from the Enable Banking control panel
 *   EB_PRIVATE_KEY   (SEB / Europe) Full contents of the downloaded .pem private key (PKCS#8)
 *   PLAID_CLIENT_ID  (America First CU / USA) from the Plaid dashboard
 *   PLAID_SECRET     (America First CU / USA) the secret for the environment you use
 *   PLAID_ENV        optional: "production" (default) or "sandbox"
 * KV namespace binding (Settings > Bindings > KV namespace):
 *   STORE            create a namespace, bind it with exactly this variable name
 */
const EB = 'https://api.enablebanking.com';
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'vary': 'origin'
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });
    const html = (body, status = 200) => new Response(page(body), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // ---- pages opened in the browser by the bank / Plaid (no password; protected by one-time secrets) ----
      if (req.method === 'GET' && path === '/callback') return await ebCallback(env, url, html);
      if (req.method === 'GET' && path === '/plaid/link') return await plaidLinkPage(env, url, html);
      if (req.method === 'POST' && path === '/plaid/done') return await plaidDone(env, url, req, json);
      if (req.method === 'GET') return json({ ok: true, name: 'Budget bridge', kv: !!env.STORE }, 200);

      if (req.method !== 'POST') return json({ error: 'Not allowed' }, 405);
      if (!env.APP_TOKEN || req.headers.get('authorization') !== 'Bearer ' + env.APP_TOKEN) return json({ error: 'Wrong bridge password' }, 401);
      let body = {};
      try { body = await req.json(); } catch (_) {}

      // ---- encrypted backup: exactly one slot, each upload replaces the previous one ----
      if (path === '/backup/put') {
        needKV(env);
        const blob = typeof body.blob === 'string' ? body.blob : '';
        if (!blob || blob.length > MAX_BACKUP_BYTES) return json({ error: 'Backup missing or too large' }, 400);
        await env.STORE.put('backup', JSON.stringify({ blob, id: String(body.id || ''), savedAt: Date.now() }));
        return json({ ok: true, savedAt: Date.now() });
      }
      if (path === '/backup/get') {
        needKV(env);
        const raw = await env.STORE.get('backup');
        if (!raw) return json({ error: 'No backup found' }, 404);
        return json(JSON.parse(raw));
      }
      if (path === '/backup/info') {
        needKV(env);
        const raw = await env.STORE.get('backup');
        if (!raw) return json({ exists: false });
        const b = JSON.parse(raw);
        return json({ exists: true, id: b.id, savedAt: b.savedAt });
      }

      // ---- Enable Banking (SEB and other European banks) ----
      if (path === '/start') {
        needKV(env);
        const st = String(body.state || crypto.randomUUID());
        const redirect = body.redirect_url || (new URL(req.url).origin + '/callback');
        const make = (days) => ({
          access: { valid_until: new Date(Date.now() + days * 864e5).toISOString() },
          aspsp: { name: body.bank || 'SEB', country: body.country || 'LV' },
          state: st,
          redirect_url: redirect,
          psu_type: 'personal'
        });
        let r = await eb(env, 'POST', '/auth', make(180));
        if (!r.ok) r = await eb(env, 'POST', '/auth', make(90)); // some banks allow shorter consent only
        if (r.ok) await env.STORE.put('pending:' + st, '1', { expirationTtl: 3600 });
        return pass(r, json);
      }
      if (path === '/session') return pass(await eb(env, 'POST', '/sessions', { code: body.code }), json);
      if (path === '/claim') {
        // The app collects the result of a bank login that finished in the browser.
        needKV(env);
        const key = 'claim:' + String(body.state || '');
        const raw = await env.STORE.get(key);
        if (!raw) return json({ status: 'waiting' }, 202);
        await env.STORE.delete(key);
        return json(JSON.parse(raw));
      }
      if (path === '/transactions') {
        const all = [];
        let key = '';
        for (let page = 0; page < 30; page++) {
          const q = new URLSearchParams({ date_from: body.date_from });
          if (key) q.set('continuation_key', key);
          // When you open the app yourself, tell the bank you're present (PSD2: no 4-per-day limit then).
          const psu = body.present ? {
            'psu-ip-address': req.headers.get('cf-connecting-ip') || '',
            'psu-user-agent': req.headers.get('user-agent') || 'Budzets'
          } : null;
          const r = await eb(env, 'GET', `/accounts/${encodeURIComponent(body.account_uid)}/transactions?${q}`, null, psu);
          if (!r.ok) return pass(r, json);
          all.push(...(r.data.transactions || []));
          key = r.data.continuation_key;
          if (!key) break;
        }
        return json({ transactions: all });
      }
      if (path === '/aspsps') return pass(await eb(env, 'GET', `/aspsps?country=${encodeURIComponent(body.country || 'LV')}`), json);

      // ---- Plaid (America First Credit Union and other US banks) ----
      if (path === '/plaid/start') return await plaidStart(env, req, body, json);
      if (path === '/plaid/status') return await plaidStatus(env, body, json);
      if (path === '/plaid/transactions') return await plaidTransactions(env, body, json);

      return json({ error: 'Unknown route' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 500);
    }
  }
};

function needKV(env) {
  if (!env.STORE) { const e = new Error('Storage is not set up on the Worker: add a KV namespace binding named STORE (see FRIENDS_SETUP.md)'); e.status = 500; throw e; }
}

function pass(r, json) {
  if (r.ok) return json(r.data);
  return json({ error: r.data.message || r.data.error || r.data.detail || ('Enable Banking error ' + r.status), details: r.data }, r.status);
}

// ================= Enable Banking =================
async function ebCallback(env, url, html) {
  needKV(env);
  const st = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  const known = st && (await env.STORE.get('pending:' + st));
  if (!known) return html('<h1>Link expired</h1><p>Go back to Budžets and start the bank connection again.</p>', 400);
  if (err || !code) {
    await env.STORE.put('claim:' + st, JSON.stringify({ error: url.searchParams.get('error_description') || err || 'Cancelled' }), { expirationTtl: 3600 });
    return html('<h1>Not connected</h1><p>The bank connection was cancelled. Go back to Budžets and try again.</p>');
  }
  const r = await eb(env, 'POST', '/sessions', { code });
  if (!r.ok) {
    await env.STORE.put('claim:' + st, JSON.stringify({ error: r.data.message || r.data.error || ('Enable Banking error ' + r.status) }), { expirationTtl: 3600 });
    return html('<h1>Something went wrong</h1><p>Go back to Budžets and try again.</p>', 502);
  }
  await env.STORE.put('claim:' + st, JSON.stringify(r.data), { expirationTtl: 3600 });
  await env.STORE.delete('pending:' + st);
  return html('<h1>Connected</h1><p>You can close this page and go back to Budžets. It will pick up the connection by itself.</p>');
}

async function eb(env, method, path, body, extraHeaders) {
  const res = await fetch(EB + path, {
    method,
    headers: { authorization: 'Bearer ' + (await jwt(env)), 'content-type': 'application/json', ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// ---- RS256 JWT for Enable Banking ----
let cachedKey = null;
async function jwt(env) {
  if (!env.EB_PRIVATE_KEY || !env.EB_APP_ID) throw new Error('SEB is not set up on this Worker (EB_APP_ID / EB_PRIVATE_KEY missing)');
  if (!cachedKey) {
    const pem = env.EB_PRIVATE_KEY.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    if (/BEGIN RSA PRIVATE KEY/.test(env.EB_PRIVATE_KEY)) throw new Error('Key is PKCS#1. Convert: openssl pkcs8 -topk8 -nocrypt -in key.pem -out key8.pem');
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    cachedKey = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  }
  const now = Math.floor(Date.now() / 1000);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ typ: 'JWT', alg: 'RS256', kid: env.EB_APP_ID });
  const claims = enc({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cachedKey, new TextEncoder().encode(head + '.' + claims));
  return head + '.' + claims + '.' + b64url(new Uint8Array(sig));
}
function b64url(bytes) {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ================= Plaid =================
const plaidBase = (env) => (env.PLAID_ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com');
async function plaid(env, path, body) {
  if (!env.PLAID_CLIENT_ID || !env.PLAID_SECRET) throw new Error('Plaid is not set up on this Worker (PLAID_CLIENT_ID / PLAID_SECRET missing)');
  const res = await fetch(plaidBase(env) + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
const plaidErr = (r) => {
  const c = r.data.error_code || '';
  if (c === 'ITEM_LOGIN_REQUIRED') return 'Bank login expired: reconnect in Settings';
  if (c === 'PRODUCT_NOT_READY') return 'Your bank is still preparing the data, try again in a minute';
  return r.data.error_message || r.data.display_message || c || ('Plaid error ' + r.status);
};
const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');

async function plaidStart(env, req, body, json) {
  needKV(env);
  const origin = new URL(req.url).origin;
  const r = await plaid(env, '/link/token/create', {
    client_name: 'Budzets', language: 'en', country_codes: ['US'],
    user: { client_user_id: 'budzets-owner' }, products: ['transactions'],
    transactions: { days_requested: 365 },
    redirect_uri: origin + '/plaid/link'
  });
  if (!r.ok) return json({ error: plaidErr(r), details: r.data }, r.status);
  const k = rand();
  await env.STORE.put('plaidlink:' + k, r.data.link_token, { expirationTtl: 3600 });
  await env.STORE.put('plaid_last', k, { expirationTtl: 3600 });
  return json({ url: origin + '/plaid/link?k=' + k, state: body.state || k });
}

async function plaidLinkPage(env, url, html) {
  needKV(env);
  // After a bank's own login (OAuth) Plaid sends the user back here with oauth_state_id; we resume the same session.
  const oauth = url.searchParams.get('oauth_state_id');
  const k = url.searchParams.get('k') || (oauth ? await env.STORE.get('plaid_last') : '');
  const token = k && (await env.STORE.get('plaidlink:' + k));
  if (!token) return html('<h1>Link expired</h1><p>Go back to Budžets and start the bank connection again.</p>', 400);
  const cfg = JSON.stringify({ token, k, received: oauth ? url.href : null }).replace(/</g, '\\u003c');
  return html(`<h1>Connect your bank</h1><p id="msg">Opening secure bank login…</p>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
const cfg = ${cfg};
const msg = document.getElementById('msg');
const opts = {
  token: cfg.token,
  onSuccess: async (public_token) => {
    msg.textContent = 'Finishing…';
    try {
      const r = await fetch('/plaid/done?k=' + encodeURIComponent(cfg.k), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ public_token }) });
      const d = await r.json();
      msg.textContent = r.ok ? 'Connected. You can close this page and go back to Budžets.' : ('Failed: ' + (d.error || r.status));
    } catch (e) { msg.textContent = 'Failed: ' + e.message; }
  },
  onExit: (err) => { msg.textContent = err ? ('Cancelled: ' + (err.display_message || err.error_message || err.error_code)) : 'Closed. Go back to Budžets to try again.'; }
};
if (cfg.received) opts.receivedRedirectUri = cfg.received;
const h = Plaid.create(opts);
h.open();
</script>`);
}

async function plaidDone(env, url, req, json) {
  needKV(env);
  const k = url.searchParams.get('k') || '';
  const token = k && (await env.STORE.get('plaidlink:' + k));
  if (!token) return json({ error: 'Link expired, start again in the app' }, 400);
  const body = await req.json().catch(() => ({}));
  const ex = await plaid(env, '/item/public_token/exchange', { public_token: body.public_token });
  if (!ex.ok) return json({ error: plaidErr(ex) }, ex.status);
  const acc = await plaid(env, '/accounts/get', { access_token: ex.data.access_token });
  const accounts = (acc.data.accounts || []).map((a) => ({ uid: a.account_id, name: a.name || a.official_name || '', mask: a.mask || '', type: a.type, subtype: a.subtype }));
  await env.STORE.put('plaid_item', JSON.stringify({ access_token: ex.data.access_token, item_id: ex.data.item_id, accounts, connectedAt: Date.now() }));
  await env.STORE.delete('plaidlink:' + k);
  return json({ ok: true });
}

async function plaidStatus(env, body, json) {
  needKV(env);
  const raw = await env.STORE.get('plaid_item');
  if (!raw) return json({ connected: false }, 202);
  const it = JSON.parse(raw);
  return json({ connected: true, accounts: it.accounts, connectedAt: it.connectedAt });
}

// Plaid amounts are positive for money leaving the account. Convert to the shape the app already understands.
function normalizePlaidTx(t) {
  const out = t.amount > 0;
  const name = t.merchant_name || t.name || '';
  const tx = {
    transaction_id: t.transaction_id,
    transaction_amount: { amount: String(Math.abs(t.amount)), currency: t.iso_currency_code || t.unofficial_currency_code || 'USD' },
    credit_debit_indicator: out ? 'DBIT' : 'CRDT',
    booking_date: t.date,
    value_date: t.authorized_date || t.date,
    remittance_information: t.name ? [t.name] : [],
    status: t.pending ? 'PDNG' : 'BOOK'
  };
  if (out) tx.creditor = { name }; else tx.debtor = { name };
  return tx;
}

async function plaidTransactions(env, body, json) {
  needKV(env);
  const raw = await env.STORE.get('plaid_item');
  if (!raw) return json({ error: 'Not connected: connect your bank in Settings' }, 400);
  const it = JSON.parse(raw);
  const end = new Date().toISOString().slice(0, 10);
  const all = [];
  let total = Infinity;
  for (let page = 0; all.length < total && page < 40; page++) {
    const opts = { count: 250, offset: all.length };
    if (body.account_uid) opts.account_ids = [body.account_uid];
    const r = await plaid(env, '/transactions/get', { access_token: it.access_token, start_date: body.date_from, end_date: end, options: opts });
    if (!r.ok) return json({ error: plaidErr(r), details: r.data }, r.status === 400 && r.data.error_code === 'PRODUCT_NOT_READY' ? 503 : r.status);
    total = r.data.total_transactions || 0;
    const batch = r.data.transactions || [];
    all.push(...batch);
    if (!batch.length) break;
  }
  return json({ transactions: all.map(normalizePlaidTx) });
}

// ================= tiny page shell =================
function page(body) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Budžets</title>
<style>body{font:17px/1.5 system-ui,-apple-system,sans-serif;background:#101312;color:#eef2ef;margin:0;padding:48px 24px;text-align:center}h1{font-size:24px}p{color:#aab4af}</style></head><body>${body}</body></html>`;
}

