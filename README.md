# Metalix Print MVP

Quick start
 - Install and run the server:

```bash
cd server
npm install
npm start
```

 - The server listens on port 5000. Health check: `http://localhost:5000/api/health`

Production (single-process)
 - Place your logo file named `logo.png` in `server/public` (optional). A placeholder `logo.svg` is included.
 - Build the client and run the server from the project root:

```bash
npm run start:prod
```

 - The server will serve the built client and API on the configured port (default `5000`). Health check: `http://localhost:5000/api/health`

Server-side PDF analysis
- The server exposes `POST /api/analyze` which accepts a `multipart/form-data` upload with `file` field and will return `{ pageCount, colorCount, colorFlags, thumbnail }` after analyzing all pages. This uses `canvas` and `pdfjs-dist` and may require native libraries on macOS/Linux.

Razorpay webhooks
- Configure `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` in your environment for real payments. The server also exposes `POST /api/webhook` — configure this URL in your Razorpay dashboard and the server will verify the signature.

Native deps for server PDF analysis (macOS)
- The `canvas` package requires system libraries. On macOS install via Homebrew if needed:

```bash
# macOS (Homebrew)
brew install pkg-config cairo pango libpng jpeg giflib librsvg
```

After installing system deps, install server packages and run the server.

Client (dev)
 - The `client` folder contains a Vite + React app. For development run:

```bash
cd client
npm install
npm run dev
```

React + Node.js starter project for print.metalix.in

## Features
- Homepage
- File upload UI
- Pricing calculator
- Express API
- Order endpoint

Deploy and extend with PostgreSQL, Razorpay, authentication, and admin dashboard.
