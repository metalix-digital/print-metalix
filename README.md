# Metalix Print MVP

Online document printing — customers upload a PDF / Word / PPT, pick print options, pay,
and get it printed and delivered or ready for pickup. Includes a marketing site, a
customer order flow, a multi-branch admin dashboard, a public order-tracking page, a
blog, and a daily analytics export to BigQuery.

- **Server** — Express API + static host, single Node process (`server/`)
- **Marketing site** (`/`, `/blog`, `/policies`) — static HTML/CSS/vanilla JS, `server/public/landing.html`
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
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay payments & webhook verification |
| `ADMIN_JWT_SECRET` | Signing secret for admin/customer sessions |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Bootstrap super-admin login (used once to seed the DB) |
| `ADMIN_RESET_EMAIL` | Where admin password-reset links are sent |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Email delivery (SMTP) |
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
- Razorpay checkout (online) or cash/UPI pay-on-delivery, with server-side signature
  verification for online payments
- Accounts: email/mobile + password, Google sign-in, password reset by email
- Track order status and progress timeline from a link / QR code; rate a completed order
- Shop-closed state: outside a branch's hours, order/track/blog pages show a "closed" page

**Admin** (`/admin`)
- Multi-branch dashboard: orders, customers, archive, feedback, blog, pricing, staff, and
  site/branch settings — a `branch_admin`'s view and API access are scoped to their branch
  and their `allowed_tabs`
- Printable job sheet (PDF) per order, with per-file download
- Order status workflow (Queued → Printing → Delivery/Pickup → Completed), single or bulk
- **Cash-on-delivery orders cannot be marked Completed until payment is recorded** via the
  "Collect Cash" / "Collect UPI" action — enforced both in the UI and by the API
- Soft-delete ("Archive") with a 30-day recovery window before a background job purges the
  order and its files permanently
- Login by ID + password; "Forgot password" emails a time-limited reset link (the login
  ID must be correct, and the link goes only to the configured reset email)

---

## API reference

**Public** — `GET /api/health` · `GET /api/pricing` · `GET /api/settings` ·
`GET /api/locations` · `GET /api/auth/config` · `GET /api/blog` · `GET /api/blog/:slug` ·
`POST /api/contact` · `GET /track/:id` (page) · `GET /api/track/:id` ·
`POST /api/track/:id/feedback`

**Uploads & orders** — `POST /api/upload` · `POST /api/orders` · `GET /api/orders/:id` ·
`POST /api/orders/:id/verify-payment` · `POST /api/webhook`

**Customer auth** — `POST /api/auth/signup` · `POST /api/auth/login` ·
`POST /api/auth/google` · `POST /api/auth/forgot-password` ·
`POST /api/auth/reset-password` · `GET /api/me` · `GET /api/my/orders`

**Admin — orders** — `GET /api/admin/orders` · `GET /api/admin/orders/:id` ·
`PATCH /api/admin/orders/:id` · `POST /api/admin/orders/bulk-status` ·
`POST /api/admin/orders/:id/collect-payment` · `POST /api/admin/orders/:id/jobsheet-pdf` ·
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

## Production

**Live deploys are fully automated.** `.github/workflows/deploy.yml` runs on a self-hosted
GitHub Actions runner installed directly on the production VM: on every push to `main` it
pulls, rebuilds only the side (`server/`/`client/`) whose files actually changed, and
restarts the `metalix` systemd service. `git push origin main` is the entire deploy step —
no manual SSH needed.

`client/dist/` is committed to the repo as a fallback so the app still serves before the
first automated build runs, but it is regenerated by the workflow on every deploy — avoid
committing a locally-rebuilt copy of it yourself, since a version that differs from what
the VM's own build produces can make the next `git pull` refuse to merge.

To reproduce a production-style run manually (from the repo root):

```bash
npm run start:prod    # builds client/, then starts the server
```

Typical underlying setup: the server runs behind a reverse proxy (see
`deploy/nginx.conf.example`) and is kept alive by the `metalix` systemd service. Supply
configuration through the environment rather than committing it.

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
  backupDb.js           Periodic database backup
  fileRetention.js      Expired-file cleanup + 30-day archive purge
  scripts/bqSync.js     SQLite → BigQuery upsert
  public/               landing.html (marketing site), admin.html (dashboard),
                         track.html (order tracking + feedback), blog.html/blog-post.html,
                         jobsheet.html (printable job sheet), closed.html (shop-closed page),
                         logo, fonts, SEO files
deploy/                 nginx + systemd unit examples
.github/workflows/      deploy.yml — automated deploy on push to main
```

## Scripts

| Command | Where | Does |
|---|---|---|
| `npm start` | root / `server/` | Start the server |
| `npm run build` | root | Install + build the client |
| `npm run start:prod` | root | Build client, then start server |
| `npm run bqsync` | `server/` | Run the BigQuery export once |
