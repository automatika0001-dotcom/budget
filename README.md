# Budžets: personal budget app for Android

Install it once on your phone. Every time you push from your PC, the phone gets the new version the next time you open the app, including big changes. Your data stays on the phone and survives updates.

How it works: it's a Progressive Web App hosted free on GitHub Pages. When you "Install" it from Chrome on Android, Chrome builds a real Android app (icon in the app drawer, own window, works offline). The app always checks GitHub for newer code when it opens.

---

## 1. Put it online (once, about 5 minutes)

1. Create a free GitHub account if you don't have one, and install **Git** on your PC (git-scm.com).
2. On github.com, click **New repository**, name it `budget`, set it **Public** (only the code is public, never your data), create it.
3. On your PC, open a terminal in this folder and run:
   ```
   git init
   git add -A
   git commit -m "first version"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/budget.git
   git push -u origin main
   ```
4. On GitHub: repo **Settings > Pages > Build and deployment > Source: Deploy from a branch**, branch `main`, folder `/ (root)`, Save.
5. After about a minute your app lives at `https://YOUR-USERNAME.github.io/budget/`.

## 2. Install on your phone (once)

1. Open that address in **Chrome** on your Android phone.
2. Tap the **⋮** menu, then **Install app** (or "Add to home screen" then "Install").
3. Open Budžets from your app drawer and complete the short setup.

## 3. Push an update from your PC (any time)

Edit any file, then in this folder run:

- Windows: `.\deploy.ps1 "what changed"`
- Mac/Linux: `./deploy.sh "what changed"`

That bumps the version number, commits and pushes. Within about a minute, the next time you open the app it loads the new version and shows "Updated to version x.y.z". You can also tap **Settings > Check for update**.

If your data format ever needs to change in a big update, add a step in `migrate()` in `js/app.js`; old data is always carried forward.

**Back up now and then:** Settings > Export backup saves a JSON file. If you ever clear Chrome's data or change phone, Import backup restores everything.

---

## 4. Connect SEB (optional, about 15 minutes)

Banks only give account data to licensed providers (PSD2). The free route for an individual in 2026 is **Enable Banking**, which has a free mode for linking **your own** accounts for personal use. A tiny free **Cloudflare Worker** sits between the app and Enable Banking so your secret key is never in the public website or on the phone.

### a) Enable Banking
1. Sign up at **enablebanking.com** and open the Control Panel.
2. **Applications > Register new application**: environment **Production**, any name (e.g. "Personal budget"), allowed redirect URL = your app address exactly, e.g. `https://YOUR-USERNAME.github.io/budget/`.
3. Let it generate the key pair and **download the private key (.pem)**. Keep it safe, never commit it.
4. Copy the **Application ID**.
5. In the application panel, choose **Link accounts**, pick Latvia > SEB, and log in with Smart-ID. The app then shows as Restricted / Active. This step is required: in free mode, only accounts linked here are returned.

### b) Cloudflare Worker (the bridge)
1. Sign up free at **cloudflare.com**, go to **Workers & Pages > Create > Worker**, name it `budget-bridge`, Deploy.
2. **Edit code**, delete the sample, paste everything from `worker/worker.js`, Deploy.
3. **Settings > Variables and Secrets**, add four secrets:
   - `EB_APP_ID`: the Application ID
   - `EB_PRIVATE_KEY`: open the .pem in Notepad and paste the whole thing including the BEGIN/END lines
   - `APP_TOKEN`: invent a long password
   - `ALLOWED_ORIGIN`: `https://YOUR-USERNAME.github.io`
4. Note the worker address, e.g. `https://budget-bridge.YOURNAME.workers.dev`.

### c) In the app
Settings > SEB bank sync: paste the Bridge URL and password, tap **Connect SEB**, approve with Smart-ID. You're sent back to the app and transactions import.

After that it syncs automatically when you open the app (at most every 3 hours, since banks limit background fetches to about 4 per day) or when you tap the sync button at the top. Bank consent lasts up to 180 days; the app warns you a week before it expires so you can tap Reconnect.

Tips:
- **Ignore list:** add words like your own name or "savings" so transfers between your own accounts aren't counted as spending.
- Delete an imported item and it won't come back on the next sync.
- Merchant names come from what SEB sends (card payments usually include the shop name). You can edit any place name.

---

## How the numbers work

- **Budget month** runs from your pay day to the day before the next pay day.
- **Monthly allowance** = net income logged in that month (or the expected salary if none logged yet) minus your monthly saving, plus or minus what carried over.
- **Today's number** = what's left of the allowance at the start of today ÷ days left (including today), minus what you've spent today. Overspend today and tomorrow's daily budget drops; underspend and it rises.
- **Overspend** at pay day is carried in full into next month's allowance, every month, until made up.
- **Leftover** at pay day rolls into next month once. If that rolled amount is still unspent at the following pay day, what's left of it goes into savings.
- **Savings:** each month adds your monthly saving. During the month, any overspend is subtracted from this month's saving live, so the goal date moves immediately. At pay day the overspend becomes next month's debt instead (so it isn't counted twice).
- **Goal date** = the pay day on which the total reaches your goal at the current monthly saving.

### Salary calculator (Latvia 2026)
Employee social insurance 10.5%, income tax 25.5% after the 550 € monthly non-taxable minimum (with a tax book submitted), 250 € per dependent, disability relief 154 € (group I/II) or 120 € (group III). Income above 105 300 € a year is taxed at 33%; the extra 7.5% is settled in the annual declaration and shown separately. These are the 2026 rules from VID and PwC Latvia's 2026 payroll guide; if rates change in 2027, update `TAX2026` in `js/logic.js` and deploy.

## Files
- `index.html`, `css/app.css`, `js/app.js`: the app
- `js/logic.js`: all calculations (tested: `node tests/logic.test.js`)
- `sw.js`: offline support and auto update
- `js/version.js`: version number (bumped by the deploy script)
- `worker/worker.js`: the SEB bridge for Cloudflare
