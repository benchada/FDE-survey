# FDE Field Readiness — Cloudflare Worker

One Worker serves the quiz, saves each participant to D1, and emails them their debrief through Resend.

Already set up in your Cloudflare account: D1 database `fde-readiness` (id `a6333541-5853-40fb-880c-a2208254b139`) with the `responses` table.

Deployment: Cloudflare Workers Builds is connected to this repo, so every push to `main` deploys automatically.

## Email (Resend)
1. In Resend, make sure the domain of `FROM_EMAIL` (in `wrangler.jsonc`, currently `debrief@entrogx.com`) is verified under **Domains**.
2. In Resend, create an API key with **Sending access** under **API Keys**.
3. In Cloudflare: **Workers & Pages > fde-survey > Settings > Variables and Secrets > Add**, type **Secret**, name `RESEND_API_KEY`, paste the key, and deploy.

Without `RESEND_API_KEY`, the Worker falls back to Cloudflare Email Service (needs the Workers Paid plan and the domain onboarded under Compute > Email Service > Email Sending). Either way, every response is saved; the `email_status` column records whether the email went out and why not.

## Settings (`wrangler.jsonc` > `vars`)
`WORKSHOP_NAME`, `FROM_EMAIL`, `SENDER_NAME`, `REPLY_TO`, and optionally `FACILITATOR_BCC` (gets a copy of every result).

## Optional
- **Download all responses as CSV:** add a secret `ADMIN_KEY` (any long password) the same way as above, then open `https://<your-link>/admin/export.csv?key=<that password>`.
- **Custom address** like `fde.entrogx.com`: uncomment the `routes` line in `wrangler.jsonc` and push.
- **Look at responses:** Cloudflare dashboard > Storage & Databases > D1 > fde-readiness > Console: `SELECT * FROM responses ORDER BY id DESC;`
- **Change questions, resources or wording:** edit the `KIT`, `MASTERCLASS`, `QUESTIONS`, `DIMS` or `LEVELS` blocks near the top of `src/index.js`, then push. The page and the email both use them.
- **Deploy by hand instead:** `npm install`, `npx wrangler login`, `npx wrangler deploy` (Node.js 20+).

## Files
- `src/index.js` — the whole app (page, API, scoring, email)
- `wrangler.jsonc` — bindings and settings
- `schema.sql` — database table (already applied)
- `logo.png` — ENTROGX logo (also embedded in `src/index.js`)
