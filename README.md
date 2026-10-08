# Budžets: personal budget app for iPhone and Android

**Setting it up for someone new (iPhone or Android, SEB or America First CU, encrypted backup): see [FRIENDS_SETUP.md](FRIENDS_SETUP.md).** The rest of this file is the owner's guide (publishing updates, building the APK).

### Owner: one shared server
All users share your Worker; new users need nothing but the app. Owner setup (Plaid keys, limits) is in FRIENDS_SETUP.md. After changing `worker/worker.js`, paste it into the Worker and Deploy again.

A real Android app (APK) you install once. Every time you push from your PC, the installed app updates itself the next time you open it, including big changes. Your data stays on the phone and survives updates.

How it works: the APK is a small native shell. The screens and logic live on GitHub Pages, and the app loads the newest version from there (and keeps a copy for offline use). GitHub also builds the APK for you in the cloud, so you never need Android Studio.

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

## 2. Build the APK on GitHub (once)

1. In your repo on github.com: **Settings > Secrets and variables > Actions > New repository secret**.
   - Name: `ANDROID_KEYSTORE`
   - Secret: open `ANDROID_KEYSTORE-secret.txt` (sent to you separately), select all, copy, paste.
   - Click **Add secret**. This is your app's signing key: keep that file somewhere safe (e.g. a USB stick or password manager), never put it in the repo.
2. Push the project (this includes the `android` folder and the build script):
   ```
   git add -A
   git commit -m "android app"
   git push
   ```
3. Open the **Actions** tab in your repo. "Build Android app" runs for about 3 to 5 minutes. When it shows a green tick, the APK is ready. (If it didn't start, click **Build Android app > Run workflow**.)

## 3. Install on your phone (once)

1. On your phone, open `https://github.com/automatika0001-dotcom/budget/releases`
2. Under **Budžets Android app**, tap **Budzets.apk** to download it.
3. Open the downloaded file. Android will ask to allow installs from this source (Chrome or Files): tap **Settings**, switch on **Allow from this source**, go back, tap **Install**.
4. If Play Protect warns that it doesn't recognize the app, tap **More details > Install anyway**. That's normal for apps you build yourself.
5. Open **Budžets** from your app drawer and complete the short setup.

If you already entered data in the browser version: there, use Settings > Export backup, then in the app use Settings > Import backup. The app and the browser keep separate data.

## 4. Push an update from your PC (any time)

Edit any file, then in this folder run:

- Windows: `.\deploy.ps1 "what changed"`
- Mac/Linux: `./deploy.sh "what changed"`

That bumps the version number, commits and pushes. Within about a minute, the next time you open the app it loads the new version and shows "Updated to version x.y.z". You can also tap **Settings > Check for update**. No reinstalling.

You only ever need a new APK if you change something inside the `android` folder (app name, icon, address). GitHub rebuilds it automatically; install it over the old one and your data is kept, as long as the same signing key is used.

If your data format ever needs to change in a big update, add a step in `migrate()` in `js/app.js`; old data is always carried forward.

**Back up now and then:** Settings > Export backup saves a JSON file to your phone's Downloads folder. If you ever clear Chrome's data or change phone, Import backup restores everything.

---

## 5. Connect SEB (optional, about 15 minutes)

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
Settings > SEB bank sync: paste the Bridge URL and password, tap **Connect SEB**, approve with Smart-ID. The bank login opens inside the app and returns to it afterwards, then transactions import.

After that it syncs automatically every time you open the app or bring it back from the background (at most every 5 minutes). Because you're present, the bank's 4-per-day background limit doesn't apply. A manual **Sync now** button is in Settings. Bank consent lasts up to 180 days; the app warns you a week before it expires so you can tap Reconnect.

Tips:
- **Ignore list:** add words like your own name or "savings" so transfers between your own accounts aren't counted as spending.
- Delete an imported item and it won't come back on the next sync.
- Merchant names come from what SEB sends (card payments usually include the shop name). You can edit any place name.

---

## 6. Live payments from Google Wallet (Android app 1.1+)

Pay with Google Wallet and the expense appears in Budžets within a second, even if the app is closed (it's picked up next time you open it).

1. Settings > Live payments > **Turn on**, find Budžets in the list and allow it.
2. If the switch is greyed out ("Restricted setting", Android 13+): Settings > Live payments > **App info**, tap ⋮ (top right) > **Allow restricted settings**, then try again.

Duplicates: when the bank sync later brings in the same purchase (same amount within 3 days), it's linked to the live entry (tags: live + SEB) instead of being added again. An expense you typed by hand within an hour of the Wallet notification also stops the notification from adding a second copy. Declined payments and refunds are ignored.

Battery: Android only wakes the listener when a notification arrives; it ignores every app except the watched ones. Nothing runs on a timer in the background, and the app's own timers pause when it's not on screen.

If a payment isn't picked up: Settings > Live payments > Advanced shows the raw text of recent Wallet notifications and what happened to each. Send that text to improve the parser.

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
- `android/`: the native Android app (the address it loads is in `android/app/build.gradle`)
- `.github/workflows/android.yml`: builds the APK on GitHub
