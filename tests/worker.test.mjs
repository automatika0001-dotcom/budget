// Run: node tests/worker.test.mjs   (mocks Enable Banking, Plaid and Cloudflare KV)
import worker from '../worker/worker.js';
import assert from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name); };

const kvStore = new Map();
const STORE = {
  async get(k) { const e = kvStore.get(k); return e ? e.v : null; },
  async put(k, v, opts) { kvStore.set(k, { v, ttl: opts && opts.expirationTtl }); },
  async delete(k) { kvStore.delete(k); }
};
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  APP_TOKEN: 'secret-token', ALLOWED_ORIGIN: 'https://me.github.io', STORE,
  EB_APP_ID: 'app-1', EB_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  PLAID_CLIENT_ID: 'cid', PLAID_SECRET: 'sec', PLAID_ENV: 'sandbox'
};
const B = 'https://bridge.example.workers.dev';
const call = (path, body, { method = 'POST', auth = true } = {}) =>
  worker.fetch(new Request(B + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer secret-token' } : {}) }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined }), env);

// ---- outbound mocks ----
const outbound = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url); const body = init.body ? JSON.parse(init.body) : {};
  outbound.push({ url: u, body, headers: init.headers });
  const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
  if (u.endsWith('/auth')) return ok({ url: 'https://seb.example/login?x=1', authorization_id: 'a1' });
  if (u.endsWith('/sessions')) return body.code === 'good' ? ok({ session_id: 'sess-1', accounts: [{ uid: 'acc-1', account_id: { iban: 'LV00TEST' } }], access: { valid_until: '2027-04-01T00:00:00Z' } }) : ok({ message: 'bad code' }, 400);
  if (u.includes('/transactions?')) return ok({ transactions: [{ transaction_id: 't1' }] });
  if (u.endsWith('/link/token/create')) return ok({ link_token: 'link-sandbox-123' });
  if (u.endsWith('/item/public_token/exchange')) return ok({ access_token: 'access-xyz', item_id: 'item-1' });
  if (u.endsWith('/accounts/get')) return ok({ accounts: [{ account_id: 'p-chk', name: 'Free Checking', mask: '1234', type: 'depository', subtype: 'checking' }, { account_id: 'p-sav', name: 'Savings', mask: '9999', type: 'depository', subtype: 'savings' }] });
  if (u.endsWith('/transactions/get')) {
    const all = [
      { transaction_id: 'x1', amount: 12.34, date: '2026-10-05', name: 'WALMART #123', merchant_name: 'Walmart', iso_currency_code: 'USD', pending: false },
      { transaction_id: 'x2', amount: -1500, date: '2026-10-01', name: 'PAYROLL ACME', merchant_name: null, iso_currency_code: 'USD', pending: false },
      { transaction_id: 'x3', amount: 4.5, date: '2026-10-06', name: 'COFFEE', pending: true, iso_currency_code: 'USD' }
    ];
    return ok({ total_transactions: all.length, transactions: all.slice(body.options.offset, body.options.offset + body.options.count) });
  }
  throw new Error('unexpected fetch ' + u);
};

await t('wrong or missing password is rejected', async () => {
  assert.strictEqual((await call('/backup/get', {}, { auth: false })).status, 401);
});

await t('backup: put, info, get, and a second put replaces the first (one slot)', async () => {
  assert.strictEqual((await call('/backup/get')).status, 404);
  assert.strictEqual((await (await call('/backup/info')).json()).exists, false);
  assert.strictEqual((await call('/backup/put', { blob: 'ENCRYPTED-ONE', id: 'lineage-A' })).status, 200);
  assert.strictEqual((await call('/backup/put', { blob: 'ENCRYPTED-TWO', id: 'lineage-A' })).status, 200);
  const got = await (await call('/backup/get')).json();
  assert.strictEqual(got.blob, 'ENCRYPTED-TWO'); assert.strictEqual(got.id, 'lineage-A');
  assert.deepStrictEqual([...kvStore.keys()].filter((k) => k === 'backup'), ['backup']);
  const info = await (await call('/backup/info')).json();
  assert.deepStrictEqual([info.exists, info.id], [true, 'lineage-A']);
  assert.ok(!('blob' in info));
});

await t('backup: empty or oversized upload refused', async () => {
  assert.strictEqual((await call('/backup/put', { blob: '' })).status, 400);
  assert.strictEqual((await call('/backup/put', { blob: 'x'.repeat(9 * 1024 * 1024) })).status, 400);
  assert.strictEqual((await (await call('/backup/get')).json()).blob, 'ENCRYPTED-TWO');
});

await t('Enable Banking: start registers the state, callback stores the session, app claims it once', async () => {
  const st = 'state-123';
  const s = await (await call('/start', { state: st, redirect_url: B + '/callback', bank: 'SEB', country: 'LV' })).json();
  assert.strictEqual(s.url, 'https://seb.example/login?x=1');
  const authCall = outbound.find((o) => o.url.endsWith('/auth'));
  assert.strictEqual(authCall.body.redirect_url, B + '/callback'); assert.strictEqual(authCall.body.aspsp.name, 'SEB');
  assert.ok(String(authCall.headers.authorization).split('.').length === 3, 'RS256 JWT sent');
  assert.strictEqual((await call('/claim', { state: st })).status, 202); // not finished yet
  const cb = await call(`/callback?code=good&state=${st}`, null, { method: 'GET', auth: false });
  assert.strictEqual(cb.status, 200); assert.ok((await cb.text()).includes('Connected'));
  const claim = await call('/claim', { state: st });
  assert.strictEqual(claim.status, 200);
  const sess = await claim.json();
  assert.strictEqual(sess.session_id, 'sess-1'); assert.strictEqual(sess.accounts[0].uid, 'acc-1');
  assert.strictEqual((await call('/claim', { state: st })).status, 202); // one-time
});

await t('Enable Banking: callback with an unknown state does nothing', async () => {
  const before = outbound.length;
  const cb = await call('/callback?code=good&state=forged', null, { method: 'GET', auth: false });
  assert.strictEqual(cb.status, 400); assert.strictEqual(outbound.length, before);
});

await t('Enable Banking: cancelled login is reported to the app', async () => {
  await call('/start', { state: 'st-cancel' });
  await call('/callback?error=access_denied&state=st-cancel', null, { method: 'GET', auth: false });
  assert.strictEqual((await (await call('/claim', { state: 'st-cancel' })).json()).error, 'access_denied');
});

await t('Enable Banking: transactions pass through', async () => {
  const r = await (await call('/transactions', { account_uid: 'acc-1', date_from: '2026-10-01', present: true })).json();
  assert.strictEqual(r.transactions[0].transaction_id, 't1');
});

await t('Plaid: start returns a link page, the page embeds the token safely, done stores the item', async () => {
  const s = await (await call('/plaid/start', {})).json();
  assert.ok(s.url.startsWith(B + '/plaid/link?k='));
  const lc = outbound.filter((o) => o.url.endsWith('/link/token/create')).pop();
  assert.strictEqual(lc.body.redirect_uri, B + '/plaid/link'); assert.deepStrictEqual(lc.body.country_codes, ['US']);
  assert.strictEqual((await (await call('/plaid/status', {})).status), 202);
  const page = await call(s.url.replace(B, ''), null, { method: 'GET', auth: false });
  const html = await page.text();
  assert.ok(html.includes('link-sandbox-123') && html.includes('link-initialize.js'));
  const k = new URL(s.url).searchParams.get('k');
  const done = await worker.fetch(new Request(`${B}/plaid/done?k=${k}`, { method: 'POST', body: JSON.stringify({ public_token: 'public-1' }) }), env);
  assert.strictEqual(done.status, 200);
  const st = await (await call('/plaid/status', {})).json();
  assert.strictEqual(st.connected, true); assert.strictEqual(st.accounts.length, 2); assert.strictEqual(st.accounts[0].uid, 'p-chk');
  assert.ok(!JSON.stringify(st).includes('access-xyz'), 'access token never leaves the Worker');
  // one-time: the same link cannot be used again
  const again = await worker.fetch(new Request(`${B}/plaid/done?k=${k}`, { method: 'POST', body: '{}' }), env);
  assert.strictEqual(again.status, 400);
});

await t('Plaid: forged link or done calls are refused', async () => {
  assert.strictEqual((await call('/plaid/link?k=nope', null, { method: 'GET', auth: false })).status, 400);
  assert.strictEqual((await worker.fetch(new Request(`${B}/plaid/done?k=nope`, { method: 'POST', body: '{}' }), env)).status, 400);
});

await t('Plaid: OAuth return resumes the same link token', async () => {
  const s = await (await call('/plaid/start', {})).json();
  const page = await call('/plaid/link?oauth_state_id=abc', null, { method: 'GET', auth: false });
  const html = await page.text();
  assert.ok(html.includes('receivedRedirectUri') && html.includes('"received":"' + B + '/plaid/link?oauth_state_id=abc"'));
  assert.ok(s.url);
});

await t('Plaid: transactions are normalised to the app format (sign, name, pending, paging)', async () => {
  const r = await (await call('/plaid/transactions', { account_uid: 'p-chk', date_from: '2026-10-01' })).json();
  assert.strictEqual(r.transactions.length, 3);
  const [spend, pay, pend] = r.transactions;
  assert.deepStrictEqual([spend.credit_debit_indicator, spend.transaction_amount.amount, spend.creditor.name, spend.booking_date], ['DBIT', '12.34', 'Walmart', '2026-10-05']);
  assert.deepStrictEqual([pay.credit_debit_indicator, pay.transaction_amount.amount, pay.debtor.name], ['CRDT', '1500', 'PAYROLL ACME']);
  assert.strictEqual(pend.status, 'PDNG');
  const tx = outbound.filter((o) => o.url.endsWith('/transactions/get')).pop();
  assert.deepStrictEqual(tx.body.options.account_ids, ['p-chk']);
});

console.log(`${n} worker tests passed`);
