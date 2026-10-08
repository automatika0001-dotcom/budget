/*
 * Budget bridge: ONE Cloudflare Worker that serves every Budžets user.
 *   1. Keeps the bank keys (Plaid; Enable Banking for the owner's SEB) off the phones and out of the public website.
 *   2. Finishes bank logins for the app (needed on iPhone, where the browser and the home screen app don't share storage).
 *   3. Stores one encrypted backup per user. The phone encrypts it first; this Worker only ever sees scrambled bytes.
 *
 * Users never sign up: on first run the app creates a random user ID and secret. The Worker keeps only a hash of the
 * secret and keeps every user's data under their own ID.
 *
 * Secrets / settings (Cloudflare: Settings > Variables and Secrets):
 *   APP_TOKEN        Owner password (your own app, plus SEB via Enable Banking which is owner-only)
 *   ALLOWED_ORIGIN   https://automatika0001-dotcom.github.io   (no path, no trailing slash)
 *   PLAID_CLIENT_ID  optional fallback: users normally paste their OWN Plaid keys in the app (Settings > Bank sync)
 *   PLAID_SECRET     optional fallback, the Production secret
 *   PLAID_ENV        optional: "production" (default) or "sandbox"
 *   PLAID_MAX_ITEMS  optional: bank logins allowed in total (default 10, Plaid's free Trial plan cap)
 *   EB_APP_ID        optional, owner's SEB: Enable Banking Application ID
 *   EB_PRIVATE_KEY   optional, owner's SEB: the .pem private key (PKCS#8)
 *   SIGNUPS          optional: set to "off" to stop new users from being created
 * KV namespace binding:
 *   STORE
 */
const EB = 'https://api.enablebanking.com';
const MAX_BACKUP_BYTES = 3 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-headers': 'content-type, authorization, x-user',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
      'vary': 'origin'
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });
    const html = (body, status = 200, extra) => new Response(page(body), { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...(extra || {}) } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      // ---- pages opened in the browser by the bank / Plaid (protected by one-time secrets) ----
      if (req.method === 'GET' && path === '/callback') return await ebCallback(env, url, html);
      if (req.method === 'GET' && path === '/plaid/link') return await plaidLinkPage(env, req, url, html);
      if (req.method === 'POST' && path === '/plaid/done') return await plaidDone(env, url, req, json);
      if (req.method === 'GET') return json({ ok: true, name: 'Budget bridge', kv: !!env.STORE, plaid: !!env.PLAID_CLIENT_ID }, 200);
      if (req.method !== 'POST') return json({ error: 'Not allowed' }, 405);

      const u = await who(req, env);
      if (!u) return json({ error: 'Not authorised' }, 401);
      let body = {};
      try { body = await req.json(); } catch (_) {}

      // ---- encrypted backup: one slot per user, each upload replaces the previous one ----
      if (path === '/backup/put') {
        const blob = typeof body.blob === 'string' ? body.blob : '';
        if (!blob || blob.length > MAX_BACKUP_BYTES) return json({ error: 'Backup missing or too large' }, 400);
        await env.STORE.put(key(u, 'backup'), JSON.stringify({ blob, id: String(body.id || ''), savedAt: Date.now() }));
        return json({ ok: true, savedAt: Date.now() });
      }
      if (path === '/backup/get') {
        const raw = await env.STORE.get(key(u, 'backup'));
        if (!raw) return json({ error: 'No backup found' }, 404);
        return json(JSON.parse(raw));
      }
      if (path === '/backup/info') {
        const raw = await env.STORE.get(key(u, 'backup'));
        if (!raw) return json({ exists: false });
        const b = JSON.parse(raw);
        return json({ exists: true, id: b.id, savedAt: b.savedAt });
      }

      // ---- Plaid (America First Credit Union and other US banks), every user ----
      if (path === '/plaid/start') return await plaidStart(env, u, req, body, json);
      if (path === '/plaid/status') return await plaidStatus(env, u, json);
      if (path === '/plaid/transactions') return await plaidTransactions(env, u, body, json);

      // ---- Enable Banking (SEB): its free mode only reaches the owner's own accounts, so owner only ----
      if (['/start', '/session', '/claim', '/transactions', '/aspsps'].includes(path) && !u.owner) {
        return json({ error: 'SEB sync is only available to the app owner' }, 403);
      }
      if (path === '/start') {
        const st = String(body.state || crypto.randomUUID());
        const redirect = body.redirect_url || (url.origin + '/callback');
        const make = (days) => ({
          access: { valid_until: new Date(Date.now() + days * 864e5).toISOString() },
          aspsp: { name: body.bank || 'SEB', country: body.country || 'LV' },
          state: st, redirect_url: redirect, psu_type: 'personal'
        });
        let r = await eb(env, 'POST', '/auth', make(180));
        if (!r.ok) r = await eb(env, 'POST', '/auth', make(90)); // some banks allow shorter consent only
        if (r.ok) await env.STORE.put('pending:' + st, '1', { expirationTtl: 3600 });
        return pass(r, json);
      }
      if (path === '/session') return pass(await eb(env, 'POST', '/sessions', { code: body.code }), json);
      if (path === '/claim') {
        const k = 'claim:' + String(body.state || '');
        const raw = await env.STORE.get(k);
        if (!raw) return json({ status: 'waiting' }, 202);
        await env.STORE.delete(k);
        return json(JSON.parse(raw));
      }
      if (path === '/transactions') {
        const all = [];
        let cont = '';
        for (let pg = 0; pg < 30; pg++) {
          const q = new URLSearchParams({ date_from: body.date_from });
          if (cont) q.set('continuation_key', cont);
          // When you open the app yourself, tell the bank you're present (PSD2: no 4-per-day limit then).
          const psu = body.present ? { 'psu-ip-address': req.headers.get('cf-connecting-ip') || '', 'psu-user-agent': req.headers.get('user-agent') || 'Budzets' } : null;
          const r = await eb(env, 'GET', `/accounts/${encodeURIComponent(body.account_uid)}/transactions?${q}`, null, psu);
          if (!r.ok) return pass(r, json);
          all.push(...(r.data.transactions || []));
          cont = r.data.continuation_key;
          if (!cont) break;
        }
        return json({ transactions: all });
      }
      if (path === '/aspsps') return pass(await eb(env, 'GET', `/aspsps?country=${encodeURIComponent(body.country || 'LV')}`), json);

      return json({ error: 'Unknown route' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, e.status || 500);
    }
  }
};

// ================= users =================
// Owner: "Authorization: Bearer <APP_TOKEN>" (keeps the original single-user keys, so nothing moves).
// Everyone else: "x-user: <id>" + "Authorization: Bearer <secret>". The first request with a new id creates the user.
async function who(req, env) {
  needKV(env);
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (env.APP_TOKEN && tok === env.APP_TOKEN && !req.headers.get('x-user')) return { owner: true, uid: 'owner' };
  const uid = req.headers.get('x-user') || '';
  if (!/^[a-z0-9]{20,64}$/.test(uid) || tok.length < 32) return null;
  const h = await sha256(tok);
  const raw = await env.STORE.get('user:' + uid);
  if (!raw) {
    if (env.SIGNUPS === 'off') return null;
    await env.STORE.put('user:' + uid, JSON.stringify({ h, created: Date.now() }));
    return { uid };
  }
  return JSON.parse(raw).h === h ? { uid } : null;
}
const key = (u, name) => (u.owner ? name : name + ':' + u.uid);
async function sha256(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

function needKV(env) {
  if (!env.STORE) { const e = new Error('Storage is not set up on the Worker: add a KV namespace binding named STORE'); e.status = 500; throw e; }
}
function pass(r, json) {
  if (r.ok) return json(r.data);
  return json({ error: r.data.message || r.data.error || r.data.detail || ('Enable Banking error ' + r.status), details: r.data }, r.status);
}

// ================= Enable Banking (owner) =================
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

// ================= Plaid (all users) =================
const plaidBase = (env) => (env.PLAID_ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com');
// The user's own Plaid keys (sent by their app) win; the server's keys are only a fallback.
function plaidCreds(env, b) {
  const p = b && b.plaid;
  if (p && /^[A-Za-z0-9]{10,64}$/.test(p.client_id || '') && /^[A-Za-z0-9]{10,64}$/.test(p.secret || '')) return { client_id: p.client_id, secret: p.secret, own: true };
  if (env.PLAID_CLIENT_ID && env.PLAID_SECRET) return { client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, own: false };
  const e = new Error('Add your Plaid keys in Settings > Bank sync'); e.status = 400; throw e;
}
async function plaid(env, path, body, creds) {
  const res = await fetch(plaidBase(env) + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: creds.client_id, secret: creds.secret, ...body })
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

async function plaidStart(env, u, req, body, json) {
  const creds = plaidCreds(env, body);
  const origin = new URL(req.url).origin;
  const existing = JSON.parse((await env.STORE.get(key(u, 'plaid_item'))) || 'null');
  const req0 = {
    client_name: 'Budzets', language: 'en', country_codes: ['US'],
    user: { client_user_id: u.uid }, redirect_uri: origin + '/plaid/link'
  };
  // Reconnecting reuses the same bank login ("update mode"), so it doesn't use up one of the free slots.
  if (existing && existing.client_id === creds.client_id) req0.access_token = existing.access_token;
  else if (creds.own) { req0.products = ['transactions']; req0.transactions = { days_requested: 365 }; }
  else {
    const used = Number(await env.STORE.get('plaid_count')) || 0;
    const max = Number(env.PLAID_MAX_ITEMS) || 10;
    if (used >= max) return json({ error: `The server's free bank connections are all used (${max}). Ask the app owner.` }, 409);
    req0.products = ['transactions'];
    req0.transactions = { days_requested: 365 };
  }
  const r = await plaid(env, '/link/token/create', req0, creds);
  const update = !!req0.access_token;
  if (!r.ok) return json({ error: plaidErr(r), details: r.data }, r.status);
  const k = rand();
  await env.STORE.put('plaidlink:' + k, JSON.stringify({ token: r.data.link_token, uid: u.uid, owner: !!u.owner, update, creds }), { expirationTtl: 3600 });
  return json({ url: origin + '/plaid/link?k=' + k });
}

async function plaidLinkPage(env, req, url, html) {
  needKV(env);
  // After the bank's own login page (OAuth), Plaid sends the user back here with oauth_state_id.
  // The cookie set on the first visit tells us which login to resume.
  const oauth = url.searchParams.get('oauth_state_id');
  const cookieK = ((req.headers.get('cookie') || '').match(/(?:^|;\s*)bk=([a-f0-9]+)/) || [])[1];
  const k = url.searchParams.get('k') || (oauth ? cookieK : '');
  const raw = k && (await env.STORE.get('plaidlink:' + k));
  if (!raw) return html('<h1>Link expired</h1><p>Go back to Budžets and start the bank connection again.</p>', 400);
  const link = JSON.parse(raw);
  const cfg = JSON.stringify({ token: link.token, k, received: oauth ? url.href : null }).replace(/</g, '\\u003c');
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
Plaid.create(opts).open();
</script>`, 200, { 'set-cookie': `bk=${k}; Path=/plaid; Max-Age=3600; Secure; HttpOnly; SameSite=Lax` });
}

async function plaidDone(env, url, req, json) {
  needKV(env);
  const k = url.searchParams.get('k') || '';
  const raw = k && (await env.STORE.get('plaidlink:' + k));
  if (!raw) return json({ error: 'Link expired, start again in the app' }, 400);
  const link = JSON.parse(raw);
  const u = link.owner ? { owner: true, uid: 'owner' } : { uid: link.uid };
  const body = await req.json().catch(() => ({}));
  let item = JSON.parse((await env.STORE.get(key(u, 'plaid_item'))) || 'null');
  const creds = link.creds;
  if (link.update && item) {
    item.connectedAt = Date.now(); // same bank login, just re-authorised
  } else {
    const ex = await plaid(env, '/item/public_token/exchange', { public_token: body.public_token }, creds);
    if (!ex.ok) return json({ error: plaidErr(ex) }, ex.status);
    item = { access_token: ex.data.access_token, item_id: ex.data.item_id, client_id: creds.client_id, connectedAt: Date.now() };
    if (!creds.own) await env.STORE.put('plaid_count', String((Number(await env.STORE.get('plaid_count')) || 0) + 1));
  }
  const acc = await plaid(env, '/accounts/get', { access_token: item.access_token }, creds);
  if (acc.ok) item.accounts = (acc.data.accounts || []).map((a) => ({ uid: a.account_id, name: a.name || a.official_name || '', mask: a.mask || '', type: a.type, subtype: a.subtype }));
  await env.STORE.put(key(u, 'plaid_item'), JSON.stringify(item));
  await env.STORE.delete('plaidlink:' + k);
  return json({ ok: true });
}

async function plaidStatus(env, u, json) {
  const raw = await env.STORE.get(key(u, 'plaid_item'));
  if (!raw) return json({ connected: false }, 202);
  const it = JSON.parse(raw);
  return json({ connected: true, accounts: it.accounts || [], connectedAt: it.connectedAt });
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
    status: t.pending ? 'PDNG' : 'BOOK',
    pending_ref: t.pending_transaction_id || null
  };
  if (out) tx.creditor = { name }; else tx.debtor = { name };
  return tx;
}

async function plaidTransactions(env, u, body, json) {
  const raw = await env.STORE.get(key(u, 'plaid_item'));
  if (!raw) return json({ error: 'Not connected: connect your bank in Settings' }, 400);
  const it = JSON.parse(raw);
  const creds = plaidCreds(env, body);
  if (body.refresh) {
    // Ask Plaid to pull fresh data from the bank now (included in the free plan). At most every 15 minutes per user;
    // the new data arrives a little later and is picked up by the next sync.
    const rk = key(u, 'plaid_refresh_at');
    const last = Number(await env.STORE.get(rk)) || 0;
    if (Date.now() - last > 15 * 60e3) {
      await env.STORE.put(rk, String(Date.now()));
      await plaid(env, '/transactions/refresh', { access_token: it.access_token }, creds).catch(() => null);
    }
  }
  const end = new Date().toISOString().slice(0, 10);
  const all = [];
  let total = Infinity;
  for (let pg = 0; all.length < total && pg < 40; pg++) {
    const opts = { count: 250, offset: all.length };
    if (body.account_uid) opts.account_ids = [body.account_uid];
    const r = await plaid(env, '/transactions/get', { access_token: it.access_token, start_date: body.date_from, end_date: end, options: opts }, creds);
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
