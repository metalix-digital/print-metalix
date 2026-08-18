const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const app = express()

// GCP client libraries (Secret Manager, Cloud Storage, BigQuery) each try their
// own credential resolution in the background. When no credentials are
// available at all (only happens on a machine without `gcloud auth
// application-default login` set up — never in production, where the VM's
// attached service account always resolves) google-auth-library's internal
// retry logic schedules its failure via setTimeout, detached from the promise
// chain any of our own try/catch blocks are attached to, so it can't be
// caught locally — it always crashes the whole process outright. Narrowly
// filtered so only that specific, known-non-actionable error class is
// swallowed; anything else still crashes the process as it should.
process.on('unhandledRejection', (reason) => {
  if (reason && reason.message && reason.message.includes('Could not load the default credentials')) {
    console.error('[gcp-auth] ignoring unreachable credential-retry rejection (no ADC in this environment):', reason.message)
    return
  }
  throw reason
})

// Payment webhook — registered before the global express.json() below on
// purpose. It needs the raw request body to verify the signature; once
// express.json() has parsed a request (it matches on Content-Type:
// application/json, which every webhook delivery sends), a later
// express.raw() on this same route becomes a silent no-op and req.body is
// already a parsed object, not a Buffer — crypto.createHmac(...).update()
// then throws on it. (This is exactly what was silently breaking every
// webhook delivery before this route was moved here — see git history.)
//
// Secondary source of truth for payment status (client-driven verification
// is primary for regular checkout; for payment links, the redirect callback
// below is primary, this webhook is the backup in case that redirect never
// lands — unreliable on mobile UPI regardless of provider).
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.RAZORPAY_KEY_SECRET || ''
  const signature = req.headers['x-razorpay-signature']
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex')
  if (signature !== expected) {
    return res.status(400).json({ error: 'invalid_signature' })
  }
  try {
    const event = JSON.parse(req.body.toString())
    console.log('Razorpay webhook event:', event.event)
    const payment = event.payload && event.payload.payment && event.payload.payment.entity
    // Payment Link orders don't have a razorpay_order_id on our side at
    // creation (see createPaymentLinkForOrder) — reference_id (our own order
    // id) is what ties the webhook back to the right order instead.
    const paymentLink = event.payload && event.payload.payment_link && event.payload.payment_link.entity
    if (event.event === 'payment_link.paid' && paymentLink && paymentLink.reference_id) {
      const order = db.getOrder(paymentLink.reference_id)
      if (order) {
        const paidOrder = db.markOrderPaid(order.id, {
          razorpay_payment_id: payment ? payment.id : null,
          order_status: 'Payment Successful'
        })
        if (paidOrder) {
          printQueue.enqueue(order.id)
          confirmStockForOrder(paidOrder)
          const fresh = db.getOrder(order.id)
          notify.sendOrderConfirmationSms(fresh)
          notify.sendOrderConfirmationEmail(fresh)
          mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
        }
      }
    } else if (payment && payment.order_id) {
      const order = db.db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(payment.order_id)
      if (order) {
        const paidOrder = db.markOrderPaid(order.id, {
          razorpay_payment_id: payment.id,
          order_status: 'Payment Successful'
        })
        if (paidOrder) {
          printQueue.enqueue(order.id)
          confirmStockForOrder(paidOrder)
          const fresh = db.getOrder(order.id)
          notify.sendOrderConfirmationSms(fresh)
          notify.sendOrderConfirmationEmail(fresh)
          mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
        }
      }
    }
    res.status(200).json({ ok: true })
  } catch (err) {
    res.status(400).end()
  }
})

// 20mb to fit the two full-page JPEG screenshots the job sheet PDF merge
// endpoint receives (html2canvas captures at 1.5x scale).
app.use(express.json({ limit: '20mb' }))

// Read at request time, not at module load — loadSecretsIntoEnv() (see bottom of
// this file) populates these from Secret Manager asynchronously before the
// server starts listening, so by the time any request arrives they're set.
// Shared by both admin tokens and customer tokens — the role claim is what
// distinguishes them (see requireAdmin / requireCustomer below).
function getJwtSecret() {
  return process.env.ADMIN_JWT_SECRET || 'dev-only-insecure-secret'
}

// The JWT only proves *identity* (decoded.sub); role/location/tab-permissions
// are re-read from the DB on every request rather than trusted from the
// token. That means revoking a staff login, changing their branch, or
// narrowing their allowed tabs takes effect on their very next request
// instead of waiting up to 12h for the token to expire.
function requireAdmin(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    if (decoded.role !== 'admin') return res.status(401).json({ error: 'unauthorized' })
    const admin = db.getAdminUserById(decoded.sub)
    if (!admin) return res.status(401).json({ error: 'unauthorized' })
    req.admin = { id: admin.id, adminRole: admin.role, locationId: admin.location_id || null, allowedTabs: admin.allowed_tabs }
    next()
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized' })
  }
}

// Locations/pricing/stages/site settings/staff management stay super-admin-only.
function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.admin.adminRole !== 'super_admin') return res.status(403).json({ error: 'forbidden', message: 'Super admin only.' })
    next()
  })
}

// The only tabs a branch_admin can ever see, restricted or not — Pricing/
// Locations/Stages/Settings/Staff stay super-admin-only regardless (enforced
// separately by requireSuperAdmin), so they're never part of this list.
const BRANCH_TABS = ['orders', 'customers', 'archive', 'feedback']

// Gates one admin-panel "tab" worth of routes. Super admin is never
// restricted; a branch admin with allowedTabs === null (the default — no
// restriction configured) also passes everything. Only an explicit array
// that omits tabKey blocks access.
function requireTab(tabKey) {
  return (req, res, next) => {
    if (req.admin.adminRole === 'super_admin') return next()
    if (Array.isArray(req.admin.allowedTabs) && !req.admin.allowedTabs.includes(tabKey)) {
      return res.status(403).json({ error: 'forbidden', message: 'You do not have access to this section.' })
    }
    next()
  }
}

// null (no filter — super admin sees everything) or the branch admin's
// locationId, for threading into db.js's location-scoped list functions.
function scopeLocation(req) {
  return req.admin.adminRole === 'branch_admin' ? req.admin.locationId : null
}

// For single-order routes: super admin owns everything; a branch admin only
// owns orders placed at their own location. Callers 404 (not 403) on a
// mismatch so a branch admin can't tell another branch's order even exists.
function ownsOrder(req, order) {
  return !!order && (req.admin.adminRole === 'super_admin' || order.location_id === req.admin.locationId)
}

function requireCustomer(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    if (decoded.role !== 'customer') return res.status(401).json({ error: 'unauthorized' })
    req.userId = decoded.sub
    next()
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized' })
  }
}

// In-memory login-attempt limiter — no external dependency needed for a
// single-process deploy. Keyed by IP + the identifier being tried, so
// brute-forcing one account (or spraying many accounts from one IP) both
// get slowed down; cleared on a successful login. A periodic sweep below
// drops expired entries so the Map can't grow unbounded.
const LOGIN_ATTEMPT_WINDOW_MS = 15 * 60 * 1000
const LOGIN_ATTEMPT_MAX = 8
const loginAttempts = new Map() // key -> { count, firstAttemptAt }

function checkLoginRateLimit(key) {
  const now = Date.now()
  const entry = loginAttempts.get(key)
  if (!entry || now - entry.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now })
    return false
  }
  entry.count += 1
  return entry.count > LOGIN_ATTEMPT_MAX
}
function clearLoginRateLimit(key) {
  loginAttempts.delete(key)
}
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of loginAttempts) {
    if (now - entry.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) loginAttempts.delete(key)
  }
}, LOGIN_ATTEMPT_WINDOW_MS).unref()

// Decode a customer token without rejecting the request if absent/invalid —
// used where login is optional (e.g. order creation works for guests too).
function getOptionalCustomerId(req) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return null
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    return decoded.role === 'customer' ? decoded.sub : null
  } catch (err) {
    return null
  }
}

const multer = require('multer')
const bcrypt = require('bcryptjs')
const { marked } = require('marked')
const db = require('./db')
const printQueue = require('./printQueue')
const notify = require('./notify')
const mailer = require('./mailer')
const sms = require('./sms')
const razorpay = require('./razorpay')
const pricing = require('./pricing')
const { analyzePdfBuffer } = require('./pdfAnalyze')
const { convertToPdf } = require('./docConvert')
const { cleanupExpiredFiles, deleteFilesForOrder, purgeExpiredArchive, cleanupOrphanedUploads } = require('./fileRetention')
const { buildInvoicePdf } = require('./invoice')
const { formatRupees } = require('./format')
const { computeGridLayout: computePassportGridLayout } = require('./passportLayout')
const campaigns = require('./campaigns')
const whatsapp = require('./whatsapp')

// pdf-lib's Standard fonts (used by the job sheet's text pages below) are
// WinAnsi-encoded and can't represent ₹ or most non-Latin1 characters — a
// customer file name, admin password note, or admin-entered pricing label
// containing one would otherwise crash generation with "WinAnsi cannot
// encode ...". Same fix as invoice.js's sanitizeForFont: swap ₹ for "Rs."
// and drop anything else the font can't encode, one character at a time.
function sanitizeForFont(str, f) {
  let out = ''
  for (const ch of String(str == null ? '' : str)) {
    if (ch === '₹') { out += 'Rs.'; continue }
    try {
      f.widthOfTextAtSize(ch, 10)
      out += ch
    } catch (e) {
      // unencodable in this font — drop it
    }
  }
  return out
}

// Short, print/handwriting-friendly order IDs — excludes 0/O and 1/I so a
// staff member transcribing one off a job sheet by hand can't misread it.
const ORDER_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
function generateOrderId() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = crypto.randomBytes(7)
    let id = ''
    for (let i = 0; i < 7; i++) id += ORDER_ID_CHARS[bytes[i] % ORDER_ID_CHARS.length]
    if (!db.getOrder(id)) return id
  }
  throw new Error('could_not_generate_unique_order_id')
}

// Generates a Razorpay Payment Link for an order's current total, so an
// admin-placed order can be paid online remotely instead of in person.
// Cancels any link already on the order first — otherwise editing the order
// (which reprices it) would leave a stale link out there payable at the old
// amount. Razorpay's own SMS/email notification is turned off since we send
// our own DLT-compliant SMS (see sms.js) rather than Razorpay's generic one.
async function createPaymentLinkForOrder(order) {
  if (order.payment_link_id) {
    await razorpay.cancelPaymentLink(order.payment_link_id)
  }
  const link = await razorpay.createPaymentLink({
    linkId: order.id,
    amount: order.total_amount,
    customerName: order.customer_name,
    customerPhone: `+91${order.customer_mobile}`,
    customerEmail: order.customer_email || undefined,
    purpose: `Metalix Print order ${order.id}`,
    returnUrl: `https://print.metalix.in/track/${order.id}`
  })
  db.updateOrder(order.id, { payment_link_id: link.link_id, payment_link_url: link.link_url })
  return link
}
const { backupDatabase } = require('./backupDb')

const uploadsDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

const ALLOWED_EXTENSIONS = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.ppt': 'ppt',
  '.pptx': 'pptx',
  '.jpg': 'jpg',
  '.jpeg': 'jpeg',
  '.png': 'png',
  '.webp': 'webp',
  '.gif': 'gif'
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    cb(null, `${crypto.randomUUID()}${ext}`)
  }
})

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED_EXTENSIONS[ext]) return cb(null, true)
    cb(Object.assign(new Error('unsupported_file_type'), { code: 'unsupported_file_type' }))
  }
})

// Blog cover images are public (served straight to article pages), unlike the
// private customer uploads above — kept in their own dir under server/public.
const blogUploadsDir = path.join(__dirname, 'public', 'blog-uploads')
if (!fs.existsSync(blogUploadsDir)) fs.mkdirSync(blogUploadsDir, { recursive: true })
const BLOG_IMAGE_EXTENSIONS = { '.jpg': true, '.jpeg': true, '.png': true, '.webp': true, '.gif': true }
const blogImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, blogUploadsDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (BLOG_IMAGE_EXTENSIONS[ext]) return cb(null, true)
    cb(Object.assign(new Error('unsupported_image_type'), { code: 'unsupported_image_type' }))
  }
})
app.use('/blog-uploads', express.static(blogUploadsDir, { maxAge: '30d' }))

// Stationery product photos are public catalog images, same reasoning as
// blog cover images — must NOT go through the private `upload`/`uploadsDir`
// pipeline above (that's for customer print files, never express.static-
// mounted). Separate dir/multer instance, same shape as blogImageUpload.
const productUploadsDir = path.join(__dirname, 'public', 'product-uploads')
if (!fs.existsSync(productUploadsDir)) fs.mkdirSync(productUploadsDir, { recursive: true })
const productImageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, productUploadsDir),
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (BLOG_IMAGE_EXTENSIONS[ext]) return cb(null, true)
    cb(Object.assign(new Error('unsupported_image_type'), { code: 'unsupported_image_type' }))
  }
})
app.use('/product-uploads', express.static(productUploadsDir, { maxAge: '30d' }))

// Bulk product CSV import — memory storage only, the file is parsed and
// discarded, never written to disk. CSV (not xlsx) deliberately: the
// npm-published xlsx/SheetJS package has unpatched high-severity Prototype
// Pollution + ReDoS vulnerabilities, so this uses a small hand-rolled parser
// below instead of adding that dependency. CSV opens/edits in Excel exactly
// the same way.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ext === '.csv') return cb(null, true)
    cb(Object.assign(new Error('unsupported_file_type'), { code: 'unsupported_file_type' }))
  }
})

// Minimal RFC4180 CSV parser: quoted fields, escaped "" quotes, commas/
// newlines inside quotes. Only needs to handle the fixed-column product
// template, not arbitrary CSVs.
function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const s = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\r') {
      // no-op; \n below closes the row
    } else if (c === '\n') {
      row.push(field); field = ''
      rows.push(row); row = []
    } else {
      field += c
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

function escapeCsvCell(v) {
  const s = String(v == null ? '' : v)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// Turns a title (or a user-typed slug) into a clean URL segment.
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Upload + analyze: PDF is analyzed directly, DOC/DOCX/PPT/PPTX are converted
// to PDF first via headless LibreOffice so we get an accurate page count and thumbnail.
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const code = err.code === 'unsupported_file_type' ? 'unsupported_file_type' : 'upload_failed'
      return res.status(400).json({ error: code, message: err.message })
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' })

    const ext = path.extname(req.file.originalname).toLowerCase()
    const fileType = ALLOWED_EXTENSIONS[ext]

    try {
      let pdfBuffer
      if (fileType === 'pdf') {
        pdfBuffer = fs.readFileSync(req.file.path)
      } else {
        const sourceBuffer = fs.readFileSync(req.file.path)
        pdfBuffer = await convertToPdf(sourceBuffer, ext)
      }

      const analysis = await analyzePdfBuffer(pdfBuffer)

      return res.json({
        fileId: req.file.filename,
        fileName: req.file.originalname,
        fileSize: req.file.size,
        fileType,
        pageCount: analysis.pageCount,
        colorCount: analysis.colorCount,
        colorFlags: analysis.colorFlags,
        thumbnail: analysis.thumbnail,
        pageThumbnails: analysis.pageThumbnails,
        previewTruncated: analysis.previewTruncated
      })
    } catch (err) {
      console.error('upload analysis error', err)
      if (err.code === 'canvas_missing') {
        return res.status(500).json({ error: 'canvas_missing', message: 'server requires the canvas package and native libs. See README.' })
      }
      if (err.message === 'conversion_failed') {
        return res.status(500).json({ error: 'conversion_failed', message: 'could not convert document for preview. Is LibreOffice (soffice) installed?' })
      }
      return res.status(500).json({ error: 'analyze_failed' })
    }
  })
})

// Stamp logo / existing-artwork upload — the same private uploads/ pipeline
// and extension whitelist as /api/upload above (reuses the exact same
// `upload` multer middleware), but deliberately skips PDF conversion/
// analysis entirely: those are print-job-specific (page count/colour
// detection for per-page pricing), meaningless for a stamp's logo image, and
// would force every image through an unnecessary LibreOffice+canvas round
// trip just to get a fileId back. Public/no-auth, matching /api/upload's own
// posture — the file is only ever attached to an order (and thus made
// meaningful) once the order itself is created.
app.post('/api/stamp-assets/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code === 'unsupported_file_type' ? 'unsupported_file_type' : 'upload_failed'
      return res.status(400).json({ error: code, message: err.message })
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' })
    return res.json({ fileId: req.file.filename, fileName: req.file.originalname, fileSize: req.file.size })
  })
})

// Public — used by the customer order page's live estimate and the admin
// New Order modal. Coupons are deliberately stripped here: unlike every
// other field in this config, a coupon list is enumerable secret-ish data
// (codes/values a promotion isn't meant to advertise to anyone poking at
// devtools) — a caller who has a specific code validates it one at a time via
// GET /api/coupons/:code below instead. The full list, for admin management,
// is served separately by the authenticated GET /api/admin/pricing near the
// pricing PUT route.
app.get('/api/pricing', (req, res) => {
  const { coupons, ...publicPricing } = db.getPricing()
  res.json(publicPricing)
})

// Public stationery catalog. Explicit safe DTO only — never forwards
// cost_price (admin/reporting-only) or the raw stock_qty count (just whether
// it's purchasable), matching the same "never expose cost prices" rule the
// rest of the pricing config already follows (coupons stripped above).
function publicProduct(p) {
  return {
    id: p.id, sku: p.sku, name: p.name, slug: p.slug, description: p.description,
    categoryId: p.category_id, price: p.price, mrp: p.mrp, images: p.images,
    inStock: p.stock_qty > 0, kind: 'product'
  }
}
// Same public-DTO role as publicProduct above, but for a cross-sell rule
// recommending a stamp type instead of a stationery product — a stamp type
// has no stock/SKU/slug, and (unlike stationery) can't be one-click-added to
// cart since it still needs a size and text/artwork, so the client renders
// it as a link into /stamps rather than an instant "+ Add" (see cart.js).
function publicStampRecommendation(stampType) {
  return {
    id: 'stamp:' + stampType.id, sku: null, name: stampType.label, slug: null, description: null,
    categoryId: null, price: stampType.basePrice, mrp: null,
    images: stampType.imageUrl ? [stampType.imageUrl] : [],
    inStock: true, kind: 'stamp', stampTypeId: stampType.id
  }
}
// All three routes below are gated by stationeryEnabled() — while off they
// 404 exactly like the /stationery page itself, so the catalog can't be
// discovered by hitting the API directly even with the nav link hidden.
// Admin's own catalog endpoints (/api/admin/products etc.) are never gated
// — see stationeryEnabled()'s comment above.
app.get('/api/product-categories', (req, res) => {
  if (!stationeryEnabled()) return res.status(404).json({ error: 'not_found' })
  res.json({ categories: db.listProductCategories({ includeInactive: false }).map((c) => ({ id: c.id, name: c.name, slug: c.slug, description: c.description })) })
})
app.get('/api/products', (req, res) => {
  if (!stationeryEnabled()) return res.status(404).json({ error: 'not_found' })
  // ?category is a slug (URL-friendly, matches the categories endpoint and
  // the /:slug product route), resolved to an id server-side for filtering.
  let categoryId
  if (req.query.category) {
    const cat = db.getProductCategoryBySlug(req.query.category)
    categoryId = cat ? cat.id : '__none__' // unknown slug -> empty result, not "all products"
  }
  const products = db.listProducts({ includeInactive: false, categoryId })
  res.json({ products: products.map(publicProduct) })
})
app.get('/api/products/:slug', (req, res) => {
  if (!stationeryEnabled()) return res.status(404).json({ error: 'not_found' })
  const product = db.getProductBySlug(req.params.slug)
  if (!product || !product.active) return res.status(404).json({ error: 'not_found' })
  res.json({ product: publicProduct(product) })
})

// Public — "Complete your order" recommendations. ?trigger is either
// 'productType:document'/'stationery'/'stamp' (fired from cart.js right
// after Cart.add()) or 'product:<id>' for a rule scoped to one specific
// product. Same safe DTO as the products list above — never cost_price/raw
// stock_qty. A recommendation can point at either a stationery product or a
// stamp type — db.listCrossSellRulesForTrigger returns which kind each rule
// resolved to (already filtered to active-only), shaped here into the same
// public DTO family as the rest of this file.
app.get('/api/cross-sell', (req, res) => {
  if (!anyVerticalEnabled()) return res.status(404).json({ error: 'not_found' })
  const trigger = String(req.query.trigger || '')
  if (!trigger) return res.json({ products: [] })
  const rows = db.listCrossSellRulesForTrigger(trigger)
  res.json({ products: rows.map((r) => r.kind === 'stamp' ? publicStampRecommendation(r.stampType) : publicProduct(r.product)) })
})

// Public — surfaces at most one coupon (the first active, not-yet-expired
// one, in Admin > Discounts' list order) for the homepage promo banner.
// Registered before the /:code route below since Express matches routes in
// registration order and /:code would otherwise treat "featured" as a
// literal code lookup. Deliberately narrower than exposing the full list —
// see GET /api/pricing's coupons-stripping comment above — just enough for
// "Use code X for Y% off", nothing about any other configured coupon.
app.get('/api/coupons/featured', (req, res) => {
  const coupons = db.getPricing().coupons || []
  const now = Date.now()
  const featured = coupons.find((c) => c.active && (!c.expiresAt || c.expiresAt > now))
  if (!featured) return res.status(404).json({ error: 'no_active_coupon' })
  res.json({ code: featured.code, type: featured.type, value: featured.value, minOrderValue: featured.minOrderValue || 0 })
})

// Public, read-only single-code lookup for a live discount preview — on
// customer checkout (a coupon field) and the admin New Order modal (staff
// applying an existing code to a walk-in order). Never the source of truth
// for what actually gets applied: order creation re-validates independently
// (active / not expired / under its usage cap) via resolveDiscountInput, so
// a stale preview here can never itself grant a discount.
app.get('/api/coupons/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase()
  const coupon = (db.getPricing().coupons || []).find((c) => c.code === code)
  if (!coupon || !coupon.active) return res.status(404).json({ error: 'invalid_coupon', message: 'This coupon code is not valid.' })
  if (coupon.expiresAt && Date.now() > coupon.expiresAt) return res.status(404).json({ error: 'coupon_expired', message: 'This coupon has expired.' })
  if (coupon.maxUses != null && db.countCouponUses(coupon.code) >= coupon.maxUses) {
    return res.status(404).json({ error: 'coupon_limit_reached', message: 'This coupon has reached its usage limit.' })
  }
  res.json({ code: coupon.code, type: coupon.type, value: coupon.value, minOrderValue: coupon.minOrderValue || 0 })
})

// The order page estimates delivery charge client-side to match this
// exactly, but "outside Gurugram" pricing needs the offline pincode-distance
// dataset (server/geodata) that isn't worth shipping to the browser — this
// gives the checkout page that one number, via the exact same pricing.js
// logic the real order uses, so the estimate never disagrees with what the
// customer is actually charged.
app.get('/api/delivery-estimate', (req, res) => {
  const pincode = String(req.query.pincode || '')
  const preDeliveryTotal = Number(req.query.preDeliveryTotal) || 0
  const config = db.getPricing()
  const deliveryCharge = pricing.calculateDeliveryCharge(config, { deliveryMethod: 'delivery', deliveryPincode: pincode, preDeliveryTotal })
  res.json({ deliveryCharge })
})

app.get('/api/settings', (req, res) => {
  res.json(db.getSiteSettings())
})

// One request for everything the landing page enhances with (pricing, site
// settings, active branches) — lets the client make a single deferred fetch
// instead of three, shrinking the critical request chain.
// "Aarav Sharma" -> "Aarav S." — enough for social proof without publishing
// a customer's full name on a public page.
function maskReviewerName(name) {
  const parts = String(name || '').trim().split(/\s+/)
  if (!parts[0]) return 'Verified Customer'
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0]
}

app.get('/api/bootstrap', (req, res) => {
  const locations = db.getLocations().filter((l) => l.active).map((l) => ({
    id: l.id, name: l.name, address: l.address || '', city: l.city || '', pincode: l.pincode || '', shopOpen: l.shopOpen, mapsUrl: l.mapsUrl || ''
  }))
  const testimonials = db.listPublicFeedback().map((f) => ({
    rating: f.rating, comment: f.comment, name: maskReviewerName(f.customer_name), created_at: f.created_at
  }))
  // landing.html's applyPricing()/applySettings() only ever read the fields
  // built below (checked against their source directly) — the full pricing
  // config (every page size/paper type, passport packs, order defaults) and
  // full settings (admin-only analytics fields, and the full legal/policy
  // text, which is rendered server-side per policy page instead) would
  // otherwise ride along on this deferred fetch for no reason. Trimming this
  // is what shrank the payload flagged in PageSpeed's network dependency
  // chain; the order page and admin dashboard get the untrimmed config from
  // their own routes (/api/pricing, /api/admin/settings).
  const fullPricing = db.getPricing()
  const a4 = (Array.isArray(fullPricing.rates && fullPricing.rates.a4) ? fullPricing.rates.a4[0] : null) || {}
  const pricing = {
    rates: { a4: [{ bw: a4.bw, color: a4.color }] },
    deliveryLocalCharge: fullPricing.deliveryLocalCharge,
    deliveryGurugramCharge: fullPricing.deliveryGurugramCharge,
    freeDeliveryThreshold: fullPricing.freeDeliveryThreshold
  }
  const fullSettings = db.getSiteSettings()
  const settings = {
    seo: fullSettings.seo,
    headOfficeAddress: fullSettings.headOfficeAddress,
    phone: fullSettings.phone,
    whatsapp: fullSettings.whatsapp,
    email: fullSettings.email,
    storeTimings: fullSettings.storeTimings,
    social: fullSettings.social
  }
  res.json({ pricing, settings, locations, testimonials })
})

// Website "contact us" form → emails the business inbox. Always logs the
// submission first so a message is never lost even if email delivery fails.
app.post('/api/contact', express.json(), async (req, res) => {
  const b = req.body || {}
  const name = String(b.name || '').trim().slice(0, 100)
  const email = String(b.email || '').trim().slice(0, 120)
  const phone = String(b.phone || '').trim().slice(0, 20)
  const message = String(b.message || '').trim().slice(0, 5000)
  if (!name || !email || !phone || !message) {
    return res.status(400).json({ error: 'missing_fields', message: 'Please fill in name, email, phone and message.' })
  }
  console.log(`[contact] ${name} <${email}> ${phone}: ${message.replace(/\s+/g, ' ').slice(0, 300)}`)
  try {
    await mailer.sendContactMessageEmail({ name, email, phone, message })
  } catch (err) {
    console.error('[contact] email send failed:', err.message)
    return res.status(500).json({ error: 'send_failed', message: 'Could not send right now — please WhatsApp or call us.' })
  }
  return res.json({ message: 'Message sent.' })
})

app.put('/api/admin/settings', requireSuperAdmin, express.json(), (req, res) => {
  const settings = req.body
  if (!settings || !settings.legal || !settings.social || !settings.seo) {
    return res.status(400).json({ error: 'invalid_settings' })
  }
  db.setSiteSettings(settings)
  return res.json(db.getSiteSettings())
})

// --- Admin authentication -------------------------------------------------
// Admin credentials (login id + bcrypt password hash) live in the admin_users
// table, changeable/resettable from the web. The first super_admin row is
// seeded once at startup from env or migrated from the legacy single-admin
// credential (see seedAdminAuth at the bottom of the file).
// The forgot-password link always goes to this fixed, server-side address — the
// client never supplies a destination, so a stranger can't redirect the reset.
const ADMIN_RESET_EMAIL = process.env.ADMIN_RESET_EMAIL || 'support@metalix.in'

app.post('/api/admin/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect login ID or password.' })
  }
  const rlKey = `admin:${req.ip}:${String(username).toLowerCase()}`
  if (checkLoginRateLimit(rlKey)) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many login attempts. Please try again in a few minutes.' })
  }
  const admin = db.getAdminUserByUsername(username)
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect login ID or password.' })
  }
  clearLoginRateLimit(rlKey)
  const token = jwt.sign({ role: 'admin', sub: admin.id, adminRole: admin.role, locationId: admin.location_id || null }, getJwtSecret(), { expiresIn: '12h' })
  return res.json({ token })
})

app.get('/api/admin/me', requireAdmin, (req, res) => {
  const admin = db.getAdminUserById(req.admin.id)
  if (!admin) return res.status(404).json({ error: 'not_found' })
  const location = admin.location_id ? db.getLocationById(admin.location_id) : null
  return res.json({
    username: admin.username,
    role: admin.role,
    locationId: admin.location_id || null,
    locationName: location ? location.name : null,
    // null = every tab (no restriction configured for this staff member).
    allowedTabs: admin.allowed_tabs
  })
})

// Requires the correct admin login id before any email is sent — this both
// stops a random visitor from spamming the admin inbox and gives the operator
// clear feedback (a wrong id is rejected outright, no email). Only super
// admins get the self-service email flow — branch admin passwords are set/
// reset by the super admin directly from the Staff panel (no per-branch email
// infra needed for v1). The reset link only ever goes to the fixed,
// server-side ADMIN_RESET_EMAIL (never an address from the request body), so
// knowing the login id buys an attacker nothing.
app.post('/api/admin/forgot-password', express.json(), async (req, res) => {
  const { username } = req.body || {}
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'missing_username', message: 'Enter your Login ID first.' })
  }
  const admin = db.getAdminUserByUsername(username)
  if (!admin || admin.role !== 'super_admin') {
    return res.status(401).json({ error: 'unknown_login_id', message: 'That Login ID is not recognized — no email was sent.' })
  }

  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  db.createPasswordReset({
    id: crypto.randomUUID(),
    user_id: `admin:${admin.id}`, // prefix distinguishes admin resets from customer resets
    token_hash: tokenHash,
    expires_at: Date.now() + 60 * 60 * 1000 // 1 hour
  })
  const resetUrl = `${req.protocol}://${req.get('host')}/admin?adminReset=${rawToken}`
  try {
    await mailer.sendAdminPasswordResetEmail(ADMIN_RESET_EMAIL, resetUrl)
  } catch (err) {
    console.error('[admin] failed to send admin reset email', err.message)
    return res.status(500).json({ error: 'email_failed', message: 'Could not send the reset email. Please try again shortly.' })
  }
  return res.json({ message: 'A reset link has been sent to the registered admin email.' })
})

app.post('/api/admin/reset-password', express.json(), async (req, res) => {
  const { token, newPassword } = req.body || {}
  if (!token || !newPassword) return res.status(400).json({ error: 'missing_fields' })
  if (newPassword.length < 8) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' })

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const reset = db.findValidPasswordReset(tokenHash)
  if (!reset || !String(reset.user_id).startsWith('admin:')) return res.status(400).json({ error: 'invalid_or_expired_token' })

  const adminId = reset.user_id.slice('admin:'.length)
  const password_hash = await bcrypt.hash(newPassword, 10)
  db.updateAdminUser(adminId, { password_hash })
  db.markPasswordResetUsed(reset.id)
  return res.json({ message: 'Admin password updated — you can now log in.' })
})

// --- Staff management (super admin only) ----------------------------------
// Branch admin accounts are created/reset directly by the super admin here —
// deliberately no self-service signup for branch logins.
app.get('/api/admin/staff', requireSuperAdmin, (req, res) => {
  return res.json({ staff: db.listAdminUsers() })
})

// undefined/null = no restriction (every branch tab); otherwise must be a
// subset of BRANCH_TABS. Invalid entries are silently dropped rather than
// erroring, so a stale client sending an old tab key can't break the request.
function cleanAllowedTabs(allowedTabs) {
  if (allowedTabs === undefined || allowedTabs === null) return null
  if (!Array.isArray(allowedTabs)) return null
  const clean = allowedTabs.filter((t) => BRANCH_TABS.includes(t))
  return clean.length ? clean : null
}

app.post('/api/admin/staff', requireSuperAdmin, express.json(), async (req, res) => {
  const { username, password, locationId, allowedTabs } = req.body || {}
  if (!username || !String(username).trim() || !password || !locationId) {
    return res.status(400).json({ error: 'missing_fields', message: 'Username, password, and a branch are all required.' })
  }
  if (password.length < 8) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' })
  if (db.getAdminUserByUsername(username)) {
    return res.status(409).json({ error: 'already_exists', message: 'That login ID is already taken.' })
  }
  if (!db.getLocationById(locationId)) return res.status(400).json({ error: 'invalid_location' })
  const password_hash = await bcrypt.hash(password, 10)
  const staffUser = db.createAdminUser({
    id: crypto.randomUUID(), username: String(username).trim(), password_hash, role: 'branch_admin', location_id: locationId,
    allowed_tabs: cleanAllowedTabs(allowedTabs)
  })
  return res.json({ staff: { id: staffUser.id, username: staffUser.username, role: staffUser.role, location_id: staffUser.location_id, allowed_tabs: staffUser.allowed_tabs } })
})

app.put('/api/admin/staff/:id', requireSuperAdmin, express.json(), async (req, res) => {
  const staffUser = db.getAdminUserById(req.params.id)
  if (!staffUser || staffUser.role !== 'branch_admin') return res.status(404).json({ error: 'not_found' })
  const { password, locationId, allowedTabs } = req.body || {}
  const updates = {}
  if (password !== undefined) {
    if (password.length < 8) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' })
    updates.password_hash = await bcrypt.hash(password, 10)
  }
  if (locationId !== undefined) {
    if (!db.getLocationById(locationId)) return res.status(400).json({ error: 'invalid_location' })
    updates.location_id = locationId
  }
  if (allowedTabs !== undefined) {
    const clean = cleanAllowedTabs(allowedTabs)
    updates.allowed_tabs = clean ? JSON.stringify(clean) : null
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_updates' })
  db.updateAdminUser(staffUser.id, updates)
  return res.json({ updated: true })
})

app.delete('/api/admin/staff/:id', requireSuperAdmin, (req, res) => {
  const staffUser = db.getAdminUserById(req.params.id)
  if (!staffUser || staffUser.role !== 'branch_admin') return res.status(404).json({ error: 'not_found' })
  db.deleteAdminUser(staffUser.id)
  return res.json({ deleted: true })
})

// Blog CMS — SEO content, kept super-admin-only like Pricing/Locations/Settings.
app.get('/api/admin/blog', requireSuperAdmin, (req, res) => {
  res.json({ posts: db.listBlogPosts({ includeUnpublished: true }) })
})

function blogFieldsFromBody(body) {
  return {
    title: (body.title || '').trim(),
    author: (body.author || '').trim() || null,
    excerpt: (body.excerpt || '').trim() || null,
    cover_image: (body.coverImage || '').trim() || null,
    category: (body.category || '').trim() || null,
    tags: Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    author_bio: (body.authorBio || '').trim() || null,
    body: body.body || '',
    meta_title: (body.metaTitle || '').trim() || null,
    meta_description: (body.metaDescription || '').trim() || null,
    meta_keywords: (body.metaKeywords || '').trim() || null,
    published: !!body.published
  }
}

app.post('/api/admin/blog', requireSuperAdmin, express.json(), (req, res) => {
  const fields = blogFieldsFromBody(req.body || {})
  if (!fields.title) return res.status(400).json({ error: 'title_required', message: 'Title is required.' })
  let slug = slugify(req.body.slug || fields.title)
  if (!slug) return res.status(400).json({ error: 'invalid_slug', message: 'Could not derive a URL slug from the title.' })
  if (db.getBlogPostBySlug(slug)) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`
  const post = db.createBlogPost({ id: crypto.randomUUID(), slug, ...fields })
  return res.json({ post })
})

// Cover images are only ever uploaded via /api/admin/blog/upload-cover into
// blog-uploads (an external http(s) URL is also a valid cover_image, but
// nothing on disk to clean up for those) — path.basename guards against a
// crafted value ever escaping that directory.
function deleteBlogCoverIfLocal(coverImage) {
  if (!coverImage || !coverImage.startsWith('/blog-uploads/')) return
  fs.unlink(path.join(blogUploadsDir, path.basename(coverImage)), () => {})
}

app.put('/api/admin/blog/:id', requireSuperAdmin, express.json(), (req, res) => {
  const existing = db.getBlogPostById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  const fields = blogFieldsFromBody(req.body || {})
  if (!fields.title) return res.status(400).json({ error: 'title_required', message: 'Title is required.' })
  let slug = req.body.slug !== undefined ? slugify(req.body.slug) : existing.slug
  if (!slug) slug = existing.slug
  const conflict = db.getBlogPostBySlug(slug)
  if (conflict && conflict.id !== existing.id) return res.status(409).json({ error: 'slug_taken', message: 'That URL slug is already used by another post.' })
  const post = db.updateBlogPost(existing.id, { slug, ...fields })
  // Replacing the cover leaves the old upload orphaned on disk otherwise.
  if (existing.cover_image && existing.cover_image !== fields.cover_image) {
    deleteBlogCoverIfLocal(existing.cover_image)
  }
  return res.json({ post })
})

app.delete('/api/admin/blog/:id', requireSuperAdmin, (req, res) => {
  const existing = db.getBlogPostById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  db.deleteBlogPost(existing.id)
  deleteBlogCoverIfLocal(existing.cover_image)
  return res.json({ deleted: true })
})

app.post('/api/admin/blog/upload-cover', requireSuperAdmin, (req, res) => {
  blogImageUpload.single('image')(req, res, (err) => {
    if (err) {
      const code = err.code === 'unsupported_image_type' ? 'unsupported_image_type' : 'upload_failed'
      return res.status(400).json({ error: code, message: err.message })
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' })
    return res.json({ url: `/blog-uploads/${req.file.filename}` })
  })
})

// ---------------------------------------------------------------------------
// Stationery catalog admin: product categories, products, stock adjustments.
// Super-admin-only, same as Pricing/Locations — see requireSuperAdmin.
// ---------------------------------------------------------------------------

app.get('/api/admin/product-categories', requireSuperAdmin, (req, res) => {
  res.json({ categories: db.listProductCategories({ includeInactive: true }) })
})

app.post('/api/admin/product-categories', requireSuperAdmin, express.json(), (req, res) => {
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required', message: 'Category name is required.' })
  let slug = slugify(req.body.slug || name)
  if (!slug) return res.status(400).json({ error: 'invalid_slug', message: 'Could not derive a URL slug from the name.' })
  if (db.getProductCategoryBySlug(slug)) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`
  const category = db.createProductCategory({
    id: crypto.randomUUID(), name, slug,
    description: (req.body.description || '').trim() || null,
    sort_order: Number(req.body.sortOrder) || 0,
    active: req.body.active !== false
  })
  return res.json({ category })
})

app.put('/api/admin/product-categories/:id', requireSuperAdmin, express.json(), (req, res) => {
  const existing = db.getProductCategoryById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  const name = (req.body.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name_required', message: 'Category name is required.' })
  let slug = req.body.slug !== undefined ? slugify(req.body.slug) : existing.slug
  if (!slug) slug = existing.slug
  const conflict = db.getProductCategoryBySlug(slug)
  if (conflict && conflict.id !== existing.id) return res.status(409).json({ error: 'slug_taken', message: 'That URL slug is already used by another category.' })
  const category = db.updateProductCategory(existing.id, {
    name, slug,
    description: (req.body.description || '').trim() || null,
    sort_order: Number(req.body.sortOrder) || 0,
    active: req.body.active !== false
  })
  return res.json({ category })
})

app.delete('/api/admin/product-categories/:id', requireSuperAdmin, (req, res) => {
  const existing = db.getProductCategoryById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  db.deleteProductCategory(existing.id)
  return res.json({ deleted: true })
})

app.get('/api/admin/products', requireSuperAdmin, (req, res) => {
  res.json({ products: db.listProducts({ includeInactive: true }) })
})

function productFieldsFromBody(body) {
  return {
    name: (body.name || '').trim(),
    description: (body.description || '').trim() || null,
    category_id: body.categoryId || null,
    price: Number(body.price) || 0,
    mrp: body.mrp != null && body.mrp !== '' ? Number(body.mrp) : null,
    cost_price: body.costPrice != null && body.costPrice !== '' ? Number(body.costPrice) : null,
    stock_qty: Number(body.stockQty) || 0,
    low_stock_threshold: body.lowStockThreshold != null && body.lowStockThreshold !== '' ? Number(body.lowStockThreshold) : 5,
    images: Array.isArray(body.images) ? body.images : [],
    active: body.active !== false,
    meta_title: (body.metaTitle || '').trim() || null,
    meta_description: (body.metaDescription || '').trim() || null
  }
}

app.post('/api/admin/products', requireSuperAdmin, express.json(), (req, res) => {
  const fields = productFieldsFromBody(req.body || {})
  if (!fields.name) return res.status(400).json({ error: 'name_required', message: 'Product name is required.' })
  const sku = (req.body.sku || '').trim().toUpperCase()
  if (!sku) return res.status(400).json({ error: 'sku_required', message: 'SKU is required.' })
  if (db.getProductBySku(sku)) return res.status(409).json({ error: 'sku_taken', message: 'That SKU is already in use.' })
  let slug = slugify(req.body.slug || fields.name)
  if (!slug) return res.status(400).json({ error: 'invalid_slug', message: 'Could not derive a URL slug from the name.' })
  if (db.getProductBySlug(slug)) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`
  const product = db.createProduct({ id: crypto.randomUUID(), sku, slug, ...fields })
  return res.json({ product })
})

app.put('/api/admin/products/:id', requireSuperAdmin, express.json(), (req, res) => {
  const existing = db.getProductById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  const fields = productFieldsFromBody(req.body || {})
  if (!fields.name) return res.status(400).json({ error: 'name_required', message: 'Product name is required.' })
  if (req.body.sku !== undefined) {
    const sku = (req.body.sku || '').trim().toUpperCase()
    if (!sku) return res.status(400).json({ error: 'sku_required', message: 'SKU is required.' })
    const conflict = db.getProductBySku(sku)
    if (conflict && conflict.id !== existing.id) return res.status(409).json({ error: 'sku_taken', message: 'That SKU is already in use.' })
    fields.sku = sku
  }
  let slug = req.body.slug !== undefined ? slugify(req.body.slug) : existing.slug
  if (!slug) slug = existing.slug
  const slugConflict = db.getProductBySlug(slug)
  if (slugConflict && slugConflict.id !== existing.id) return res.status(409).json({ error: 'slug_taken', message: 'That URL slug is already used by another product.' })
  const product = db.updateProduct(existing.id, { slug, ...fields })
  return res.json({ product })
})

app.post('/api/admin/products/:id/deactivate', requireSuperAdmin, (req, res) => {
  const existing = db.getProductById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  return res.json({ product: db.updateProduct(existing.id, { active: false }) })
})

app.post('/api/admin/products/:id/reactivate', requireSuperAdmin, (req, res) => {
  const existing = db.getProductById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  return res.json({ product: db.updateProduct(existing.id, { active: true }) })
})

app.delete('/api/admin/products/:id', requireSuperAdmin, (req, res) => {
  const existing = db.getProductById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  try {
    db.deleteProductHardIfUnreferenced(existing.id)
  } catch (err) {
    if (err.code === 'product_referenced') return res.status(409).json({ error: err.code, message: err.message })
    throw err
  }
  ;(existing.images || []).forEach((url) => {
    if (url && url.startsWith('/product-uploads/')) fs.unlink(path.join(productUploadsDir, path.basename(url)), () => {})
  })
  return res.json({ deleted: true })
})

app.post('/api/admin/products/upload-image', requireSuperAdmin, (req, res) => {
  productImageUpload.single('image')(req, res, (err) => {
    if (err) {
      const code = err.code === 'unsupported_image_type' ? 'unsupported_image_type' : 'upload_failed'
      return res.status(400).json({ error: code, message: err.message })
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' })
    return res.json({ url: `/product-uploads/${req.file.filename}` })
  })
})

// Downloadable CSV starter — header row + two filled-in sample products so
// admins can see the exact expected shape before bulk-editing their own
// catalog. Re-uploading it unedited would create those two sample SKUs,
// same as any spreadsheet template (the user is expected to overwrite the
// sample rows with real data).
app.get('/api/admin/products/bulk-template', requireSuperAdmin, (req, res) => {
  const categories = db.listProductCategories({ includeInactive: true })
  const sampleCategory = categories[0] ? categories[0].name : 'Notebooks'
  const rows = [
    ['SKU', 'Name', 'Category', 'Description', 'Price', 'MRP', 'Cost Price', 'Stock Qty', 'Low Stock Threshold', 'Active', 'Meta Title', 'Meta Description'],
    ['SAMPLE-NB-A5', 'A5 Ruled Notebook (200 pages)', sampleCategory, 'Hardbound A5 notebook, 200 ruled pages.', '120', '150', '70', '50', '10', 'yes', 'A5 Ruled Notebook | Metalix Print', 'Buy A5 ruled notebooks online with fast delivery.'],
    ['SAMPLE-PEN-BL', 'Blue Ball Pen (Pack of 10)', sampleCategory, 'Smooth-write blue ball pens, pack of 10.', '80', '100', '45', '200', '20', 'yes', '', '']
  ]
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', 'attachment; filename="metalix-products-template.csv"')
  return res.send('\uFEFF' + csv)
})

// Matches an existing category by name (case-insensitive), or creates one —
// lets a CSV author just type a category name without first visiting the
// Categories manager, same convenience as the free-text Category field would
// offer in a UI, without needing one.
function resolveOrCreateCategoryId(name) {
  const trimmed = (name || '').trim()
  if (!trimmed) return null
  const existing = db.listProductCategories({ includeInactive: true })
    .find((c) => c.name.toLowerCase() === trimmed.toLowerCase())
  if (existing) return existing.id
  let slug = slugify(trimmed)
  if (!slug) return null
  if (db.getProductCategoryBySlug(slug)) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`
  return db.createProductCategory({ id: crypto.randomUUID(), name: trimmed, slug, description: null, sort_order: 0, active: true }).id
}

const CSV_BOOL_TRUE = new Set(['yes', 'y', 'true', '1', 'active'])
const CSV_BOOL_FALSE = new Set(['no', 'n', 'false', '0', 'inactive'])
const BULK_UPLOAD_COLUMNS = {
  sku: 'sku', name: 'name', category: 'category', description: 'description',
  price: 'price', mrp: 'mrp', costPrice: 'cost price', stockQty: 'stock qty',
  lowStockThreshold: 'low stock threshold', active: 'active',
  metaTitle: 'meta title', metaDescription: 'meta description'
}

// Bulk create/update via CSV, matched on SKU. A SKU already in the catalog
// is updated in place (stock changes go through adjustStock so they're
// ledgered like any other stock change — see adjust-stock above); an unknown
// SKU is created fresh with the CSV's Stock Qty as its opening balance,
// matching the no-ledger convention the "New product" form already uses for
// a brand-new product's initial stock. Never touches product images/slug —
// the CSV has no column for either, so both stay whatever they already are.
app.post('/api/admin/products/bulk-upload', requireSuperAdmin, (req, res) => {
  csvUpload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code === 'unsupported_file_type' ? 'unsupported_file_type' : 'upload_failed'
      return res.status(400).json({ error: code, message: code === 'unsupported_file_type' ? 'Please upload a .csv file.' : err.message })
    }
    if (!req.file) return res.status(400).json({ error: 'no_file', message: 'Choose a CSV file to upload.' })

    const rows = parseCsv(req.file.buffer.toString('utf8'))
    if (!rows.length) return res.status(400).json({ error: 'empty_file', message: 'That file has no rows.' })

    const header = rows[0].map((h) => h.trim().toLowerCase())
    const idx = {}
    Object.keys(BULK_UPLOAD_COLUMNS).forEach((key) => { idx[key] = header.indexOf(BULK_UPLOAD_COLUMNS[key]) })
    if (idx.sku === -1 || idx.name === -1 || idx.price === -1) {
      return res.status(400).json({ error: 'invalid_header', message: 'The CSV must have SKU, Name, and Price columns — download the template to see the exact format.' })
    }

    const results = { created: 0, updated: 0, skipped: [] }
    rows.slice(1).forEach((r, i) => {
      const rowNum = i + 2 // 1-indexed, plus the header row
      const get = (key) => (idx[key] !== -1 ? (r[idx[key]] || '').trim() : '')
      const sku = get('sku').toUpperCase()
      const name = get('name')
      const priceRaw = get('price')
      if (!sku || !name || priceRaw === '') {
        results.skipped.push({ row: rowNum, sku: sku || null, reason: 'Missing SKU, Name, or Price.' })
        return
      }
      const price = Number(priceRaw)
      if (!Number.isFinite(price) || price < 0) {
        results.skipped.push({ row: rowNum, sku, reason: 'Price must be a non-negative number.' })
        return
      }
      const activeRaw = get('active').toLowerCase()
      const active = CSV_BOOL_FALSE.has(activeRaw) ? false : (activeRaw === '' || CSV_BOOL_TRUE.has(activeRaw))
      const stockQtyRaw = get('stockQty')
      const stockQty = stockQtyRaw === '' ? 0 : Math.max(0, Math.round(Number(stockQtyRaw)) || 0)
      const fields = {
        name,
        description: get('description') || null,
        category_id: resolveOrCreateCategoryId(get('category')),
        price,
        mrp: get('mrp') !== '' && Number.isFinite(Number(get('mrp'))) ? Number(get('mrp')) : null,
        cost_price: get('costPrice') !== '' && Number.isFinite(Number(get('costPrice'))) ? Number(get('costPrice')) : null,
        low_stock_threshold: get('lowStockThreshold') !== '' ? Math.max(0, Math.round(Number(get('lowStockThreshold'))) || 0) : 5,
        active,
        meta_title: get('metaTitle') || null,
        meta_description: get('metaDescription') || null
      }

      try {
        const existing = db.getProductBySku(sku)
        if (existing) {
          db.updateProduct(existing.id, fields)
          if (stockQtyRaw !== '') {
            const delta = stockQty - existing.stock_qty
            if (delta !== 0) db.adjustStock(existing.id, delta, 'adjustment', req.admin.id, 'Bulk upload')
          }
          results.updated++
        } else {
          let slug = slugify(name) || sku.toLowerCase()
          if (db.getProductBySlug(slug)) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`
          db.createProduct({ id: crypto.randomUUID(), sku, slug, stock_qty: stockQty, images: [], ...fields })
          results.created++
        }
      } catch (rowErr) {
        results.skipped.push({ row: rowNum, sku, reason: rowErr.message || 'Could not save this row.' })
      }
    })

    return res.json(results)
  })
})

const STOCK_ADJUST_REASONS = ['received', 'damaged', 'adjustment']
app.post('/api/admin/products/:id/adjust-stock', requireSuperAdmin, express.json(), (req, res) => {
  const existing = db.getProductById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  const delta = Math.round(Number(req.body.delta))
  if (!Number.isFinite(delta) || delta === 0) return res.status(400).json({ error: 'invalid_delta', message: 'Enter a non-zero whole-number adjustment.' })
  const reason = STOCK_ADJUST_REASONS.includes(req.body.reason) ? req.body.reason : null
  if (!reason) return res.status(400).json({ error: 'invalid_reason', message: 'Reason must be received, damaged, or adjustment.' })
  const result = db.adjustStock(existing.id, delta, reason, req.admin.id, (req.body.note || '').trim() || null)
  return res.json(result)
})

app.get('/api/admin/products/:id/stock-ledger', requireSuperAdmin, (req, res) => {
  const existing = db.getProductById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  return res.json({ ledger: db.listStockLedger(existing.id) })
})

// ---------------------------------------------------------------------------
// Cross-sell rules admin (super-admin-only, same as Pricing/Locations).
// ---------------------------------------------------------------------------

const CROSS_SELL_TRIGGER_TYPES = ['productType:document', 'productType:stationery', 'productType:stamp']
function isValidCrossSellTrigger(trigger) {
  if (CROSS_SELL_TRIGGER_TYPES.includes(trigger)) return true
  if (typeof trigger === 'string' && trigger.startsWith('product:')) return !!db.getProductById(trigger.slice('product:'.length))
  return false
}
// A recommendation is either a stationery product id (existing behavior) or
// 'stamp:<stampTypeId>' pointing at an active admin-configured stamp type —
// resolves the same way db.listCrossSellRulesForTrigger does, so a rule can
// never be saved pointing at something the public endpoint would then
// silently drop.
function resolveCrossSellRecommendation(value) {
  if (typeof value !== 'string' || !value) return null
  if (value.startsWith('stamp:')) {
    const stampTypeId = value.slice('stamp:'.length)
    const types = ((db.getPricing().stamps || {}).types || [])
    const type = types.find((t) => t.id === stampTypeId && t.active)
    return type ? 'stamp:' + type.id : null
  }
  const product = db.getProductById(value)
  return product ? product.id : null
}

app.get('/api/admin/cross-sell-rules', requireSuperAdmin, (req, res) => {
  res.json({ rules: db.listCrossSellRules({ includeInactive: true }) })
})

app.post('/api/admin/cross-sell-rules', requireSuperAdmin, express.json(), (req, res) => {
  const { triggerType, recommendedProductId, sortOrder, active } = req.body || {}
  if (!isValidCrossSellTrigger(triggerType)) return res.status(400).json({ error: 'invalid_trigger', message: 'Choose a valid trigger.' })
  const resolved = resolveCrossSellRecommendation(recommendedProductId)
  if (!resolved) return res.status(400).json({ error: 'invalid_product', message: 'Choose a product or stamp to recommend.' })
  const rule = db.createCrossSellRule({
    id: crypto.randomUUID(), trigger_type: triggerType, recommended_product_id: resolved,
    sort_order: Number(sortOrder) || 0, active: active !== false
  })
  return res.json({ rule })
})

app.put('/api/admin/cross-sell-rules/:id', requireSuperAdmin, express.json(), (req, res) => {
  const existing = db.getCrossSellRuleById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  const { triggerType, recommendedProductId, sortOrder, active } = req.body || {}
  if (!isValidCrossSellTrigger(triggerType)) return res.status(400).json({ error: 'invalid_trigger', message: 'Choose a valid trigger.' })
  const resolved = resolveCrossSellRecommendation(recommendedProductId)
  if (!resolved) return res.status(400).json({ error: 'invalid_product', message: 'Choose a product or stamp to recommend.' })
  const rule = db.updateCrossSellRule(existing.id, {
    trigger_type: triggerType, recommended_product_id: resolved, sort_order: Number(sortOrder) || 0, active: active !== false
  })
  return res.json({ rule })
})

app.delete('/api/admin/cross-sell-rules/:id', requireSuperAdmin, (req, res) => {
  const existing = db.getCrossSellRuleById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  db.deleteCrossSellRule(existing.id)
  return res.json({ deleted: true })
})

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, mobile: user.mobile, marketingOptIn: !!user.marketing_opt_in }
}

app.post('/api/auth/signup', express.json(), async (req, res) => {
  const { name, email, mobile, password, marketingOptIn } = req.body || {}
  if (!name || !email || !mobile || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'Name, email, mobile, and password are all required.' })
  }
  if (db.findUserByIdentifier(email) || db.findUserByIdentifier(mobile)) {
    return res.status(409).json({ error: 'already_exists', message: 'An account with this email or mobile already exists.' })
  }
  const password_hash = await bcrypt.hash(password, 10)
  // Opt-in defaults off — signup doesn't imply consent to marketing, only to
  // the transactional order/account emails every account needs regardless.
  const user = db.createUser({ id: crypto.randomUUID(), name, email, mobile, password_hash, marketingOptIn: !!marketingOptIn })
  const token = jwt.sign({ role: 'customer', sub: user.id }, getJwtSecret(), { expiresIn: '30d' })
  return res.json({ token, user: publicUser(user) })
})

app.post('/api/auth/login', express.json(), async (req, res) => {
  const { identifier, password } = req.body || {}
  if (!identifier || !password) {
    return res.status(400).json({ error: 'missing_fields' })
  }
  const rlKey = `customer:${req.ip}:${String(identifier).toLowerCase()}`
  if (checkLoginRateLimit(rlKey)) {
    return res.status(429).json({ error: 'too_many_attempts', message: 'Too many login attempts. Please try again in a few minutes.' })
  }
  const user = db.findUserByIdentifier(identifier)
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email/mobile or password.' })
  }
  clearLoginRateLimit(rlKey)
  const token = jwt.sign({ role: 'customer', sub: user.id }, getJwtSecret(), { expiresIn: '30d' })
  return res.json({ token, user: publicUser(user) })
})

app.get('/api/me', requireCustomer, (req, res) => {
  const user = db.getUserById(req.userId)
  if (!user) return res.status(404).json({ error: 'not_found' })
  return res.json({ user: publicUser(user) })
})

// Always returns the same generic response whether or not the email is
// registered — avoids leaking which emails have accounts.
app.post('/api/auth/forgot-password', express.json(), async (req, res) => {
  const { email } = req.body || {}
  const generic = { message: 'If that email is registered, a reset link has been sent.' }
  if (!email) return res.json(generic)

  const user = db.findUserByEmail(email)
  if (user) {
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    db.createPasswordReset({
      id: crypto.randomUUID(),
      user_id: user.id,
      token_hash: tokenHash,
      expires_at: Date.now() + 60 * 60 * 1000 // 1 hour
    })
    const resetUrl = `${req.protocol}://${req.get('host')}/?resetToken=${rawToken}`
    try {
      await mailer.sendPasswordResetEmail(user.email, resetUrl)
    } catch (err) {
      console.error('[auth] failed to send password reset email', err.message)
    }
  }
  return res.json(generic)
})

app.post('/api/auth/reset-password', express.json(), async (req, res) => {
  const { token, newPassword } = req.body || {}
  if (!token || !newPassword) return res.status(400).json({ error: 'missing_fields' })
  if (newPassword.length < 8) return res.status(400).json({ error: 'weak_password', message: 'Password must be at least 8 characters.' })

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex')
  const reset = db.findValidPasswordReset(tokenHash)
  // A user_id starting with 'admin:' is an admin reset token — it must go
  // through /api/admin/reset-password, never this customer endpoint.
  if (!reset || String(reset.user_id).startsWith('admin:')) return res.status(400).json({ error: 'invalid_or_expired_token' })

  const password_hash = await bcrypt.hash(newPassword, 10)
  db.updateUserPassword(reset.user_id, password_hash)
  db.markPasswordResetUsed(reset.id)
  return res.json({ message: 'Password updated — you can now log in.' })
})

// View-only order history for the logged-in customer — deliberately omits
// delivery address and other internal fields (downloads remain admin-only).
app.get('/api/my/orders', requireCustomer, (req, res) => {
  const orders = db.listOrdersForCustomer(req.userId).map((o) => {
    let files = []
    try { files = o.files_json ? JSON.parse(o.files_json) : [] } catch (err) { files = [] }
    return {
      id: o.id,
      created_at: o.created_at,
      order_status: o.order_status,
      total_amount: o.total_amount,
      paper_size: o.paper_size,
      paper_type: o.paper_type,
      print_mode: o.print_mode,
      copies: o.copies,
      fileNames: files.length ? files.map((f) => f.fileName) : [o.file_name].filter(Boolean)
    }
  })
  return res.json({ orders })
})

// Public — the OAuth Client ID is not secret; the frontend needs it to render the Google button.
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' })
})

// Public — the Maps key is HTTP-referrer-restricted to print.metalix.in, so it's
// safe to hand to the browser; the checkout page needs it for address autocomplete.
app.get('/api/maps-config', (req, res) => {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '' })
})

const { OAuth2Client } = require('google-auth-library')

app.post('/api/auth/google', express.json(), async (req, res) => {
  const { idToken } = req.body || {}
  if (!idToken) return res.status(400).json({ error: 'missing_id_token' })
  const clientId = process.env.GOOGLE_CLIENT_ID
  if (!clientId) return res.status(500).json({ error: 'google_not_configured' })

  let payload
  try {
    const client = new OAuth2Client(clientId)
    const ticket = await client.verifyIdToken({ idToken, audience: clientId })
    payload = ticket.getPayload()
  } catch (err) {
    return res.status(401).json({ error: 'invalid_google_token' })
  }
  if (!payload || !payload.email) {
    return res.status(401).json({ error: 'invalid_google_token' })
  }

  let user = db.findUserByGoogleId(payload.sub)
  if (!user) {
    user = db.findUserByEmail(payload.email)
    if (user) {
      // Same email already has a password-based account — link Google as another way in.
      user = db.linkGoogleId(user.id, payload.sub)
    } else {
      const password_hash = await bcrypt.hash(crypto.randomUUID(), 10)
      user = db.createUser({
        id: crypto.randomUUID(),
        name: payload.name || payload.email.split('@')[0],
        email: payload.email,
        mobile: null,
        password_hash,
        google_id: payload.sub
      })
    }
  }

  const token = jwt.sign({ role: 'customer', sub: user.id }, getJwtSecret(), { expiresIn: '30d' })
  return res.json({ token, user: publicUser(user) })
})

app.get('/api/admin/orders', requireAdmin, requireTab('orders'), (req, res) => {
  const { status, search, limit, offset, location } = req.query
  // A branch admin's own scope always wins; a super admin may optionally
  // filter to one branch via ?location=, or omit it to see every branch.
  const locationId = scopeLocation(req) || (location || undefined)
  const orders = db.listOrders({
    status: status || undefined,
    search: search || undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
    locationId
  })
  return res.json({ orders })
})

// Full single-order lookup for the printable job sheet — distinct from the
// public /api/orders/:id (which any customer with the order ID can hit) since
// this is gated behind requireAdmin.
app.get('/api/admin/orders/:id', requireAdmin, requireTab('orders'), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  return res.json({ order })
})

// Merges the job-sheet cover/back pages (rendered to images client-side via
// html2canvas, since we deliberately avoid a headless-Chromium server
// dependency) with the customer's actual print-ready document(s) into one
// PDF — page 1 cover, middle pages the real document(s), last page branding.
const A4_PT = { width: 595.28, height: 841.89 }
const MM_TO_PT = 2.834645669
// fs.readFileSync can return a Buffer that's a view into a larger, reused
// internal memory pool (a nonzero byteOffset into a bigger underlying
// ArrayBuffer) rather than a dedicated allocation — normal and harmless for
// almost everything, but pdf-lib's JPEG/PNG embedders read straight from
// `buffer.buffer` at absolute offset 0 and ignore byteOffset entirely, so a
// pooled buffer makes them parse garbage from earlier in the pool and throw
// (e.g. "SOI not found in JPEG") — intermittently, depending on incidental
// pool state at the time of the read, not on anything about the file itself.
// ArrayBuffer#slice always performs a real copy, independent of any of that,
// so this guarantees byteOffset 0 regardless of how the input was allocated.
function toCleanBuffer(buf) {
  return Buffer.from(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
}
// Physical page size for a source document's content, in PDF points — read
// from the admin-owned pageSizes row (widthMm/heightMm) rather than a
// hardcoded id lookup, since a row's id can outlive a rename (e.g. id
// 'letter' relabeled to '4R' for photo prints) and must still size correctly.
// Falls back to A4 if the row or its dimensions are missing.
function sizePt(pricingConfig, id) {
  const row = (pricingConfig.pageSizes || []).find((s) => s.id === id)
  if (!row || !row.widthMm || !row.heightMm) return A4_PT
  return {
    width: Math.round(row.widthMm * MM_TO_PT * 100) / 100,
    height: Math.round(row.heightMm * MM_TO_PT * 100) / 100
  }
}
app.post('/api/admin/orders/:id/jobsheet-pdf', requireAdmin, requireTab('orders'), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const { coverImage, backImage } = req.body || {}
  if (!coverImage || !backImage) return res.status(400).json({ error: 'missing_images' })
  if (order.files_deleted_at) {
    return res.status(410).json({ error: 'files_deleted', message: 'The original files for this order were already auto-deleted (3 days after completion) — only the job sheet cover/back pages can be generated, not the merged document.' })
  }

  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  if (!files.length && order.file_path) {
    files = [{ fileId: order.file_path, fileName: order.file_name }]
  }

  try {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
    const merged = await PDFDocument.create()
    const pricingConfig = db.getPricing()

    async function addImagePage(dataUrl) {
      const base64 = dataUrl.split(',')[1] || ''
      // toCleanBuffer: see its definition above — Buffer.from(base64string) can
      // return a pooled, nonzero-byteOffset buffer just like fs.readFileSync.
      const bytes = toCleanBuffer(Buffer.from(base64, 'base64'))
      const img = dataUrl.startsWith('data:image/png') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes)
      const scale = A4_PT.width / img.width
      const drawHeight = Math.min(img.height * scale, A4_PT.height)
      const page = merged.addPage([A4_PT.width, A4_PT.height])
      page.drawImage(img, { x: 0, y: A4_PT.height - drawHeight, width: A4_PT.width, height: drawHeight })
    }

    await addImagePage(coverImage)

    const font = await merged.embedFont(StandardFonts.Helvetica)

    // Convert every file to a PDF buffer up front, in parallel. A LibreOffice
    // cold-start (each conversion spawns its own soffice process) dominates
    // this step, and every file's conversion is independent — running them
    // concurrently turns N sequential cold-starts into one wait instead of N,
    // which is most of where "Print Job Sheet" felt slow on multi-file orders.
    // Page-embedding below stays sequential (it mutates the one shared
    // `merged` PDFDocument, and is CPU-bound/fast either way).
    const converted = await Promise.all(files.map(async (f) => {
      // Stationery is a ready-made product picked from inventory, not
      // printed — no file/conversion at all, just an instruction page (see
      // the render loop below) telling staff what to pick and how many.
      if (f.productType === 'stationery') return { f, isStationery: true }
      // Custom stamps are manufactured, not printed — no LibreOffice
      // conversion needed. The optional logo (if any) is read here so the
      // render loop below can embed it straight onto the instruction page.
      if (f.productType === 'stamp') {
        const result = { f, isStamp: true }
        if (f.logoFileId) {
          const logoPath = path.join(uploadsDir, path.basename(String(f.logoFileId)))
          if (fs.existsSync(logoPath)) {
            try { result.imageBuffer = toCleanBuffer(fs.readFileSync(logoPath)) } catch (err) { /* unreadable — jobsheet notes this below */ }
          }
        }
        // A customer-uploaded design (in place of typed text) can be an
        // image or a PDF (see stamps.html's artwork upload accept list) — an
        // image is embedded on the instruction page like a logo; a PDF's
        // pages are appended after it in full, same as a document file, so
        // staff always see the design at its original fidelity.
        if (f.artworkFileId) {
          const artworkPath = path.join(uploadsDir, path.basename(String(f.artworkFileId)))
          if (fs.existsSync(artworkPath)) {
            const ext = path.extname(f.artworkFileId).toLowerCase()
            try {
              if (ext === '.pdf') result.artworkPdfBuffer = fs.readFileSync(artworkPath)
              else result.artworkImageBuffer = toCleanBuffer(fs.readFileSync(artworkPath))
            } catch (err) { /* unreadable — jobsheet notes this below */ }
          }
        }
        return result
      }
      // Passport-photo items are raster images, not documents — no
      // LibreOffice conversion needed. A missing fileId here is expected
      // (admin-created orders can have a photo-less pack, see
      // buildPricedOrderFiles), not an error.
      if ((f.productType || 'document') === 'passport-photo') {
        const safeFileId = f.fileId ? path.basename(String(f.fileId)) : ''
        const filePath = safeFileId ? path.join(uploadsDir, safeFileId) : null
        if (!filePath || !fs.existsSync(filePath)) return { f, safeFileId, isPassport: true }
        try {
          return { f, safeFileId, isPassport: true, imageBuffer: toCleanBuffer(fs.readFileSync(filePath)) }
        } catch (err) {
          return { f, safeFileId, isPassport: true }
        }
      }
      const safeFileId = path.basename(String(f.fileId || ''))
      const filePath = path.join(uploadsDir, safeFileId)
      if (!safeFileId || !fs.existsSync(filePath)) return { f, safeFileId, skip: true }
      try {
        const buffer = fs.readFileSync(filePath)
        const ext = path.extname(f.fileName || safeFileId).toLowerCase() || '.pdf'
        const pdfBuffer = ext === '.pdf' ? buffer : await convertToPdf(buffer, ext)
        return { f, safeFileId, pdfBuffer }
      } catch (err) {
        return { f, safeFileId, convertError: err }
      }
    }))

    for (const { f, safeFileId, pdfBuffer, convertError, skip, isPassport, isStationery, isStamp, imageBuffer, artworkImageBuffer, artworkPdfBuffer } of converted) {
      if (isStamp) {
        const page = merged.addPage([A4_PT.width, A4_PT.height])
        page.drawText('PRODUCE THIS STAMP', { x: 50, y: A4_PT.height - 90, size: 20, font, color: rgb(1, 0.4, 0) })
        const type = ((pricingConfig.stamps || {}).types || []).find((t) => t.id === f.stampTypeId)
        const size = ((type && type.sizes) || []).find((s) => s.id === f.stampSizeId)
        const qty = f.quantity || 1
        page.drawText(sanitizeForFont(`${qty} × ${type ? type.label : (f.stampTypeId || 'Stamp')}`, font), { x: 50, y: A4_PT.height - 140, size: 15, font, color: rgb(0.1, 0.13, 0.2) })
        if (size) page.drawText(sanitizeForFont(`Size: ${size.label}`, font), { x: 50, y: A4_PT.height - 165, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
        let ty = A4_PT.height - 200
        if (f.textLines && f.textLines.length) {
          page.drawText('Text:', { x: 50, y: ty, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
          ty -= 18
          f.textLines.forEach((line) => {
            page.drawText(sanitizeForFont(line, font), { x: 50, y: ty, size: 14, font, color: rgb(0.1, 0.13, 0.2) })
            ty -= 20
          })
        } else if (f.artworkFileId) {
          page.drawText('Customer supplied their own design — see below' + (artworkPdfBuffer ? '/next page' : '') + '.', { x: 50, y: ty, size: 12, font, color: rgb(0.1, 0.13, 0.2) })
          ty -= 24
        }
        if (imageBuffer) {
          try {
            const ext = path.extname(f.logoFileId || '').toLowerCase()
            const img = ext === '.png' ? await merged.embedPng(imageBuffer) : await merged.embedJpg(imageBuffer)
            const maxW = 180, maxH = 180
            const scale = Math.min(maxW / img.width, maxH / img.height, 1)
            page.drawText('Logo:', { x: 50, y: ty - 20, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
            page.drawImage(img, { x: 50, y: ty - 30 - img.height * scale, width: img.width * scale, height: img.height * scale })
            ty = ty - 40 - img.height * scale
          } catch (err) { /* logo embed failed — stamp text above still lets staff produce it */ }
        } else if (f.logoFileId) {
          page.drawText('Logo attached but could not be loaded — check the original upload.', { x: 50, y: ty - 20, size: 10, font, color: rgb(0.7, 0.2, 0.2) })
          ty -= 30
        }
        if (artworkImageBuffer) {
          try {
            const ext = path.extname(f.artworkFileId || '').toLowerCase()
            const img = ext === '.png' ? await merged.embedPng(artworkImageBuffer) : await merged.embedJpg(artworkImageBuffer)
            const maxW = 300, maxH = 260
            const scale = Math.min(maxW / img.width, maxH / img.height, 1)
            page.drawText('Uploaded design:', { x: 50, y: ty - 20, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
            page.drawImage(img, { x: 50, y: ty - 30 - img.height * scale, width: img.width * scale, height: img.height * scale })
          } catch (err) {
            page.drawText('Design attached but could not be loaded — check the original upload.', { x: 50, y: ty - 20, size: 10, font, color: rgb(0.7, 0.2, 0.2) })
          }
        } else if (f.artworkFileId && !artworkPdfBuffer) {
          page.drawText('Design attached but could not be loaded — check the original upload.', { x: 50, y: ty - 20, size: 10, font, color: rgb(0.7, 0.2, 0.2) })
        }
        // A PDF design is appended as its own full-fidelity page(s) right
        // after the instruction page, same embed-and-fit approach as a
        // regular document file below — never rasterized, so staff see
        // exactly what the customer supplied.
        if (artworkPdfBuffer) {
          try {
            const srcDoc = await PDFDocument.load(artworkPdfBuffer, { ignoreEncryption: true })
            for (const idx of srcDoc.getPageIndices()) {
              let hasContents = false
              try { hasContents = !!srcDoc.getPage(idx).node.Contents() } catch (e) { hasContents = false }
              if (!hasContents) continue
              try {
                const [ep] = await merged.embedPdf(srcDoc, [idx])
                const pw = ep.width, ph = ep.height
                const landscape = pw > ph
                const pageW = landscape ? A4_PT.height : A4_PT.width
                const pageH = landscape ? A4_PT.width : A4_PT.height
                const scale = Math.min(pageW / pw, pageH / ph)
                const w = pw * scale, h = ph * scale
                const artPage = merged.addPage([pageW, pageH])
                artPage.drawText('UPLOADED STAMP DESIGN', { x: 30, y: pageH - 30, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
                artPage.drawPage(ep, { x: (pageW - w) / 2, y: (pageH - h) / 2 - 10, width: w, height: h })
              } catch (pageErr) { /* one page failed — instruction page above still lets staff produce it */ }
            }
          } catch (err) { /* whole PDF failed to load — instruction page above still notes it was supplied */ }
        }
        continue
      }
      if (isStationery) {
        const page = merged.addPage([A4_PT.width, A4_PT.height])
        page.drawText('PICK FROM INVENTORY', { x: 50, y: A4_PT.height - 90, size: 20, font, color: rgb(1, 0.4, 0) })
        const qty = f.quantity || 1
        const label = sanitizeForFont(`${qty} × ${f.name || f.fileName || 'Product'}`, font)
        page.drawText(label, { x: 50, y: A4_PT.height - 140, size: 16, font, color: rgb(0.1, 0.13, 0.2) })
        if (f.sku) page.drawText(sanitizeForFont(`SKU: ${f.sku}`, font), { x: 50, y: A4_PT.height - 168, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
        page.drawText(sanitizeForFont(`Rs. ${formatRupees(f.amount || 0)}`, font), { x: 50, y: A4_PT.height - 190, size: 11, font, color: rgb(0.42, 0.45, 0.5) })
        continue
      }
      if (isPassport) {
        // Helvetica (WinAnsi) can't render ₹ — same "Rs." convention as invoice.js.
        const label = sanitizeForFont(`Passport Photo Pack — ${f.paperLabel || f.sizePresetId || 'Passport Photo'} · ${f.colorLabel || ((f.packQty || 0) + '-pack')} · Rs. ${formatRupees(f.amount || 0)}`, font)
        const preset = ((pricingConfig.passportPhotos || {}).sizePresets || []).find((s) => s.id === f.sizePresetId)
        if (imageBuffer && preset) {
          // Real print output: tile the cropped photo across as many A4
          // sheets as the pack quantity needs, at its actual physical size —
          // same computeGridLayout() a customer's live preview used, so what
          // staff print always matches what the customer saw before ordering.
          try {
            const ext = path.extname(f.fileName || safeFileId || '').toLowerCase()
            const img = ext === '.png' ? await merged.embedPng(imageBuffer) : await merged.embedJpg(imageBuffer)
            const a4Row = (pricingConfig.pageSizes || []).find((s) => s.id === 'a4')
            const layout = computePassportGridLayout({
              sheetWidthMm: (a4Row && a4Row.widthMm) || 210,
              sheetHeightMm: (a4Row && a4Row.heightMm) || 297,
              photoWidthMm: preset.widthMm,
              photoHeightMm: preset.heightMm,
              qty: f.packQty || 1
            })
            const photoWPt = layout.photoWidthMm * MM_TO_PT
            const photoHPt = layout.photoHeightMm * MM_TO_PT
            // Nothing but the photos themselves goes on these pages — this
            // sheet gets cut up and handed straight to the customer, so no
            // staff label/pricing text may appear on it anywhere. Order
            // context (size/pack/price) lives on the cover sheet instead.
            layout.sheets.forEach((sheet) => {
              const page = merged.addPage([A4_PT.width, A4_PT.height])
              sheet.positions.forEach((pos) => {
                const xPt = pos.x * MM_TO_PT
                // PDF y-axis grows upward from the bottom; layout math is
                // top-down (mm from the top edge), so flip it here.
                const yPt = A4_PT.height - pos.y * MM_TO_PT - photoHPt
                page.drawImage(img, { x: xPt, y: yPt, width: photoWPt, height: photoHPt })
              })
            })
          } catch (err) {
            const page = merged.addPage([A4_PT.width, A4_PT.height])
            page.drawText('Could not render the uploaded photo — check the original file.', { x: 50, y: A4_PT.height - 120, size: 12, font, color: rgb(0.1, 0.13, 0.2) })
            page.drawText(label, { x: 50, y: 60, size: 13, font, color: rgb(0.1, 0.13, 0.2) })
          }
          continue
        }
        // No photo uploaded yet (admin-created order, see buildPricedOrderFiles's
        // allowMissingFile) or an unrecognized size preset — a single
        // placeholder reference page instead of a real grid.
        const page = merged.addPage([A4_PT.width, A4_PT.height])
        page.drawText('No photo uploaded yet for this pack.', { x: 50, y: A4_PT.height - 120, size: 12, font, color: rgb(0.1, 0.13, 0.2) })
        page.drawText(label, { x: 50, y: 60, size: 13, font, color: rgb(0.1, 0.13, 0.2) })
        continue
      }
      if (skip) continue
      if (convertError) {
        const page = merged.addPage([A4_PT.width, A4_PT.height])
        const lines = [
          `Could not auto-include "${f.fileName || safeFileId}".`,
          'It may be password-protected or in an unsupported format.',
          'Use the per-file Download button in admin to print it manually.'
        ]
        if (f.password) lines.push(`Document password on file: ${f.password}`)
        lines.forEach((line, i) => page.drawText(sanitizeForFont(line, font), { x: 50, y: A4_PT.height - 80 - i * 22, size: 12, font, color: rgb(0.1, 0.13, 0.2) }))
        continue
      }
      try {
        // Normalize every document page onto the file's own chosen page size:
        // fit-to-page (preserve aspect ratio, centered), portrait or landscape
        // to match the source page's orientation. A pre-feature order has no
        // f.pageSize — falls back to A4, its actual physical size at the time.
        const filePt = sizePt(pricingConfig, f.pageSize || 'a4')
        const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
        // The job sheet is what staff actually print from — it must contain
        // as many copies of the file as the customer paid for, not just one.
        const numCopies = Math.max(1, Math.min(999, Math.round(Number(f.copies)) || 1))
        for (let copyNum = 0; copyNum < numCopies; copyNum++) {
          for (const idx of srcDoc.getPageIndices()) {
            // Content-less pages can't be embedded (pdf-lib throws at save), so
            // detect them and emit a blank sheet at the file's page size —
            // preserving page count/order.
            let hasContents = false
            try { hasContents = !!srcDoc.getPage(idx).node.Contents() } catch (e) { hasContents = false }
            if (!hasContents) { merged.addPage([filePt.width, filePt.height]); continue }
            try {
              const [ep] = await merged.embedPdf(srcDoc, [idx])
              const pw = ep.width
              const ph = ep.height
              const landscape = pw > ph
              const pageW = landscape ? filePt.height : filePt.width
              const pageH = landscape ? filePt.width : filePt.height
              const scale = Math.min(pageW / pw, pageH / ph)
              const w = pw * scale
              const h = ph * scale
              const pg = merged.addPage([pageW, pageH])
              pg.drawPage(ep, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h })
            } catch (pageErr) {
              merged.addPage([filePt.width, filePt.height])
            }
          }
        }
      } catch (err) {
        const page = merged.addPage([A4_PT.width, A4_PT.height])
        const lines = [
          `Could not auto-include "${f.fileName || safeFileId}".`,
          'It may be password-protected or in an unsupported format.',
          'Use the per-file Download button in admin to print it manually.'
        ]
        if (f.password) lines.push(`Document password on file: ${f.password}`)
        lines.forEach((line, i) => page.drawText(sanitizeForFont(line, font), { x: 50, y: A4_PT.height - 80 - i * 22, size: 12, font, color: rgb(0.1, 0.13, 0.2) }))
      }
    }

    await addImagePage(backImage)

    // Embed the order ID as the PDF title so "print → Save as PDF" and most
    // viewers suggest an order-ID filename (downloads are already named below).
    merged.setTitle(`Metalix Job Sheet ${order.id}`)
    merged.setAuthor('Metalix Print')
    merged.setSubject(`Job sheet for order ${order.id}`)

    const pdfBytes = await merged.save()
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="jobsheet-${order.id}.pdf"`)
    return res.send(Buffer.from(pdfBytes))
  } catch (err) {
    console.error('jobsheet-pdf merge failed', err)
    return res.status(500).json({ error: 'merge_failed', message: 'Could not generate the combined job sheet PDF.' })
  }
})

app.patch('/api/admin/orders/:id', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const {
    order_status, failure_reason,
    customer_name, customer_mobile, customer_email,
    delivery_method, delivery_address, delivery_city, delivery_state, delivery_pincode,
    files,
    location_id, notes, needs_attention,
    discountType, discountValue, discountCode, discountReason
  } = req.body || {}
  if (order_status === 'Completed' && order.payment_method === 'cod' && order.payment_status !== 'paid') {
    return res.status(400).json({ error: 'payment_not_collected', message: 'This is a pay-on-delivery order — collect cash/UPI payment before marking it Completed.' })
  }

  // Whether this request is explicitly touching the discount — a key being
  // present (even as null/'', clearing it) counts, same !== undefined
  // convention as every other optional field here.
  const discountFieldsProvided = discountType !== undefined || discountValue !== undefined || discountCode !== undefined

  // Content edits (customer/delivery/print options) are only allowed before
  // money has changed hands — once paid, reprising here would mean silently
  // rewriting what was actually printed/delivered for a paid amount. Place a
  // new order for the customer instead. Status changes (order_status/
  // failure_reason) are unaffected — those must keep working on paid orders,
  // which is the normal happy path.
  //
  // Discount is deliberately excluded from this gate, same as notes/
  // location_id below — a post-hoc goodwill discount or correcting a missed
  // one on an already-paid (including Completed) order doesn't touch what
  // was printed or delivered, only the recorded price. The repricing block
  // further down still recomputes print/delivery cost from the order's
  // EXISTING files/delivery info whenever only discount fields are sent (no
  // files/delivery_method in the request), so those figures come out
  // unchanged — only discount_amount/gst_amount/total_amount actually move.
  const wantsContentEdit = customer_name !== undefined || customer_mobile !== undefined || customer_email !== undefined ||
    delivery_method !== undefined || delivery_address !== undefined || delivery_city !== undefined ||
    delivery_state !== undefined || delivery_pincode !== undefined || Array.isArray(files)
  if (wantsContentEdit && String(order.payment_status).toLowerCase() === 'paid') {
    return res.status(400).json({ error: 'order_already_paid', message: 'This order is already paid — place a new order for the customer instead of editing this one.' })
  }

  // Discount is excluded from the gate above, but a gateway (Razorpay)
  // payment is its own, narrower exception to *that* exception: once
  // payment_method is 'online' and payment_status is 'paid', the amount is
  // already captured and settled through the gateway — changing
  // discount_amount here would just make total_amount disagree with what
  // Razorpay actually charged, with no corresponding refund to reconcile it.
  // A cash/UPI walk-in order (payment_method 'cod', even though marked
  // 'paid') has no such problem — staff can reconcile the difference by
  // hand — so only the gateway case is blocked.
  if (discountFieldsProvided && order.payment_method === 'online' && String(order.payment_status).toLowerCase() === 'paid') {
    return res.status(400).json({ error: 'gateway_payment_locked', message: 'This order was paid online through the payment gateway — the discount can’t be changed after a gateway payment. Process a refund for the difference instead if needed.' })
  }

  // Re-resolves fresh on every edit (never trusts the order's existing
  // discount_amount) — same allowAdHoc: true reasoning as the walk-in create
  // route, since this is staff-only. An explicit discountType/Value/Code in
  // this request overrides; otherwise the order's existing discount (if any)
  // carries forward into the repricing below unchanged.
  let discountResolved
  if (discountFieldsProvided) {
    discountResolved = resolveDiscountInput({ discountCode, discountType, discountValue, discountReason }, { allowAdHoc: true })
    if (discountResolved.error) return res.status(400).json({ error: discountResolved.error, message: discountResolved.message })
  } else if (order.discount_type) {
    discountResolved = { discount: { type: order.discount_type, value: order.discount_value, minOrderValue: 0 }, code: order.discount_code, reason: order.discount_reason }
  } else {
    discountResolved = { discount: null, code: null, reason: null }
  }

  if (customer_mobile !== undefined && !/^\d{10}$/.test(String(customer_mobile))) {
    return res.status(400).json({ error: 'invalid_mobile', message: 'Mobile must be a 10-digit number.' })
  }
  if (delivery_method === 'delivery' && (delivery_address !== undefined || delivery_pincode !== undefined)) {
    const addr = delivery_address !== undefined ? delivery_address : order.delivery_address
    const city = delivery_city !== undefined ? delivery_city : order.delivery_city
    const state = delivery_state !== undefined ? delivery_state : order.delivery_state
    const pin = delivery_pincode !== undefined ? delivery_pincode : order.delivery_pincode
    if (!addr || !city || !state || !pin) return res.status(400).json({ error: 'missing_delivery_address' })
  }

  const updates = {}
  if (order_status !== undefined) updates.order_status = order_status
  if (failure_reason !== undefined) updates.failure_reason = failure_reason
  if (customer_name !== undefined) updates.customer_name = customer_name
  if (customer_mobile !== undefined) updates.customer_mobile = customer_mobile
  if (customer_email !== undefined) updates.customer_email = customer_email || null
  if (delivery_method !== undefined) updates.delivery_method = delivery_method
  if (delivery_address !== undefined) updates.delivery_address = delivery_address || null
  if (delivery_city !== undefined) updates.delivery_city = delivery_city || null
  if (delivery_state !== undefined) updates.delivery_state = delivery_state || null
  if (delivery_pincode !== undefined) updates.delivery_pincode = delivery_pincode || null
  // Pure bookkeeping (staff-facing instructions, never affects money), so —
  // like location_id below — it's allowed even on a paid order.
  if (notes !== undefined) updates.notes = String(notes || '').trim().slice(0, 500) || null
  // Staff dismissing the stock-shortfall warning banner (see
  // confirmStockForOrder) — pure bookkeeping, allowed even on a paid order.
  // Only ever settable to 0 here (clearing it); it's set to 1 only by the
  // system itself, never by a client request.
  if (needs_attention !== undefined) updates.needs_attention = needs_attention ? 1 : 0
  // Pure bookkeeping (which branch fulfilled it) — never touches money, so
  // it's allowed even on a paid order, unlike the content edits above.
  if (location_id !== undefined) {
    const loc = location_id ? db.getLocations().find((l) => l.id === location_id && l.active) : null
    if (location_id && !loc) return res.status(400).json({ error: 'invalid_location', message: 'Unknown or inactive branch.' })
    updates.location_id = loc ? loc.id : null
    updates.location_name = loc ? loc.name : null
  }

  // Anything that affects price (per-file print options, or the delivery
  // method/pincode the delivery charge is based on) triggers a full
  // recompute through the same pricing.calculate() used at order creation —
  // never trust a client-supplied total.
  const repricingNeeded = Array.isArray(files) || delivery_method !== undefined || delivery_pincode !== undefined || discountFieldsProvided
  if (repricingNeeded) {
    let currentFiles = []
    try { currentFiles = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { currentFiles = [] }
    if (!currentFiles.length && order.file_path) {
      currentFiles = [{
        fileId: order.file_path, fileName: order.file_name, fileType: order.file_type,
        pageCount: order.page_count, colorPageCount: 0,
        printMode: order.print_mode, orientation: order.orientation,
        printSide: order.print_side, pageSize: order.paper_size, paperType: order.paper_type, copies: order.copies
      }]
    }
    const paperTypeConfig = db.getPricing()
    const pageSizeIds = (paperTypeConfig.pageSizes || []).filter((s) => s.active).map((s) => s.id)
    const passportPresetIds = ((paperTypeConfig.passportPhotos || {}).sizePresets || []).filter((s) => s.active).map((s) => s.id)
    const passportPackQtys = ((paperTypeConfig.passportPhotos || {}).packPrices || []).map((p) => p.qty)
    const VALID_MODES = ['auto', 'color', 'bw']
    const VALID_SIDES = ['single', 'double']
    // Keyed by itemId (assigned to every files_json line item at order
    // creation, all productTypes) falling back to fileId only for legacy
    // rows that predate itemId — fileId is null/non-unique for stationery,
    // service, and photo-less passport-photo lines, so keying by it alone
    // means multiple such lines in one order collide on the same `null` key
    // and only the last override survives, silently discarding edits to the
    // others. itemId fixes that for every productType at once.
    const overridesById = new Map((files || []).map((f) => [f.itemId || f.fileId, f]))

    // Branch per-item on productType — an order can mix Documents, Passport
    // Photos, Additional Services, and Stationery, and each has completely
    // disjoint editable fields. A passport-photo, service, or stationery
    // entry must NEVER fall through to the document branch below: none of
    // them have pageSize/paperType, so it would otherwise silently get
    // rewritten to pageSize:'a4'/paperType:'normal' and reprice as a
    // near-zero document. Services are add-only here (see POST
    // .../add-service) — this general edit flow just passes an existing one
    // through unchanged, same as it can't touch a passport pack's size/qty.
    const mergedFiles = currentFiles.map((f) => {
      if (f.productType === 'service') return f
      // Stamps aren't editable via this general flow (same as services) —
      // re-configuring a custom stamp's type/size/text/artwork after order
      // creation isn't supported in this phase; pass the line through
      // unchanged so it still reprices correctly via toPricingFile.
      if (f.productType === 'stamp') return f
      if (f.productType === 'stationery') {
        const o = overridesById.get(f.itemId || f.fileId) || {}
        const quantity = o.quantity !== undefined ? Math.max(1, Math.min(999, Math.round(Number(o.quantity)) || 1)) : f.quantity
        return { ...f, productType: 'stationery', quantity }
      }
      if ((f.productType || 'document') === 'passport-photo') {
        const o = overridesById.get(f.itemId || f.fileId) || {}
        const sizePresetId = passportPresetIds.includes(o.sizePresetId) ? o.sizePresetId : f.sizePresetId
        const packQty = passportPackQtys.includes(Number(o.packQty)) ? Number(o.packQty) : f.packQty
        // Lets staff attach a photo after the fact (e.g. it arrives over
        // WhatsApp after the order/invoice/payment-link was already created
        // with no file) — only overwrites fileId/fileName/etc when the
        // override actually supplies a new fileId that exists on disk.
        let fileOverride = {}
        if (o.fileId) {
          const safeFileId = path.basename(String(o.fileId))
          if (safeFileId && fs.existsSync(path.join(uploadsDir, safeFileId))) {
            fileOverride = { fileId: safeFileId, fileName: o.fileName || safeFileId, fileType: o.fileType || null, fileSize: Number(o.fileSize) || 0 }
          }
        }
        return { ...f, ...fileOverride, productType: 'passport-photo', sizePresetId, packQty }
      }
      const o = overridesById.get(f.itemId || f.fileId) || {}
      const printMode = VALID_MODES.includes(o.printMode) ? o.printMode : f.printMode
      const printSide = printMode === 'color' ? 'single' : (VALID_SIDES.includes(o.printSide) ? o.printSide : f.printSide)
      // Page size is resolved before paper type since which paper types are
      // valid depends on it. 'a4' is a legacy-data fallback only — f.pageSize
      // is absent on files_json entries stored before this field existed.
      const pageSize = pageSizeIds.includes(o.pageSize) ? o.pageSize : (pageSizeIds.includes(f.pageSize) ? f.pageSize : 'a4')
      const sizePaperTypeIds = (paperTypeConfig.rates[pageSize] || paperTypeConfig.rates.a4 || []).map((t) => t.id)
      const defaultPaperType = sizePaperTypeIds[0] || 'normal'
      const paperType = sizePaperTypeIds.includes(o.paperType) ? o.paperType : (sizePaperTypeIds.includes(f.paperType) ? f.paperType : defaultPaperType)
      const copies = o.copies !== undefined ? Math.max(1, Math.min(999, Math.round(Number(o.copies)) || 1)) : f.copies
      return { ...f, productType: 'document', printMode, printSide, pageSize, paperType, copies }
    })

    // Aggregate stock re-check on edit, same reasoning as buildPricedOrderFiles's
    // pre-scan — two stationery lines for the same product must be checked
    // together, not independently. Unreachable once a captured online
    // payment exists (the order_already_paid guard above already blocks any
    // content edit at that point), so this only ever runs pre-payment.
    const editedStationeryQtyByProduct = new Map()
    mergedFiles.forEach((f) => {
      if (f.productType === 'stationery' && f.productId) {
        editedStationeryQtyByProduct.set(f.productId, (editedStationeryQtyByProduct.get(f.productId) || 0) + (Number(f.quantity) || 0))
      }
    })
    for (const [productId, qty] of editedStationeryQtyByProduct) {
      const product = db.getProductById(productId)
      if (!product || qty > product.stock_qty) {
        return res.status(400).json({
          error: 'insufficient_stock',
          message: product ? `Only ${product.stock_qty} left in stock for "${product.name}".` : 'One of the stationery items is no longer available.'
        })
      }
    }

    const pricingFiles = mergedFiles.map(toPricingFile)

    const effectiveDeliveryMethod = delivery_method !== undefined ? delivery_method : order.delivery_method
    const effectiveDeliveryPincode = delivery_pincode !== undefined ? delivery_pincode : order.delivery_pincode
    const calc = pricing.calculate(paperTypeConfig, {
      files: pricingFiles,
      deliveryMethod: effectiveDeliveryMethod || 'pickup',
      deliveryPincode: effectiveDeliveryPincode,
      discount: discountResolved.discount
    })

    // Document-only summary fields — see the same rule in buildPricedOrderFiles.
    const mergedDocFiles = mergedFiles.filter((f) => f.productType === 'document')
    const fileModes = new Set(mergedDocFiles.map((f) => f.printMode))
    const fileSides = new Set(mergedDocFiles.map((f) => f.printSide))
    const filePaperTypes = new Set(mergedDocFiles.map((f) => f.paperType))
    const filePageSizes = new Set(mergedDocFiles.map((f) => f.pageSize))
    const mergedProductTypes = new Set(mergedFiles.map((f) => f.productType))

    // Bake each file's actual charged amount/labels in now, so an invoice
    // printed later reflects what was charged even if rates change meanwhile.
    mergedFiles.forEach((f, i) => { if (calc.fileBreakdown[i]) Object.assign(f, calc.fileBreakdown[i]) })

    updates.files_json = JSON.stringify(mergedFiles)
    updates.print_mode = mergedDocFiles.length ? (fileModes.size === 1 ? mergedDocFiles[0].printMode : 'mixed') : null
    updates.print_side = mergedDocFiles.length ? (fileSides.size === 1 ? mergedDocFiles[0].printSide : 'mixed') : null
    updates.paper_size = mergedDocFiles.length ? (filePageSizes.size === 1 ? mergedDocFiles[0].pageSize : 'mixed') : null
    updates.paper_type = mergedDocFiles.length ? (filePaperTypes.size === 1 ? mergedDocFiles[0].paperType : 'mixed') : null
    updates.product_type = mergedProductTypes.size === 1 ? mergedFiles[0].productType : (mergedProductTypes.size ? 'mixed' : 'document')
    updates.copies = mergedDocFiles.reduce((sum, f) => sum + f.copies, 0) +
      mergedFiles.filter((f) => f.productType === 'passport-photo').reduce((sum, f) => sum + (f.packQty || 0), 0)
    updates.print_cost = calc.printCost
    updates.services_cost = calc.servicesCost
    updates.stationery_cost = calc.stationeryCost
    updates.stamp_cost = calc.stampCost
    updates.delivery_charge = calc.deliveryCharge
    updates.handling_charge = calc.handlingCharge
    updates.gst_amount = calc.gstAmount
    updates.total_amount = calc.totalAmount
    updates.discount_type = discountResolved.discount ? discountResolved.discount.type : null
    updates.discount_value = discountResolved.discount ? discountResolved.discount.value : 0
    updates.discount_amount = calc.discountAmount
    updates.discount_code = discountResolved.code
    updates.discount_reason = discountResolved.reason
  }

  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_updates' })
  const updated = db.updateOrder(order.id, updates)

  // Keep the linked print job in step, and email the customer — but only when
  // the status actually changed. Fire-and-forget so a hiccup never fails the
  // admin's update.
  if (order.order_status !== updated.order_status) {
    printQueue.syncPrintJobStatus(updated.id, updated.order_status)
    // A genuine transition INTO a cancelled/refunded status restores any
    // stationery stock this order had decremented — checked against the OLD
    // status too, so re-saving an already-cancelled order (e.g. editing its
    // notes) can't double-credit stock on every subsequent PATCH.
    if (printQueue.isCancelledOrRefundedStatus(updated.order_status) && !printQueue.isCancelledOrRefundedStatus(order.order_status)) {
      db.restoreStockForOrder(updated)
    }
    const base = `${req.protocol}://${req.get('host')}`
    emailStatusChange(updated, base)
    smsCompletedNotification(updated, base)
  }

  return res.json({ order: updated })
})

// Whether reaching `status` should email the customer, per the admin-managed
// stage config (falls back to false for unknown/legacy statuses).
function stageNotifies(status) {
  const stage = db.getOrderStages().find((s) => s.name === status)
  return !!(stage && stage.notify)
}

// Whether a status change to `status` results in a customer email at all —
// a notify-enabled stage, or "Completed" (which always sends the invoice).
function willEmailOnStatus(status) {
  return status === 'Completed' || stageNotifies(status)
}

// Sends the appropriate customer email for a status change. "Completed" always
// gets a PDF invoice attached; other notify-enabled stages get the plain status
// email. Fully fire-and-forget (errors are logged, never thrown).
function emailStatusChange(order, base) {
  if (!order || !order.customer_email) return
  const trackUrl = `${base}/track/${order.id}`
  // Only used by the "Awaiting Customer Pickup" copy, but harmless to look up
  // for every status — a no-op when the order has no location or the branch
  // never set a Maps link.
  const location = order.location_id ? db.getLocationById(order.location_id) : null
  const mapsUrl = location ? location.mapsUrl : null
  if (order.order_status === 'Completed') {
    ;(async () => {
      let attachments = []
      try {
        attachments = [{ filename: `Invoice-${order.id}.pdf`, content: await buildInvoicePdf(order) }]
      } catch (err) {
        console.error(`[invoice] generation failed for ${order.id}:`, err.message)
      }
      await mailer.sendOrderStatusEmail(order, trackUrl, attachments, mapsUrl)
    })().catch((err) => console.error(`[orders] completed email failed for ${order.id}:`, err.message))
    return
  }
  if (stageNotifies(order.order_status)) {
    mailer.sendOrderStatusEmail(order, trackUrl, null, mapsUrl).catch((err) => console.error(`[orders] status email failed for ${order.id}:`, err.message))
  }
}

// Texts the customer a link to download their invoice once an order reaches
// Completed. Deliberately separate from emailStatusChange above — that
// function no-ops entirely when there's no customer_email, but a mobile
// number and an email are independent fields, so SMS gets its own gate.
function smsCompletedNotification(order, base) {
  if (!order || !order.customer_mobile || order.order_status !== 'Completed') return
  const invoiceUrl = `${base}/api/orders/${order.id}/invoice.pdf`
  sms.sendOrderCompletedSms(order, invoiceUrl).catch((err) => console.error(`[sms] order completed failed for ${order.id}:`, err.message))
}

// Bulk status update: apply one status to many orders at once. Skips orders
// that are missing or already at that status, and emails each customer whose
// new stage is notify-enabled.
app.post('/api/admin/orders/bulk-status', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const { ids, order_status } = req.body || {}
  if (!Array.isArray(ids) || !ids.length || !order_status) {
    return res.status(400).json({ error: 'missing_fields', message: 'Select at least one order and a status.' })
  }
  const base = `${req.protocol}://${req.get('host')}`
  let updated = 0
  let emailed = 0
  let skippedUnpaid = 0
  for (const id of ids) {
    const order = db.getOrder(id)
    if (!ownsOrder(req, order) || order.order_status === order_status) continue
    if (order_status === 'Completed' && order.payment_method === 'cod' && order.payment_status !== 'paid') {
      skippedUnpaid++
      continue
    }
    const u = db.updateOrder(id, { order_status })
    updated++
    printQueue.syncPrintJobStatus(u.id, u.order_status)
    if (printQueue.isCancelledOrRefundedStatus(u.order_status) && !printQueue.isCancelledOrRefundedStatus(order.order_status)) {
      db.restoreStockForOrder(u)
    }
    if (u.customer_email && willEmailOnStatus(u.order_status)) {
      emailed++
      emailStatusChange(u, base)
    }
    smsCompletedNotification(u, base)
  }
  return res.json({ updated, emailed, skippedUnpaid })
})

// Record a pay-on-delivery collection (Cash/UPI) — marks the order paid.
// Adds one Additional Service line item (e.g. photo editing) to an already-
// placed order — deliberately its own endpoint, not routed through the
// general files PATCH above, for two reasons: (1) that PATCH blocks every
// content edit once paid, but adding a service is safe even on a paid order
// — it never touches what was already printed/delivered/charged, only adds
// a new line item; (2) unlike discount, this can *increase* the total past
// what a gateway payment already captured, so — unlike the discount PATCH
// exception above — it's allowed regardless of payment_method/
// payment_status. Staff collect the difference separately (cash/UPI, or a
// fresh payment link for just that amount), same trust model as COD
// collection elsewhere in this file. Add-only — no "un-add" endpoint,
// matching collect-payment's one-directional shape just below.
app.post('/api/admin/orders/:id/add-service', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const { serviceId, quantity } = req.body || {}
  const catalog = (db.getPricing().additionalServices || []).filter((s) => s.active)
  const service = catalog.find((s) => s.id === serviceId)
  if (!service) return res.status(400).json({ error: 'invalid_service', message: 'Select a valid additional service.' })
  const safeQty = Math.max(1, Math.min(999, Math.round(Number(quantity)) || 1))

  let currentFiles = []
  try { currentFiles = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { currentFiles = [] }
  if (!currentFiles.length && order.file_path) {
    currentFiles = [{
      fileId: order.file_path, fileName: order.file_name, fileType: order.file_type,
      pageCount: order.page_count, colorPageCount: 0,
      printMode: order.print_mode, orientation: order.orientation,
      printSide: order.print_side, pageSize: order.paper_size, paperType: order.paper_type, copies: order.copies
    }]
  }
  const newFiles = [...currentFiles, {
    productType: 'service', fileId: null, fileName: service.label, fileType: null, fileSize: 0,
    serviceId: service.id, quantity: safeQty
  }]

  const pricingConfig = db.getPricing()
  // Carries the order's existing discount forward unchanged (same
  // minOrderValue: 0 simplification the general repricing block above
  // already makes for a not-explicitly-resubmitted discount — the original
  // coupon's minOrderValue isn't itself stored on the order).
  const discount = order.discount_type ? { type: order.discount_type, value: order.discount_value, minOrderValue: 0 } : null
  const calc = pricing.calculate(pricingConfig, {
    files: newFiles.map(toPricingFile),
    deliveryMethod: order.delivery_method || 'pickup',
    deliveryPincode: order.delivery_pincode,
    discount
  })
  newFiles.forEach((f, i) => { if (calc.fileBreakdown[i]) Object.assign(f, calc.fileBreakdown[i]) })
  const productTypesPresent = new Set(newFiles.map((f) => f.productType))

  const updated = db.updateOrder(order.id, {
    files_json: JSON.stringify(newFiles),
    product_type: productTypesPresent.size === 1 ? newFiles[0].productType : 'mixed',
    print_cost: calc.printCost,
    services_cost: calc.servicesCost,
    stationery_cost: calc.stationeryCost,
    stamp_cost: calc.stampCost,
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount
  })
  return res.json({ order: updated })
})

// Adds one more "quick print line" to an already-placed order — same rate-
// card-priced, no-file-required shape as New Order's Quick Print flow (the
// admin walk-in create path), for the common "customer's back, print 5 more
// of this" case. Same reasoning/allowance as add-service above: never
// touches what was already printed/delivered, only appends a line, so it's
// allowed regardless of payment status.
app.post('/api/admin/orders/:id/add-print-line', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const { pageSize, paperType, printMode, printSide, quantity } = req.body || {}
  const pricingConfig = db.getPricing()
  const pageSizeIds = (pricingConfig.pageSizes || []).filter((s) => s.active).map((s) => s.id)
  if (!pageSizeIds.includes(pageSize)) {
    return res.status(400).json({ error: 'missing_page_size', message: 'Select a page size.' })
  }
  const paperTypeRow = (pricingConfig.rates[pageSize] || []).find((t) => t.id === paperType)
  if (!paperTypeRow) {
    return res.status(400).json({ error: 'missing_paper_type', message: 'Select a paper type.' })
  }
  const VALID_MODES = ['color', 'bw']
  const mode = VALID_MODES.includes(printMode) ? printMode : 'bw'
  const side = mode === 'color' ? 'single' : (printSide === 'double' ? 'double' : 'single')
  const safeQty = Math.max(1, Math.min(999, Math.round(Number(quantity)) || 1))
  const sizeLabel = (pricingConfig.pageSizes.find((s) => s.id === pageSize) || {}).label || pageSize
  const modeLabel = mode === 'color' ? 'Color' : (side === 'double' ? 'B&W Double' : 'B&W Single')

  let currentFiles = []
  try { currentFiles = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { currentFiles = [] }
  if (!currentFiles.length && order.file_path) {
    currentFiles = [{
      fileId: order.file_path, fileName: order.file_name, fileType: order.file_type,
      pageCount: order.page_count, colorPageCount: 0,
      printMode: order.print_mode, orientation: order.orientation,
      printSide: order.print_side, pageSize: order.paper_size, paperType: order.paper_type, copies: order.copies
    }]
  }
  const newFiles = [...currentFiles, {
    itemId: crypto.randomUUID().slice(0, 8),
    productType: 'document', fileId: null,
    fileName: sizeLabel + ' · ' + paperTypeRow.label + ' · ' + modeLabel,
    fileType: null, fileSize: 0,
    pageCount: 1, colorPageCount: mode === 'color' ? 1 : 0,
    printMode: mode, orientation: 'portrait', printSide: side, pageSize, paperType, copies: safeQty
  }]

  const discount = order.discount_type ? { type: order.discount_type, value: order.discount_value, minOrderValue: 0 } : null
  const calc = pricing.calculate(pricingConfig, {
    files: newFiles.map(toPricingFile),
    deliveryMethod: order.delivery_method || 'pickup',
    deliveryPincode: order.delivery_pincode,
    discount
  })
  newFiles.forEach((f, i) => { if (calc.fileBreakdown[i]) Object.assign(f, calc.fileBreakdown[i]) })
  const productTypesPresent = new Set(newFiles.map((f) => f.productType))

  const updated = db.updateOrder(order.id, {
    files_json: JSON.stringify(newFiles),
    product_type: productTypesPresent.size === 1 ? newFiles[0].productType : 'mixed',
    print_cost: calc.printCost,
    services_cost: calc.servicesCost,
    stationery_cost: calc.stationeryCost,
    stamp_cost: calc.stampCost,
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount
  })
  return res.json({ order: updated })
})

// Adds a stationery line (a real inventory-tracked product, not a print job)
// to an already-placed order. Unlike add-print-line/add-service, this has a
// real stock implication — but db.decrementStockForOrder re-decrements EVERY
// stationery line's full quantity on each call (it isn't idempotent per-item,
// see its own comment), so calling it here would double-decrement every line
// already on the order. Decrements only this new line's own quantity
// instead, directly, mirroring decrementStockForOrder's per-item logic but
// scoped to just this one item. Rejects outright on insufficient stock
// (same as the general PATCH edit route's stationery-quantity check) rather
// than partially fulfilling, since this is a fresh add, not an
// already-captured payment that can't be unwound.
app.post('/api/admin/orders/:id/add-stationery', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const { productId, quantity } = req.body || {}
  const product = productId ? db.getProductById(productId) : null
  if (!product || !product.active) {
    return res.status(400).json({ error: 'invalid_product', message: 'Select a valid stationery product.' })
  }
  const safeQty = Math.max(1, Math.min(999, Math.round(Number(quantity)) || 1))
  if (safeQty > product.stock_qty) {
    return res.status(400).json({ error: 'insufficient_stock', message: `Only ${product.stock_qty} left in stock for "${product.name}".` })
  }

  let currentFiles = []
  try { currentFiles = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { currentFiles = [] }
  if (!currentFiles.length && order.file_path) {
    currentFiles = [{
      fileId: order.file_path, fileName: order.file_name, fileType: order.file_type,
      pageCount: order.page_count, colorPageCount: 0,
      printMode: order.print_mode, orientation: order.orientation,
      printSide: order.print_side, pageSize: order.paper_size, paperType: order.paper_type, copies: order.copies
    }]
  }

  const newItem = {
    itemId: crypto.randomUUID().slice(0, 8),
    productType: 'stationery', fileId: null, fileName: product.name, fileType: null, fileSize: 0,
    productId: product.id, sku: product.sku, name: product.name, unitPrice: product.price,
    quantity: safeQty, itemStatus: 'pending', stockDecrementedQty: safeQty
  }
  db.decrementStockForNewItem(product.id, safeQty, `${order.id}:${newItem.itemId}`)

  const newFiles = [...currentFiles, newItem]
  const discount = order.discount_type ? { type: order.discount_type, value: order.discount_value, minOrderValue: 0 } : null
  const calc = pricing.calculate(db.getPricing(), {
    files: newFiles.map(toPricingFile),
    deliveryMethod: order.delivery_method || 'pickup',
    deliveryPincode: order.delivery_pincode,
    discount
  })
  newFiles.forEach((f, i) => { if (calc.fileBreakdown[i]) Object.assign(f, calc.fileBreakdown[i]) })
  const productTypesPresent = new Set(newFiles.map((f) => f.productType))

  const updated = db.updateOrder(order.id, {
    files_json: JSON.stringify(newFiles),
    product_type: productTypesPresent.size === 1 ? newFiles[0].productType : 'mixed',
    print_cost: calc.printCost,
    services_cost: calc.servicesCost,
    stationery_cost: calc.stationeryCost,
    stamp_cost: calc.stampCost,
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount
  })
  return res.json({ order: updated })
})

// Removes one Additional Service line item added via add-service above.
// Identified by array index (not serviceId) since an order can carry more
// than one line for the same service. Unlike add-service, this can only
// ever *decrease* total_amount — the same risk a discount change poses on a
// captured gateway payment — so it reuses that exact guard: blocked once
// payment_method is 'online' and payment_status is 'paid', allowed on a
// cash/UPI (cod) paid order since staff can reconcile by hand.
app.post('/api/admin/orders/:id/remove-service', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  if (order.payment_method === 'online' && String(order.payment_status).toLowerCase() === 'paid') {
    return res.status(400).json({ error: 'gateway_payment_locked', message: 'This order was paid online through the payment gateway — services can’t be removed after a gateway payment. Process a refund for the difference instead if needed.' })
  }
  const index = Number(req.body && req.body.index)
  let currentFiles = []
  try { currentFiles = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { currentFiles = [] }
  if (!Number.isInteger(index) || !currentFiles[index] || currentFiles[index].productType !== 'service') {
    return res.status(400).json({ error: 'invalid_index', message: 'That service line item was not found on this order.' })
  }
  const newFiles = currentFiles.filter((_, i) => i !== index)

  const pricingConfig = db.getPricing()
  const discount = order.discount_type ? { type: order.discount_type, value: order.discount_value, minOrderValue: 0 } : null
  const calc = pricing.calculate(pricingConfig, {
    files: newFiles.map(toPricingFile),
    deliveryMethod: order.delivery_method || 'pickup',
    deliveryPincode: order.delivery_pincode,
    discount
  })
  newFiles.forEach((f, i) => { if (calc.fileBreakdown[i]) Object.assign(f, calc.fileBreakdown[i]) })
  const productTypesPresent = new Set(newFiles.map((f) => f.productType))

  const updated = db.updateOrder(order.id, {
    files_json: JSON.stringify(newFiles),
    product_type: productTypesPresent.size === 1 ? newFiles[0].productType : (productTypesPresent.size ? 'mixed' : 'document'),
    print_cost: calc.printCost,
    services_cost: calc.servicesCost,
    stationery_cost: calc.stationeryCost,
    stamp_cost: calc.stampCost,
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount
  })
  return res.json({ order: updated })
})

// Per-line-item fulfillment status — what PRINT/PICK/PRODUCE actually means
// operationally for a mixed order. print_jobs (see printQueue.js) is
// order-level only and can't represent "the pen is picked but the stamp
// isn't produced yet"; item-level status instead lives inline on each
// files_json entry (itemStatus, plus role-specific timestamps), matching how
// files_json already is the source of truth for everything else about a
// line item. Each productType has its own status vocabulary.
const ITEM_STATUS_VOCAB = {
  stationery: ['pending', 'picked'],
  stamp: ['pending', 'proof_sent', 'approved', 'changes_requested', 'in_production', 'produced']
}
// A stamp's proof_sent/approved/changes_requested statuses are only ever set
// as a side effect of the dedicated proof-upload / customer-respond
// endpoints below (each does more than just flip a field — it writes a
// stamp_proofs row, and proof_sent sends an email) — never directly through
// this generic endpoint.
const STAMP_DEDICATED_STATUSES = ['proof_sent', 'approved', 'changes_requested']
app.post('/api/admin/orders/:id/items/:itemId/status', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  const item = files.find((f) => f.itemId === req.params.itemId)
  if (!item) return res.status(404).json({ error: 'item_not_found' })
  const vocab = ITEM_STATUS_VOCAB[item.productType]
  if (!vocab) return res.status(400).json({ error: 'unsupported_item_type', message: 'This item type does not support status updates here.' })
  const status = req.body && req.body.status
  if (!vocab.includes(status)) return res.status(400).json({ error: 'invalid_status', message: `Status must be one of: ${vocab.join(', ')}.` })
  if (item.productType === 'stamp' && STAMP_DEDICATED_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'use_dedicated_endpoint', message: 'Upload a proof, or use the customer approval flow, to set this status.' })
  }
  if (item.productType === 'stamp' && status === 'in_production') {
    const stampConfig = db.getPricing().stamps || {}
    if (stampConfig.requireProofApproval !== false && item.itemStatus !== 'approved') {
      return res.status(400).json({ error: 'proof_not_approved', message: 'This stamp needs customer approval before production — upload a proof first (or turn off "Require proof approval" in Stamp Settings).' })
    }
  }
  item.itemStatus = status
  if (item.productType === 'stationery' && status === 'picked') item.pickedAt = Date.now()
  if (item.productType === 'stamp' && status === 'produced') item.producedAt = Date.now()
  const updated = db.updateOrder(order.id, { files_json: JSON.stringify(files) })
  // "All items ready" = every item this feature knows how to track is in its
  // terminal state — document/passport-photo/service items aren't tracked
  // here (they're covered by the order-level print_jobs status instead), so
  // only items with a recognized vocabulary count toward this.
  const trackedItems = files.filter((f) => ITEM_STATUS_VOCAB[f.productType])
  const allItemsReady = trackedItems.length > 0 && trackedItems.every((f) => {
    const v = ITEM_STATUS_VOCAB[f.productType]
    return f.itemStatus === v[v.length - 1]
  })
  return res.json({ order: updated, allItemsReady })
})

// Admin uploads a stamp proof (an image/PDF, same private uploads/ pipeline
// and extension whitelist as any customer print file — reuses the `upload`
// middleware directly, never the public product-image pipeline). Creates a
// stamp_proofs row, moves the item to 'proof_sent', and emails the customer
// a link to review it on their tracking page — the one place a customer
// interacts with an in-progress order beyond just viewing status.
app.post('/api/admin/orders/:id/items/:itemId/stamp-proof', requireAdmin, requireTab('orders'), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  upload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code === 'unsupported_file_type' ? 'unsupported_file_type' : 'upload_failed'
      return res.status(400).json({ error: code, message: err.message })
    }
    if (!req.file) return res.status(400).json({ error: 'no_file' })
    let files = []
    try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (e) { files = [] }
    const item = files.find((f) => f.itemId === req.params.itemId && f.productType === 'stamp')
    if (!item) {
      fs.unlink(path.join(uploadsDir, req.file.filename), () => {})
      return res.status(404).json({ error: 'item_not_found' })
    }
    db.createStampProof({ order_id: order.id, item_id: item.itemId, file_id: req.file.filename, uploaded_by_admin_id: req.admin.id })
    item.itemStatus = 'proof_sent'
    const updated = db.updateOrder(order.id, { files_json: JSON.stringify(files) })
    const base = `${req.protocol}://${req.get('host')}`
    const trackUrl = `${base}/track/${encodeURIComponent(order.id)}`
    mailer.sendStampProofReadyEmail(updated, trackUrl).catch((mailErr) => console.error(`[mailer] stamp proof email failed for ${order.id}:`, mailErr.message))
    return res.json({ order: updated })
  })
})

// Admin downloads/previews the latest proof for one stamp item — same
// ownership gate as everything else here, distinct from the customer-facing
// image URL below (which is unauthenticated and order-ID-gated instead).
app.get('/api/admin/orders/:id/items/:itemId/stamp-proof', requireAdmin, requireTab('orders'), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const proof = db.getLatestStampProofForItem(order.id, req.params.itemId)
  if (!proof) return res.status(404).json({ error: 'not_found' })
  return res.json({ proof })
})

app.post('/api/admin/orders/:id/collect-payment', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const { mode } = req.body || {}
  if (!['cash', 'upi'].includes(mode)) {
    return res.status(400).json({ error: 'invalid_mode', message: 'Payment mode must be cash or upi.' })
  }
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  const updated = db.updateOrder(order.id, { payment_status: 'paid', payment_mode: mode, payment_collected_at: Date.now() })
  return res.json({ order: updated })
})

// Undoes a mistaken Collect Cash/Collect UPI click (wrong button, wrong
// mode confirmed, collected against the wrong order) — reopens the order
// for collection instead of leaving a bad payment record with no way back.
// COD only: a gateway (Razorpay) payment is genuinely captured money with
// no local "undo", same immutability reasoning as the discount/service-
// removal locks elsewhere in this file. Blocked once the order has reached
// Completed — that transition itself requires payment_status 'paid' for a
// COD order (see the PATCH route's payment_not_collected gate above), so
// rolling back payment here would leave a Completed order silently unpaid;
// move it back a stage first if that's genuinely needed.
app.post('/api/admin/orders/:id/rollback-payment', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  if (order.payment_method !== 'cod') {
    return res.status(400).json({ error: 'not_cod', message: 'Only a cash/UPI collection can be rolled back — an online gateway payment is already captured.' })
  }
  if (String(order.payment_status).toLowerCase() !== 'paid') {
    return res.status(400).json({ error: 'not_paid', message: 'This order has no collected payment to roll back.' })
  }
  if (order.order_status === 'Completed') {
    return res.status(400).json({ error: 'order_completed', message: 'Move this order back from Completed before rolling back its payment.' })
  }
  const updated = db.updateOrder(order.id, { payment_status: 'pending', payment_mode: null, payment_collected_at: null })
  return res.json({ order: updated })
})

// Generates (or regenerates) a Razorpay Payment Link for an already-placed
// COD/pending order and texts it to the customer — lets a customer who
// phoned in an order pay online remotely instead of at pickup/delivery.
app.post('/api/admin/orders/:id/payment-link', requireAdmin, requireTab('orders'), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  if (String(order.payment_status).toLowerCase() === 'paid') {
    return res.status(400).json({ error: 'order_already_paid', message: 'This order is already paid.' })
  }
  let link
  try {
    link = await createPaymentLinkForOrder(order)
  } catch (err) {
    return res.status(500).json({ error: err.code || 'payment_link_failed', message: err.message })
  }
  const fresh = db.getOrder(order.id)
  let smsSent = false
  try {
    smsSent = await sms.sendPaymentLinkSms(fresh, link.link_url)
  } catch (err) {
    smsSent = false
    console.error(`[sms] payment link send failed for ${order.id}:`, err.message)
  }
  return res.json({ order: fresh, linkUrl: link.link_url, smsSent })
})

// Manual "send invoice" action — lets staff email a PDF invoice to the
// customer for any order on demand, independent of the automatic invoice
// that goes out when an order reaches "Completed".
app.post('/api/admin/orders/:id/send-invoice', requireAdmin, requireTab('orders'), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  if (!order.customer_email) {
    return res.status(400).json({ error: 'no_email', message: 'This order has no customer email on file.' })
  }
  let pdf
  try {
    pdf = await buildInvoicePdf(order)
  } catch (err) {
    return res.status(500).json({ error: 'invoice_generation_failed', message: err.message })
  }
  try {
    await mailer.sendInvoiceEmail(order, pdf)
  } catch (err) {
    return res.status(502).json({ error: 'email_send_failed', message: err.message })
  }
  return res.json({ ok: true })
})

// Lets staff download the PDF invoice directly — the counterpart to
// send-invoice above for orders with no customer email on file (or when
// staff just want a local copy), so it isn't gated on that field like the
// email route is.
app.get('/api/admin/orders/:id/invoice.pdf', requireAdmin, requireTab('orders'), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  try {
    const pdf = await buildInvoicePdf(order)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${order.id}.pdf"`)
    return res.send(pdf)
  } catch (err) {
    return res.status(500).json({ error: 'invoice_generation_failed', message: err.message })
  }
})

// Manual escape hatch: a Payment Link's primary confirmation is the redirect
// callback below, with the webhook as backup — if both are ever delayed or
// lost, this lets staff directly ask Razorpay whether the link has actually
// been paid, without waiting on either.
app.post('/api/admin/orders/:id/recheck-payment', requireAdmin, requireTab('orders'), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  if (String(order.payment_status).toLowerCase() === 'paid') {
    return res.json({ order, alreadyPaid: true })
  }
  if (!order.payment_link_id) {
    return res.status(400).json({ error: 'no_payment_link', message: 'This order has no payment link to check.' })
  }
  let status
  try {
    status = await razorpay.getPaymentLinkStatus(order.payment_link_id)
  } catch (err) {
    return res.status(502).json({ error: err.code || 'status_check_failed', message: err.message })
  }
  if (status.status !== 'paid') {
    return res.json({ order, alreadyPaid: false, razorpayStatus: status.status })
  }
  const paidOrder = db.markOrderPaid(order.id, { razorpay_payment_id: status.payment_id, order_status: 'Payment Successful' })
  if (paidOrder) {
    printQueue.enqueue(order.id)
    confirmStockForOrder(paidOrder)
    const fresh = db.getOrder(order.id)
    notify.sendOrderConfirmationSms(fresh)
    notify.sendOrderConfirmationEmail(fresh)
    mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
  }
  return res.json({ order: db.getOrder(order.id), alreadyPaid: false, justConfirmed: !!paidOrder })
})

// Archive (soft-delete) a single order. It leaves the Orders/Customers views
// and BigQuery immediately, but is recoverable for 30 days before the purge
// job removes it for good.
app.delete('/api/admin/orders/:id', requireAdmin, requireTab('orders'), (req, res) => {
  if (!ownsOrder(req, db.getOrder(req.params.id))) return res.status(404).json({ error: 'not_found' })
  const order = db.archiveOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ archived: true })
})

// Bulk archive of orders.
app.post('/api/admin/orders/bulk-delete', requireAdmin, requireTab('orders'), express.json(), (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'missing_fields', message: 'Select at least one order.' })
  let archived = 0
  for (const id of ids) {
    if (!ownsOrder(req, db.getOrder(id))) continue
    if (db.archiveOrder(id)) archived++
  }
  return res.json({ archived })
})

// Registered ahead of the /:mobile routes below — Express matches in
// registration order, and "marketing-opt-in" would otherwise be swallowed
// as a :mobile value by the PATCH route further down (it was, briefly).
//
// The only way to grant marketing consent right now besides a customer's own
// signup-time checkbox — for someone who agreed another way (phone, in
// person, an old account from before that checkbox existed). Resolves to an
// actual account by mobile/email same as login does; a guest/walk-in
// customer with no account has no consent to manage, hence 404 rather than
// silently no-op-ing.
app.patch('/api/admin/customers/marketing-opt-in', requireAdmin, requireTab('customers'), express.json(), (req, res) => {
  const { mobile, email, optIn } = req.body || {}
  const user = (mobile && db.findUserByIdentifier(mobile)) || (email && db.findUserByIdentifier(email))
  if (!user) return res.status(404).json({ error: 'no_account', message: "This customer doesn't have an account, so there's no consent to manage." })
  db.setMarketingOptIn(user.id, !!optIn)
  return res.json({ ok: true, marketingOptIn: !!optIn })
})

// Archive a customer (identified by mobile) — archives all their orders.
app.delete('/api/admin/customers/:mobile', requireAdmin, requireTab('customers'), (req, res) => {
  const orders = db.archiveCustomerByMobile(req.params.mobile, scopeLocation(req))
  return res.json({ archived: true, archivedOrders: orders.length })
})

// Edits a customer's name/mobile/email — rewritten onto every one of their
// own orders, since that's the only place this data lives (see
// updateCustomerByMobile in db.js). Changing the mobile silently merges this
// customer with whoever already has the new number, same as the Customers
// list's own grouping — the client warns about that before submitting.
app.patch('/api/admin/customers/:mobile', requireAdmin, requireTab('customers'), express.json(), (req, res) => {
  const { name, mobile: newMobile, email } = req.body || {}
  if (newMobile != null && !/^\d{10}$/.test(String(newMobile))) {
    return res.status(400).json({ error: 'invalid_mobile', message: 'Mobile must be a 10-digit number.' })
  }
  const changed = db.updateCustomerByMobile(req.params.mobile, { name, newMobile, email }, scopeLocation(req))
  if (!changed) return res.status(404).json({ error: 'not_found' })
  return res.json({ updated: true, ordersUpdated: changed })
})

app.post('/api/admin/customers/bulk-archive', requireAdmin, requireTab('customers'), express.json(), (req, res) => {
  const { mobiles } = req.body || {}
  if (!Array.isArray(mobiles) || !mobiles.length) {
    return res.status(400).json({ error: 'missing_fields', message: 'Select at least one customer.' })
  }
  const locationId = scopeLocation(req)
  const archivedOrders = mobiles.reduce((sum, m) => sum + db.archiveCustomerByMobile(m, locationId).length, 0)
  return res.json({ archived: true, count: mobiles.length, archivedOrders })
})

// Archive management: list, restore, or permanently delete now.
app.get('/api/admin/archive', requireAdmin, requireTab('archive'), (req, res) => {
  return res.json({ orders: db.listArchivedOrders(scopeLocation(req)), retentionDays: 30 })
})

app.get('/api/admin/feedback', requireAdmin, requireTab('feedback'), (req, res) => {
  return res.json({ feedback: db.listOrderFeedback(scopeLocation(req)) })
})

// CSV download of the same list the Feedback tab shows, respecting the same
// branch scoping. Registered as its own literal path (not a query param on
// the route above) so it's a plain adminFetch()-able URL the client can pull
// as a blob — see admin.html's downloadOrderFile for the same pattern.
app.get('/api/admin/feedback/export', requireAdmin, requireTab('feedback'), (req, res) => {
  const feedback = db.listOrderFeedback(scopeLocation(req))
  const escapeCsvCell = (v) => {
    const s = String(v == null ? '' : v)
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const rows = [
    ['Order ID', 'Customer Name', 'Customer Mobile', 'Rating', 'Comment', 'Submitted At'],
    ...feedback.map((f) => [f.order_id, f.customer_name || '', f.customer_mobile || '', f.rating, f.comment || '', new Date(f.created_at).toISOString()])
  ]
  const csv = rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')
  res.setHeader('Content-Type', 'text/csv; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="feedback-${new Date().toISOString().slice(0, 10)}.csv"`)
  // Leading BOM so Excel (which guesses encoding rather than reading a
  // charset header) renders non-ASCII customer names/comments correctly
  // instead of mangling them.
  return res.send('\uFEFF' + csv)
})

// Staff correcting a garbled rating/comment, or moderating an inappropriate
// one — 404s (not 403) on a branch admin viewing another branch's feedback,
// same posture as ownsOrder elsewhere.
app.patch('/api/admin/feedback/:id', requireAdmin, requireTab('feedback'), express.json(), (req, res) => {
  const feedback = db.getOrderFeedbackById(req.params.id)
  if (!feedback) return res.status(404).json({ error: 'not_found' })
  if (!ownsOrder(req, db.getOrder(feedback.order_id))) return res.status(404).json({ error: 'not_found' })
  const { rating, comment } = req.body || {}
  if (rating !== undefined && (!Number.isInteger(rating) || rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'invalid_rating', message: 'Rating must be a whole number from 1 to 5.' })
  }
  const updated = db.updateOrderFeedback(feedback.id, {
    rating,
    comment: comment !== undefined ? String(comment).trim().slice(0, 2000) : undefined
  })
  return res.json({ feedback: updated })
})

// Deleting reopens the order for feedback (getOrderFeedback(order_id) goes
// back to null), so the customer sees the rating form again on their next
// tracking-page visit — acceptable, staff would only delete a spam/test/
// abusive entry they'd want gone anyway.
app.delete('/api/admin/feedback/:id', requireAdmin, requireTab('feedback'), (req, res) => {
  const feedback = db.getOrderFeedbackById(req.params.id)
  if (!feedback) return res.status(404).json({ error: 'not_found' })
  if (!ownsOrder(req, db.getOrder(feedback.order_id))) return res.status(404).json({ error: 'not_found' })
  db.deleteOrderFeedback(feedback.id)
  return res.json({ deleted: true })
})

app.post('/api/admin/orders/:id/restore', requireAdmin, requireTab('orders'), (req, res) => {
  if (!ownsOrder(req, db.getOrder(req.params.id))) return res.status(404).json({ error: 'not_found' })
  const order = db.restoreOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ restored: true })
})

app.delete('/api/admin/orders/:id/purge', requireAdmin, requireTab('orders'), (req, res) => {
  if (!ownsOrder(req, db.getOrder(req.params.id))) return res.status(404).json({ error: 'not_found' })
  const order = db.deleteOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  try { deleteFilesForOrder(order) } catch (err) { console.error('[archive] file cleanup on purge failed:', err.message) }
  return res.json({ deleted: true })
})

// Public: active branches the customer can pick from (no admin-only fields).
app.get('/api/locations', (req, res) => {
  const active = db.getLocations().filter((l) => l.active).map((l) => ({
    id: l.id, name: l.name, address: l.address || '', city: l.city || '', pincode: l.pincode || '', shopOpen: l.shopOpen, mapsUrl: l.mapsUrl || ''
  }))
  return res.json({ locations: active })
})

// Public blog — list only shows published posts, ordered newest-first.
app.get('/api/blog', (req, res) => {
  const posts = db.listBlogPosts({ includeUnpublished: false }).map((p) => ({
    id: p.id, title: p.title, slug: p.slug, author: p.author, excerpt: p.excerpt,
    coverImage: p.cover_image, category: p.category, tags: p.tags, publishedAt: p.published_at
  }))
  return res.json({ posts })
})

app.get('/api/blog/:slug', (req, res) => {
  const post = db.getBlogPostBySlug(req.params.slug)
  if (!post || !post.published) return res.status(404).json({ error: 'not_found' })
  return res.json({
    post: {
      id: post.id, title: post.title, slug: post.slug, author: post.author, excerpt: post.excerpt,
      coverImage: post.cover_image, category: post.category, tags: post.tags, authorBio: post.author_bio,
      metaTitle: post.meta_title, metaDescription: post.meta_description, metaKeywords: post.meta_keywords,
      publishedAt: post.published_at, updatedAt: post.updated_at
    },
    html: marked.parse(post.body || '')
  })
})

// Admin-managed branches / pickup locations (add / edit / delete / activate).
app.get('/api/admin/locations', requireSuperAdmin, (req, res) => {
  return res.json({ locations: db.getLocations() })
})

app.put('/api/admin/locations', requireSuperAdmin, express.json(), (req, res) => {
  const { locations } = req.body || {}
  if (!Array.isArray(locations)) return res.status(400).json({ error: 'invalid_locations' })
  const clean = []
  const seenId = new Set()
  for (const l of locations) {
    const name = String((l && l.name) || '').trim().slice(0, 100)
    if (!name) return res.status(400).json({ error: 'invalid_location_name', message: "Branch names can't be empty." })
    // Stable id: keep an existing one, else slugify the name (deduped).
    let id = String((l && l.id) || '').trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'branch'
    while (seenId.has(id)) id += '-x'
    seenId.add(id)
    // Only keep http(s) links — anything else (e.g. a stray "javascript:")
    // never reaches an href on the public site.
    const mapsUrlRaw = String((l && l.mapsUrl) || '').trim().slice(0, 500)
    const mapsUrl = /^https?:\/\//i.test(mapsUrlRaw) ? mapsUrlRaw : ''
    clean.push({
      id,
      name,
      address: String((l && l.address) || '').trim().slice(0, 200),
      city: String((l && l.city) || '').trim().slice(0, 80),
      pincode: String((l && l.pincode) || '').trim().slice(0, 12),
      active: !!(l && l.active),
      mapsUrl
    })
  }
  try {
    db.setLocations(clean)
  } catch (err) {
    if (err.code === 'location_has_staff') return res.status(400).json({ error: err.code, message: err.message })
    throw err
  }
  // Identity fields (above) and operating info (shopOpen/hours) are separate
  // updates in db.js — apply any operating-info fields per location too.
  for (const l of locations) {
    if (l && l.id && (l.shopOpen !== undefined || l.storeTimings)) {
      db.updateLocationOperatingInfo(l.id, { shopOpen: l.shopOpen, storeTimings: l.storeTimings })
    }
  }
  return res.json({ locations: db.getLocations() })
})

// Admin-managed order workflow stages (add / delete / reorder / notify flag).
// Readable by any admin (branch admins need the real stage names for their
// order status dropdown) — editing the shared stage list stays super-admin-only.
app.get('/api/admin/stages', requireAdmin, (req, res) => {
  return res.json({ stages: db.getOrderStages() })
})

app.put('/api/admin/stages', requireSuperAdmin, express.json(), (req, res) => {
  const { stages } = req.body || {}
  if (!Array.isArray(stages) || !stages.length) {
    return res.status(400).json({ error: 'invalid_stages', message: 'Keep at least one stage.' })
  }
  const clean = []
  const seen = new Set()
  for (const s of stages) {
    const name = String((s && s.name) || '').trim().slice(0, 60)
    if (!name) return res.status(400).json({ error: 'invalid_stage_name', message: "Stage names can't be empty." })
    const key = name.toLowerCase()
    if (seen.has(key)) return res.status(400).json({ error: 'duplicate_stage', message: `Duplicate stage: ${name}` })
    seen.add(key)
    clean.push({ name, notify: !!(s && s.notify) })
  }
  db.setOrderStages(clean)
  return res.json({ stages: db.getOrderStages() })
})

app.get('/api/admin/customers', requireAdmin, requireTab('customers'), (req, res) => {
  return res.json({ customers: db.listCustomers(scopeLocation(req)) })
})

// Sales analytics — super-admin only (matches Pricing/Locations/Settings),
// no branch scoping since there's no branch-restricted UI for it yet.
// Same explicit from/to range shape as the Reports tab's line-item export,
// rather than a relative "days back from now" count — the two share one
// date-range picker (rangeToDates() client-side) and this is what it emits.
app.get('/api/admin/analytics/sales', requireSuperAdmin, (req, res) => {
  const from = Number(req.query.from)
  const to = Number(req.query.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return res.status(400).json({ error: 'invalid_range', message: 'Provide a valid from/to time range.' })
  }
  return res.json(db.getSalesAnalytics(from, to))
})

// ---- Line-item report ----
// Reads the live SQLite DB (via db.getOrdersForLineItemReport) rather than
// the daily BigQuery mirror — an admin pulling a report wants this morning's
// orders in it, not whatever the last sync happened to catch. BigQuery stays
// in place separately (scripts/bqSync.js, still running on its daily timer)
// for ad-hoc SQL/BI access; this report just doesn't route through it.
//
// Raw per-order columns an admin can opt into as extra report columns,
// beyond the fixed Order Date/ID/Customer/Item/Type/Price/GST/Total set —
// every key here must be a real `orders` column (see db.js's CREATE TABLE /
// ensureColumn calls), since it's used to read straight off each row.
const REPORT_EXTRA_COLUMNS = {
  customer_mobile: 'Customer Mobile',
  customer_email: 'Customer Email',
  location_name: 'Branch',
  payment_method: 'Payment Method',
  payment_status: 'Payment Status',
  order_status: 'Order Status',
  delivery_method: 'Delivery Method',
  discount_amount: 'Discount (₹)',
  discount_code: 'Discount Code',
  total_amount: 'Final Amount (₹)',
  razorpay_payment_id: 'Razorpay Payment ID'
}

const REPORT_PRODUCT_TYPE_LABELS = {
  document: 'Print', stationery: 'Stationery', stamp: 'Stamp',
  service: 'Service', 'passport-photo': 'Passport Photo'
}

// Splits one order into its purchasable line items (files_json — already
// carries a baked-in per-item `amount` from pricing.js's fileBreakdown, see
// the Object.assign(f, calc.fileBreakdown[i]) call sites) plus synthetic
// Delivery/Handling lines when those charges are non-zero.
//
// GST isn't tracked per line item anywhere in this app — pricing.js computes
// one flat gst_amount for the whole order (same as the real PDF invoice's
// single "GST" row) — so each item's GST here is its price's share of the
// order's actual gst_amount, at the order's own effective rate
// (gst_amount / (total_amount - gst_amount), reconstructed from the stored
// totals rather than today's live settings, so it's still correct for old
// orders even if the configured GST% has since changed). On an order with a
// discount code, item prices are pre-discount, so allocated-GST here will run
// slightly high relative to the order's real gst_amount — a known
// approximation, fine for a line-item breakdown, not exact enough to be the
// GST-filing source of truth for discounted orders.
function flattenOrderToLineItems(order) {
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  const totalAmount = Number(order.total_amount) || 0
  const gstAmount = Number(order.gst_amount) || 0
  const taxableAmount = totalAmount - gstAmount
  const effectiveRate = taxableAmount > 0 ? gstAmount / taxableAmount : 0

  const items = []
  const pushItem = (name, type, price) => {
    const p = Math.round(Number(price) || 0)
    if (!p) return
    const gst = Math.round(p * effectiveRate)
    items.push({ item: name || type, type, price: p, gst, total: p + gst })
  }

  files.forEach((f) => {
    const productType = f.productType || 'document'
    const type = REPORT_PRODUCT_TYPE_LABELS[productType] || productType
    const name = productType === 'document' ? (f.fileName || f.paperLabel || 'Document') : (f.name || f.paperLabel || type)
    pushItem(name, type, f.amount)
  })
  pushItem('Delivery charge', 'Delivery', order.delivery_charge)
  pushItem('Handling charge', 'Handling', order.handling_charge)
  return items
}

app.get('/api/admin/reports/line-items', requireSuperAdmin, (req, res) => {
  const from = Number(req.query.from)
  const to = Number(req.query.to)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
    return res.status(400).json({ error: 'invalid_range', message: 'Provide a valid from/to time range.' })
  }
  const extraKeys = String(req.query.columns || '').split(',').map((s) => s.trim()).filter((k) => REPORT_EXTRA_COLUMNS[k])
  const format = req.query.format === 'json' ? 'json' : 'csv'

  try {
    const orders = db.getOrdersForLineItemReport(from, to)
    const lineRows = []
    orders.forEach((order) => {
      flattenOrderToLineItems(order).forEach((li) => {
        const row = {
          'Order Date': new Date(Number(order.created_at)).toISOString(),
          'Order ID': order.id,
          'Customer Name': order.customer_name || '',
          'Item': li.item,
          'Type': li.type,
          'Price (₹)': li.price,
          'GST (₹)': li.gst,
          'Price incl. GST (₹)': li.total
        }
        extraKeys.forEach((k) => { row[REPORT_EXTRA_COLUMNS[k]] = order[k] == null ? '' : order[k] })
        lineRows.push(row)
      })
    })

    if (format === 'json') {
      return res.json({ rows: lineRows, orderCount: orders.length })
    }
    const headers = ['Order Date', 'Order ID', 'Customer Name', 'Item', 'Type', 'Price (₹)', 'GST (₹)', 'Price incl. GST (₹)', ...extraKeys.map((k) => REPORT_EXTRA_COLUMNS[k])]
    const escapeCsvCell = (v) => {
      const s = String(v == null ? '' : v)
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }
    const csv = [headers, ...lineRows.map((r) => headers.map((h) => r[h]))]
      .map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="line-items-${new Date(from).toISOString().slice(0, 10)}_to_${new Date(to).toISOString().slice(0, 10)}.csv"`)
    return res.send('\uFEFF' + csv)
  } catch (err) {
    console.error('Line-item report error:', err)
    return res.status(500).json({ error: 'report_failed', message: 'Could not generate the report. Check server logs.' })
  }
})

// ---- Campaign management (Email/WhatsApp/SMS marketing) ----
// Super-admin only, same posture as Analytics/Reports — this reaches every
// opted-in customer across every branch, not something to expose to a
// branch-scoped admin.

app.get('/api/admin/message-templates', requireSuperAdmin, (req, res) => {
  return res.json({ templates: db.listMessageTemplates(req.query.channel || null) })
})
app.post('/api/admin/message-templates', requireSuperAdmin, express.json(), (req, res) => {
  const { channel, name, contentSid, variables } = req.body || {}
  if (!['whatsapp', 'sms'].includes(channel) || !name || !contentSid) {
    return res.status(400).json({ error: 'invalid_template', message: 'Channel (whatsapp/sms), name, and Content SID are required.' })
  }
  const template = db.createMessageTemplate({ channel, name: String(name).trim().slice(0, 120), contentSid: String(contentSid).trim(), variables })
  return res.json({ template })
})
app.delete('/api/admin/message-templates/:id', requireSuperAdmin, (req, res) => {
  db.deleteMessageTemplate(req.params.id)
  return res.json({ ok: true })
})

// Whether each channel can actually deliver right now — the campaign
// composer uses this to warn before an admin builds a whole campaign around
// a channel with nothing configured behind it, rather than let every send
// silently land as "skipped".
app.get('/api/admin/campaigns/channel-status', requireSuperAdmin, (req, res) => {
  return res.json({ email: mailer.isConfigured(), sms: sms.isConfigured(), whatsapp: whatsapp.isConfigured() })
})

app.get('/api/admin/campaigns', requireSuperAdmin, (req, res) => {
  return res.json({ campaigns: db.listCampaigns() })
})
app.get('/api/admin/campaigns/:id', requireSuperAdmin, (req, res) => {
  const campaign = db.getCampaign(req.params.id)
  if (!campaign) return res.status(404).json({ error: 'not_found' })
  return res.json({ campaign })
})
app.post('/api/admin/campaigns', requireSuperAdmin, express.json(), (req, res) => {
  const { name, channel } = req.body || {}
  if (!name || !['email', 'whatsapp', 'sms'].includes(channel)) {
    return res.status(400).json({ error: 'invalid_campaign', message: 'Name and a valid channel (email/whatsapp/sms) are required.' })
  }
  const campaign = db.createCampaign({ name: String(name).trim().slice(0, 120), channel, createdBy: req.admin.id })
  return res.json({ campaign })
})
app.patch('/api/admin/campaigns/:id', requireSuperAdmin, express.json(), (req, res) => {
  const { name, subject, bodyHtml, templateId, templateVars, audienceFilter, audienceSource } = req.body || {}
  const campaign = db.updateCampaign(req.params.id, { name, subject, bodyHtml, templateId, templateVars, audienceFilter, audienceSource })
  if (!campaign) return res.status(404).json({ error: 'not_found' })
  return res.json({ campaign })
})
app.delete('/api/admin/campaigns/:id', requireSuperAdmin, (req, res) => {
  const ok = db.deleteCampaign(req.params.id)
  if (!ok) return res.status(409).json({ error: 'not_draft', message: 'Only draft campaigns can be deleted.' })
  return res.json({ ok: true })
})

// Audience size + a small sample, computed from the campaign's currently
// saved filter and source (not a request body) — always enforces the same
// gates the actual send does, so what an admin previews here is exactly who
// a real send would reach.
app.get('/api/admin/campaigns/:id/audience', requireSuperAdmin, (req, res) => {
  const campaign = db.getCampaign(req.params.id)
  if (!campaign) return res.status(404).json({ error: 'not_found' })
  const usePastCustomers = campaign.audience_source === 'past_customers' && campaign.channel === 'email'
  const audience = usePastCustomers
    ? db.getPastCustomersAudience(campaign.audienceFilter)
    : db.getCampaignAudience(campaign.channel, campaign.audienceFilter)
  const stats = usePastCustomers ? null : db.getCampaignAudienceStats(campaign.channel)
  return res.json({
    count: audience.length, sample: audience.slice(0, 20),
    totalOptedIn: stats ? stats.totalOptedIn : null, totalOptedInWithOrders: stats ? stats.withOrders : null
  })
})

app.get('/api/admin/campaigns/:id/recipients', requireSuperAdmin, (req, res) => {
  return res.json({ recipients: db.getCampaignRecipients(req.params.id) })
})

// Sends to exactly one contact the admin supplies (their own email/phone),
// bypassing the audience filter entirely — the "does this actually look
// right" check before committing to the real send. Never touches the
// campaign's status/recipient rows.
app.post('/api/admin/campaigns/:id/test-send', requireSuperAdmin, express.json(), async (req, res) => {
  const campaign = db.getCampaign(req.params.id)
  if (!campaign) return res.status(404).json({ error: 'not_found' })
  const { contact } = req.body || {}
  if (!contact) return res.status(400).json({ error: 'missing_contact', message: 'Provide an email or mobile number to test-send to.' })
  try {
    let ok = false
    if (campaign.channel === 'email') {
      ok = await mailer.sendCampaignEmail({
        to: contact, subject: '[TEST] ' + (campaign.subject || campaign.name), bodyHtml: campaign.body_html,
        unsubscribeUrl: campaigns.buildUnsubscribeUrl(req.admin.id), businessAddress: campaigns.primaryBusinessAddress()
      })
    } else {
      const template = db.getMessageTemplate(campaign.template_id)
      if (!template) return res.status(400).json({ error: 'no_template', message: 'Pick a message template first.' })
      ok = campaign.channel === 'whatsapp'
        ? await whatsapp.sendCampaignWhatsapp(contact, template.content_sid, campaign.templateVars)
        : await sms.sendCampaignSms(contact, template.content_sid, campaign.templateVars)
    }
    if (!ok) return res.status(502).json({ error: 'not_configured', message: `${campaign.channel} isn't configured yet — see server logs for the stub output.` })
    return res.json({ ok: true })
  } catch (err) {
    console.error('Campaign test-send error:', err)
    return res.status(502).json({ error: 'send_failed', message: err.message })
  }
})

// Fire-and-forget, same pattern as notify.js — a real send can take a while
// (batched, rate-limited) and there's no reason to hold the admin's request
// open for it. The UI polls GET /api/admin/campaigns/:id for status.
app.post('/api/admin/campaigns/:id/send', requireSuperAdmin, (req, res) => {
  const campaign = db.getCampaign(req.params.id)
  if (!campaign) return res.status(404).json({ error: 'not_found' })
  if (campaign.status !== 'draft') return res.status(409).json({ error: 'not_draft', message: 'This campaign has already been sent.' })
  if (campaign.channel !== 'email' && !campaign.template_id) {
    return res.status(400).json({ error: 'no_template', message: 'Pick a message template before sending.' })
  }
  if (campaign.channel === 'email' && !campaign.body_html) {
    return res.status(400).json({ error: 'no_content', message: 'Write the email content before sending.' })
  }
  campaigns.runCampaignSend(campaign.id).catch((err) => console.error(`[campaigns] send failed for ${campaign.id}:`, err.message))
  return res.json({ ok: true, status: 'sending' })
})

// Public, no auth — the link every campaign email carries. GET (not POST) so
// it works as a plain click from any mail client, no JS/fetch required.
// Keyed by contact (c), not a users.id — the "All past customers" audience
// reaches plenty of people with no account, and this has to work for them
// too. Suppression is recorded by contact regardless; if an account happens
// to exist for that email, its marketing_opt_in is also cleared so the
// Customers tab stays in sync with the real, permanent suppression record.
app.get('/unsubscribe', (req, res) => {
  const { c, t } = req.query
  const ok = c && t && campaigns.verifyUnsubscribeToken(String(c), String(t))
  if (ok) {
    db.addMarketingSuppression(String(c), 'email', 'unsubscribe_link')
    const user = db.findUserByIdentifier(String(c))
    if (user) db.setMarketingOptIn(user.id, false)
  }
  res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${ok ? 'Unsubscribed' : 'Link invalid'} — Metalix Print</title>
    <style>body{font-family:Arial,Helvetica,sans-serif;background:#F4F4F5;margin:0;padding:60px 20px;text-align:center;color:#18181B;}
    .card{max-width:440px;margin:0 auto;background:#fff;border:1px solid #E4E4E7;border-radius:16px;padding:36px 32px;}
    h1{font-size:20px;margin:0 0 10px;} p{font-size:14px;color:#71717A;line-height:1.6;margin:0;}</style></head>
    <body><div class="card"><h1>${ok ? "You're unsubscribed" : 'This link is invalid'}</h1>
    <p>${ok ? "You won't receive any more marketing emails from Metalix Print. You'll still get order-related messages for anything you order." : 'This unsubscribe link is broken or expired. Contact us if you keep receiving emails you want to stop.'}</p>
    </div></body></html>`)
})

app.get('/api/admin/orders/:id/files/:fileId/download', requireAdmin, requireTab('orders'), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })

  const safeFileId = path.basename(req.params.fileId)
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  let fileName = null
  // A stamp's logo/existing-artwork uploads are stored under logoFileId/
  // artworkFileId rather than fileId (that field is reserved for the
  // print-file/passport-photo shape) — checked here too so this same
  // ownership-gated download endpoint also serves them.
  const byFileId = files.find((f) => f.fileId === safeFileId)
  const byLogo = files.find((f) => f.logoFileId === safeFileId)
  const byArtwork = files.find((f) => f.artworkFileId === safeFileId)
  if (byFileId) {
    fileName = byFileId.fileName
  } else if (byLogo) {
    fileName = 'stamp-logo' + path.extname(safeFileId)
  } else if (byArtwork) {
    fileName = 'stamp-artwork' + path.extname(safeFileId)
  } else if (order.file_path === safeFileId) {
    fileName = order.file_name
  } else {
    return res.status(404).json({ error: 'file_not_found' })
  }

  const filePath = path.join(uploadsDir, safeFileId)
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'file_not_found', message: 'This file has been auto-deleted (files are removed 3 days after order completion).' })
  }
  return res.download(filePath, fileName || safeFileId)
})

// Authenticated counterpart to the public GET /api/pricing above — the only
// difference is this one includes `coupons`, since the admin Pricing tab is
// the one place that legitimately needs the full code list (to manage it),
// not just to validate one code a customer typed in.
app.get('/api/admin/pricing', requireSuperAdmin, (req, res) => {
  res.json(db.getPricing())
})

app.put('/api/admin/pricing', requireSuperAdmin, express.json(), (req, res) => {
  const pricing = req.body
  if (!pricing || !pricing.rates || !Array.isArray(pricing.rates.a4)) {
    return res.status(400).json({ error: 'invalid_pricing' })
  }
  // db.setPricing normalizes the paper-type rows (ids, numeric rates) before persisting.
  db.setPricing(pricing)
  return res.json(db.getPricing())
})

// Create an order: validates the previously-uploaded file still exists,
// computes the authoritative price server-side, and creates a Razorpay order
// (or a simulated one if no live keys are configured).
const MAX_TOTAL_UPLOAD_BYTES = 100 * 1024 * 1024

// Resolves a client-supplied discount request into pricing.calculate()'s
// { type, value, minOrderValue } shape, or an { error, message } to reject
// with. Two independent paths:
//  - A coupon code: looked up fresh against the admin-managed list in
//    Pricing on every call (active / not expired / under its usage cap) —
//    never trusted from an earlier client-side check.
//  - An ad-hoc type+value with no code: staff-only (allowAdHoc), for a
//    walk-in order where there's no formal code, just "take ₹20 off this
//    one". A customer-facing caller passes allowAdHoc: false so a tampered
//    request body can't grant itself an arbitrary discount.
// Returns { discount: null, code: null, reason: null } when nothing was requested.
function resolveDiscountInput({ discountCode, discountType, discountValue, discountReason }, { allowAdHoc }) {
  const code = String(discountCode || '').trim().toUpperCase()
  if (code) {
    const coupon = (db.getPricing().coupons || []).find((c) => c.code === code)
    if (!coupon || !coupon.active) return { error: 'invalid_coupon', message: 'This coupon code is not valid.' }
    if (coupon.expiresAt && Date.now() > coupon.expiresAt) return { error: 'coupon_expired', message: 'This coupon has expired.' }
    if (coupon.maxUses != null && db.countCouponUses(coupon.code) >= coupon.maxUses) {
      return { error: 'coupon_limit_reached', message: 'This coupon has reached its usage limit.' }
    }
    return { discount: { type: coupon.type, value: coupon.value, minOrderValue: coupon.minOrderValue || 0 }, code: coupon.code, reason: null }
  }
  if (discountType === 'percent' || discountType === 'flat') {
    if (!allowAdHoc) return { error: 'invalid_discount', message: 'Only a coupon code can be applied here.' }
    const value = Number(discountValue)
    if (!Number.isFinite(value) || value <= 0 || (discountType === 'percent' && value > 100)) {
      return { error: 'invalid_discount_value', message: 'Enter a valid discount value.' }
    }
    return { discount: { type: discountType, value, minOrderValue: 0 }, code: null, reason: String(discountReason || '').trim().slice(0, 200) || null }
  }
  return { discount: null, code: null, reason: null }
}

// Shared by POST /api/orders (customer checkout) and POST /api/admin/orders
// (staff-placed order) — both validate/normalize the raw `files` input,
// resolve delivery timing, and price the order identically; only what
// happens next (payment method, who owns the order) differs between them.
// Returns { error, message? } on the first invalid file/input (caller
// responds with that as a 400), otherwise the validated, priced result.
// Converts one already-stored files_json entry (any productType) into the
// shape pricing.calculate() expects. Shared by the general Edit Order
// repricing block and the add-service endpoint below, both of which need to
// reprice a full mixed-productType files array from stored data rather than
// raw request input (that's buildPricedOrderFiles's job, further down).
function toPricingFile(f) {
  if (f.productType === 'service') {
    return { productType: 'service', serviceId: f.serviceId, quantity: f.quantity }
  }
  if (f.productType === 'passport-photo') {
    return { productType: 'passport-photo', sizePresetId: f.sizePresetId, packQty: f.packQty }
  }
  if (f.productType === 'stationery') {
    return { productType: 'stationery', productId: f.productId, name: f.name, unitPrice: f.unitPrice, quantity: f.quantity }
  }
  if (f.productType === 'stamp') {
    return { productType: 'stamp', stampTypeId: f.stampTypeId, stampSizeId: f.stampSizeId, hasLogo: !!f.logoFileId, quantity: f.quantity }
  }
  const { colorPages, bwPages } = pricing.resolveFileColorPages({ pageCount: f.pageCount, colorCount: f.colorPageCount }, f.printMode)
  return { colorPages, bwPages, copies: f.copies, printSide: f.printSide, pageSize: f.pageSize, paperType: f.paperType }
}

// Decrements stock for any stationery items in a newly-confirmed order.
// Called from every "order just got confirmed" call site, immediately after
// printQueue.enqueue() — COD-at-creation, admin walk-in creation,
// verify-payment, recheck-payment, and the webhook's confirmPaid — the exact
// same set of places, since those are all "this order is now real" moments.
// A shortfall (see db.decrementStockForOrder) never blocks or unwinds an
// already-captured payment — it flags the order so staff notice and can
// resolve it manually (contact the customer, restock, or refund).
function confirmStockForOrder(order) {
  try {
    const { shortfalls } = db.decrementStockForOrder(order)
    if (shortfalls.length) {
      const detail = shortfalls.map((s) => `${s.name || s.productId} (needed ${s.requested}, only ${s.decremented} available)`).join('; ')
      db.updateOrder(order.id, {
        needs_attention: 1,
        needs_attention_reason: `Stock shortfall at confirmation: ${detail}`
      })
    }
  } catch (err) {
    console.error(`[inventory] stock decrement failed for order ${order.id}:`, err.message)
  }
}

function buildPricedOrderFiles(files, { deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode, deliveryTiming, scheduledAt, allowMissingFile, discount }) {
  const VALID_MODES = ['auto', 'color', 'bw']
  const VALID_ORIENTATIONS = ['portrait', 'landscape']
  const VALID_SIDES = ['single', 'double']
  // Page sizes and paper types are both admin-managed, so the valid sets come
  // from the live pricing config, not a hardcoded list. Both are required per
  // file — the customer order page no longer pre-selects either, so a
  // missing/unknown id here means the field was genuinely skipped. Page size
  // is validated first since which paper types are valid depends on it.
  const paperTypeConfig = db.getPricing()
  const pageSizeIds = (paperTypeConfig.pageSizes || []).filter((s) => s.active).map((s) => s.id)
  const passportPresetIds = ((paperTypeConfig.passportPhotos || {}).sizePresets || []).filter((s) => s.active).map((s) => s.id)
  const passportPackQtys = ((paperTypeConfig.passportPhotos || {}).packPrices || []).map((p) => p.qty)
  let totalFileSize = 0
  const safeFiles = []
  const pricingFiles = []
  const serviceCatalog = (paperTypeConfig.additionalServices || []).filter((s) => s.active)
  const serviceIds = serviceCatalog.map((s) => s.id)
  // Pre-scan: aggregate requested stationery quantity per productId across
  // the WHOLE cart before the per-item loop below prices anything. Two
  // separate cart lines for the same product (e.g. added at different times)
  // must not each independently pass a stock check and jointly oversell —
  // the actual check runs once, after the loop, against this aggregate (see
  // below). Never deducts stock here — that only happens once the order is
  // actually confirmed (paid online, or COD at creation), in decrementStockForOrder.
  const stationeryQtyByProduct = new Map()
  for (const f of files) {
    if (f.productType === 'stationery' && f.productId) {
      const qty = Math.max(1, Math.min(999, Math.round(Number(f.quantity)) || 1))
      stationeryQtyByProduct.set(f.productId, (stationeryQtyByProduct.get(f.productId) || 0) + qty)
    }
  }
  // An order can mix Documents, Passport Photos, Additional Services, and
  // Stationery, so branching happens per-item (on each file's own
  // productType) rather than for the whole order.
  for (const f of files) {
    const productType = f.productType === 'passport-photo' ? 'passport-photo' : (f.productType === 'service' ? 'service' : (f.productType === 'stationery' ? 'stationery' : (f.productType === 'stamp' ? 'stamp' : 'document')))

    if (productType === 'service') {
      if (!serviceIds.includes(f.serviceId)) {
        return { error: 'missing_service', message: 'Select an additional service for every service line.' }
      }
      const service = serviceCatalog.find((s) => s.id === f.serviceId)
      const quantity = Math.max(1, Math.min(999, Math.round(Number(f.quantity)) || 1))
      const fileData = {
        itemId: crypto.randomUUID().slice(0, 8),
        productType: 'service',
        fileId: null,
        fileName: service.label,
        fileType: null,
        fileSize: 0,
        serviceId: service.id,
        quantity
      }
      pricingFiles.push({ productType: 'service', serviceId: service.id, quantity })
      safeFiles.push(fileData)
      continue
    }

    // Ready-made stationery (pens, staplers, Rent Receipt Booklets, ...) —
    // a real inventory-tracked product, not a print job. name/unitPrice are
    // snapshotted from the product row now so a later price change never
    // retroactively rewrites what an already-placed order was charged (same
    // reasoning as fileBreakdown's baked-in amounts). The actual stock
    // availability check runs once below, after this loop, against the
    // pre-scanned aggregate — never per-line, so multiple lines of the same
    // product can't each pass an independent check and jointly oversell.
    if (productType === 'stationery') {
      const product = f.productId ? db.getProductById(f.productId) : null
      if (!product || !product.active) {
        return { error: 'invalid_product', message: 'One of the stationery items in your cart is no longer available.' }
      }
      const quantity = Math.max(1, Math.min(999, Math.round(Number(f.quantity)) || 1))
      const fileData = {
        itemId: crypto.randomUUID().slice(0, 8),
        productType: 'stationery',
        fileId: null,
        fileName: product.name,
        fileType: null,
        fileSize: 0,
        productId: product.id,
        sku: product.sku,
        name: product.name,
        unitPrice: product.price,
        quantity,
        itemStatus: 'pending'
      }
      pricingFiles.push({ productType: 'stationery', productId: product.id, name: product.name, unitPrice: product.price, quantity })
      safeFiles.push(fileData)
      continue
    }

    // Custom Stamp Printing — type/size validated against the ACTIVE admin
    // config (settings.pricing.stamps), same "must be currently offered"
    // rule as page size/paper type below. Logo/existing-artwork uploads
    // reuse the exact same private uploads/ pipeline and path.basename +
    // fs.existsSync guard as a document file, since they're genuinely the
    // same kind of thing (a customer-supplied file attached to an order
    // item) — never the public product-photo pipeline. itemId + itemStatus
    // give this line the same PICK/PRODUCE-style tracking stationery has
    // (see the item-status endpoint) — the proof-approval lifecycle itself
    // is built in a later phase.
    if (productType === 'stamp') {
      const stampConfig = paperTypeConfig.stamps || {}
      const stampTypes = (stampConfig.types || []).filter((t) => t.active)
      const stampType = stampTypes.find((t) => t.id === f.stampTypeId)
      if (!stampType) {
        return { error: 'missing_stamp_type', message: 'Select a stamp type.' }
      }
      // Sizes live inside their type — a size id is only valid for the type
      // it belongs to (a Self-Inking size chart and a Pre-Inked size chart
      // are different real-world products, not interchangeable ids).
      const stampSizes = (stampType.sizes || []).filter((s) => s.active)
      if (!stampSizes.some((s) => s.id === f.stampSizeId)) {
        return { error: 'missing_stamp_size', message: 'Select a stamp size.' }
      }
      const textLines = (Array.isArray(f.textLines) ? f.textLines : [])
        .map((l) => String(l || '').trim().slice(0, 60))
        .filter(Boolean)
        .slice(0, 6)
      let artworkFileId = null
      if (f.artworkFileId) {
        const safeArtworkId = path.basename(String(f.artworkFileId))
        if (safeArtworkId && fs.existsSync(path.join(uploadsDir, safeArtworkId))) artworkFileId = safeArtworkId
      }
      // A customer with their own ready-made design uploads artwork instead
      // of typing text (see stamps.html's design-mode choice) — only reject
      // when NEITHER is present, so that path isn't blocked by a text
      // requirement it was explicitly meant to replace.
      if (!textLines.length && !artworkFileId) {
        return { error: 'missing_stamp_text', message: 'Enter the text for your stamp, or upload your own design.' }
      }
      let logoFileId = null
      if (f.logoFileId) {
        const safeLogoId = path.basename(String(f.logoFileId))
        if (safeLogoId && fs.existsSync(path.join(uploadsDir, safeLogoId))) logoFileId = safeLogoId
      }
      const quantity = Math.max(1, Math.min(999, Math.round(Number(f.quantity)) || 1))
      const fileData = {
        itemId: crypto.randomUUID().slice(0, 8),
        productType: 'stamp',
        fileId: null,
        fileName: 'Custom Stamp',
        fileType: null,
        fileSize: 0,
        stampTypeId: f.stampTypeId,
        stampSizeId: f.stampSizeId,
        textLines,
        logoFileId,
        artworkFileId,
        quantity,
        itemStatus: 'pending'
      }
      pricingFiles.push({ productType: 'stamp', stampTypeId: f.stampTypeId, stampSizeId: f.stampSizeId, hasLogo: !!logoFileId, quantity })
      safeFiles.push(fileData)
      continue
    }

    if (productType === 'passport-photo') {
      if (!passportPresetIds.includes(f.sizePresetId)) {
        return { error: 'missing_size_preset', message: 'Select a size for every passport photo.' }
      }
      if (!passportPackQtys.includes(Number(f.packQty))) {
        return { error: 'missing_pack_qty', message: 'Select a pack quantity for every passport photo.' }
      }
      // The customer self-serve flow always uploads (and crops) a real photo
      // first, so a missing file there is a genuine error. The admin walk-in
      // flow explicitly allows a photo-less line item — real order volume
      // comes in over WhatsApp, and staff need to price/invoice/send a
      // payment link before (or without ever) having the file in hand.
      let safeFileId = null
      if (f.fileId) {
        safeFileId = path.basename(String(f.fileId))
        if (!safeFileId || !fs.existsSync(path.join(uploadsDir, safeFileId))) {
          return { error: 'file_not_found', message: 'One or more uploaded files expired or were not found. Please re-upload.' }
        }
      } else if (!allowMissingFile) {
        return { error: 'file_not_found', message: 'Upload a photo for every passport photo item.' }
      }
      const fileData = {
        itemId: crypto.randomUUID().slice(0, 8),
        productType: 'passport-photo',
        fileId: safeFileId,
        fileName: f.fileName || (safeFileId || 'Passport photo'),
        fileType: f.fileType || null,
        fileSize: Number(f.fileSize) || 0,
        sizePresetId: f.sizePresetId,
        packQty: Number(f.packQty)
      }
      pricingFiles.push({ productType: 'passport-photo', sizePresetId: fileData.sizePresetId, packQty: fileData.packQty })
      totalFileSize += fileData.fileSize
      safeFiles.push(fileData)
      continue
    }

    // Same allowMissingFile relaxation as the passport-photo branch above —
    // the walk-in "quick rate" line (New Order modal) prices off a chosen
    // page-type rate + a typed quantity, not an uploaded file's page count,
    // so staff can price/invoice/send a payment link before ever having the
    // document in hand. The customer self-serve flow never sets
    // allowMissingFile, so a real upload is still required there.
    let safeFileId = null
    if (f.fileId) {
      safeFileId = path.basename(String(f.fileId))
      if (!safeFileId || !fs.existsSync(path.join(uploadsDir, safeFileId))) {
        return { error: 'file_not_found', message: 'One or more uploaded files expired or were not found. Please re-upload.' }
      }
    } else if (!allowMissingFile) {
      return { error: 'file_not_found', message: 'One or more uploaded files expired or were not found. Please re-upload.' }
    }
    if (!pageSizeIds.includes(f.pageSize)) {
      return { error: 'missing_page_size', message: 'Select a page size for every file.' }
    }
    const filePageSize = f.pageSize
    const paperTypeIds = (paperTypeConfig.rates[filePageSize] || []).map((t) => t.id)
    if (!paperTypeIds.includes(f.paperType)) {
      return { error: 'missing_paper_type', message: 'Select a paper type for every file.' }
    }
    const fileMode = VALID_MODES.includes(f.printMode) ? f.printMode : 'auto'
    const fileOrientation = VALID_ORIENTATIONS.includes(f.orientation) ? f.orientation : 'portrait'
    // Colour prints are single-sided only — enforce server-side regardless of input.
    const fileSide = fileMode === 'color' ? 'single' : (VALID_SIDES.includes(f.printSide) ? f.printSide : 'single')
    const filePaperType = f.paperType
    const fileCopies = Math.max(1, Math.min(999, Math.round(Number(f.copies)) || 1))
    const filePassword = String(f.password || '').trim().slice(0, 200) || null
    const fileData = {
      itemId: crypto.randomUUID().slice(0, 8),
      productType: 'document',
      fileId: safeFileId,
      fileName: f.fileName || safeFileId || 'Document',
      fileType: f.fileType || null,
      pageCount: Number(f.pageCount) || 0,
      colorPageCount: Number(f.colorPageCount) || 0,
      fileSize: Number(f.fileSize) || 0,
      printMode: fileMode,
      orientation: fileOrientation,
      printSide: fileSide,
      pageSize: filePageSize,
      paperType: filePaperType,
      copies: fileCopies,
      password: filePassword
    }
    const { colorPages, bwPages } = pricing.resolveFileColorPages(
      { pageCount: fileData.pageCount, colorCount: fileData.colorPageCount },
      fileMode
    )
    pricingFiles.push({ colorPages, bwPages, copies: fileCopies, printSide: fileSide, pageSize: filePageSize, paperType: filePaperType })
    totalFileSize += fileData.fileSize
    safeFiles.push(fileData)
  }
  if (totalFileSize > MAX_TOTAL_UPLOAD_BYTES) {
    return { error: 'files_too_large', message: 'Total upload size exceeds 100 MB.' }
  }
  // Aggregate stock check — see the pre-scan above. This is a point-in-time
  // check only (never allow stock to become negative is enforced for real at
  // confirmation time in decrementStockForOrder); its job here is just to
  // reject an order up front when it's obviously asking for more than exists,
  // rather than letting the customer pay first and find out never.
  for (const [productId, qty] of stationeryQtyByProduct) {
    const product = db.getProductById(productId)
    if (!product || qty > product.stock_qty) {
      return {
        error: 'insufficient_stock',
        message: product
          ? `Only ${product.stock_qty} left in stock for "${product.name}" — please reduce the quantity.`
          : 'One of the stationery items in your cart is no longer available.'
      }
    }
  }
  if (deliveryMethod === 'delivery' && (!deliveryAddress || !deliveryCity || !deliveryState || !deliveryPincode)) {
    return { error: 'missing_delivery_address' }
  }

  // Instant delivery matches the existing 3-4hr TAT with no extra input needed;
  // scheduled delivery requires a concrete future slot, bounded so it's neither
  // effectively "instant" in disguise nor an unreasonably far-out promise.
  const MIN_SCHEDULE_LEAD_MS = 2 * 60 * 60 * 1000
  const MAX_SCHEDULE_LEAD_MS = 7 * 24 * 60 * 60 * 1000
  let resolvedDeliveryTiming = 'instant'
  let resolvedScheduledAt = null
  if (deliveryMethod === 'delivery') {
    resolvedDeliveryTiming = deliveryTiming === 'scheduled' ? 'scheduled' : 'instant'
    if (resolvedDeliveryTiming === 'scheduled') {
      const ts = Number(scheduledAt)
      const now = Date.now()
      if (!Number.isFinite(ts) || ts < now + MIN_SCHEDULE_LEAD_MS || ts > now + MAX_SCHEDULE_LEAD_MS) {
        return { error: 'invalid_scheduled_time', message: 'Choose a delivery time at least 2 hours from now, within the next 7 days.' }
      }
      resolvedScheduledAt = ts
    }
  }

  // Document-only summary fields — a passport-photo item has none of
  // pageSize/paperType/printMode/etc, so these are derived over document
  // items alone. A pure-passport (or otherwise document-less) order gets
  // null for all of them rather than a misleading 'mixed'/fallback value.
  const documentFiles = safeFiles.filter((f) => f.productType === 'document')
  const totalPageCount = documentFiles.reduce((sum, f) => sum + f.pageCount, 0)
  let summaryMode = null, summaryOrientation = null, summarySide = null, summaryPaperType = null, summaryPageSize = null
  if (documentFiles.length) {
    const fileModes = new Set(documentFiles.map((f) => f.printMode))
    summaryMode = fileModes.size === 1 ? documentFiles[0].printMode : 'mixed'
    const fileOrientations = new Set(documentFiles.map((f) => f.orientation))
    summaryOrientation = fileOrientations.size === 1 ? documentFiles[0].orientation : 'mixed'
    const fileSides = new Set(documentFiles.map((f) => f.printSide))
    summarySide = fileSides.size === 1 ? documentFiles[0].printSide : 'mixed'
    const filePaperTypes = new Set(documentFiles.map((f) => f.paperType))
    summaryPaperType = filePaperTypes.size === 1 ? documentFiles[0].paperType : 'mixed'
    const filePageSizes = new Set(documentFiles.map((f) => f.pageSize))
    summaryPageSize = filePageSizes.size === 1 ? documentFiles[0].pageSize : 'mixed'
  }
  // "Copies" now spans two different units (document copies, photo-pack
  // quantities) that both mean "how many physical prints" — summing them
  // keeps this display-only column meaningful instead of showing 0 for a
  // passport-only order. Never used for pricing (pricing.calculate() owns that).
  const totalCopies = documentFiles.reduce((sum, f) => sum + f.copies, 0) +
    safeFiles.filter((f) => f.productType === 'passport-photo').reduce((sum, f) => sum + (f.packQty || 0), 0)
  const productTypesPresent = new Set(safeFiles.map((f) => f.productType))
  const summaryProductType = productTypesPresent.size === 1 ? safeFiles[0].productType : (productTypesPresent.size ? 'mixed' : 'document')

  const pricingConfig = db.getPricing()
  const calc = pricing.calculate(pricingConfig, {
    files: pricingFiles,
    deliveryMethod: deliveryMethod || 'pickup',
    deliveryPincode,
    discount
  })
  // Bake each file's actual charged amount/labels in now, so an invoice
  // printed later reflects what was charged even if rates change meanwhile.
  safeFiles.forEach((f, i) => { if (calc.fileBreakdown[i]) Object.assign(f, calc.fileBreakdown[i]) })

  return {
    safeFiles, totalPageCount, summaryMode, summaryOrientation, summarySide,
    summaryPaperType, summaryPageSize, totalCopies, summaryProductType, calc,
    resolvedDeliveryTiming, resolvedScheduledAt
  }
}

app.post('/api/orders', express.json(), async (req, res) => {
  const {
    customerName, customerMobile, customerEmail,
    files,
    deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode,
    deliveryTiming, scheduledAt,
    locationId, paymentMethod, notes, discountCode
  } = req.body || {}
  const isCod = paymentMethod === 'cod'
  const safeNotes = String(notes || '').trim().slice(0, 500) || null

  if (!customerName || !customerMobile) {
    return res.status(400).json({ error: 'missing_customer_info' })
  }
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'missing_file_info' })
  }

  // allowAdHoc: false — a customer can only apply a real coupon code, never
  // an arbitrary type+value straight from the request body.
  const discountResolved = resolveDiscountInput({ discountCode }, { allowAdHoc: false })
  if (discountResolved.error) return res.status(400).json({ error: discountResolved.error, message: discountResolved.message })

  // allowMissingFile is never set here — a customer must always have
  // actually uploaded (and, for passport photos, cropped) the file first;
  // that upload is the whole point of the self-serve flow. Only the admin
  // walk-in endpoint below allows a photo-less passport-photo line item.
  const built = buildPricedOrderFiles(files, { deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode, deliveryTiming, scheduledAt, discount: discountResolved.discount })
  if (built.error) return res.status(400).json({ error: built.error, message: built.message })
  const { safeFiles, totalPageCount, summaryMode, summaryOrientation, summarySide, summaryPaperType, summaryPageSize, totalCopies, summaryProductType, calc, resolvedDeliveryTiming, resolvedScheduledAt } = built

  const orderId = generateOrderId()
  let razorpayOrder = null
  let simulated = true

  // Pay-on-delivery (Cash/UPI) skips the online gateway entirely — the order is
  // confirmed now and payment is collected by staff at delivery/pickup.
  if (!isCod) {
    try {
      razorpayOrder = await razorpay.createOrder({ orderId, amount: calc.totalAmount })
      simulated = !!razorpayOrder.simulated
    } catch (err) {
      console.error('Razorpay order creation failed', err)
      return res.status(500).json({ error: 'payment_error' })
    }
  }

  const fileNameSummary = safeFiles.length > 1
    ? `${safeFiles[0].fileName} +${safeFiles.length - 1} more`
    : safeFiles[0].fileName

  // Resolve the chosen branch server-side so the stored name is trustworthy.
  const chosenLocation = locationId ? db.getLocations().find((l) => l.id === locationId && l.active) : null

  const order = db.createOrder({
    id: orderId,
    customer_id: getOptionalCustomerId(req),
    customer_name: customerName,
    customer_mobile: customerMobile,
    customer_email: customerEmail || null,
    file_name: fileNameSummary,
    file_path: safeFiles[0].fileId,
    file_type: safeFiles[0].fileType,
    page_count: totalPageCount,
    files_json: JSON.stringify(safeFiles),
    orientation: summaryOrientation,
    print_mode: summaryMode,
    print_side: summarySide,
    copies: totalCopies,
    paper_size: summaryPageSize,
    paper_type: summaryPaperType,
    product_type: summaryProductType,
    delivery_method: deliveryMethod || 'pickup',
    delivery_address: deliveryAddress || null,
    delivery_city: deliveryCity || null,
    delivery_state: deliveryState || null,
    delivery_pincode: deliveryPincode || null,
    delivery_timing: resolvedDeliveryTiming,
    scheduled_at: resolvedScheduledAt,
    location_id: chosenLocation ? chosenLocation.id : (locationId || null),
    location_name: chosenLocation ? chosenLocation.name : null,
    payment_method: isCod ? 'cod' : 'online',
    print_cost: calc.printCost,
    services_cost: calc.servicesCost,
    stationery_cost: calc.stationeryCost,
    stamp_cost: calc.stampCost,
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount,
    discount_type: discountResolved.discount ? discountResolved.discount.type : null,
    discount_value: discountResolved.discount ? discountResolved.discount.value : 0,
    discount_amount: calc.discountAmount,
    discount_code: discountResolved.code,
    discount_reason: discountResolved.reason,
    razorpay_order_id: isCod ? null : razorpayOrder.id,
    payment_status: isCod ? 'pending' : 'created',
    order_status: 'Received',
    notes: safeNotes,
    created_at: Date.now()
  })

  // COD orders are confirmed immediately: queue them for printing and notify,
  // just like a paid online order does after verify-payment.
  if (isCod) {
    printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
    confirmStockForOrder(order)
    const fresh = db.getOrder(order.id)
    notify.sendOrderConfirmationSms(fresh)
    notify.sendOrderConfirmationEmail(fresh)
    mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
    return res.json({ order: fresh, cod: true })
  }

  return res.json({ order, razorpayOrder, key: process.env.RAZORPAY_KEY_ID || '', simulated })
})

// Lets staff place an order for a customer who doesn't want to use the
// website themselves (walk-in / phone order). Mirrors the validation and
// pricing above, but never takes the online-Razorpay path — an admin-placed
// order is always either "pay later" (cash/UPI on pickup or delivery, same
// as customer COD) or "already collected" (paid in person right now), which
// only an authenticated admin can declare — a customer-facing endpoint must
// never accept an already-paid flag straight from the request body.
app.post('/api/admin/orders', requireAdmin, requireTab('orders'), express.json(), async (req, res) => {
  const {
    customerName, customerMobile, customerEmail,
    files,
    deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode,
    deliveryTiming, scheduledAt,
    locationId,
    paymentStatus, paymentMode, notes,
    discountCode, discountType, discountValue, discountReason
  } = req.body || {}
  const safeNotes = String(notes || '').trim().slice(0, 500) || null

  if (!customerName || !customerMobile) {
    return res.status(400).json({ error: 'missing_customer_info' })
  }
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'missing_file_info' })
  }
  const markPaidNow = paymentStatus === 'paid'
  const wantsPaymentLink = paymentStatus === 'link'
  if (markPaidNow && !['cash', 'upi'].includes(paymentMode)) {
    return res.status(400).json({ error: 'invalid_payment_mode', message: 'Payment mode must be cash or upi.' })
  }

  // allowAdHoc: true — staff can either apply an existing coupon code or type
  // a flat/percent discount straight in, no code required.
  const discountResolved = resolveDiscountInput({ discountCode, discountType, discountValue, discountReason }, { allowAdHoc: true })
  if (discountResolved.error) return res.status(400).json({ error: discountResolved.error, message: discountResolved.message })

  // allowMissingFile: true — real order volume comes in over WhatsApp/other
  // channels, so staff need to price a passport-photo line item, create the
  // order, and generate an invoice/payment link without necessarily having
  // the photo file in the system yet (it can be attached later, or never —
  // the shop already has it). Document items still require a real uploaded
  // file, same as always (buildPricedOrderFiles only relaxes this for
  // passport-photo items).
  const built = buildPricedOrderFiles(files, { deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode, deliveryTiming, scheduledAt, allowMissingFile: true, discount: discountResolved.discount })
  if (built.error) return res.status(400).json({ error: built.error, message: built.message })
  const { safeFiles, totalPageCount, summaryMode, summaryOrientation, summarySide, summaryPaperType, summaryPageSize, totalCopies, summaryProductType, calc, resolvedDeliveryTiming, resolvedScheduledAt } = built

  const orderId = generateOrderId()
  const fileNameSummary = safeFiles.length > 1
    ? `${safeFiles[0].fileName} +${safeFiles.length - 1} more`
    : safeFiles[0].fileName

  // A branch admin can only place orders under their own branch; a super
  // admin may pick one explicitly (or leave it unset for pickup-only shops).
  const effectiveLocationId = req.admin.adminRole === 'branch_admin' ? req.admin.locationId : (locationId || null)
  const chosenLocation = effectiveLocationId ? db.getLocations().find((l) => l.id === effectiveLocationId && l.active) : null

  // Links this walk-in order to a registered account when the customer's
  // mobile/email matches one, purely as a backend guarantee (see
  // findUserByMobileOrEmail) — independent of whatever staff did or didn't
  // pick in the New Order modal's customer search.
  const matchedUser = db.findUserByMobileOrEmail(customerMobile, customerEmail || null)

  const order = db.createOrder({
    id: orderId,
    customer_id: matchedUser ? matchedUser.id : null,
    customer_name: customerName,
    customer_mobile: customerMobile,
    customer_email: customerEmail || null,
    file_name: fileNameSummary,
    file_path: safeFiles[0].fileId,
    file_type: safeFiles[0].fileType,
    page_count: totalPageCount,
    files_json: JSON.stringify(safeFiles),
    orientation: summaryOrientation,
    print_mode: summaryMode,
    print_side: summarySide,
    copies: totalCopies,
    paper_size: summaryPageSize,
    paper_type: summaryPaperType,
    product_type: summaryProductType,
    delivery_method: deliveryMethod || 'pickup',
    delivery_address: deliveryAddress || null,
    delivery_city: deliveryCity || null,
    delivery_state: deliveryState || null,
    delivery_pincode: deliveryPincode || null,
    delivery_timing: resolvedDeliveryTiming,
    scheduled_at: resolvedScheduledAt,
    location_id: chosenLocation ? chosenLocation.id : (effectiveLocationId || null),
    location_name: chosenLocation ? chosenLocation.name : null,
    // A payment-link order is genuinely online (nothing collected in person),
    // so it follows the same "paid before printing" rule as a customer's own
    // checkout — everything else here is COD-shaped (staff-trusted).
    payment_method: wantsPaymentLink ? 'online' : 'cod',
    print_cost: calc.printCost,
    services_cost: calc.servicesCost,
    stationery_cost: calc.stationeryCost,
    stamp_cost: calc.stampCost,
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount,
    discount_type: discountResolved.discount ? discountResolved.discount.type : null,
    discount_value: discountResolved.discount ? discountResolved.discount.value : 0,
    discount_amount: calc.discountAmount,
    discount_code: discountResolved.code,
    discount_reason: discountResolved.reason,
    // 'created' mirrors the public checkout's pre-payment state — it's what
    // keeps an unpaid link order out of db.listOrders() until it's paid,
    // same as an abandoned self-checkout never shows up either.
    payment_status: markPaidNow ? 'paid' : (wantsPaymentLink ? 'created' : 'pending'),
    order_status: 'Received',
    notes: safeNotes,
    created_at: Date.now()
  })

  if (markPaidNow) {
    db.updateOrder(order.id, { payment_mode: paymentMode, payment_collected_at: Date.now() })
  }

  if (wantsPaymentLink) {
    let link
    try {
      link = await createPaymentLinkForOrder(order)
    } catch (err) {
      // Order creation and link generation are one operation from the
      // admin's point of view — if the link fails, don't leave behind a
      // ghost order stuck in payment_status 'created', which never shows up
      // in the Orders list and has no link to recover it.
      db.deleteOrder(order.id)
      return res.status(500).json({ error: err.code || 'payment_link_failed', message: err.message })
    }
    let smsSent = false
    try {
      smsSent = await sms.sendPaymentLinkSms(order, link.link_url)
    } catch (err) {
      smsSent = false
      console.error(`[sms] payment link send failed for ${order.id}:`, err.message)
    }
    // No printQueue.enqueue / order-confirmation notify here — those fire
    // only from the /api/webhook PAYMENT_LINK_EVENT handler, once the
    // customer actually pays (payment links have no client-driven
    // confirmation path — see the webhook route's comment).
    return res.json({ order, linkUrl: link.link_url, smsSent })
  }

  printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
  confirmStockForOrder(order)
  const fresh = db.getOrder(order.id)
  notify.sendOrderConfirmationSms(fresh)
  notify.sendOrderConfirmationEmail(fresh)
  mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
  return res.json({ order: fresh })
})

app.get('/api/orders/:id', (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ order })
})

// Public "download my invoice" link — what the order-completed SMS points
// to. Same trust model as /api/track/:id/pay below (order ID is the sole
// credential): this codebase already treats a known order ID as enough to
// let a customer trigger a real payment, so serving the same PDF they'd
// otherwise get as an email attachment is no larger a departure. Only ever
// serves once the order actually has a completed_at, so it can't be used to
// peek at an in-progress order before its invoice exists.
app.get('/api/orders/:id/invoice.pdf', async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order) || !order.completed_at) return res.status(404).json({ error: 'not_found' })
  try {
    const pdf = await buildInvoicePdf(order)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${order.id}.pdf"`)
    return res.send(pdf)
  } catch (err) {
    console.error(`[invoice] public download failed for ${order.id}:`, err.message)
    return res.status(500).json({ error: 'invoice_generation_failed' })
  }
})

// Public tracking lookup behind the job sheet's QR code — deliberately never
// returns customer name, contact, or files, since order IDs aren't secret
// enough to gate anything sensitive behind. Order-level context (status,
// payment, pricing, progress) is fine to expose — it's what a package
// tracking page normally shows.
const READY_BY_WINDOW_MS = 4 * 60 * 60 * 1000
// A "confirmed" order is paid online, pay-on-delivery, or a genuine Payment
// Link order — the payment_link_id check is this function's one addition
// over the base definition used everywhere else (db.listOrders/listMyOrders/
// listCustomers). Razorpay's Payment Link callback_url sends the customer's
// browser straight to /track/:id right after they pay, and although that
// redirect is itself signature-verified (see /api/payment-links/callback),
// many UPI apps never return control to the browser at all — the webhook
// below is the backup for exactly that case, and can lag a few seconds
// behind. Without this, a not-yet-confirmed order 404s on a real,
// already-placed order for however long confirmation takes to land. Safe to
// allow pre-confirmation here specifically because a Payment Link order only exists
// once staff (or the create-with-link flow) generated one — unlike an
// abandoned self-checkout, which never gets a payment_link_id and stays
// correctly hidden until actually paid.
// COD orders are queued for printing immediately on creation, so a customer
// tracking one before it's paid at delivery is normal, not an error.
function isConfirmedOrder(order) {
  return !!order && (order.payment_status === 'paid' || order.payment_method === 'cod' || !!order.payment_link_id)
}
app.get('/api/track/:id', (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order)) return res.status(404).json({ error: 'not_found' })
  const stages = db.getOrderStages().map((s) => s.name)
  const feedback = db.getOrderFeedback(order.id)
  // Same "only nudge happy customers" gate as the feedback POST route below —
  // re-derived here (not just returned once at submit time) so the Google
  // review ask keeps showing on every tracking-page visit after Completed,
  // not just the single moment right after the customer submitted feedback.
  const reviewUrl = feedback && feedback.rating >= 4 ? (db.getSiteSettings().googleReviewUrl || null) : null
  return res.json({
    id: order.id,
    order_status: order.order_status,
    stages,
    stage_index: stages.indexOf(order.order_status),
    ready_by: (order.updated_at || order.created_at) + READY_BY_WINDOW_MS,
    created_at: order.created_at,
    completed: !!order.completed_at,
    feedback_submitted: !!feedback,
    reviewUrl,
    payment_status: order.payment_status,
    payment_method: order.payment_method,
    delivery_method: order.delivery_method,
    page_count: order.page_count,
    total_amount: order.total_amount,
    // Any stamp item currently awaiting the customer's proof approval — the
    // tracking page renders its review widget only when this is non-empty,
    // never for a plain document/stationery order.
    stampProofItems: (() => {
      let files = []
      try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (e) { files = [] }
      return files
        .filter((f) => f.productType === 'stamp' && f.itemStatus === 'proof_sent')
        .map((f) => ({ itemId: f.itemId, stampTypeId: f.stampTypeId, textLines: f.textLines }))
    })()
  })
})

// Same "order ID isn't secret enough to gate anything sensitive" posture as
// the GET above — only accepts feedback for orders that actually completed,
// and only once per order (order_feedback.order_id is uniquely indexed).
app.post('/api/track/:id/feedback', express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order)) return res.status(404).json({ error: 'not_found' })
  if (!order.completed_at) return res.status(400).json({ error: 'not_completed', message: 'Feedback opens once this order is marked Completed.' })
  if (db.getOrderFeedback(order.id)) return res.status(409).json({ error: 'already_submitted', message: 'Feedback was already submitted for this order.' })

  const rating = Number(req.body?.rating)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'invalid_rating', message: 'Rating must be a whole number from 1 to 5.' })
  }
  const comment = String(req.body?.comment || '').trim().slice(0, 2000)
  const feedback = db.createOrderFeedback({ order_id: order.id, rating, comment })
  // Only nudge happy customers toward a public Google review — never
  // prompt after a middling/poor rating.
  const reviewUrl = rating >= 4 ? (db.getSiteSettings().googleReviewUrl || null) : null
  return res.json({ feedback, reviewUrl })
})

// Lets a customer pay for their own still-unpaid order directly from the
// tracking page they already have — a COD order they'd rather pay for
// remotely, or an online order whose original checkout session was
// abandoned. Deliberately reuses createPaymentLinkForOrder (the exact same
// helper the admin "Send payment link" button and the create-with-link flow
// use) rather than trying to resume/reuse any existing link: that helper
// always cancels a stale link first, which is what keeps this safe to call
// even if the order's total changed since an older link was generated —
// the customer only ever gets charged the order's current total, never a
// stale amount. Same public, no-auth posture as the rest of /api/track/:id —
// the order ID is the only thing gating access, same trust model already
// accepted for feedback above.
app.post('/api/track/:id/pay', express.json(), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order)) return res.status(404).json({ error: 'not_found' })
  if (String(order.payment_status).toLowerCase() === 'paid') {
    return res.status(400).json({ error: 'already_paid', message: 'This order is already paid.' })
  }
  if (!razorpay.isConfigured()) {
    return res.status(400).json({ error: 'razorpay_not_configured', message: 'Online payment isn\'t available right now — please pay at pickup/delivery.' })
  }
  try {
    const link = await createPaymentLinkForOrder(order)
    return res.json({ linkUrl: link.link_url })
  } catch (err) {
    // Unlike the admin payment-link endpoint (which surfaces err.message
    // verbatim so staff get the real diagnostic), this is a public,
    // customer-facing surface — a raw Razorpay API/account error (e.g.
    // "link_creation_api is not enabled...") is meaningless and unprofessional
    // to show a paying customer. Log the real reason for us, show them the
    // same friendly fallback as the not-configured case above.
    console.error(`[pay-now] payment link failed for ${order.id}:`, err.message)
    return res.status(500).json({ error: 'payment_link_failed', message: 'Online payment isn\'t available right now — please pay at pickup/delivery.' })
  }
})

// Public — the tracking page's proof-review widget points its <img> straight
// at this URL. Same order-ID-as-credential trust model as the public invoice
// PDF (GET /api/orders/:id/invoice.pdf) below — a stamp proof image is no
// more sensitive than the order's own tracking status, already public this
// same way.
app.get('/api/track/:id/items/:itemId/stamp-proof/image', (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order)) return res.status(404).json({ error: 'not_found' })
  const proof = db.getLatestStampProofForItem(order.id, req.params.itemId)
  if (!proof) return res.status(404).json({ error: 'not_found' })
  const filePath = path.join(uploadsDir, path.basename(proof.file_id))
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file_not_found' })
  return res.sendFile(filePath)
})

// Public — customer approves or requests changes to a stamp proof from their
// tracking page. Same isConfirmedOrder gate as feedback/pay above. Only
// meaningful while the item is actually awaiting a response (proof_sent) —
// stops a stale/replayed request from re-approving (or un-approving) an item
// that's already moved past that point.
app.post('/api/track/:id/items/:itemId/stamp-proof/respond', express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order)) return res.status(404).json({ error: 'not_found' })
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (e) { files = [] }
  const item = files.find((f) => f.itemId === req.params.itemId && f.productType === 'stamp')
  if (!item) return res.status(404).json({ error: 'item_not_found' })
  if (item.itemStatus !== 'proof_sent') {
    return res.status(400).json({ error: 'no_pending_proof', message: 'There is no proof awaiting your response for this item.' })
  }
  const approved = !!(req.body && req.body.approved)
  const comment = String((req.body && req.body.comment) || '').trim().slice(0, 1000)
  const proof = db.getLatestStampProofForItem(order.id, item.itemId)
  if (proof) db.updateStampProof(proof.id, { status: approved ? 'approved' : 'changes_requested', customer_comment: comment || null, resolved_at: Date.now() })
  item.itemStatus = approved ? 'approved' : 'changes_requested'
  const updated = db.updateOrder(order.id, { files_json: JSON.stringify(files) })
  return res.json({ order: updated, status: item.itemStatus })
})

// Verify the Razorpay checkout response (or simulated payment) and advance the order.
app.post('/api/orders/:id/verify-payment', express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  if (order.payment_status === 'paid') {
    return res.json({ order })
  }

  const { simulated, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {}

  // Trust that an order is actually a simulated (no-Razorpay-configured) one
  // from its own stored razorpay_order_id, never from the request body —
  // otherwise anyone who knows an order ID could mark any real order "paid"
  // for free by just sending { simulated: true }.
  const isActuallySimulated = typeof order.razorpay_order_id === 'string' && order.razorpay_order_id.startsWith('SIM_')
  if (simulated && isActuallySimulated) {
    const paidOrder = db.markOrderPaid(order.id, { razorpay_payment_id: `SIM_PAY_${order.id}` })
    if (!paidOrder) return res.json({ order: db.getOrder(order.id) }) // lost the race — already confirmed elsewhere
    printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
    confirmStockForOrder(paidOrder)
    const fresh = db.getOrder(order.id)
    notify.sendOrderConfirmationSms(fresh)
    notify.sendOrderConfirmationEmail(fresh)
    mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
    return res.json({ order: fresh })
  }

  if (!razorpay.verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
    db.updateOrder(order.id, { payment_status: 'failed', order_status: 'Failed', failure_reason: 'signature_mismatch' })
    return res.status(400).json({ error: 'invalid_signature' })
  }

  const paidOrder = db.markOrderPaid(order.id, { razorpay_payment_id, razorpay_signature })
  if (!paidOrder) return res.json({ order: db.getOrder(order.id) }) // lost the race — already confirmed elsewhere
  printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
  confirmStockForOrder(paidOrder)
  const fresh = db.getOrder(order.id)
  notify.sendOrderConfirmationSms(fresh)
  notify.sendOrderConfirmationEmail(fresh)
  mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
  return res.json({ order: fresh })
})

// Razorpay redirects the customer's browser here after they pay (or cancel)
// a Payment Link — this is the primary confirmation path for that flow (the
// webhook above is the secondary/backup one, same "client-driven primary,
// webhook backup" split as the regular checkout's verify-payment endpoint).
app.get('/api/payment-links/callback', (req, res) => {
  const {
    razorpay_payment_id, razorpay_payment_link_id,
    razorpay_payment_link_reference_id, razorpay_payment_link_status,
    razorpay_signature
  } = req.query
  const order = db.getOrder(razorpay_payment_link_reference_id)
  if (order && razorpay_payment_link_status === 'paid' && order.payment_status !== 'paid') {
    if (razorpay.verifyPaymentLinkSignature({
      razorpay_payment_link_id, razorpay_payment_link_reference_id,
      razorpay_payment_link_status, razorpay_payment_id, razorpay_signature
    })) {
      const paidOrder = db.markOrderPaid(order.id, { razorpay_payment_id })
      if (paidOrder) {
        printQueue.enqueue(order.id)
        confirmStockForOrder(paidOrder)
        const fresh = db.getOrder(order.id)
        notify.sendOrderConfirmationSms(fresh)
        notify.sendOrderConfirmationEmail(fresh)
        mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
      }
    }
  }
  return res.redirect(`/track/${encodeURIComponent(razorpay_payment_link_reference_id || '')}`)
})

// Serve site images (logo, blog placeholder, ...) from server/public/images —
// every static image asset lives under this one folder/mount rather than a
// one-off route per file, so adding a new image needs no server.js change.
const publicDir = path.join(__dirname, 'public')

// These HTML templates (landing/blog/blog-post/track/order-success) are read
// and string-substituted on every request. They only change on deploy (which
// restarts the process), so read each one from disk once and cache it here
// instead of paying a synchronous fs read on every single page view.
const templateCache = new Map()
function readPublicTemplate(name) {
  let cached = templateCache.get(name)
  if (!cached) {
    cached = fs.readFileSync(path.join(publicDir, name), 'utf8')
    // landing.html's analytics.js include gets a content-hash query param
    // here, once, so every route that serves this template picks it up
    // without each one needing its own placeholder/substitution — see the
    // long maxAge on the /js static route above for why this exists.
    if (name === 'landing.html') {
      cached = cached.split('/js/analytics.js"').join(`/js/analytics.js?v=${analyticsJsVersion}"`)
    }
    templateCache.set(name, cached)
  }
  return cached
}

if (fs.existsSync(publicDir)) {
  // These are static brand assets that effectively never change, so let
  // browsers cache them for a year instead of re-fetching on every visit
  // (Lighthouse flags the default max-age=0 as an inefficient cache policy).
  app.use('/images', express.static(path.join(publicDir, 'images'), {
    maxAge: '365d',
    immutable: true,
  }))

  // Self-hosted, glyph-subset web fonts referenced by landing.html's @font-face
  // rules. Content-hashed by weight and effectively immutable, so cache them for
  // a year. Fonts are always fetched in CORS mode (the preload uses crossorigin),
  // so advertise an open ACAO to keep the preload and the @font-face fetch on the
  // same cached response instead of double-fetching.
  app.use('/fonts', express.static(path.join(publicDir, 'fonts'), {
    maxAge: '365d',
    immutable: true,
    setHeaders: (res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Content-Type', 'font/woff2')
    },
  }))

  // Shared client-side logic (currently just the cookie-consent/GA4 loader).
  // Not a fingerprinted build asset, so cache it long (Lighthouse flags
  // anything short) but bust that cache automatically via the content-hashed
  // ?v= query param landing.html requests it with below — a real edit here
  // changes the hash, and therefore the URL, so long-lived callers always
  // fetch the new content instead of serving a stale cached copy for a year.
  app.use('/js', express.static(path.join(publicDir, 'js'), { maxAge: '365d', immutable: true }))
}

const analyticsJsPath = path.join(publicDir, 'js', 'analytics.js')
const analyticsJsVersion = fs.existsSync(analyticsJsPath)
  ? crypto.createHash('sha256').update(fs.readFileSync(analyticsJsPath)).digest('hex').slice(0, 10)
  : Date.now().toString(36)

// Admin-controlled kill switch (Settings tab) for taking the storefront
// offline without touching /admin, /track/:id, /jobsheet.html, or any /api/*
// route — those must keep working so admin can flip it back on and existing
// customers can still track/print already-placed orders. Undefined (not yet
// saved by any install) means open, so this never needs a DB migration.
function isShopOpen() {
  return db.getSiteSettings().shopOpen !== false
}

// Independent soft-launch gates for Stationery and Stamps (see
// DEFAULT_SITE_SETTINGS in db.js) — explicit opt-in, checked at each
// vertical's own routes/APIs (real 404 while off, same as the route never
// having existed). Admin endpoints are never gated by these — Products/
// Inventory/Stamp Settings/walk-in order creation must stay usable so
// either catalog can be fully prepared before flipping it on.
function stationeryEnabled() {
  return db.getSiteSettings().stationeryEnabled === true
}
function stampsEnabled() {
  return db.getSiteSettings().stampsEnabled === true
}
// /cart and /api/cross-sell are shared by both verticals, not a vertical of
// their own — live whenever either one is.
function anyVerticalEnabled() {
  return stationeryEnabled() || stampsEnabled()
}

// Kept in sync by hand with the <details class="faq-item"> markup in
// landing.html's #faq section — the JSON-LD must describe content that's
// actually visible on the page, not just claims made in structured data.
const FAQ_ITEMS = [
  { q: 'How long does printing and delivery take?', a: 'Most standard orders under 100 pages are printed and ready instantly after successful payment. Bulk orders — 100+ pages or many copies — may take longer, and we’ll give you a realistic estimate at checkout.' },
  { q: 'Which file formats can I upload?', a: 'PDF, Word (.doc/.docx), PowerPoint (.ppt/.pptx), and photos (JPG/PNG). We convert and calculate your page count automatically, so there’s no need to export to PDF yourself first.' },
  { q: 'Do you deliver, or is it pickup only?', a: 'Both. Shop pickup is free. Home delivery is ₹__PRICE_DELIVERY_LOCAL__ within our local PIN code (122505), ₹__PRICE_DELIVERY_GURUGRAM__ elsewhere in Gurugram, and priced by distance if you’re outside Gurugram. Delivery is free on orders over ₹__PRICE_FREE_DELIVERY_THRESHOLD__. You can also choose instant delivery (within 2 hours) or schedule a delivery slot for later.' },
  { q: 'What’s the difference between color and black & white pricing?', a: 'Color pages cost more per page than black & white. You can print a file entirely in black & white, entirely in color, or use auto-detect so only the pages that actually contain color are billed at the color rate.' },
  { q: 'How do I pay, and is it secure?', a: 'All payments are processed securely through Razorpay before your order enters the print queue. Metalix Print never stores your card or banking details.' },
  { q: 'Can I track my order?', a: 'Yes — after payment you get a tracking link showing whether your order is queued, printing, or out for delivery. No account or app install required.' },
  { q: 'What if something’s wrong with my print?', a: 'Report it within 24 hours of pickup or delivery by calling or WhatsApp-ing us. If we made a mistake, we reprint it free; if the issue is with the uploaded file, we can offer a paid reprint.' }
]

function faqJsonLd() {
  const prices = pricingPlaceholders()
  const withLivePrices = (text) => Object.entries(prices).reduce((s, [token, value]) => s.split(token).join(value), text)
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: withLivePrices(item.a) }
    }))
  })
}

// ratingValue/reviewCount are computed from every rating ever submitted
// (db.getFeedbackStats), not just the curated 4-5★ subset shown in the
// carousel — Google's guidelines require aggregate ratings to reflect all
// genuine reviews, not a filtered/flattering slice. Omitted entirely when
// there are zero ratings rather than fabricating one.
function localBusinessJsonLd() {
  const business = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: 'Metalix Print',
    url: 'https://print.metalix.in/',
    logo: 'https://print.metalix.in/images/logo.svg',
    image: 'https://print.metalix.in/images/logo.svg',
    description: 'Online document printing — upload your PDF, Word, or PPT, choose settings, and get prints delivered instantly.',
    telephone: '+91-7042443143',
    address: {
      '@type': 'PostalAddress',
      streetAddress: 'M86/2, M3M Solitude, Sector 89',
      addressLocality: 'Gurugram',
      addressRegion: 'HR',
      postalCode: '122505',
      addressCountry: 'IN'
    },
    openingHours: ['Mo-Fr 09:00-21:00', 'Sa 09:00-20:00', 'Su 10:00-18:00']
  }
  const stats = db.getFeedbackStats()
  if (stats.count > 0) {
    business.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(stats.average.toFixed(1)),
      reviewCount: stats.count
    }
  }
  return JSON.stringify(business)
}

// landing.html is a single template shared by both routes below — each gets
// its own title/description/keywords/canonical (previously both silently
// used the homepage's, which told crawlers /policies was just a duplicate
// of "/" via its canonical tag). Only "/" gets the FAQPage schema, since
// that's the only route where the FAQ markup is actually the page's content.
// (Policies used to live here too, but each policy is now its own real page
// — see POLICY_META and renderPolicyPage() below.)
const LANDING_ROUTES = {
  '/': {
    title: 'Metalix Print — Upload · Print · Deliver',
    description: 'Upload your PDF, Word, or PPT file, pick your settings, and get it printed and delivered to your door — instantly.',
    keywords: 'print shop, online printing, document printing, Gurugram',
    canonical: 'https://print.metalix.in/',
    includeFaq: true,
    robots: 'index,follow'
  },
  '/orders': {
    title: 'My Orders — Metalix Print',
    description: 'View your Metalix Print order history and status.',
    keywords: '',
    canonical: 'https://print.metalix.in/orders',
    includeFaq: false,
    // Private, per-customer content — never indexed.
    robots: 'noindex,nofollow'
  }
}

// Builds the two GTM install snippets (head script + body noscript) from the
// admin-configured Container ID — server-rendered and synchronous (rather
// than fetched client-side after page load) to match Google's official
// install pattern exactly. GTM's own detection tooling (Tag Assistant) can
// fail to find a container that only appears via a delayed client-side
// fetch-then-inject; a real page load never has that gap. The dataLayer/gtag
// stub + Consent Mode default are always emitted, even with no container
// configured, so the cookie-banner code in analytics.js can always call
// window.gtag() safely regardless of whether GTM itself is set up yet.
function gtmSnippets(settings) {
  const gtmId = (settings.analytics || {}).gtmContainerId || ''
  const adsensePubId = (settings.analytics || {}).adsensePublisherId || ''
  // AdSense's own snippet, not GTM-managed — it has to be present verbatim in
  // <head> on every page for Google's site-ownership crawler to find it,
  // whereas GTM tags/triggers are configured entirely inside the container.
  const adsenseSnippet = adsensePubId
    ? `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${escAttr(adsensePubId)}" crossorigin="anonymous"></script>`
    : ''
  const ahrefsAnalytics = `<script src="https://analytics.ahrefs.com/analytics.js" data-key="1f3z2nF4BVju06mZIUFG3A" async></script>`
  const consentBoot = `<script>
window.dataLayer = window.dataLayer || [];
function gtag(){window.dataLayer.push(arguments);}
window.gtag = gtag;
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});
(function(){try{var c=localStorage.getItem('metalix_cookie_consent');if(c==='granted'||c==='denied'){gtag('consent','update',{ad_storage:c,ad_user_data:c,ad_personalization:c,analytics_storage:c});}}catch(e){}})();
</script>`
  if (!gtmId) return { head: adsenseSnippet + ahrefsAnalytics + consentBoot, noscript: '' }
  const idAttr = escAttr(gtmId)
  const head = adsenseSnippet + ahrefsAnalytics + consentBoot + `
<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${idAttr}');</script>
<!-- End Google Tag Manager -->`
  const noscript = `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${idAttr}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`
  return { head, noscript }
}

// Matches landing.html's client-side fmtPrice() exactly, so the
// server-rendered figure and whatever applyPricing() might patch it to
// later never disagree in format (whole number vs. up to 2 decimals).
function fmtPrice(n) {
  const num = Number(n)
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100)
}

// landing.html's hero/pricing numbers used to be hardcoded fallback text —
// fine at first, but "hardcoded" means they silently go stale the moment an
// admin changes a rate, and every single page load would then visibly flash
// from the stale figure to the live one once landing.html's applyPricing()
// patches it in (deliberately deferred to idle, so it doesn't block first
// paint). Rendering the *current* rate here instead means that flash can
// only happen if pricing changes again before this process next restarts
// (i.e. the next deploy), not on every page load in between.
function pricingPlaceholders() {
  const pricing = db.getPricing()
  const a4 = (Array.isArray(pricing.rates.a4) ? pricing.rates.a4[0] : null) || {}
  const bw = a4.bw || {}
  const color = a4.color || {}
  // Same fallbacks as pricing.js's calculateDeliveryCharge() — an install's
  // DB may predate these fields (added after deliveryCharge/deliveryLocalCharge),
  // and fmtPrice(undefined) would otherwise render "₹NaN".
  return {
    __PRICE_BW_SINGLE__: fmtPrice(bw.single),
    __PRICE_BW_DOUBLE__: fmtPrice(bw.double),
    __PRICE_COLOR_SINGLE__: fmtPrice(color.single),
    __PRICE_DELIVERY_LOCAL__: fmtPrice(pricing.deliveryLocalCharge != null ? pricing.deliveryLocalCharge : 20),
    __PRICE_DELIVERY_GURUGRAM__: fmtPrice(pricing.deliveryGurugramCharge != null ? pricing.deliveryGurugramCharge : 60),
    __PRICE_FREE_DELIVERY_THRESHOLD__: fmtPrice(pricing.freeDeliveryThreshold != null ? pricing.freeDeliveryThreshold : 500)
  }
}

function renderLanding(route) {
  const meta = LANDING_ROUTES[route]
  const settings = db.getSiteSettings()
  const seo = settings.seo || {}
  // Admin-editable title/description/keywords (Settings > SEO metadata) only
  // apply to the public homepage — "/orders" is private/noindex, where
  // site-wide SEO copy would never make sense to substitute in.
  const title = (route === '/' && seo.metaTitle) ? seo.metaTitle : meta.title
  const description = (route === '/' && seo.metaDescription) ? seo.metaDescription : meta.description
  const keywords = (route === '/' && seo.keywords) ? seo.keywords : meta.keywords
  const gscCode = (settings.analytics || {}).searchConsoleVerification || ''
  const gtm = gtmSnippets(settings)
  const template = readPublicTemplate('landing.html')
  let html = template
    .split('__META_TITLE__').join(escAttr(title))
    .split('__META_DESCRIPTION__').join(escAttr(description))
    .split('__META_KEYWORDS__').join(escAttr(keywords))
    .split('__CANONICAL_URL__').join(escAttr(meta.canonical))
    .split('__META_ROBOTS__').join(meta.robots)
    // Search Console verifies via the home page, so this is only meaningful on "/" —
    // harmless (empty) on every other route since the meta tag is simply omitted.
    .split('__GSC_VERIFICATION__').join(gscCode ? `<meta name="google-site-verification" content="${escAttr(gscCode)}">` : '')
    .split('__GTM_HEAD__').join(gtm.head)
    .split('__GTM_NOSCRIPT__').join(gtm.noscript)
    .split('__LOCALBUSINESS_JSON_LD__').join(localBusinessJsonLd())
    .split('__FAQ_JSON_LD_SCRIPT__').join(meta.includeFaq ? `<script type="application/ld+json">${faqJsonLd()}</script>` : '')
  Object.entries(pricingPlaceholders()).forEach(([token, value]) => { html = html.split(token).join(escAttr(value)) })
  return html
}

// Marketing landing page at the root path, served ahead of the SPA catch-all below.
app.get('/', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.send(renderLanding('/'))
})

// Each policy used to be a tab inside one /policies view (all four sharing a
// single canonical URL/title/description) — GSC flagged that page as
// non-actionable since crawlers only ever saw whichever tab was server-
// rendered first. Every policy is now its own real page with a distinct
// title/description/canonical; content still comes from the admin-editable
// legal settings when set, falling back to the copy below otherwise (mirrors
// the old client-side setLegal() override, just applied server-side now).
const POLICY_META = {
  'refund-reprint': {
    label: 'Refund & Reprint',
    title: 'Refund & Reprint Policy — Metalix Print',
    description: 'When you can cancel, when we reprint for free, and how refunds are processed at Metalix Print.',
    legalKey: 'refundPolicy'
  },
  'delivery': {
    label: 'Delivery',
    title: 'Delivery Policy — Metalix Print',
    description: 'Delivery options, turnaround time, delivery area, and what happens if your order is delayed.',
    legalKey: 'shippingPolicy'
  },
  'terms-of-service': {
    label: 'Terms of Service',
    title: 'Terms of Service — Metalix Print',
    description: 'The terms that apply when you use Metalix Print to upload, pay for, and print documents.',
    legalKey: 'termsConditions'
  },
  'privacy': {
    label: 'Privacy',
    title: 'Privacy Policy — Metalix Print',
    description: 'What information Metalix Print collects, how it is used, and how long uploaded files are retained.',
    legalKey: 'privacyPolicy'
  }
}
const POLICY_SLUGS = Object.keys(POLICY_META)

function defaultPolicyBody(slug) {
  switch (slug) {
    case 'refund-reprint':
      return `<div class="callout"><p><strong>TL;DR:</strong> Cancel any time before "Printing started" for a full refund. If we make a mistake, we reprint free. If the issue is with your file, we can offer a paid reprint.</p></div>
      <h2>When can I cancel?</h2>
      <p>You can cancel your order free of charge from <strong>My Orders</strong> on the app as long as the status is <em>Received</em> or <em>Queued</em>. The moment the status changes to <strong>Printing Started</strong>, your job is on the press and can no longer be cancelled.</p>
      <h2>If the mistake is ours</h2>
      <p>We take responsibility for errors that happen on our end — smudged pages, wrong paper size, wrong number of copies, wrong color mode applied after you paid for auto-detect. In these cases:</p>
      <ul>
        <li>We'll <strong>reprint the affected pages free of charge</strong>, or</li>
        <li>Issue a <strong>full or partial refund</strong> to your original payment method within 5–7 business days</li>
      </ul>
      <p>Report the issue within <strong>24 hours</strong> of pickup or delivery by calling or WhatsApp-ing us.</p>
      <h2>If the issue is with your file</h2>
      <p>We print exactly what you upload, without modifying your files. We cannot offer refunds for:</p>
      <ul>
        <li>Low-resolution images that appear blurry once printed</li>
        <li>Typos or content errors in the original document</li>
        <li>Wrong file uploaded by mistake</li>
        <li>Color pages the customer chose to print as B/W (or vice versa)</li>
      </ul>
      <p>We're happy to offer a <strong>paid reprint</strong> once you've updated your file.</p>
      <h2>Refund timeline</h2>
      <p>Approved refunds are processed to your original payment method. Razorpay typically settles refunds within <strong>5–7 business days</strong>.</p>`
    case 'delivery':
      return `<div class="callout"><p><strong>TL;DR:</strong> Pickup is free, home delivery is ₹20 (local PIN 122505) or ₹30 elsewhere. Orders are printed and ready instantly after payment — choose instant delivery (within 2 hrs) or a scheduled slot.</p></div>
      <h2>Delivery options</h2>
      <p>We offer two ways to receive your prints:</p>
      <ul>
        <li><strong>Shop pickup</strong> — Free. Collect from our store at your convenience once we notify you.</li>
        <li><strong>Home delivery</strong> — ₹20 within our local PIN code (122505), ₹30 elsewhere within the city. We dispatch your order as soon as it's printed. At checkout you can also choose instant delivery (within 2 hours) or schedule a delivery slot for later.</li>
      </ul>
      <h2>Turnaround time</h2>
      <p>Most standard orders (under 100 pages) are printed and ready <strong>instantly</strong> after successful payment confirmation. Bulk orders (100+ pages or multiple copies) may take longer — we'll estimate the time at checkout.</p>
      <h2>Delivery area</h2>
      <p>Home delivery is currently available within Gurugram city limits. If your PIN code is outside our zone, we'll contact you to arrange shop pickup and refund the delivery charge.</p>
      <h2>Delays</h2>
      <p>If your order is delayed significantly past the estimate, reach out via WhatsApp with your Order ID. We'll either expedite or waive the delivery fee, depending on the situation.</p>`
    case 'terms-of-service':
      return `<h2>Who can use this service</h2>
      <p>Metalix Print is available to anyone aged 18 and above. By placing an order, you agree to these terms.</p>
      <h2>Your content</h2>
      <p>You confirm that you have the legal right to print and reproduce the content in any file you upload. Metalix Print is not responsible for copyright infringement, defamatory content, or unauthorized reproduction of third-party material.</p>
      <h2>What we will not print</h2>
      <ul>
        <li>Content that infringes copyright without authorization</li>
        <li>Defamatory, obscene, or hateful material</li>
        <li>Content that violates any applicable law</li>
      </ul>
      <h2>Payment</h2>
      <p>All payments are processed securely through Razorpay. Metalix Print does not store your card or banking details. By paying, you agree to Razorpay's terms of service.</p>
      <h2>Limitation of liability</h2>
      <p>Our liability is limited to the amount paid for the specific order in question. We are not liable for indirect losses, loss of business, or consequential damages.</p>`
    case 'privacy':
      return `<div class="callout"><p><strong>Short version:</strong> Your files are used only to print your order and deleted after 3 days. We don't sell your data.</p></div>
      <h2>What we collect</h2>
      <ul>
        <li>Name, mobile number, and optional email — to process and communicate about your order</li>
        <li>Delivery address — only if you choose home delivery</li>
        <li>Uploaded files — solely to fulfil your print job</li>
        <li>Payment transaction data — processed by Razorpay; we only receive a transaction ID</li>
      </ul>
      <h2>How we use it</h2>
      <p>We use your information only to fulfil your order, contact you about it, and improve our service. We do not share your data with third parties except as needed to complete delivery (our delivery partner).</p>
      <h2>File retention</h2>
      <p>Uploaded documents are automatically and permanently deleted from our systems <strong>3 days after your order is completed</strong>.</p>
      <h2>Your rights</h2>
      <p>You can request deletion of your personal data or a copy of what we hold by emailing <a href="mailto:hello@metalix.in" style="color:var(--orange-text);">hello@metalix.in</a>.</p>`
    default:
      return ''
  }
}

function renderPolicyPage(slug) {
  const meta = POLICY_META[slug]
  const settings = db.getSiteSettings()
  const gtm = gtmSnippets(settings)
  const template = readPublicTemplate('policy.html')
  const body = (settings.legal && settings.legal[meta.legalKey]) || defaultPolicyBody(slug)
  const email = settings.email || 'hello@metalix.in'
  const canonical = `https://print.metalix.in/policies/${slug}`
  let html = template
    .split('__GTM_HEAD__').join(gtm.head)
    .split('__GTM_NOSCRIPT__').join(gtm.noscript)
    .split('__META_TITLE__').join(escAttr(meta.title))
    .split('__META_DESCRIPTION__').join(escAttr(meta.description))
    .split('__META_KEYWORDS__').join(escAttr('refund policy, delivery policy, terms of service, privacy policy, Metalix Print'))
    .split('__CANONICAL_URL__').join(escAttr(canonical))
    .split('__PAGE_H1__').join(escAttr(meta.label + ' Policy'))
    .split('__PAGE_META__').join(`Last updated: June 2026 · Questions? <a href="mailto:${escAttr(email)}">${escAttr(email)}</a>`)
    .split('__CONTENT_HTML__').join(`<div class="policy-article">${body}</div>`)
  const TAB_TOKENS = { 'refund-reprint': 'REFUND', 'delivery': 'DELIVERY', 'terms-of-service': 'TERMS', 'privacy': 'PRIVACY' }
  Object.entries(TAB_TOKENS).forEach(([s, token]) => {
    html = html.split(`__TAB_${token}_ACTIVE__`).join(s === slug ? 'active' : '')
  })
  return html
}

app.get('/policies', (req, res) => {
  // Previously the four policies lived as tabs under this one URL — now each
  // has its own page, so this permanently redirects to the first (matching
  // what visitors used to see by default at /policies).
  res.redirect(301, '/policies/refund-reprint')
})

app.get('/policies/:slug', (req, res) => {
  if (!POLICY_META[req.params.slug]) return res.status(404).send('Not found')
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.send(renderPolicyPage(req.params.slug))
})

function renderContactPage() {
  const settings = db.getSiteSettings()
  const gtm = gtmSnippets(settings)
  const template = readPublicTemplate('contact.html')
  const phone = settings.phone || '+91 70424 43143'
  const whatsapp = 'https://wa.me/' + (settings.whatsapp || phone).replace(/[^0-9]/g, '')
  const email = settings.email || 'hello@metalix.in'
  const address = settings.pickupAddress || settings.headOfficeAddress || ''
  const t = settings.storeTimings || {}
  return template
    .split('__GTM_HEAD__').join(gtm.head)
    .split('__GTM_NOSCRIPT__').join(gtm.noscript)
    .split('__LOCALBUSINESS_JSON_LD__').join(localBusinessJsonLd())
    .split('__CONTACT_ADDRESS__').join(escAttr(address))
    .split('__CONTACT_PHONE_HREF__').join(escAttr(phone.replace(/[^0-9+]/g, '')))
    .split('__CONTACT_PHONE__').join(escAttr(phone))
    .split('__CONTACT_WHATSAPP_HREF__').join(escAttr(whatsapp))
    .split('__CONTACT_EMAIL__').join(escAttr(email))
    .split('__HOURS_WEEKDAYS__').join(escAttr(t.weekdays || ''))
    .split('__HOURS_SATURDAY__').join(escAttr(t.saturday || ''))
    .split('__HOURS_SUNDAY__').join(escAttr(t.sunday || ''))
}

app.get('/contact', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.send(renderContactPage())
})

// Same pattern as /policies: "My Orders" is a view inside the landing page
// (#page-orders, showPage('orders')) — this just gives it a real, bookmarkable,
// noindex URL. landing.html's initFromUrl() opens the view on load.
app.get('/orders', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.send(renderLanding('/orders'))
})

// Blog list + article pages — the SPA-style views inside landing.html handle
// their own routing, but the blog is plain server-rendered HTML + client JS
// (like track.html) since each post needs its own crawlable, shareable URL.
// Mirrors blog.html's client-side readingTime()/renderGrid() exactly, so the
// server-rendered card markup (for crawlers and before client JS runs) never
// visibly differs from what the client re-renders for search/category filtering.
function blogReadingTime(excerpt) {
  const words = String(excerpt || '').split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 40)) + ' min read'
}
function renderBlogPostsSsr(posts) {
  if (!posts.length) return '<div class="empty-state">No posts found.</div>'
  return posts.map((p) => {
    const dateStr = p.published_at
      ? new Date(p.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      : ''
    return '<a class="post-card" href="/blog/' + encodeURIComponent(p.slug) + '">' +
      '<div class="post-cover"><img src="' + escAttr(p.cover_image || '/images/blog-placeholder.png') + '" alt="' + escAttr(p.title) + '" loading="lazy"></div>' +
      '<div class="post-body">' +
        (p.category ? '<span class="post-cat">' + escAttr(p.category) + '</span>' : '') +
        '<span class="post-title">' + escAttr(p.title) + '</span>' +
        '<span class="post-excerpt">' + escAttr(p.excerpt || '') + '</span>' +
        '<span class="post-meta">' + escAttr(p.author || 'Metalix Team') + ' · ' + dateStr + ' · ' + blogReadingTime(p.excerpt) + '</span>' +
      '</div>' +
    '</a>'
  }).join('')
}

app.get('/blog', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  const gtm = gtmSnippets(db.getSiteSettings())
  const posts = db.listBlogPosts({ includeUnpublished: false })
  const template = readPublicTemplate('blog.html')
  res.send(template
    .split('__GTM_HEAD__').join(gtm.head)
    .split('__GTM_NOSCRIPT__').join(gtm.noscript)
    .split('__BLOG_POSTS_SSR__').join(renderBlogPostsSsr(posts)))
})

// Attribute-safe (not full HTML-safe) — only used inside "..." attribute
// values and <title>/<meta content> text nodes in the template below.
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Server-renders the SEO-critical <head> tags (title, description, OG,
// canonical, JSON-LD) *and* the full article body into the static template
// before sending it, so crawlers see real content and a real <h1> with no JS
// execution required — a crawler that doesn't render JS (Ahrefs by default)
// previously saw an empty article and flagged "H1 missing"/"low word count"
// on every post. blog-post.html's inline <script> now only wires up the
// copy-link button; it no longer fetches or injects the content itself.
function articleReadingTime(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length
  return Math.max(1, Math.round(words / 200)) + ' min read'
}
function postInitials(name) {
  return String(name || 'M').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
}
function shareUrl(kind, url, title) {
  const u = encodeURIComponent(url), t = encodeURIComponent(title)
  if (kind === 'x') return 'https://twitter.com/intent/tweet?url=' + u + '&text=' + t
  if (kind === 'facebook') return 'https://www.facebook.com/sharer/sharer.php?u=' + u
  if (kind === 'linkedin') return 'https://www.linkedin.com/sharing/share-offsite/?url=' + u
  if (kind === 'whatsapp') return 'https://wa.me/?text=' + t + '%20' + u
  return '#'
}
function shareRowHtml(url, title, idSuffix) {
  return '<div class="share-row"><span class="lbl">Share:</span>' +
    '<a class="share-btn" href="' + shareUrl('x', url, title) + '" target="_blank" rel="noopener" title="Share on X">𝕏</a>' +
    '<a class="share-btn" href="' + shareUrl('facebook', url, title) + '" target="_blank" rel="noopener" title="Share on Facebook">f</a>' +
    '<a class="share-btn" href="' + shareUrl('linkedin', url, title) + '" target="_blank" rel="noopener" title="Share on LinkedIn">in</a>' +
    '<a class="share-btn" href="' + shareUrl('whatsapp', url, title) + '" target="_blank" rel="noopener" title="Share on WhatsApp">💬</a>' +
    '<a class="share-btn" href="mailto:?subject=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(url) + '" title="Share by email">✉️</a>' +
    '<button class="share-btn copy-link-btn" type="button" title="Copy link">🔗</button>' +
  '</div>'
}
// Every published post used to be linked from exactly one place — its card
// on /blog — which Ahrefs flagged as "only one dofollow incoming internal
// link" on both posts. Cross-linking a few other posts from the bottom of
// each article gives every post at least one more inbound internal link.
function renderRelatedPostsSsr(otherPosts) {
  if (!otherPosts.length) return ''
  return '<div class="related-posts"><h3>More from the blog</h3><div class="related-grid">' +
    otherPosts.map((p) => '<a class="related-card" href="/blog/' + encodeURIComponent(p.slug) + '">' + escAttr(p.title) + '</a>').join('') +
    '</div></div>'
}
function renderBlogPostContentSsr(post, articleHtml, canonicalUrl, otherPosts) {
  const dateStr = post.published_at
    ? new Date(post.published_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
  return (post.category ? '<span class="post-cat">' + escAttr(post.category) + '</span>' : '') +
    '<h1>' + escAttr(post.title) + '</h1>' +
    '<div class="post-meta">' +
      '<span>' + escAttr(post.author || 'Metalix Team') + '</span><span class="dot"></span>' +
      '<span>' + dateStr + '</span><span class="dot"></span>' +
      '<span>' + articleReadingTime(articleHtml.replace(/<[^>]+>/g, ' ')) + '</span>' +
    '</div>' +
    shareRowHtml(canonicalUrl, post.title, 'top') +
    '<img class="cover-img" src="' + escAttr(post.cover_image || '/images/blog-placeholder.png') + '" alt="' + escAttr(post.title) + '">' +
    '<div class="article">' + articleHtml + '</div>' +
    (post.tags && post.tags.length ? ('<div class="tags-row">' + post.tags.map((t) => '<span class="tag-chip">#' + escAttr(t) + '</span>').join('') + '</div>') : '') +
    (post.author_bio ? (
      '<div class="author-box"><div class="av">' + escAttr(postInitials(post.author)) + '</div>' +
      '<div><div class="name">' + escAttr(post.author || 'Metalix Team') + '</div><div class="bio">' + escAttr(post.author_bio) + '</div></div></div>'
    ) : '') +
    shareRowHtml(canonicalUrl, post.title, 'bottom') +
    renderRelatedPostsSsr(otherPosts) +
    '<div class="cta-card"><h3>Ready to print your documents?</h3><p>Upload a file, pick your settings, and get it delivered — instantly.</p><a href="/order">Start your order →</a></div>'
}

app.get('/blog/:slug', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  const post = db.getBlogPostBySlug(req.params.slug)
  const template = readPublicTemplate('blog-post.html')
  const canonical = `https://print.metalix.in/blog/${req.params.slug}`
  const gtm = gtmSnippets(db.getSiteSettings())

  if (!post || !post.published) {
    const html = template
      .split('__META_TITLE__').join(escAttr('Post not found — Metalix Print Blog'))
      .split('__META_DESCRIPTION__').join(escAttr('This blog post could not be found.'))
      .split('__META_KEYWORDS__').join('')
      .split('__CANONICAL_URL__').join(escAttr(canonical))
      .split('__OG_IMAGE__').join('https://print.metalix.in/images/logo.svg')
      .split('__JSON_LD__').join('null')
      .split('__GTM_HEAD__').join(gtm.head)
      .split('__GTM_NOSCRIPT__').join(gtm.noscript)
      .split('__POST_CONTENT_SSR__').join('<div class="not-found">We couldn\'t find that post. <a href="/blog">Back to blog</a></div>')
    return res.status(404).send(html)
  }

  const title = post.meta_title || post.title
  const description = post.meta_description || post.excerpt || ''
  const image = post.cover_image
    ? (post.cover_image.startsWith('http') ? post.cover_image : `https://print.metalix.in${post.cover_image}`)
    : 'https://print.metalix.in/images/logo.svg'
  const jsonLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description,
    image,
    author: { '@type': 'Person', name: post.author || 'Metalix Team' },
    datePublished: post.published_at ? new Date(post.published_at).toISOString() : undefined,
    dateModified: post.updated_at ? new Date(post.updated_at).toISOString() : undefined,
    mainEntityOfPage: canonical
  })
  const articleHtml = marked.parse(post.body || '')
  const otherPosts = db.listBlogPosts({ includeUnpublished: false }).filter((p) => p.slug !== post.slug).slice(0, 3)
  const postContent = renderBlogPostContentSsr(post, articleHtml, canonical, otherPosts)

  const html = template
    .split('__META_TITLE__').join(escAttr(title))
    .split('__META_DESCRIPTION__').join(escAttr(description))
    .split('__META_KEYWORDS__').join(escAttr(post.meta_keywords || (post.tags || []).join(', ')))
    .split('__CANONICAL_URL__').join(escAttr(canonical))
    .split('__OG_IMAGE__').join(escAttr(image))
    .split('__JSON_LD__').join(jsonLd)
    .split('__GTM_HEAD__').join(gtm.head)
    .split('__GTM_NOSCRIPT__').join(gtm.noscript)
    .split('__POST_CONTENT_SSR__').join(postContent)
  res.send(html)
})

// SEO: robots.txt (references the sitemap) and the sitemap itself. The
// sitemap is generated on request (not a static file) so published blog
// posts appear/disappear automatically as they're published/unpublished.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'robots.txt'))
})
app.get('/sitemap.xml', (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  const staticUrls = [
    { loc: 'https://print.metalix.in/', freq: 'weekly', priority: '1.0', lastmod: today },
    { loc: 'https://print.metalix.in/order', freq: 'weekly', priority: '0.9', lastmod: today },
    { loc: 'https://print.metalix.in/blog', freq: 'weekly', priority: '0.7', lastmod: today },
    { loc: 'https://print.metalix.in/contact', freq: 'monthly', priority: '0.5', lastmod: today },
    ...POLICY_SLUGS.map((slug) => ({ loc: `https://print.metalix.in/policies/${slug}`, freq: 'monthly', priority: '0.3', lastmod: today }))
  ]
  // /orders and /order-success/:id are private, per-customer pages (noindex'd
  // and disallowed in robots.txt) — deliberately excluded from the sitemap.
  const postUrls = db.listBlogPosts({ includeUnpublished: false }).map((p) => ({
    loc: `https://print.metalix.in/blog/${p.slug}`, freq: 'monthly', priority: '0.6',
    lastmod: new Date(p.updated_at || p.published_at || Date.now()).toISOString().slice(0, 10)
  }))
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    staticUrls.concat(postUrls).map((u) =>
      `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    ).join('\n') +
    '\n</urlset>'
  res.type('application/xml').send(xml)
})

// llms.txt — a machine-readable site summary for AI agents (llmstxt.org). Checked
// by Lighthouse's Agentic Browsing category; must expose an H1, a summary, and links.
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'llms.txt'))
})

// Google Search Console domain ownership verification (HTML file method).
app.get('/googlecfc92098877ba2b1.html', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'googlecfc92098877ba2b1.html'))
})

// IndexNow key file (Bing/Yandex instant-crawl protocol) — the key at this
// URL must match the key submitted to the IndexNow API so engines can verify
// we control the domain before honoring a submission.
app.get('/9bfdfd32292e7b33e7925368594d989d.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, '9bfdfd32292e7b33e7925368594d989d.txt'))
})

// Password-protected admin dashboard (orders, customers, pricing).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'))
})

// Printable job sheet — admin-only, fetched client-side via the admin token,
// never billed to the customer (separate from order pricing/page counts).
app.get('/jobsheet.html', (req, res) => {
  res.sendFile(path.join(publicDir, 'jobsheet.html'))
})

// Stationery catalog (browse + add to cart) and the cart itself — both
// static templates, product/cart data fetched client-side (see
// stationery.html / cart.html), same GTM-substitution pattern as every
// other public page here.
app.get('/stationery', (req, res) => {
  if (!stationeryEnabled()) return res.status(404).sendFile(path.join(publicDir, 'not-found.html'))
  const gtm = gtmSnippets(db.getSiteSettings())
  const template = readPublicTemplate('stationery.html')
  res.send(template.split('__GTM_HEAD__').join(gtm.head).split('__GTM_NOSCRIPT__').join(gtm.noscript))
})
app.get('/cart', (req, res) => {
  if (!anyVerticalEnabled()) return res.status(404).sendFile(path.join(publicDir, 'not-found.html'))
  const gtm = gtmSnippets(db.getSiteSettings())
  const template = readPublicTemplate('cart.html')
  res.send(template.split('__GTM_HEAD__').join(gtm.head).split('__GTM_NOSCRIPT__').join(gtm.noscript))
})
app.get('/stamps', (req, res) => {
  if (!stampsEnabled()) return res.status(404).sendFile(path.join(publicDir, 'not-found.html'))
  const gtm = gtmSnippets(db.getSiteSettings())
  const template = readPublicTemplate('stamps.html')
  res.send(template.split('__GTM_HEAD__').join(gtm.head).split('__GTM_NOSCRIPT__').join(gtm.noscript))
})

// Public scan-to-track page linked from the job sheet's QR code.
app.get('/track/:id', (req, res) => {
  const gtm = gtmSnippets(db.getSiteSettings())
  const template = readPublicTemplate('track.html')
  res.send(template.split('__GTM_HEAD__').join(gtm.head).split('__GTM_NOSCRIPT__').join(gtm.noscript))
})

// Dedicated post-checkout confirmation page (stable URL, single order fetched
// client-side via the existing public GET /api/orders/:id) — gives GA4 a real
// page load to fire the 'purchase' conversion event from.
app.get('/order-success/:id', (req, res) => {
  const gtm = gtmSnippets(db.getSiteSettings())
  const template = readPublicTemplate('order-success.html')
  res.send(template.split('__GTM_HEAD__').join(gtm.head).split('__GTM_NOSCRIPT__').join(gtm.noscript))
})

// If a production client build exists, serve it (single-process deploy)
const clientDist = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(clientDist)) {
  // Vite fingerprints built assets (…-[hash].js/.css), so they can be cached
  // long-term. index.html is returned by the catch-all below without maxAge,
  // so new deploys are always picked up immediately.
  app.use(express.static(clientDist, {
    maxAge: '30d',
    setHeaders: (res, filePath) => {
      // Never long-cache HTML — it's the entry point that references the
      // hashed assets, so it must be revalidated to pick up new deploys.
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache')
    },
  }))
  let clientIndexHtml = null
  // Scoped to the exact /order path (query strings like ?coupon=X still match —
  // Express ignores the query string when matching). This used to be a
  // catch-all '*', which meant literally any unmatched URL — a typo'd link, a
  // stray external URL missing its https:// prefix and resolved as a relative
  // path, anything — served this same page with a 200 status instead of a
  // real 404. That's a soft-404: search engines index every broken link on
  // the internet pointing here as if it were real content. See the dedicated
  // 404 handler below for what unmatched paths get instead.
  app.get('/order', (req, res) => {
    if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
    const gtm = gtmSnippets(db.getSiteSettings())
    // Same reasoning as readPublicTemplate() above: this only changes on
    // deploy (which restarts the process), so read it from disk once.
    if (!clientIndexHtml) clientIndexHtml = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8')
    const template = clientIndexHtml
    res.set('Cache-Control', 'no-cache')
    res.send(template.split('__GTM_HEAD__').join(gtm.head).split('__GTM_NOSCRIPT__').join(gtm.noscript))
  })
}

// Final fallback for any path that matched no route above — a real 404, not
// the soft-404 the old catch-all produced (see comment above /order).
app.use((req, res) => {
  res.status(404).sendFile(path.join(publicDir, 'not-found.html'))
})

// Seed the DB-backed admin credential once, from env, if it doesn't exist yet.
// After this the login id / password are managed entirely from the web (change
// or reset), so ADMIN_PASSWORD in .env only matters for the very first boot.
// Ensures at least one super_admin row exists in admin_users. On an install
// that already had the legacy single-admin credential (settings.admin_auth),
// migrates it in as-is (same password hash, so the existing login keeps
// working). On a genuinely fresh install, seeds from env like before.
async function seedAdminAuth() {
  if (db.countAdminUsers() > 0) return
  const legacy = db.getAdminAuth()
  if (legacy) {
    db.createAdminUser({ id: crypto.randomUUID(), username: legacy.username, password_hash: legacy.password_hash, role: 'super_admin', location_id: null })
    console.log(`[admin] migrated legacy admin credential into admin_users (login id: ${legacy.username})`)
    return
  }
  const username = process.env.ADMIN_USERNAME || 'support@metalix.in'
  const password = process.env.ADMIN_PASSWORD || 'metalix-admin'
  const password_hash = await bcrypt.hash(password, 10)
  db.createAdminUser({ id: crypto.randomUUID(), username, password_hash, role: 'super_admin', location_id: null })
  console.log(`[admin] seeded initial super admin credential (login id: ${username})`)
}

const { loadSecretsIntoEnv } = require('./secrets')
const PORT = process.env.PORT || 5050
loadSecretsIntoEnv().then(async () => {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_JWT_SECRET) {
    console.warn('Warning: ADMIN_PASSWORD/ADMIN_JWT_SECRET not set, using insecure development defaults.')
  }
  await seedAdminAuth()
  app.listen(PORT, () => console.log(`Running on ${PORT}`))
  cleanupExpiredFiles()
  setInterval(cleanupExpiredFiles, 60 * 60 * 1000)
  cleanupOrphanedUploads()
  setInterval(cleanupOrphanedUploads, 6 * 60 * 60 * 1000)
  purgeExpiredArchive()
  setInterval(purgeExpiredArchive, 6 * 60 * 60 * 1000)
  backupDatabase()
  setInterval(backupDatabase, 6 * 60 * 60 * 1000)
})
