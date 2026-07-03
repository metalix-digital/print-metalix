# Metalix Print MVP

Online document printing — customers upload a PDF / Word / PPT, pick print options, pay,
and get it printed and delivered. Includes a customer web app, a payment flow, an admin
dashboard, and a daily analytics export to BigQuery.

- **Client** — Vite + React single-page app (`client/`)
- **Server** — Express API + static host, single Node process (`server/`)
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

**Client** (Vite dev server):

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
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Bootstrap admin login (used once to seed the DB) |
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
| `orders` | One row per order: customer name/contact, uploaded file info, print options (paper, colour, sides, copies), delivery details, amounts, and payment/order status. |
| `print_jobs` | Print-queue entries linked to an order, with status and timestamps. |
| `users` | Customer accounts — name, email, mobile, a hashed password, and optional Google id. |
| `settings` | Key/value app config (pricing, site settings, and the admin login credential). |
| `password_resets` | Short-lived, single-use tokens for password resets. |

---

## Features

**Customer**
- Upload PDF / Word / PPT; the server analyses pages, colour, and page count
- Print options: paper size/type, B&W or colour, single/double-sided, orientation, copies
- Live pricing calculator; home delivery or store pickup
- Razorpay checkout with server-side signature verification
- Accounts: email/mobile + password, Google sign-in, password reset by email
- Track order status from a link / QR code

**Admin** (`/admin`)
- Dashboard for orders, customers, pricing, and site settings
- Printable job sheet (PDF) per order, with per-file download
- Order status workflow (Queued → Printing → Delivery/Pickup → Completed)
- Login by ID + password; "Forgot password" emails a time-limited reset link (the login
  ID must be correct, and the link goes only to the configured reset email)

---

## API reference

**Public** — `GET /api/health` · `GET /api/pricing` · `GET /api/settings` ·
`GET /api/auth/config` · `GET /track/:id`

**Uploads & orders** — `POST /api/upload` · `POST /api/orders` · `GET /api/orders/:id` ·
`POST /api/orders/:id/verify-payment` · `POST /api/webhook`

**Customer auth** — `POST /api/auth/signup` · `POST /api/auth/login` ·
`POST /api/auth/google` · `POST /api/auth/forgot-password` ·
`POST /api/auth/reset-password` · `GET /api/me` · `GET /api/my/orders`

**Admin** — `POST /api/admin/login` · `POST /api/admin/forgot-password` ·
`POST /api/admin/reset-password` · `GET /api/admin/orders` · `GET /api/admin/orders/:id` ·
`PATCH /api/admin/orders/:id` · `POST /api/admin/orders/:id/jobsheet-pdf` ·
`GET /api/admin/orders/:id/files/:fileId/download` · `GET /api/admin/customers` ·
`PUT /api/admin/pricing` · `PUT /api/admin/settings`

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

Build the client and serve everything from one Node process (from the repo root):

```bash
npm run start:prod    # builds client/, then starts the server
```

Typical setup: run the server behind a reverse proxy (see `deploy/nginx.conf.example`)
and keep it alive with a process manager or systemd service. Supply configuration through
the environment rather than committing it.

---

## Repository layout

```
client/                 Vite + React customer app
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
  fileRetention.js      Expired-file cleanup
  scripts/bqSync.js     SQLite → BigQuery upsert
  public/               admin dashboard, job sheet, tracking, logo, SEO files
deploy/                 nginx + systemd unit examples
```

## Scripts

| Command | Where | Does |
|---|---|---|
| `npm start` | root / `server/` | Start the server |
| `npm run build` | root | Install + build the client |
| `npm run start:prod` | root | Build client, then start server |
| `npm run bqsync` | `server/` | Run the BigQuery export once |
