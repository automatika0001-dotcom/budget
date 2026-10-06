/*
 * Budget bank bridge: a tiny Cloudflare Worker between the app and Enable Banking (PSD2 aggregator).
 * It keeps your Enable Banking private key off the phone and out of the public website.
 *
 * Secrets to set in Cloudflare (Settings > Variables and Secrets):
 *   EB_APP_ID       Application ID from the Enable Banking control panel
 *   EB_PRIVATE_KEY  Full contents of the downloaded .pem private key
 *   APP_TOKEN       Any long random password; type the same one into the app's Settings
 *   ALLOWED_ORIGIN  Your app address, e.g. https://yourname.github.io  (no path, no trailing slash)
 */
const EB = 'https://api.enablebanking.com';

export default {
  async fetch(req, env) {
    const cors = {
      'access-control-allow-origin': env.ALLOWED_ORIGIN || '*',
      'access-control-allow-headers': 'content-type, authorization',
      'access-control-allow-methods': 'POST, OPTIONS',
      'vary': 'origin'
    };
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, 'content-type': 'application/json' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST') return json({ error: 'Budget bridge is running' }, 405);
    if (!env.APP_TOKEN || req.headers.get('authorization') !== 'Bearer ' + env.APP_TOKEN) return json({ error: 'Wrong bridge password' }, 401);

    const path = new URL(req.url).pathname;
    let body = {};
    try { body = await req.json(); } catch (_) {}

    try {
      if (path === '/start') {
        // Start SEB authorization; returns the bank login URL (Smart-ID / mobile app).
        const make = (days) => ({
          access: { valid_until: new Date(Date.now() + days * 864e5).toISOString() },
          aspsp: { name: body.bank || 'SEB', country: body.country || 'LV' },
          state: body.state || crypto.randomUUID(),
          redirect_url: body.redirect_url,
          psu_type: 'personal'
        });
        let r = await eb(env, 'POST', '/auth', make(180));
        if (!r.ok) r = await eb(env, 'POST', '/auth', make(90)); // some banks allow shorter consent only
        return pass(r, json);
      }
      if (path === '/session') {
        return pass(await eb(env, 'POST', '/sessions', { code: body.code }), json);
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
      if (path === '/aspsps') {
        return pass(await eb(env, 'GET', `/aspsps?country=${encodeURIComponent(body.country || 'LV')}`), json);
      }
      return json({ error: 'Unknown route' }, 404);
    } catch (e) {
      return json({ error: String(e.message || e) }, 500);
    }
  }
};

function pass(r, json) {
  if (r.ok) return json(r.data);
  return json({ error: r.data.message || r.data.error || r.data.detail || ('Enable Banking error ' + r.status), details: r.data }, r.status);
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
