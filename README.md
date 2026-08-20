# Metalix Print MVP

Online document printing — customers upload a PDF / Word / PPT, pick print options, pay,
and get it printed and delivered or ready for pickup. Includes a marketing site, a
customer order flow, a multi-branch admin dashboard, a public order-tracking page, a
blog, and a daily analytics export to BigQuery.

- **Server** — Express API + static host, single Node process (`server/`)
- **Marketing site** (`/`, `/blog`, `/policies/<slug>`, `/contact`) — static HTML/CSS/vanilla
  JS, `server/public/landing.html`. Each policy (`refund-reprint`, `delivery`,
  `terms-of-service`, `privacy`) is its own indexable page with distinct title/description/
  canonical; the bare `/policies` URL 301s to `/policies/refund-reprint`
- **Order flow** (catch-all route, e.g. `/order`) — a single static HTML page built by Vite,
  `client/` — plain HTML/CSS/vanilla JS, **no framework** (the `client` name and Vite
  build step predate a planned React migration that never happened)
- **Admin dashboard** (`/admin`) — static HTML/CSS/vanilla JS, `server/public/admin.html`
- **Order tracking** (`/track/:id`) — static HTML/CSS/vanilla JS, `server/public/track.html`
- **Data** — SQLite (`better-sqlite3`), file `server/data/metalix.db`

---

## Quick start (development)

**Server** (listens on port `5050`):

```bash
cd server
npm install
npm start          # or: npm run dev
```

Health check: `http://localhost:5050/api/health`

**Client** (Vite dev server, for the order/upload page only):

```bash
cd client
npm install
npm run dev
```

With no configuration the server still boots using development defaults; payment, email,
and cloud features degrade to stubs until their environment variables are provided.

---

## Configuration

Set these environment variables (via your process manager or a `server/.env` file) to
enable the corresponding features. **Do not commit real values** — keep secrets out of
the repo.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `5050`) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay payments, payment links & webhook verification. Live vs. test mode is implicit in the key type (`rzp_live_...` vs `rzp_test_...`) — no separate env toggle needed |
| `ADMIN_JWT_SECRET` | Signing secret for admin/customer sessions |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Bootstrap super-admin login (used once to seed the DB) |
| `ADMIN_RESET_EMAIL` | Where admin password-reset links are sent |
| `GOOGLE_CLIENT_ID` | Google sign-in (browser-side id-token verification only) |
| `GOOGLE_CLIENT_SECRET` | Server-side OAuth code exchange for the Google Reviews admin tab (`server/googleBusinessAuth.js`) — not used by sign-in |
| `ANTHROPIC_API_KEY` | Drafts suggested replies to Google reviews (`server/aiReply.js`) — the review's own text is never touched, only the admin-approved reply |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Email delivery (SMTP) |
| `CONTACT_EMAIL` | Where "contact us" and "new order" business alerts are sent. **Must be a genuinely different mailbox from `GMAIL_USER`** — Gmail/Workspace delivers self-addressed mail (including aliases of the same account) to Sent only, never Inbox. Defaults to `support@metalix.in`, which equals `GMAIL_USER`, so this must be overridden in production (currently set via a systemd drop-in on the VM, not in git — see `deploy-process` notes). |
| `SOFFICE_BIN` | Path to LibreOffice `soffice` for Word/PPT → PDF |

---

## Native dependencies

- **`canvas` + `pdfjs-dist`** — server-side PDF analysis (page count, colour, thumbnail).
  `canvas` needs system libraries:

  ```bash
  # macOS (Homebrew)
  brew install pkg-config cairo pango libpng jpeg giflib librsvg
  # Debian/Ubuntu
  sudo apt-get install -y libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev
  ```

- **LibreOffice** (`soffice`) — converts Word/PPT uploads to PDF. Install it and, if
  needed, set `SOFFICE_BIN` to the binary path.

---

## Database tables

SQLite (`server/data/metalix.db`, WAL mode). Schema and lightweight migrations are in
`server/db.js`.

| Table | What it holds |
|---|---|
| `orders` | One row per order: customer name/contact, uploaded file info, print options (paper, colour, sides, copies), delivery details, branch (`location_id`), amounts, payment/order status, and `archived_at` for soft-delete. |
| `print_jobs` | Print-queue entries linked to an order, with status and timestamps. |
| `order_feedback` | One star rating + optional comment per order, left by the customer from the tracking page. |
| `google_reviews` | Public Google Business Profile reviews synced from the Business Profile API, each with an AI-drafted reply an admin edits and approves before it posts live. |
| `users` | Customer accounts — name, email, mobile, a hashed password, and optional Google id. |
| `admin_users` | Staff accounts — a `super_admin` sees every branch; a `branch_admin` is scoped to one `location_id` and a subset of dashboard tabs (`allowed_tabs`). |
| `locations` | Branches — address, hours, Maps link, `active`/`shop_open` flags. |
| `blog_posts` | SEO blog content (Markdown body, tags, cover image), managed from the admin Blog tab. |
| `settings` | Key/value app config (pricing, site settings). |
| `password_resets` | Short-lived, single-use tokens for password resets. |

---

## Features

**Customer**
- Upload PDF / Word / PPT; the server analyses pages, colour, and page count
- Print options: paper size/type, B&W or colour, single/double-sided, orientation, copies
- Live pricing calculator; choose a branch, home delivery or store pickup
- Razorpay checkout (online) or cash/UPI pay-on-delivery. Razorpay's client SDK hands back
  a cryptographically verifiable signature, so `verify-payment` checks it locally with no
  round trip to Razorpay; admin-sent payment links are confirmed via a signed redirect
  callback (primary) with the Razorpay webhook as a backup
- Accounts: email/mobile + password, Google sign-in, password reset by email
- Track order status and progress timeline from a link / QR code; rate a completed order
- Shop-closed state: outside a branch's hours, order/track/blog pages show a "closed" page

**Admin** (`/admin`)
- Multi-branch dashboard: orders, customers, archive, feedback, blog, pricing, staff, and
  site/branch settings — a `branch_admin`'s view and API access are scoped to their branch
  and their `allowed_tabs`
- Manual order entry (New Order) for phone/WhatsApp customers: paste a copied image
  directly into the modal, JPG/PNG uploads default to whichever page size is marked
  "Photo" in Pricing, bulk-apply page size/paper type across multiple files, and
  mobile-number autofill from past customers
- Printable job sheet (PDF) per order, with per-file download
- Order status workflow (Queued → Printing → Delivery/Pickup → Completed), single or bulk
- **Cash-on-delivery orders cannot be marked Completed until payment is recorded** via the
  "Collect Cash" / "Collect UPI" action — enforced both in the UI and by the API
- Send a Razorpay payment link for phone/WhatsApp orders; "Recheck payment" manually
  re-queries Razorpay for a link's status as a hardening measure, for the rare case both
  the redirect callback and the webhook are delayed or lost
- Soft-delete ("Archive") with a 30-day recovery window before a background job purges the
  order and its files permanently
- Analytics & SEO settings: Google Tag Manager container ID, Google Search Console
  verification (meta-tag method), and an optional direct GA Measurement ID snippet (only
  needed for GSC's separate "Google Analytics" ownership-verification method)
- Login by ID + password; "Forgot password" emails a time-limited reset link (the login
  ID must be correct, and the link goes only to the configured reset email); both admin and
  customer login are rate-limited (8 attempts / 15 min per IP + identifier)

---

## API reference

**Public** — `GET /api/health` · `GET /api/pricing` · `GET /api/settings` ·
`GET /api/locations` · `GET /api/auth/config` · `GET /api/blog` · `GET /api/blog/:slug` ·
`POST /api/contact` · `GET /track/:id` (page) · `GET /api/track/:id` ·
`POST /api/track/:id/feedback`

**Uploads & orders** — `POST /api/upload` · `POST /api/orders` · `GET /api/orders/:id` ·
`POST /api/orders/:id/verify-payment` · `POST /api/webhook` ·
`GET /api/payment-links/callback`

**Customer auth** — `POST /api/auth/signup` · `POST /api/auth/login` ·
`POST /api/auth/google` · `POST /api/auth/forgot-password` ·
`POST /api/auth/reset-password` · `GET /api/me` · `GET /api/my/orders`

**Admin — orders** — `GET /api/admin/orders` · `POST /api/admin/orders` (manual/phone entry) ·
`GET /api/admin/orders/:id` ·
`PATCH /api/admin/orders/:id` · `POST /api/admin/orders/bulk-status` ·
`POST /api/admin/orders/:id/collect-payment` · `POST /api/admin/orders/:id/payment-link` ·
`POST /api/admin/orders/:id/recheck-payment` · `POST /api/admin/orders/:id/jobsheet-pdf` ·
`GET /api/admin/orders/:id/files/:fileId/download` · `DELETE /api/admin/orders/:id` (archive) ·
`POST /api/admin/orders/:id/restore` · `DELETE /api/admin/orders/:id/purge` ·
`POST /api/admin/orders/bulk-delete` · `GET /api/admin/archive` · `GET /api/admin/feedback`

**Admin — auth, staff & branches** — `POST /api/admin/login` ·
`POST /api/admin/forgot-password` · `POST /api/admin/reset-password` ·
`GET /api/admin/me` · `GET /api/admin/staff` · `POST /api/admin/staff` ·
`PUT /api/admin/staff/:id` · `DELETE /api/admin/staff/:id` ·
`GET /api/admin/my-location` · `PUT /api/admin/my-location` ·
`GET /api/admin/locations` · `PUT /api/admin/locations` ·
`GET /api/admin/customers` · `DELETE /api/admin/customers/:mobile` ·
`GET /api/admin/stages` · `PUT /api/admin/stages`

**Admin — pricing, settings & blog** — `PUT /api/admin/pricing` ·
`PUT /api/admin/settings` · `GET /api/admin/blog` · `POST /api/admin/blog` ·
`PUT /api/admin/blog/:id` · `DELETE /api/admin/blog/:id` ·
`POST /api/admin/blog/upload-cover`

---

## Analytics: SQLite → BigQuery

`server/scripts/bqSync.js` (`npm run bqsync`) exports the business tables (`orders`,
`print_jobs`, `users`) to a BigQuery dataset so the data is queryable there.

- **Mode:** incremental **upsert** — loads current rows into `stg_*` staging tables, then
  `MERGE`s into the target on `id` (new rows inserted, existing rows updated in place).
  Never full-reloads; never deletes from the target.
- **Excluded by design:** the users' hashed password, the `password_resets` table, and
  `settings` — no analytics value.
- **Timestamps** are epoch-millisecond integers; wrap with `TIMESTAMP_MILLIS(created_at)`
  in BigQuery.
- **Schedule:** run on a timer (see `deploy/metalix-bqsync.*.example`). Requires BigQuery
  access for the runtime environment. Run manually with `npm --prefix server run bqsync`.

---

## Google Reviews (AI-drafted replies)

The admin panel's "Google Reviews" tab connects to a Google Business Profile location (OAuth,
`server/googleBusinessAuth.js`) and syncs in its public reviews. Each new review gets a
suggested reply drafted by `server/aiReply.js` (Anthropic) — the review's own text is never
touched, only the reply, and nothing posts to Google until an admin edits/approves it in the
tab.

- **Setup prerequisites** (external, not code): a Google Business Profile API access request
  approved for this project (up to ~2 weeks, see Google's Business Profile Help Center), and
  the `business.manage` OAuth scope added to the existing Google Cloud OAuth client — kept in
  **Testing** publishing status with the connecting admin's Google account added as a test
  user, so it never needs Google's full app-verification review.
- **Sync:** `server/scripts/syncGoogleReviews.js` (`npm run reviews-sync`), on a timer (see
  `deploy/metalix-reviews-sync.*.example`) — no-ops cleanly until a location is connected.
  The admin tab also has a "Sync now" button for an immediate pull instead of waiting for the
  next timer run.
- **Config:** `GOOGLE_CLIENT_SECRET` and `ANTHROPIC_API_KEY` (see Configuration above). The
  OAuth refresh token itself lives in the `settings` table under its own key, deliberately
  kept out of the public `GET /api/settings` response.

---

## Production

**Live deploys are fully automated.** `.github/workflows/deploy.yml` runs on a self-hosted
GitHub Actions runner installed directly on the production VM: on every push to `main` it
pulls, conditionally reinstalls dependencies for whichever side (`server/`/`client/`)
changed, and rebuilds `client/dist`, all *before* touching the running service — then stops
`metalix`, conditionally runs the server's `npm ci`, and starts it again. Downtime per
deploy is just that stop→start gap (observed ~130ms with no server dependency change), not
the build time. `git push origin main` is the entire deploy step — no manual SSH needed.

`client/dist/` is **not** committed to the repo (it's gitignored) — it's a pure build
artifact, unconditionally regenerated by the workflow on every deploy. Don't commit a
locally-built copy of it.

To reproduce a production-style run manually (from the repo root):

```bash
npm run start:prod    # builds client/, then starts the server
```

Typical underlying setup: the server runs behind a reverse proxy (Caddy, see
`deploy/Caddyfile.example`; migrated from nginx on 2026-08-12 — `deploy/nginx.conf.example`
is kept for reference/rollback) and is kept alive by the `metalix` systemd service. Caddy
manages its own TLS cert (Let's Encrypt) automatically, so there's no certbot renewal
timer to maintain. Supply configuration through the environment rather than committing it.

---

## Repository layout

```
client/                 Order/upload page — static HTML/CSS/vanilla JS bundled by Vite (no framework)
server/
  server.js             Express app: routes, static host, startup
  db.js                 SQLite schema, migrations, queries
  secrets.js            Loads configuration into the environment
  pricing.js            Pricing calculation
  pdfAnalyze.js         PDF page/colour analysis (canvas + pdfjs-dist)
  docConvert.js         Word/PPT → PDF via LibreOffice
  printQueue.js         Print-job queue
  mailer.js  notify.js  Email / notifications
  backupDb.js           Periodic database backup (cloud, falling back to a local copy in
                         server/data/backups/, pruned to last 28, if cloud is unavailable)
  fileRetention.js      Expired-file cleanup + 30-day archive purge
  scripts/bqSync.js     SQLite → BigQuery upsert
  scripts/syncGoogleReviews.js  Pull Google reviews + draft AI replies
  googleBusinessAuth.js Google Business Profile OAuth + reviews API client
  aiReply.js             Anthropic reply drafting
  public/               landing.html (marketing site), admin.html (dashboard),
                         track.html (order tracking + feedback), blog.html/blog-post.html,
                         jobsheet.html (printable job sheet), closed.html (shop-closed page),
                         logo, fonts, SEO files
deploy/                 Caddyfile + systemd unit examples (nginx.conf.example: pre-2026-08-12 config, kept for rollback)
.github/workflows/      deploy.yml — automated deploy on push to main
```

## Scripts

| Command | Where | Does |
|---|---|---|
| `npm start` | root / `server/` | Start the server |
| `npm run build` | root | Install + build the client |
| `npm run start:prod` | root | Build client, then start server |
| `npm run bqsync` | `server/` | Run the BigQuery export once |
| `npm run reviews-sync` | `server/` | Pull new Google reviews + draft AI replies once |
