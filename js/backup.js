/* Encrypted backup helpers. Everything is encrypted on the phone (AES-GCM, key from your passphrase via PBKDF2),
   so the Worker that stores the backup only ever holds scrambled bytes. Pure functions: tested in node. */
(function (root) {
  'use strict';
  const subtle = (root.crypto && root.crypto.subtle) || null;
  const ITER = 250000;
  const enc = new TextEncoder(), dec = new TextDecoder();

  const toB64 = (buf) => {
    const bytes = new Uint8Array(buf); let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const fromB64 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  async function deriveKey(pass, salt, iter) {
    const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  /** Encrypt any JSON value with a passphrase. Returns a string safe to store anywhere. */
  async function encrypt(value, pass) {
    if (!subtle) throw new Error('Encryption is not available in this browser');
    if (!pass || pass.length < 8) throw new Error('Passphrase must be at least 8 characters');
    const salt = root.crypto.getRandomValues(new Uint8Array(16));
    const iv = root.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, ITER);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
    return JSON.stringify({ v: 1, i: ITER, s: toB64(salt), n: toB64(iv), c: toB64(ct) });
  }

  async function decrypt(blob, pass) {
    if (!subtle) throw new Error('Encryption is not available in this browser');
    let o;
    try { o = JSON.parse(blob); } catch (e) { throw new Error('Backup is damaged'); }
    if (!o || o.v !== 1) throw new Error('Unknown backup format');
    try {
      const key = await deriveKey(pass, fromB64(o.s), o.i || ITER);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.n) }, key, fromB64(o.c));
      return JSON.parse(dec.decode(pt));
    } catch (e) { throw new Error('Wrong passphrase (or damaged backup)'); }
  }

  // ---- schedule: at most 3 uploads a day, at least 8 hours apart, only when something changed ----
  const GAP_MS = 8 * 3600e3, MAX_PER_DAY = 3;

  /**
   * meta: { dirty, lastOkMs, day, count }. day/count count uploads made on the current local day.
   * force = the user tapped "Back up now" (ignores the gap, still respects nothing else).
   */
  function shouldBackup(meta, nowMs, dayStr, force) {
    if (force) return true;
    if (!meta.lastOkMs) return true; // never backed up on this install: do it as soon as possible
    if (!meta.dirty) return false;
    if (nowMs - meta.lastOkMs < GAP_MS) return false;
    const count = meta.day === dayStr ? meta.count || 0 : 0;
    return count < MAX_PER_DAY;
  }
  function afterBackup(meta, nowMs, dayStr) {
    const count = meta.day === dayStr ? meta.count || 0 : 0;
    return { ...meta, dirty: false, lastOkMs: nowMs, day: dayStr, count: count + 1, error: '' };
  }

  // ---- recovery code: lets a fresh install find its data with one paste ----
  // { u: server address, i + s: this user's automatic ID and secret, t: owner password (owner only) }
  function makeRecoveryCode(o) {
    const c = { u: o.workerUrl || '' };
    if (o.token) c.t = o.token;
    if (o.uid) { c.i = o.uid; c.s = o.secret; }
    return 'budzets:' + toB64(enc.encode(JSON.stringify(c))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function parseRecoveryCode(code) {
    const m = String(code || '').replace(/\s+/g, '').match(/^budzets:([A-Za-z0-9_-]+)$/);
    if (!m) throw new Error('That is not a recovery code');
    let b = m[1].replace(/-/g, '+').replace(/_/g, '/'); while (b.length % 4) b += '=';
    let o;
    try { o = JSON.parse(dec.decode(fromB64(b))); } catch (e) { throw new Error('That recovery code is damaged'); }
    if (!o || (o.u && !/^https:\/\//.test(o.u)) || !(o.t || (o.i && o.s))) throw new Error('That recovery code is damaged');
    return { workerUrl: o.u || '', token: o.t || '', uid: o.i || '', secret: o.s || '' };
  }

  // ---- password account: the password alone finds and unlocks your data ----
  // A slow hash (PBKDF2, 300k rounds) turns the password into an ID (to find your backup and bank link on the server)
  // and a secret (to prove it's you and to encrypt the backup). The server only ever stores a hash of the secret.
  const ACCOUNT_SALT = 'cbudget-account-v1';
  async function deriveAccount(password, iter) {
    if (!subtle) throw new Error('Encryption is not available in this browser');
    const pw = String(password || '');
    if (pw.length < 8) throw new Error('Password needs at least 8 characters');
    const base = await subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(ACCOUNT_SALT), iterations: iter || 300000 }, base, 384));
    const hx = (a) => Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    return { uid: hx(bits.slice(0, 16)), secret: hx(bits.slice(16)) };
  }

  const api = { deriveAccount, encrypt, decrypt, shouldBackup, afterBackup, makeRecoveryCode, parseRecoveryCode, GAP_MS, MAX_PER_DAY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BudgetBackup = api;
})(typeof window !== 'undefined' ? window : globalThis);
