# CBudget: how to start

## For a new user (2 minutes)

**iPhone**
1. Open this link in **Safari**: `https://automatika0001-dotcom.github.io/budget/`
2. Tap **Share**, then **Add to Home Screen**.
3. Open **CBudget** from the home screen and follow the steps. You choose a password in step 2: write it down. Latvia users connect SEB through their own free Enable Banking account, USA users connect America First CU through their own free Plaid account; the steps show every link and value to copy.

**Android**: install **Budzets.apk** from `https://github.com/automatika0001-dotcom/budget/releases`, then step 3.

No CBudget account and no passwords to invent. Your Plaid keys stay in your app (and your encrypted backup); the server only uses them to talk to Plaid for you. Your budget is private: it's kept on your phone, and the automatic backup is encrypted on your phone before it leaves, so nobody else can read it.

**Deleted the app or new phone?** Install it again, tap **I already used CBudget: restore my backup** and enter your password.

---

## For the owner: running the shared server (once)

One Cloudflare Worker (`https://budget-bridge.automatika-0001.workers.dev`) serves everyone. Its address is built into the app in `js/config.js`.

Worker settings (Cloudflare > Workers & Pages > budget-bridge > Settings):
- **Bindings**: KV namespace `STORE` (done).
- **Variables and Secrets** (Secret type):
  - `APP_TOKEN`: your owner password (already set; your own app uses it, and SEB sync is owner-only)
  - `ALLOWED_ORIGIN`: `https://automatika0001-dotcom.github.io`
  - `PLAID_CLIENT_ID` and `PLAID_SECRET`: optional, not needed (users paste their own keys in the app)
  - `EB_APP_ID` and `EB_PRIVATE_KEY`: your SEB (already set)

### Plaid
Each user brings their own free Plaid account and pastes the keys into their app, so every person gets their own 10 bank logins and nothing per-user goes into the Worker. You don't need to set anything up for them.

Optional: if you put `PLAID_CLIENT_ID` and `PLAID_SECRET` into the Worker, users without their own keys use yours instead (shared cap of 10 bank logins in total, and you'd hold read access to their transactions).

### SEB
Each user registers their own free Enable Banking app and adds its Application ID and .pem key in the app (setup steps 3 to 6), so their SEB accounts never touch yours. Your own app keeps using the keys stored on the Worker.
