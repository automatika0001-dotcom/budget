# Budžets: set up for a new person

Everyone gets their own private budget. Your numbers live on your phone and in your own encrypted backup; nobody else (not even the person who shared the app) can see them.

What it costs: nothing. GitHub Pages, Cloudflare Workers + KV and Enable Banking's personal mode are free tiers. For America First Credit Union, Plaid's free Trial plan is used (see the note at the end).

Time: 5 minutes for the app, about 20 more for backup and bank, once.

---

## 1. Install the app

**iPhone**
1. Open **Safari** (it must be Safari) and go to `https://automatika0001-dotcom.github.io/budget/`
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.
3. Open **Budžets from the home screen** and do the setup there. Data typed into the Safari tab stays in Safari; the home screen app has its own.

**Android**
1. Open `https://github.com/automatika0001-dotcom/budget/releases` and install **Budzets.apk** (allow installs from this source when asked).

Updates arrive by themselves: when the app is opened, it loads the newest version.

In setup, pick your currency: **Euro** (includes the Latvian salary calculator) or **US dollar**.

---

## 2. Your bridge (free Cloudflare Worker)

The bridge is your own small server. It keeps your encrypted backup and talks to your bank. Each person makes their own.

1. Sign up free at **https://dash.cloudflare.com/sign-up**.
2. **Storage & Databases > KV > Create** a namespace, name it `budget-store`.
3. **Workers & Pages > Create > Worker**, name it `budget-bridge`, **Deploy**.
4. **Edit code**, delete everything, paste the whole file `worker/worker.js` (from `https://github.com/automatika0001-dotcom/budget/blob/main/worker/worker.js`, use the **Copy raw file** button), **Deploy**.
5. **Settings > Bindings > Add > KV namespace**: variable name `STORE` (exactly), namespace `budget-store`. Save.
6. **Settings > Variables and Secrets**, add as **Secret**:
   - `APP_TOKEN`: a long random password you invent (40+ letters and digits). This is your **bridge password**.
   - `ALLOWED_ORIGIN`: `https://automatika0001-dotcom.github.io`
7. Note your Worker address, e.g. `https://budget-bridge.yourname.workers.dev`. Opening it in a browser should show `"kv":true`.

## 3. Encrypted backup (strongly recommended)

In the app: **Settings > Your bridge**: paste the Worker address and the bridge password. Then **Encrypted backup**: choose a passphrase (8+ characters) and tap **Turn on backup**.

- Your data is encrypted on the phone before upload. The Worker only stores scrambled bytes.
- There is one backup slot; each new backup replaces the last one.
- It backs up when something changed, at most 3 times a day (8+ hours apart), whenever the app is open or you leave it. **Back up now** does it immediately.
- Tap **Copy recovery code** and save it with your passphrase in your password manager (iPhone: Passwords app). **If you lose the passphrase, the backup cannot be opened by anyone.**

**Getting your data back** (deleted the app, new phone): install the app as in step 1, and on the setup screen tap **I already used Budžets: restore my backup**. Paste the recovery code and your passphrase. Everything returns, including your bank connection settings.

Safety: a fresh install never overwrites an existing backup. If you set up from scratch by mistake, Settings shows "Backup paused" and lets you restore the old one or deliberately replace it.

---

## 4. Bank sync

Pick your bank in **Settings > Bank sync**.

### SEB (Latvia), via Enable Banking

1. Follow **BANK_SETUP.md** steps 1 and 2 (Enable Banking application, link your SEB account). In **Allowed redirect URLs** add both:
   - `https://automatika0001-dotcom.github.io/budget/`
   - `https://budget-bridge.yourname.workers.dev/callback` (your Worker address + `/callback`; needed on iPhone)
2. Add two more Worker secrets: `EB_APP_ID` (Application ID) and `EB_PRIVATE_KEY` (the whole .pem file, including the BEGIN/END lines).
3. In the app: **Settings > Bank sync > SEB > Connect SEB > Open bank login**, approve with Smart-ID, come back to the app. It connects by itself within a few seconds.

The consent lasts up to 180 days; the app warns you a week before.

### America First Credit Union (USA), via Plaid

1. Sign up at **https://dashboard.plaid.com/signup**. A new team gets the free **Trial plan** (real bank data, up to 10 bank logins). If Plaid asks for a company or app profile, describe it as a personal budgeting app for your own accounts.
2. **Developers > Keys**: copy the **client_id** and the **Production secret**.
3. **Developers > API > Allowed redirect URIs**: add `https://budget-bridge.yourname.workers.dev/plaid/link` (your Worker address + `/plaid/link`). America First uses its own login page, which needs this.
4. Add Worker secrets: `PLAID_CLIENT_ID` and `PLAID_SECRET`.
5. In the app: **Settings > Bank sync > America First Credit Union > Connect AFCU > Open bank login**, log in, come back. It connects by itself.

What it syncs: your checking account(s). Card payments appear as soon as AFCU reports them (usually minutes to a few hours) and count straight away; when the bank finalises a payment it updates the same entry, so nothing is counted twice. Each time you open the app, Plaid is asked to fetch fresh data (at most every 15 minutes).

Tip for both banks: **Ignore transactions containing** with words like `savings` or `transfer` keeps moves between your own accounts out of your spending.

---

## Notes

- **Several people**: each person repeats this guide with their own Cloudflare (and Enable Banking or Plaid) account. Never share your Worker or its secrets: anyone with them could read your bank data.
- **Plaid is the one free tier that is called a trial.** Plaid lists no end date and no cap on syncing already-connected accounts, but it could change its terms. If it ever does, only the Worker needs a different provider; the app and your data are not affected.
- **Free-tier limits** (far above what one person uses): Cloudflare Workers 100,000 requests/day, KV 1,000 writes/day.
