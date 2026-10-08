# Connect SEB to CBudget

About 15 minutes, done once. At the end, the app pulls your SEB transactions automatically every time you open it.

## How it fits together

```
CBudget app  ──>  Your Cloudflare Worker  ──>  Enable Banking  ──>  SEB
 (phone)          (holds the secret key)       (licensed PSD2       (you approve
                                                provider)            with Smart-ID)
```

- **Enable Banking** is a licensed open banking provider. Banks only share data with licensed providers, and Enable Banking has a free mode for private people linking their own accounts.
- **Cloudflare Worker** is a tiny free server that keeps your Enable Banking key secret. It never stores your transactions, it only passes them through.
- Your data still ends up only on your phone.

You will need: your PC, your phone with Smart-ID, and about 15 minutes.

---

## Step 1: Create the Enable Banking application

1. On your PC, go to **https://enablebanking.com/sign-in/** and sign up (email login is fine).
2. In the Control Panel, open **API applications** and click **Register new application**.
3. Fill in:

   | Field | Value |
   |---|---|
   | Environment | **Production** |
   | Application name | `Budzets` |
   | Allowed redirect URLs | `https://automatika0001-dotcom.github.io/budget/` |
   | Description | `Personal budget, own accounts only` |
   | Privacy / Terms URL (if asked) | `https://automatika0001-dotcom.github.io/budget/` |

   The redirect URL must match exactly, including `https://` and the `/` at the end.
4. For the key, choose **Generate in the browser** and click **Register**. Your browser downloads a file ending in **.pem**. Move it to a safe folder, **not** inside `budget-app` (so it never gets pushed to GitHub).
5. Copy the **Application ID** shown on the application card (looks like `1a2b3c4d-....`). Paste it into Notepad for now.

## Step 2: Link your SEB account (required for the free mode)

1. On the same application card, click **Link accounts** (sometimes under the **⋮** menu).
2. Choose **Latvia**, then **SEB**, account type **Personal**.
3. Log in to SEB with **Smart-ID** and approve access to your account(s).
4. Back in the Control Panel the application should now show **Restricted** and **Active**. That is the free personal mode and is what you want.

If you skip this step, the app connects but finds no accounts.

## Step 3: Make a bridge password

This is a password only the app and your Worker know. In PowerShell, run:

```powershell
-join ((48..57 + 65..90 + 97..122) | Get-Random -Count 40 | ForEach-Object {[char]$_})
```

Copy the 40-character result into Notepad. You'll paste it in two places.

## Step 4: Create the Cloudflare Worker

1. Go to **https://dash.cloudflare.com/sign-up** and create a free account.
2. In the left menu open **Compute (Workers) > Workers & Pages**, click **Create**, then **Create Worker** (choose "Start with Hello World" if asked).
3. Name it `budget-bridge` and click **Deploy**.
4. Click **Edit code**. Delete everything in the editor, then open `budget-app\worker\worker.js` on your PC in Notepad, copy all of it, paste it into the editor, and click **Deploy**.
5. Go back to the worker and open **Settings > Variables and Secrets**. Click **Add** four times, choose type **Secret** each time:

   | Name | Value |
   |---|---|
   | `EB_APP_ID` | The Application ID from Step 1 |
   | `EB_PRIVATE_KEY` | Open the .pem file in Notepad, copy **everything** including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |
   | `APP_TOKEN` | The bridge password from Step 3 |
   | `ALLOWED_ORIGIN` | `https://automatika0001-dotcom.github.io` (no `/budget`, no slash at the end) |

   Click **Deploy** / **Save** after adding them.
6. Copy your worker's address from the top of the page. It looks like `https://budget-bridge.YOURNAME.workers.dev`.
7. **Quick test:** open that address in your browser. You should see `{"error":"Budget bridge is running"}`. That means it's working.

## Step 5: Connect in the app

1. On your phone, open **CBudget** and tap the **gear icon** (top right).
2. Scroll to **SEB bank sync** and fill in:
   - **Bridge URL:** your worker address from Step 4.6
   - **Bridge password:** the password from Step 3
3. Optional but recommended: in **Ignore transactions containing**, add words that appear on transfers between your own accounts, e.g. your name or `savings`. Separate with commas. These won't count as spending.
4. Tap **Connect SEB**. The SEB login opens inside the app. Approve with **Smart-ID** (switch to the Smart-ID app, confirm, come back).
5. You're returned to CBudget and see **"SEB connected"**, followed by **"Imported X expenses"**.

Done. A small sync icon now appears at the top of the app.

---

## How syncing works from now on

- **Automatic:** whenever you open the app, if the last sync was more than 3 hours ago. Banks allow only about 4 automatic fetches per day, so it doesn't sync more often by itself.
- **Manual:** tap the sync icon at the top any time.
- **Only booked transactions** are imported. Card payments still "pending" appear a day or two later, once SEB books them.
- **Imports start from your budget start date.** Older transactions are skipped.
- **Incoming money** (salary etc.) is added as income. Turn off "Import incoming payments as income" in Settings if you prefer logging income by hand.
- **Deleting** an imported item keeps it deleted; it won't come back on the next sync.
- **Editing:** tap any imported item to rename the place (useful for the pie chart) or change the amount.

## Every 180 days

Banks require you to re-approve access at most every 180 days. A week before it expires the app shows a red banner. Then: **Settings > Reconnect SEB** and approve with Smart-ID again. Nothing else changes.

---

## Troubleshooting

| What you see | What it means and what to do |
|---|---|
| **"Wrong bridge password"** | The password in the app doesn't match `APP_TOKEN` in Cloudflare. Paste it again in both places (no spaces at the start or end). |
| **"Failed to fetch"** or nothing happens | Bridge URL is wrong, or `ALLOWED_ORIGIN` doesn't match exactly. It must be `https://automatika0001-dotcom.github.io` with no slash at the end. After changing a secret, wait a minute. |
| Enable Banking page says **redirect URL not allowed** | In the Enable Banking application, the redirect URL must be exactly `https://automatika0001-dotcom.github.io/budget/` |
| **"SEB connected (0 accounts)"** or nothing imports | You haven't done Step 2 (Link accounts) or linked a different account. Link SEB in the Enable Banking Control Panel, then **Reconnect SEB** in the app. |
| **"Key is PKCS#1..."** | Your .pem has `BEGIN RSA PRIVATE KEY`. Generate a new key in Enable Banking (Step 1.4) using **Generate in the browser**, update `EB_PRIVATE_KEY`. |
| **"ASPSP not found"** or bank not found | The bank name in Enable Banking might differ slightly. Tell me the exact error text and I'll adjust it. |
| **"SEB access expired"** | Normal after up to 180 days, or if you revoked access in SEB internet bank. Settings > Reconnect SEB. |
| A transfer to your own savings counts as spending | Add a word from that transaction to the ignore list, then delete the imported item once. |

Still stuck? Copy the exact error message and send it to me.

## Security notes

- The `.pem` key and bridge password are the only secrets. They live in Cloudflare and on your phone, never in GitHub.
- Access is **read-only**: nothing in this setup can make payments.
- To cut access completely: delete the application in Enable Banking, or revoke "third party access" in SEB internet bank.
