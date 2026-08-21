# Metalix Print MVP

Online printing and stationery — customers upload a PDF / Word / PPT, pick print options
(or order passport photos, stationery, or a custom stamp), pay, and get it printed and
delivered or ready for pickup. Includes a marketing site, a customer order flow, a
multi-branch admin dashboard, a public order-tracking page, a blog, email/WhatsApp/SMS
marketing campaigns, AI-assisted Google review replies, and a daily analytics export to
BigQuery.

- **Server** — Express API + static host, single Node process (`server/`)
- **Marketing site** (`/`, `/blog`, `/policies/<slug>`, `/contact`) — static HTML/CSS/vanilla
  JS, `server/public/landing.html`. Each policy (`refund-reprint`, `delivery`,
  `terms-of-service`, `privacy`) is its own indexable page with distinct title/description/
  canonical; the bare `/policies` URL 301s to `/policies/refund-reprint`
- **Order flow** (`/order`) — a single static HTML page built by Vite, `client/` — plain
  HTML/CSS/vanilla JS, **no framework** (the `client` name and Vite build step predate a
  planned React migration that never happened). Handles both document printing and
  passport-photo packs in the same mixed cart
- **Stationery & Stamps catalogs** (`/stationery`, `/stamps`, `/cart`) — static HTML/CSS/
  vanilla JS, `server/public/stationery.html` / `stamps.html` / `cart.html`; each vertical
  can be toggled on/off independently from site settings
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
SMS/WhatsApp, and cloud features degrade to stubs until their environment variables are
provided.

---

## Configuration

Set these environment variables (via your process manager or a `server/.env` file) to
enable the corresponding features. **Do not commit real values** — keep secrets out of
the repo. In production these are pulled from Google Secret Manager at startup instead
(`server/secrets.js`) — the env var names below match the Secret Manager secret names
one-to-one (e.g. `TWILIO_WHATSAPP_NUMBER` ↔ secret `twilio-whatsapp-number`).

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `5050`) |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay payments, payment links & webhook verification. Live vs. test mode is implicit in the key type (`rzp_live_...` vs `rzp_test_...`) — no separate env toggle needed |
| `ADMIN_JWT_SECRET` | Signing secret for admin/customer sessions |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Bootstrap super-admin login (used once to seed the DB) |
| `ADMIN_RESET_EMAIL` | Where admin password-reset links are sent |
| `GOOGLE_CLIENT_ID` | Google sign-in (browser-side id-token verification only) |
| `GOOGLE_CLIENT_SECRET` | Server-side OAuth code exchange for the Google Reviews admin tab (`server/googleBusinessAuth.js`) — not used by sign-in. **The redirect URI `https://<host>/api/admin/google-reviews/oauth/callback` must be added to this OAuth Client's "Authorized redirect URIs" in Google Cloud Console manually** (Console-only, no API for it) — a fresh client, or a host change, needs this step or Google returns `redirect_uri_mismatch` |
| `ANTHROPIC_API_KEY` | Drafts suggested replies to Google reviews (`server/aiReply.js`) — the review's own text is never touched, only the reply |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Email delivery (SMTP) — order emails and email marketing campaigns |
| `CONTACT_EMAIL` | Where "contact us" and "new order" business alerts are sent. **Must be a genuinely different mailbox from `GMAIL_USER`** — Gmail/Workspace delivers self-addressed mail (including aliases of the same account) to Sent only, never Inbox. Defaults to `support@metalix.in`, which equals `GMAIL_USER`, so this must be overridden in production (currently set via a systemd drop-in on the VM, not in git — see deploy notes). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio account credentials — shared by SMS and WhatsApp sending |
| `TWILIO_MESSAGING_SERVICE_SID` | Twilio Messaging Service used for outbound SMS (order confirmation, payment link, order completed, and SMS marketing campaigns) |
| `TWILIO_WHATSAPP_NUMBER` | The approved WhatsApp Business Sender's E.164 number, **without** the `whatsapp:` prefix (`server/whatsapp.js` adds that itself) — required for WhatsApp campaign sends |
| `TWILIO_ORDER_CONFIRMATION_TEMPLATE_SID`, `TWILIO_PAYMENT_LINK_TEMPLATE_SID`, `TWILIO_ORDER_COMPLETED_TEMPLATE_SID` | Content SIDs (`HX...`) of pre-approved, DLT-registered SMS templates for each transactional message — India blocks A2P SMS whose body doesn't exactly match a registered template, so the actual wording lives in Twilio's Content template, not in this codebase |
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
| `orders` | One row per order: customer name/contact, uploaded file info, print options (paper, colour, sides, copies), delivery details, branch (`location_id`), amounts, payment/order status, and `archived_at` for soft-delete. An order's line items (documents, passport-photo packs, stationery products, services) live in JSON on the row, not a separate table. |
| `print_jobs` | Print-queue entries linked to an order, with status and timestamps. |
| `order_feedback` | One star rating + optional comment per order, left by the customer from the tracking page. |
| `google_reviews` | Public Google Business Profile reviews synced from the Business Profile API, each with an AI-drafted reply an admin edits and approves before it posts live. |
| `users` | Customer accounts — name, email, mobile, a hashed password, optional Google id, and a `marketing_opt_in` flag. |
| `admin_users` | Staff accounts — a `super_admin` sees every branch; a `branch_admin` is scoped to one `location_id` and a subset of dashboard tabs (`allowed_tabs`). |
| `locations` | Branches — address, hours, Maps link, `active`/`shop_open` flags. |
| `blog_posts` | SEO blog content (Markdown body, tags, cover image), managed from the admin Blog tab. |
| `product_categories`, `products` | Stationery/stamp catalog. Soft-delete only (`active` flag) once a product has been referenced by any order, so a historical line item never points at a vanished row. `products.cost_price` is admin/reporting-only and must never be forwarded by any public/customer-facing endpoint. |
| `stock_ledger` | Append-only stock audit trail — every adjustment (manual receive/damage, or system-driven order/return) writes exactly one row here, never mutated or deleted, so Stock History is always a true reconstruction of how a product's `stock_qty` got to its current value. |
| `cross_sell_rules` | Admin-configured "you may also need" recommendations, keyed by a trigger (a product type, or a specific product id). |
| `stamp_proofs` | Custom-stamp proof-approval history — one order/item can accumulate several rows over a changes-requested → re-upload cycle; the latest row for a given (order, item) is authoritative. |
| `message_templates` | Registry of pre-approved Twilio Content Templates (WhatsApp/SMS), each with a `content_sid` and the variable names it expects, so the campaign composer can prompt for them instead of guessing. |
| `campaigns` | One row per marketing campaign — channel (email/WhatsApp/SMS), audience filter, body/template, delivery stats, status. |
| `campaign_recipients` | Per-recipient send record for a campaign — a real delivery report (sent/failed/error) rather than just a "sent" toast. |
| `marketing_suppressions` | A permanent, contact+channel-keyed opt-out record, independent of whether an account exists — this is what makes unsubscribe work even for guest checkouts with no `users` row, and is checked as a floor no send can bypass. |
| `settings` | Key/value app config (pricing, site settings, the Google Business OAuth refresh token, etc.). |
| `password_resets` | Short-lived, single-use tokens for password resets. |

---

## Features

**Customer**
- Upload PDF / Word / PPT; the server analyses pages, colour, and page count
- Print options: paper size/type, B&W or colour, single/double-sided, orientation, copies
- Passport-photo packs — pick a size preset and quantity, with a live print-sheet layout
  preview (`server/passportLayout.js`, mirrored client-side for an instant preview that
  always matches what actually prints); mixes freely in the same cart as document prints
- Stationery catalog and custom stamps, each independently toggleable per site settings
- Live pricing calculator; choose a branch, home delivery or store pickup
- Razorpay checkout (online) or cash/UPI pay-on-delivery. Razorpay's client SDK hands back
  a cryptographically verifiable signature, so `verify-payment` checks it locally with no
  round trip to Razorpay; admin-sent payment links are confirmed via a signed redirect
  callback (primary) with the Razorpay webhook as a backup
- Accounts: email/mobile + password, Google sign-in, password reset by email
- Track order status and progress timeline from a link / QR code; rate a completed order;
  approve/request changes on a custom-stamp proof; download the invoice once completed
- Shop-closed state: outside a branch's hours, order/track/blog pages show a "closed" page

**Admin** (`/admin`)
- Multi-branch dashboard: orders, customers, archive, feedback, blog, pricing, staff,
  campaigns, Google reviews, and site/branch settings — a `branch_admin`'s view and API
  access are scoped to their branch and their `allowed_tabs`
- Manual order entry (New Order, a full-screen page) for phone/WhatsApp customers: paste a
  copied image directly into the form, JPG/PNG uploads default to whichever page size is
  marked "Photo" in Pricing, bulk-apply page size/paper type across multiple files, mobile-
  number autofill from past customers (backfilling a missing mobile on account match), and
  capturing marketing consent at order time
- Printable job sheet (PDF) per order, with per-file download
- Order status workflow (Queued → Printing → Delivery/Pickup → Completed), single or bulk;
  add/remove print lines, services, or stationery items on an existing order after creation
- **Cash-on-delivery orders cannot be marked Completed until payment is recorded** via the
  "Collect Cash" / "Collect UPI" action — enforced both in the UI and by the API
- Send a Razorpay payment link for phone/WhatsApp orders; "Recheck payment" manually
  re-queries Razorpay for a link's status as a hardening measure, for the rare case both
  the redirect callback and the webhook are delayed or lost
- Product & stamp catalog management: categories, stock adjustments with a full audit
  ledger, cross-sell rules, bulk CSV upload (with a downloadable template), custom-stamp
  proof upload/approval workflow
- **Marketing campaigns** (Email / WhatsApp / SMS) — see [Marketing campaigns](#marketing-campaigns-email--whatsapp--sms) below
- Google Reviews — see [Google Reviews](#google-reviews-ai-drafted-replies) below
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
`GET /api/product-categories` · `GET /api/products` · `GET /api/products/:slug` ·
`GET /api/cross-sell` · `GET /api/coupons/:code` · `GET /api/coupons/featured` ·
`GET /api/delivery-estimate` · `GET /api/maps-config` · `GET /api/bootstrap` ·
`POST /api/contact` · `GET /track/:id` (page) · `GET /api/track/:id` ·
`POST /api/track/:id/feedback` · `POST /api/track/:id/pay` ·
`GET /api/track/:id/items/:itemId/stamp-proof/image` ·
`POST /api/track/:id/items/:itemId/stamp-proof/respond` · `GET /unsubscribe`

**Uploads & orders** — `POST /api/upload` · `POST /api/stamp-assets/upload` ·
`POST /api/orders` · `GET /api/orders/:id` · `GET /api/orders/:id/invoice.pdf` ·
`POST /api/orders/:id/verify-payment` · `POST /api/webhook` ·
`GET /api/payment-links/callback`

**Customer auth** — `POST /api/auth/signup` · `POST /api/auth/login` ·
`POST /api/auth/google` · `POST /api/auth/forgot-password` ·
`POST /api/auth/reset-password` · `GET /api/me` · `GET /api/my/orders`

**Admin — orders** — `GET /api/admin/orders` · `POST /api/admin/orders` (manual/phone entry) ·
`GET /api/admin/orders/:id` · `PATCH /api/admin/orders/:id` ·
`POST /api/admin/orders/bulk-status` · `POST /api/admin/orders/:id/collect-payment` ·
`POST /api/admin/orders/:id/payment-link` · `POST /api/admin/orders/:id/recheck-payment` ·
`POST /api/admin/orders/:id/rollback-payment` · `POST /api/admin/orders/:id/send-invoice` ·
`GET /api/admin/orders/:id/invoice.pdf` · `POST /api/admin/orders/:id/jobsheet-pdf` ·
`POST /api/admin/orders/:id/add-print-line` · `POST /api/admin/orders/:id/add-service` ·
`POST /api/admin/orders/:id/add-stationery` · `POST /api/admin/orders/:id/remove-service` ·
`POST /api/admin/orders/:id/items/:itemId/status` ·
`POST /api/admin/orders/:id/items/:itemId/stamp-proof` ·
`GET /api/admin/orders/:id/items/:itemId/stamp-proof` ·
`GET /api/admin/orders/:id/files/:fileId/download` · `DELETE /api/admin/orders/:id` (archive) ·
`POST /api/admin/orders/:id/restore` · `DELETE /api/admin/orders/:id/purge` ·
`POST /api/admin/orders/bulk-delete` · `GET /api/admin/archive` ·
`GET /api/admin/feedback` · `PATCH /api/admin/feedback/:id` ·
`DELETE /api/admin/feedback/:id` · `GET /api/admin/feedback/export`

**Admin — auth, staff & branches** — `POST /api/admin/login` ·
`POST /api/admin/forgot-password` · `POST /api/admin/reset-password` ·
`GET /api/admin/me` · `GET /api/admin/staff` · `POST /api/admin/staff` ·
`PUT /api/admin/staff/:id` · `DELETE /api/admin/staff/:id` ·
`GET /api/admin/my-location` · `PUT /api/admin/my-location` ·
`GET /api/admin/locations` · `PUT /api/admin/locations` ·
`GET /api/admin/customers` · `DELETE /api/admin/customers/:mobile` ·
`PATCH /api/admin/customers/:mobile` · `PATCH /api/admin/customers/marketing-opt-in` ·
`POST /api/admin/customers/bulk-marketing-opt-in` · `POST /api/admin/customers/bulk-archive` ·
`GET /api/admin/stages` · `PUT /api/admin/stages`

**Admin — pricing, settings & blog** — `PUT /api/admin/pricing` ·
`PUT /api/admin/settings` · `GET /api/admin/blog` · `POST /api/admin/blog` ·
`PUT /api/admin/blog/:id` · `DELETE /api/admin/blog/:id` ·
`POST /api/admin/blog/upload-cover`

**Admin — products, categories & catalog** — `GET /api/admin/products` ·
`POST /api/admin/products` · `PUT /api/admin/products/:id` ·
`DELETE /api/admin/products/:id` · `POST /api/admin/products/:id/deactivate` ·
`POST /api/admin/products/:id/reactivate` · `POST /api/admin/products/:id/adjust-stock` ·
`GET /api/admin/products/:id/stock-ledger` · `POST /api/admin/products/bulk-upload` ·
`GET /api/admin/products/bulk-template` · `GET /api/admin/product-categories` ·
`POST /api/admin/product-categories` · `PUT /api/admin/product-categories/:id` ·
`DELETE /api/admin/product-categories/:id` · `GET /api/admin/cross-sell-rules` ·
`POST /api/admin/cross-sell-rules` · `PUT /api/admin/cross-sell-rules/:id` ·
`DELETE /api/admin/cross-sell-rules/:id` · `POST /api/admin/products/upload-image` ·
`GET /api/admin/product-images` (used by the campaign image gallery too — every image ever
uploaded through this shared pipeline, with computed used/idle status) ·
`DELETE /api/admin/product-images/:filename` (blocked with 409 if still referenced anywhere)

**Admin — reports & analytics** — `GET /api/admin/analytics/sales` ·
`GET /api/admin/reports/line-items`

**Admin — marketing campaigns** — `GET /api/admin/campaigns/channel-status` ·
`GET /api/admin/campaigns` · `POST /api/admin/campaigns` · `GET /api/admin/campaigns/:id` ·
`PATCH /api/admin/campaigns/:id` · `DELETE /api/admin/campaigns/:id` ·
`GET /api/admin/campaigns/:id/audience` · `GET /api/admin/campaigns/:id/recipients` ·
`POST /api/admin/campaigns/:id/test-send` · `POST /api/admin/campaigns/:id/send` ·
`GET /api/admin/message-templates` · `POST /api/admin/message-templates` ·
`DELETE /api/admin/message-templates/:id`

**Admin — Google Reviews** — `GET /api/admin/google-reviews/status` ·
`GET /api/admin/google-reviews/oauth/start` · `GET /api/admin/google-reviews/oauth/callback` ·
`GET /api/admin/google-reviews/locations` · `POST /api/admin/google-reviews/location` ·
`POST /api/admin/google-reviews/disconnect` · `GET /api/admin/google-reviews` ·
`POST /api/admin/google-reviews/sync` · `POST /api/admin/google-reviews/:id/draft` ·
`POST /api/admin/google-reviews/:id/reply` · `POST /api/admin/google-reviews/:id/dismiss`

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
  approved for this project (Google's stated review window is 7-10 business days via the
  Business Profile Help Center's API contact form — separate and typically faster than the
  "up to 14 days" figure quoted in general docs), the `business.manage` OAuth scope added
  to the existing Google Cloud OAuth client (non-sensitive scope — no CASA/verification-
  video review required), **and that OAuth client's "Authorized redirect URIs" must include
  `https://<host>/api/admin/google-reviews/oauth/callback`**, added manually in Cloud
  Console (no API for this) — a fresh client or a host change needs this step, or Google
  rejects the connect flow with `redirect_uri_mismatch`.
- Until Business Profile API access is approved, calls against it are capped at a very low
  default quota — expect `Quota exceeded ... Requests per minute` on the location picker
  rather than actual data, even once OAuth itself succeeds. This clears on its own once
  access is granted; there's no separate quota-increase request to file.
- **Sync:** `server/scripts/syncGoogleReviews.js` (`npm run reviews-sync`), on a timer (see
  `deploy/metalix-reviews-sync.*.example`) — no-ops cleanly until a location is connected.
  The admin tab also has a "Sync now" button for an immediate pull instead of waiting for the
  next timer run.
- **Config:** `GOOGLE_CLIENT_SECRET` and `ANTHROPIC_API_KEY` (see Configuration above). The
  OAuth refresh token itself lives in the `settings` table under its own key, deliberately
  kept out of the public `GET /api/settings` response.

---

## Marketing campaigns (Email / WhatsApp / SMS)

The admin panel's "Campaigns" tab sends one-off broadcasts on three channels, orchestrated
by `server/campaigns.js`. All three enforce the same opt-in floor: `marketing_suppressions`
(a permanent, contact+channel-keyed unsubscribe record, independent of whether an account
exists) is checked no matter which audience source a campaign uses.

- **Audience sources:** the strict opt-in list (`users.marketing_opt_in`), or "all past
  customers" (email-only — reaches guest checkouts too, since it's contact-based rather than
  account-based). Every send still carries the required unsubscribe link/consent framing
  regardless of source.
- **Email** (`server/mailer.js`) — a composed HTML body, edited directly in the admin as raw
  HTML (not Markdown — literal newlines/asterisks won't auto-format; needs real `<p>`,
  `<ul><li>`, `<strong>` tags). Images are inserted via a gallery picker
  (`GET /api/admin/product-images`) over the same shared upload pool product photos, blog
  covers, and stamp reference photos already use, each tile tagged **Used** or **Idle**
  (computed live by scanning every table that can reference a `/product-uploads/` URL, not
  tracked in a second place that could drift) — idle images can be deleted straight from the
  gallery, re-checked server-side against live usage before the file is actually removed.
  Inserted image URLs are absolute (`window.location.origin` + path) — a relative URL
  resolves fine in a browser but has nothing to resolve against inside an email client, so it
  silently fails to load otherwise.
- **WhatsApp & SMS** (`server/whatsapp.js`, `server/sms.js`) — **cannot carry free-composed
  text** the way email can. WhatsApp's commerce policy blocks any business-initiated message
  sent outside a customer-initiated 24-hour session unless it uses a Meta-approved template;
  India's DLT rules separately block A2P SMS whose body doesn't exactly match a registered
  template. Both point a campaign at a pre-approved Twilio Content Template (`content_sid`,
  submitted and approved *outside* this app, via Twilio's Content Template Builder / WhatsApp
  Manager) rather than a composed body — `message_templates` is the registry of already-
  approved templates, registered from the admin's Templates screen (name + Content SID +
  the variable names it expects). A WhatsApp template approved for WhatsApp is **not**
  automatically usable for SMS or vice versa — they're independent approval pipelines even
  when the same Content resource could technically hold both a `twilio/media` and a
  `twilio/text` type.
- **Sending requires the underlying channel to actually be configured** —
  `GET /api/admin/campaigns/channel-status` reports `mailer.isConfigured()` /
  `sms.isConfigured()` / `whatsapp.isConfigured()`, and the UI shows "isn't configured yet"
  rather than let an admin build a whole campaign that can only fail at send time. WhatsApp
  specifically needs `TWILIO_WHATSAPP_NUMBER` set to an **online** Sender's number — check
  `messaging.twilio.com/v2/Channels/Senders?Channel=whatsapp` if unsure which of possibly
  several senders (the shared Twilio Sandbox number included) is the real one.
- **Always "Send test" first** — it skips the audience filter entirely and sends only to the
  configured test contact, the same real send path a full campaign uses.

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
timer to maintain. Supply configuration through the environment rather than committing it
— in production, secrets are pulled from Google Secret Manager at boot (`server/secrets.js`,
project `metalix-print` — note a same-named `metalix-vm` exists in an unrelated project
`metalix-prod`, so always pass `--project=metalix-print` explicitly with `gcloud`).

---

## Repository layout

```
client/                       Order/upload page — static HTML/CSS/vanilla JS bundled by Vite (no framework)
server/
  server.js                   Express app: routes, static host, startup
  db.js                       SQLite schema, migrations, queries
  secrets.js                  Loads configuration into the environment (Secret Manager in prod)
  pricing.js                  Pricing calculation
  pdfAnalyze.js               PDF page/colour analysis (canvas + pdfjs-dist)
  docConvert.js               Word/PPT → PDF via LibreOffice
  passportLayout.js           Passport-photo print-sheet grid layout math
  printQueue.js               Print-job queue
  invoice.js                  PDF invoice generation (pdf-lib)
  format.js                   Shared currency/number formatting
  razorpay.js                 Razorpay payments, checkout verification, payment links
  shipping.js                 Delivery-zone classification & distance pricing by pincode
  mailer.js, notify.js        Email / notifications
  sms.js, whatsapp.js         Twilio SMS & WhatsApp delivery (transactional + campaigns)
  campaigns.js                Marketing campaign send orchestration (audience → channel sender)
  backupDb.js                 Periodic database backup (cloud, falling back to a local copy in
                               server/data/backups/, pruned to last 28, if cloud is unavailable)
  fileRetention.js            Expired-file cleanup + 30-day archive purge
  scripts/bqSync.js           SQLite → BigQuery upsert
  scripts/syncGoogleReviews.js  Pull Google reviews + draft AI replies
  googleBusinessAuth.js       Google Business Profile OAuth + reviews API client
  aiReply.js                  Anthropic reply drafting
  public/                     landing.html (marketing site), admin.html (dashboard),
                               track.html (order tracking + feedback), blog.html/blog-post.html,
                               stationery.html/stamps.html/cart.html (catalogs), jobsheet.html
                               (printable job sheet), closed.html (shop-closed page), logo,
                               fonts, SEO files, product-uploads/ (shared image pool)
deploy/                       Caddyfile + systemd unit examples (nginx.conf.example: pre-2026-08-12 config, kept for rollback)
.github/workflows/            deploy.yml — automated deploy on push to main
```

## Scripts

| Command | Where | Does |
|---|---|---|
| `npm start` | root / `server/` | Start the server |
| `npm run build` | root | Install + build the client |
| `npm run start:prod` | root | Build client, then start server |
| `npm run bqsync` | `server/` | Run the BigQuery export once |
| `npm run reviews-sync` | `server/` | Pull new Google reviews + draft AI replies once |
