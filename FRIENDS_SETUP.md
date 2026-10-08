# Budžets: how to start

## For a new user (2 minutes)

**iPhone**
1. Open this link in **Safari**: `https://automatika0001-dotcom.github.io/budget/`
2. Tap **Share**, then **Add to Home Screen**.
3. Open **Budžets** from the home screen, fill in the short setup, tap **Connect America First CU** and log in to your bank.
4. When the app says **Save your recovery code**, tap **Copy it** and paste it into your Notes.

**Android**: install **Budzets.apk** from `https://github.com/automatika0001-dotcom/budget/releases`, then steps 3 and 4.

That's all. No accounts, no passwords to invent. Your budget is private: it's kept on your phone, and the automatic backup is encrypted on your phone before it leaves, so nobody else can read it.

**Deleted the app or new phone?** Install it again, tap **I already used Budžets: restore my backup** and paste your recovery code.

---

## For the owner: running the shared server (once)

One Cloudflare Worker (`https://budget-bridge.automatika-0001.workers.dev`) serves everyone. Its address is built into the app in `js/config.js`.

Worker settings (Cloudflare > Workers & Pages > budget-bridge > Settings):
- **Bindings**: KV namespace `STORE` (done).
- **Variables and Secrets** (Secret type):
  - `APP_TOKEN`: your owner password (already set; your own app uses it, and SEB sync is owner-only)
  - `ALLOWED_ORIGIN`: `https://automatika0001-dotcom.github.io`
  - `PLAID_CLIENT_ID` and `PLAID_SECRET`: for America First Credit Union, see below
  - `EB_APP_ID` and `EB_PRIVATE_KEY`: your SEB (already set)

### Plaid (America First CU for all users)
1. Sign up at **https://dashboard.plaid.com/signup**. A new team gets the free **Trial plan**. If asked for a company or app profile, describe it as a small personal budgeting app.
2. **Developers > Keys**: copy **client_id** and the **Production secret** into the Worker secrets above.
3. **Developers > API > Allowed redirect URIs**: add `https://budget-bridge.automatika-0001.workers.dev/plaid/link`.

Limits to know:
- The free plan allows **10 bank logins in total** across all users. Reconnecting the same person doesn't use a new one. When all 10 are used, new users see "The server's free bank connections are all used" and can still use the app without bank sync.
- Plaid calls this plan a trial. It lists no end date, but it could change its terms.
- As the server owner you hold each user's Plaid access, so they're trusting you with read access to their transactions. Their backups stay encrypted with their own key; you can't read those.
- To stop new users from being created, add the secret `SIGNUPS` = `off`.

### SEB
Enable Banking's free mode only reaches the owner's own accounts, so SEB sync is available in the owner's app only (the one with the owner password in Settings > Backup > Advanced).
