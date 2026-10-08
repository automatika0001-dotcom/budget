// Run: node tests/backup.test.js
const B = require('../js/backup.js');
const assert = require('assert');
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('ok  ' + name); };

(async () => {
  await t('encrypt then decrypt returns the same data', async () => {
    const data = { app: 'budzets', state: { expenses: [{ id: 'a', amount: 12.5, place: 'Rimi ā č š' }], settings: { goal: 20000 } } };
    const blob = await B.encrypt(data, 'correct horse battery');
    assert.ok(!blob.includes('Rimi'), 'plaintext must not appear in the blob');
    assert.deepStrictEqual(await B.decrypt(blob, 'correct horse battery'), data);
  });
  await t('wrong passphrase fails clearly', async () => {
    const blob = await B.encrypt({ x: 1 }, 'passphrase-one');
    await assert.rejects(() => B.decrypt(blob, 'passphrase-two'), /Wrong passphrase/);
  });
  await t('tampered backup fails', async () => {
    const o = JSON.parse(await B.encrypt({ x: 1 }, 'passphrase-one'));
    o.c = o.c.slice(0, -4) + 'AAAA';
    await assert.rejects(() => B.decrypt(JSON.stringify(o), 'passphrase-one'), /Wrong passphrase/);
  });
  await t('two encryptions of the same data differ (random salt and iv)', async () => {
    assert.notStrictEqual(await B.encrypt({ x: 1 }, 'passphrase-one'), await B.encrypt({ x: 1 }, 'passphrase-one'));
  });
  await t('short passphrase refused', async () => {
    await assert.rejects(() => B.encrypt({}, 'short'), /at least 8/);
  });
  await t('large backup (2 MB of expenses) round trips', async () => {
    const big = { list: Array.from({ length: 20000 }, (_, i) => ({ id: 'id' + i, place: 'Shop ' + i, amount: i / 7 })) };
    assert.deepStrictEqual(await B.decrypt(await B.encrypt(big, 'passphrase-one'), 'passphrase-one'), big);
  });

  const H = 3600e3;
  await t('schedule: first backup happens at once', () => {
    assert.strictEqual(B.shouldBackup({ dirty: true }, 1e12, '2026-10-08'), true);
    assert.strictEqual(B.shouldBackup({}, 1e12, '2026-10-08'), true);
  });
  await t('schedule: nothing changed means no upload', () => {
    assert.strictEqual(B.shouldBackup({ dirty: false, lastOkMs: 1e12 - 20 * H, day: '2026-10-08', count: 1 }, 1e12, '2026-10-08'), false);
  });
  await t('schedule: changed but under 8 hours since last, wait', () => {
    assert.strictEqual(B.shouldBackup({ dirty: true, lastOkMs: 1e12 - 7 * H, day: '2026-10-08', count: 1 }, 1e12, '2026-10-08'), false);
  });
  await t('schedule: changed and 8 hours passed, upload', () => {
    assert.strictEqual(B.shouldBackup({ dirty: true, lastOkMs: 1e12 - 8 * H, day: '2026-10-08', count: 1 }, 1e12, '2026-10-08'), true);
  });
  await t('schedule: never more than 3 a day, counter resets next day', () => {
    let meta = {}; let now = 1e12; const day = '2026-10-08'; let uploads = 0;
    for (let i = 0; i < 40; i++) { // app opened every 30 minutes, always with changes
      meta.dirty = true;
      if (B.shouldBackup(meta, now, day)) { meta = B.afterBackup(meta, now, day); uploads++; }
      now += 0.5 * H;
    }
    assert.strictEqual(uploads, 3); // 20 hours of use: at hour 0, 8, 16
    meta.dirty = true;
    assert.strictEqual(B.shouldBackup({ ...meta, lastOkMs: now - 9 * H }, now, '2026-10-09'), true);
  });
  await t('schedule: force (Back up now) ignores the gap', () => {
    assert.strictEqual(B.shouldBackup({ dirty: false, lastOkMs: 1e12 - 1000, day: '2026-10-08', count: 3 }, 1e12, '2026-10-08', true), true);
  });
  await t('recovery code: automatic user and owner forms, bad input', () => {
    const user = { workerUrl: 'https://budget-bridge.me.workers.dev', uid: 'a'.repeat(32), secret: 'b'.repeat(64) };
    const code = B.makeRecoveryCode(user);
    assert.ok(code.startsWith('budzets:') && !/[+/=]/.test(code.slice(8)));
    assert.deepStrictEqual(B.parseRecoveryCode(code), { ...user, token: '' });
    assert.deepStrictEqual(B.parseRecoveryCode(' ' + code.slice(0, 20) + '\n' + code.slice(20) + ' '), { ...user, token: '' }); // pasted with line breaks
    const owner = { workerUrl: 'https://x.workers.dev', token: 'tok/with+odd=chars', uid: 'c'.repeat(32), secret: 'd'.repeat(64) };
    assert.deepStrictEqual(B.parseRecoveryCode(B.makeRecoveryCode(owner)), owner);
    assert.throws(() => B.parseRecoveryCode('hello'), /not a recovery code/);
    assert.throws(() => B.parseRecoveryCode('budzets:AAAA'), /damaged/);
    assert.throws(() => B.parseRecoveryCode(B.makeRecoveryCode({ workerUrl: 'https://x.dev' })), /damaged/);
  });
  await t('password account: same password gives the same account, different ones differ', async () => {
    const a = await B.deriveAccount('correct horse 1'), b = await B.deriveAccount('correct horse 1'), c = await B.deriveAccount('correct horse 2');
    assert.deepStrictEqual(a, b); assert.notStrictEqual(a.uid, c.uid);
    assert.ok(/^[a-f0-9]{32}$/.test(a.uid) && /^[a-f0-9]{64}$/.test(a.secret));
    await assert.rejects(() => B.deriveAccount('short'), /at least 8/);
  });
  console.log(`${n} backup tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
