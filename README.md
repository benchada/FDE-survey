# FDE Field Readiness — Cloudflare Worker

One Worker serves the quiz, saves each participant to D1, and emails them their debrief through Cloudflare Email Service.

Already set up in your Cloudflare account: D1 database `fde-readiness` (id `a6333541-5853-40fb-880c-a2208254b139`) with the `responses` table.

## Before you deploy (once)
1. Email Sending needs the **Workers Paid** plan ($5/month): Workers & Pages > Plans.
2. Onboard your sending domain: **Compute > Email Service > Email Sending > Onboard Domain** and pick `entrogx.com`. Cloudflare adds the DNS records (on `cf-bounce.entrogx.com` and `_dmarc`). If you already have a DMARC record, keep yours.
3. Check the settings in `wrangler.jsonc` under `vars`: `WORKSHOP_NAME`, `FROM_EMAIL` (must be on the onboarded domain), `REPLY_TO`, and optionally `FACILITATOR_BCC`.

## Deploy
Needs Node.js 20+. In Terminal, inside this folder:
```
npm install
npx wrangler login
npx wrangler deploy
```
Wrangler prints your link, e.g. `https://fde-survey.<your-subdomain>.workers.dev`.

## Optional
- **Download all responses as CSV:** `npx wrangler secret put ADMIN_KEY` (type any long password), then open `https://<your-link>/admin/export.csv?key=<that password>`.
- **Custom address** like `fde.entrogx.com`: uncomment the `routes` line in `wrangler.jsonc` and run `npx wrangler deploy` again.
- **Look at responses:** Cloudflare dashboard > Storage & Databases > D1 > fde-readiness > Console: `SELECT * FROM responses ORDER BY id DESC;`
- **Change questions or wording:** edit the `QUESTIONS`, `DIMS` or `LEVELS` blocks at the top of `src/index.js`, then deploy again. The page and the email both use them.

## Files
- `src/index.js` — the whole app (page, API, scoring, email)
- `wrangler.jsonc` — bindings and settings
- `schema.sql` — database table (already applied)
