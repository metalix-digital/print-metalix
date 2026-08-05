const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const app = express()

// Payment webhook — registered before the global express.json() below on
// purpose. It needs the raw request body to verify the signature; once
// express.json() has parsed a request (it matches on Content-Type:
// application/json, which every webhook delivery sends), a later
// express.raw() on this same route becomes a silent no-op and req.body is
// already a parsed object, not a Buffer — crypto.createHmac(...).update()
// then throws on it. (This is exactly what was silently breaking every
// webhook delivery before this route was moved here — see git history.)
//
// For regular checkout, this is the backup confirmation path (client-driven
// verify-payment is primary). For payment links there is no reliable
// client-driven path at all (no signed redirect Cashfree gives us to trust —
// see the /api/payment-links/callback comment below), so this webhook is the
// *sole* authoritative confirmation for those — getting the Cashfree
// Dashboard webhook subscription right (PAYMENT_SUCCESS_WEBHOOK and
// PAYMENT_LINK_EVENT) matters more here than it did for Razorpay.
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const timestamp = req.headers['x-webhook-timestamp']
  const signature = req.headers['x-webhook-signature']
  if (!cashfree.verifyWebhookSignature(req.body, timestamp, signature)) {
    return res.status(400).json({ error: 'invalid_signature' })
  }
  try {
    const event = JSON.parse(req.body.toString())
    console.log('Cashfree webhook event:', event.type)

    function confirmPaid(order, cashfreePaymentId) {
      const paidOrder = db.markOrderPaid(order.id, {
        cashfree_payment_id: cashfreePaymentId || null,
        order_status: 'Payment Successful'
      })
      if (paidOrder) {
        printQueue.enqueue(order.id)
        const fresh = db.getOrder(order.id)
        notify.sendOrderConfirmationSms(fresh)
        notify.sendOrderConfirmationEmail(fresh)
        mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
      }
    }

    if (event.type === 'PAYMENT_SUCCESS_WEBHOOK') {
      // Cashfree's order_id is our own order id by construction (we choose
      // it at creation time) — no indirect lookup column needed.
      const orderId = event.data && event.data.order && event.data.order.order_id
      const paymentStatus = event.data && event.data.payment && event.data.payment.payment_status
      const order = orderId && db.getOrder(orderId)
      if (order && paymentStatus === 'SUCCESS') {
        confirmPaid(order, event.data.payment.cf_payment_id)
      }
    } else if (event.type === 'PAYMENT_LINK_EVENT') {
      const linkId = event.data && event.data.link_id
      const linkStatus = event.data && event.data.link_status
      const order = linkId && db.getOrder(linkId)
      if (order && linkStatus === 'PAID') {
        const txnId = (event.data.order && event.data.order.transaction_id) || event.data.cf_link_id
        confirmPaid(order, txnId)
      }
    }
    // PAYMENT_FAILED_WEBHOOK / PAYMENT_USER_DROPPED_WEBHOOK / anything else:
    // no action needed, just acknowledge so Cashfree doesn't retry/disable
    // the webhook over an event type we deliberately don't act on.
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
const cashfree = require('./cashfree')
const pricing = require('./pricing')
const { analyzePdfBuffer } = require('./pdfAnalyze')
const { convertToPdf } = require('./docConvert')
const { cleanupExpiredFiles, deleteFilesForOrder, purgeExpiredArchive, cleanupOrphanedUploads } = require('./fileRetention')
const { buildInvoicePdf } = require('./invoice')
const { formatRupees } = require('./format')
const { computeGridLayout: computePassportGridLayout } = require('./passportLayout')

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

// Generates a Cashfree Payment Link for an order's current total, so an
// admin-placed order can be paid online remotely instead of in person.
// Cancels any link already on the order first — otherwise editing the order
// (which reprices it) would leave a stale link out there payable at the old
// amount. Cashfree's own SMS/email notification is turned off since we send
// our own DLT-compliant SMS (see sms.js) rather than Cashfree's generic one.
async function createPaymentLinkForOrder(order) {
  if (order.payment_link_id) {
    await cashfree.cancelPaymentLink(order.payment_link_id)
  }
  const link = await cashfree.createPaymentLink({
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
  res.json({ code: featured.code, type: featured.type, value: featured.value })
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

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, mobile: user.mobile }
}

app.post('/api/auth/signup', express.json(), async (req, res) => {
  const { name, email, mobile, password } = req.body || {}
  if (!name || !email || !mobile || !password) {
    return res.status(400).json({ error: 'missing_fields', message: 'Name, email, mobile, and password are all required.' })
  }
  if (db.findUserByIdentifier(email) || db.findUserByIdentifier(mobile)) {
    return res.status(409).json({ error: 'already_exists', message: 'An account with this email or mobile already exists.' })
  }
  const password_hash = await bcrypt.hash(password, 10)
  const user = db.createUser({ id: crypto.randomUUID(), name, email, mobile, password_hash })
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

    for (const { f, safeFileId, pdfBuffer, convertError, skip, isPassport, imageBuffer } of converted) {
      if (isPassport) {
        // Helvetica (WinAnsi) can't render ₹ — same "Rs." convention as invoice.js.
        const label = `Passport Photo Pack — ${f.paperLabel || f.sizePresetId || 'Passport Photo'} · ${f.colorLabel || ((f.packQty || 0) + '-pack')} · Rs. ${formatRupees(f.amount || 0)}`
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
        lines.forEach((line, i) => page.drawText(line, { x: 50, y: A4_PT.height - 80 - i * 22, size: 12, font, color: rgb(0.1, 0.13, 0.2) }))
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
        lines.forEach((line, i) => page.drawText(line, { x: 50, y: A4_PT.height - 80 - i * 22, size: 12, font, color: rgb(0.1, 0.13, 0.2) }))
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
    location_id, notes,
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

  // Discount is excluded from the gate above, but a gateway (Cashfree)
  // payment is its own, narrower exception to *that* exception: once
  // payment_method is 'online' and payment_status is 'paid', the amount is
  // already captured and settled through the gateway — changing
  // discount_amount here would just make total_amount disagree with what
  // Cashfree actually charged, with no corresponding refund to reconcile it.
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
    const overridesById = new Map((files || []).map((f) => [f.fileId, f]))

    // Branch per-item on productType — an order can mix Documents, Passport
    // Photos, and Additional Services, and each has completely disjoint
    // editable fields. A passport-photo or service entry must NEVER fall
    // through to the document branch below: neither has pageSize/paperType,
    // so it would otherwise silently get rewritten to pageSize:'a4'/
    // paperType:'normal' and reprice as a near-zero document. Services are
    // add-only here (see POST .../add-service) — this general edit flow just
    // passes an existing one through unchanged, same as it can't touch a
    // passport pack's size/qty either.
    const mergedFiles = currentFiles.map((f) => {
      if (f.productType === 'service') return f
      if ((f.productType || 'document') === 'passport-photo') {
        // Matched by fileId, same convention as the document branch below —
        // note this can't disambiguate between multiple photo-less (fileId:
        // null) items in one order, but no admin UI in this phase edits
        // passport items after order creation, so it's not yet reachable.
        const o = overridesById.get(f.fileId) || {}
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
      const o = overridesById.get(f.fileId) || {}
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
    emailStatusChange(updated, `${req.protocol}://${req.get('host')}`)
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
    if (u.customer_email && willEmailOnStatus(u.order_status)) {
      emailed++
      emailStatusChange(u, base)
    }
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
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount
  })
  return res.json({ order: updated })
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
// COD only: a gateway (Cashfree) payment is genuinely captured money with
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

// Generates (or regenerates) a Cashfree Payment Link for an already-placed
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

// Manual escape hatch: payment links have no client-driven confirmation path
// (see /api/webhook's PAYMENT_LINK_EVENT handler) — if a webhook is ever
// delayed or lost for any reason, this lets staff directly ask Cashfree
// whether an order has actually been paid, without waiting on webhook
// delivery or Cashfree support.
app.post('/api/admin/orders/:id/recheck-payment', requireAdmin, requireTab('orders'), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })
  if (String(order.payment_status).toLowerCase() === 'paid') {
    return res.json({ order, alreadyPaid: true })
  }
  let status
  try {
    status = await cashfree.getOrderStatus(order.id)
  } catch (err) {
    return res.status(502).json({ error: err.code || 'status_check_failed', message: err.message })
  }
  if (status.order_status !== 'PAID') {
    return res.json({ order, alreadyPaid: false, cashfreeStatus: status.order_status })
  }
  const paidOrder = db.markOrderPaid(order.id, { cashfree_payment_id: status.cf_payment_id, order_status: 'Payment Successful' })
  if (paidOrder) {
    printQueue.enqueue(order.id)
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
app.get('/api/admin/analytics/sales', requireSuperAdmin, (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30))
  return res.json(db.getSalesAnalytics(days))
})

app.get('/api/admin/orders/:id/files/:fileId/download', requireAdmin, requireTab('orders'), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!ownsOrder(req, order)) return res.status(404).json({ error: 'not_found' })

  const safeFileId = path.basename(req.params.fileId)
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  let fileName = null
  if (files.some((f) => f.fileId === safeFileId)) {
    fileName = files.find((f) => f.fileId === safeFileId).fileName
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
// computes the authoritative price server-side, and creates a Cashfree order
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
  const { colorPages, bwPages } = pricing.resolveFileColorPages({ pageCount: f.pageCount, colorCount: f.colorPageCount }, f.printMode)
  return { colorPages, bwPages, copies: f.copies, printSide: f.printSide, pageSize: f.pageSize, paperType: f.paperType }
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
  // An order can mix Documents, Passport Photos, and Additional Services, so
  // branching happens per-item (on each file's own productType) rather than
  // for the whole order.
  for (const f of files) {
    const productType = f.productType === 'passport-photo' ? 'passport-photo' : (f.productType === 'service' ? 'service' : 'document')

    if (productType === 'service') {
      if (!serviceIds.includes(f.serviceId)) {
        return { error: 'missing_service', message: 'Select an additional service for every service line.' }
      }
      const service = serviceCatalog.find((s) => s.id === f.serviceId)
      const quantity = Math.max(1, Math.min(999, Math.round(Number(f.quantity)) || 1))
      const fileData = {
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
  let cashfreeOrder = null
  let simulated = true

  // Pay-on-delivery (Cash/UPI) skips the online gateway entirely — the order is
  // confirmed now and payment is collected by staff at delivery/pickup.
  if (!isCod) {
    try {
      cashfreeOrder = await cashfree.createOrder({
        orderId,
        amount: calc.totalAmount,
        customerName,
        customerPhone: customerMobile,
        customerEmail,
        returnUrl: `https://print.metalix.in/order-success/${orderId}`
      })
      simulated = !!cashfreeOrder.simulated
    } catch (err) {
      console.error('Cashfree order creation failed', err)
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
    delivery_charge: calc.deliveryCharge,
    handling_charge: calc.handlingCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount,
    discount_type: discountResolved.discount ? discountResolved.discount.type : null,
    discount_value: discountResolved.discount ? discountResolved.discount.value : 0,
    discount_amount: calc.discountAmount,
    discount_code: discountResolved.code,
    discount_reason: discountResolved.reason,
    // Simulated orders have no real cf_order_id — store the SIM_ marker here
    // instead so verify-payment can trust *this* (server-written) column to
    // tell a simulated order from a real one, never anything the client claims.
    cashfree_order_id: isCod ? null : (cashfreeOrder.simulated ? `SIM_${orderId}` : cashfreeOrder.cf_order_id),
    payment_status: isCod ? 'pending' : 'created',
    order_status: 'Received',
    notes: safeNotes,
    created_at: Date.now()
  })

  // COD orders are confirmed immediately: queue them for printing and notify,
  // just like a paid online order does after verify-payment.
  if (isCod) {
    printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
    const fresh = db.getOrder(order.id)
    notify.sendOrderConfirmationSms(fresh)
    notify.sendOrderConfirmationEmail(fresh)
    mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
    return res.json({ order: fresh, cod: true })
  }

  return res.json({
    order,
    cashfreeOrder: { payment_session_id: cashfreeOrder.payment_session_id, order_id: cashfreeOrder.order_id },
    cashfreeMode: process.env.CASHFREE_ENV === 'production' ? 'production' : 'sandbox',
    simulated
  })
})

// Lets staff place an order for a customer who doesn't want to use the
// website themselves (walk-in / phone order). Mirrors the validation and
// pricing above, but never takes the online-Cashfree path — an admin-placed
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

// Public tracking lookup behind the job sheet's QR code — deliberately never
// returns customer name, contact, or files, since order IDs aren't secret
// enough to gate anything sensitive behind. Order-level context (status,
// payment, pricing, progress) is fine to expose — it's what a package
// tracking page normally shows.
const READY_BY_WINDOW_MS = 4 * 60 * 60 * 1000
// A "confirmed" order is paid online, pay-on-delivery, or a genuine Payment
// Link order — the payment_link_id check is this function's one addition
// over the base definition used everywhere else (db.listOrders/listMyOrders/
// listCustomers). Cashfree's Payment Link returnUrl sends the customer's
// browser straight to /track/:id the instant they finish paying, but
// confirmation itself is entirely webhook-driven (see /api/webhook's
// PAYMENT_LINK_EVENT handler) and can lag a few seconds behind that
// redirect. Without this, that redirect 404s on a real, already-placed
// order for however long the webhook takes to land. Safe to allow pre-
// confirmation here specifically because a Payment Link order only exists
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
    total_amount: order.total_amount
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

// Confirms payment for the regular checkout flow. Unlike the old Razorpay
// integration, there's no client-supplied signature to check — Cashfree's
// client SDK gives the browser no cryptographically verifiable proof of its
// own payment, so nothing the client reports is trusted. Instead the server
// asks Cashfree directly, using its own credentials, for the authoritative
// status. This does mean a real outbound network call on every confirm,
// where the old HMAC check was instant and local — client-side should show
// a brief "Confirming payment…" state across this call.
app.post('/api/orders/:id/verify-payment', express.json(), async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  if (order.payment_status === 'paid') {
    return res.json({ order })
  }

  // Trust that an order is actually a simulated (no-Cashfree-configured) one
  // from its own stored cashfree_order_id, never from anything the client
  // sends — otherwise anyone who knows an order ID could mark any real order
  // "paid" for free.
  const isActuallySimulated = typeof order.cashfree_order_id === 'string' && order.cashfree_order_id.startsWith('SIM_')
  let status
  try {
    status = isActuallySimulated ? { order_status: 'PAID', cf_payment_id: `SIM_PAY_${order.id}` } : await cashfree.getOrderStatus(order.id)
  } catch (err) {
    console.error(`Cashfree status check failed for ${order.id}:`, err.message)
    return res.status(502).json({ error: 'status_check_failed' })
  }

  if (status.order_status !== 'PAID') {
    db.updateOrder(order.id, { payment_status: 'failed', order_status: 'Failed', failure_reason: status.order_status })
    return res.status(400).json({ error: 'payment_not_completed', status: status.order_status })
  }

  const paidOrder = db.markOrderPaid(order.id, { cashfree_payment_id: status.cf_payment_id })
  if (!paidOrder) return res.json({ order: db.getOrder(order.id) }) // lost the race — already confirmed elsewhere
  printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
  const fresh = db.getOrder(order.id)
  notify.sendOrderConfirmationSms(fresh)
  notify.sendOrderConfirmationEmail(fresh)
  mailer.sendNewOrderAlertEmail(fresh).catch((err) => console.error(`[mailer] new order alert failed for ${fresh.id}:`, err.message))
  return res.json({ order: fresh })
})

// Cashfree may redirect the customer's browser here after they pay (or
// cancel) a Payment Link. Deliberately a pure UX convenience redirect with
// zero trust placed in it — Cashfree gives no verifiable signature on a
// Payment Link redirect, and the redirect itself is unreliable on mobile
// (many UPI payments never return to the browser at all). Building
// verification around an unauthenticated redirect would be strictly worse
// than doing nothing, since it'd just be trusting the query string. Actual
// confirmation happens only via the /api/webhook PAYMENT_LINK_EVENT handler.
// Query param name for the order id isn't 100% pinned down — Cashfree's
// convention elsewhere is `order_id`, but verify against live Payment Links
// behavior and adjust if it differs.
app.get('/api/payment-links/callback', (req, res) => {
  const orderId = req.query.order_id || req.query.link_id || req.query.reference_id || ''
  return res.redirect(`/track/${encodeURIComponent(orderId)}`)
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

// Kept in sync by hand with the <details class="faq-item"> markup in
// landing.html's #faq section — the JSON-LD must describe content that's
// actually visible on the page, not just claims made in structured data.
const FAQ_ITEMS = [
  { q: 'How long does printing and delivery take?', a: 'Most standard orders under 100 pages are ready within 3–4 hours of successful payment. Bulk orders — 100+ pages or many copies — may take longer, and we’ll give you a realistic estimate at checkout.' },
  { q: 'Which file formats can I upload?', a: 'PDF, Word (.doc/.docx), PowerPoint (.ppt/.pptx), and photos (JPG/PNG). We convert and calculate your page count automatically, so there’s no need to export to PDF yourself first.' },
  { q: 'Do you deliver, or is it pickup only?', a: 'Both. Shop pickup is free. Home delivery is ₹__PRICE_DELIVERY_LOCAL__ within our local PIN code (122505), ₹__PRICE_DELIVERY_GURUGRAM__ elsewhere in Gurugram, and priced by distance if you’re outside Gurugram. Delivery is free on orders over ₹__PRICE_FREE_DELIVERY_THRESHOLD__. You can also choose instant delivery (within 2 hours) or schedule a delivery slot for later.' },
  { q: 'What’s the difference between color and black & white pricing?', a: 'Color pages cost more per page than black & white. You can print a file entirely in black & white, entirely in color, or use auto-detect so only the pages that actually contain color are billed at the color rate.' },
  { q: 'How do I pay, and is it secure?', a: 'All payments are processed securely through Cashfree before your order enters the print queue. Metalix Print never stores your card or banking details.' },
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
    description: 'Online document printing — upload your PDF, Word, or PPT, choose settings, and get prints delivered, usually within 3–4 hours.',
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
    description: 'Upload your PDF, Word, or PPT file, pick your settings, and get it printed and delivered to your door — usually within 3–4 hours.',
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
  const consentBoot = `<script>
window.dataLayer = window.dataLayer || [];
function gtag(){window.dataLayer.push(arguments);}
window.gtag = gtag;
gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied',wait_for_update:500});
(function(){try{var c=localStorage.getItem('metalix_cookie_consent');if(c==='granted'||c==='denied'){gtag('consent','update',{ad_storage:c,ad_user_data:c,ad_personalization:c,analytics_storage:c});}}catch(e){}})();
</script>`
  if (!gtmId) return { head: consentBoot, noscript: '' }
  const idAttr = escAttr(gtmId)
  const head = consentBoot + `
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
      <p>Approved refunds are processed to your original payment method. Cashfree typically settles refunds within <strong>5–7 business days</strong>.</p>`
    case 'delivery':
      return `<div class="callout"><p><strong>TL;DR:</strong> Pickup is free, home delivery is ₹20 (local PIN 122505) or ₹30 elsewhere. Choose instant (within 2 hrs) or a scheduled slot. Most orders are ready within 3–4 hours of payment.</p></div>
      <h2>Delivery options</h2>
      <p>We offer two ways to receive your prints:</p>
      <ul>
        <li><strong>Shop pickup</strong> — Free. Collect from our store at your convenience once we notify you.</li>
        <li><strong>Home delivery</strong> — ₹20 within our local PIN code (122505), ₹30 elsewhere within the city. We dispatch your order as soon as it's printed. At checkout you can also choose instant delivery (within 2 hours) or schedule a delivery slot for later.</li>
      </ul>
      <h2>Turnaround time</h2>
      <p>Most standard orders (under 100 pages) are ready within <strong>3–4 hours</strong> of successful payment confirmation. Bulk orders (100+ pages or multiple copies) may take longer — we'll estimate the time at checkout.</p>
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
      <p>All payments are processed securely through Cashfree. Metalix Print does not store your card or banking details. By paying, you agree to Cashfree's terms of service.</p>
      <h2>Limitation of liability</h2>
      <p>Our liability is limited to the amount paid for the specific order in question. We are not liable for indirect losses, loss of business, or consequential damages.</p>`
    case 'privacy':
      return `<div class="callout"><p><strong>Short version:</strong> Your files are used only to print your order and deleted after 3 days. We don't sell your data.</p></div>
      <h2>What we collect</h2>
      <ul>
        <li>Name, mobile number, and optional email — to process and communicate about your order</li>
        <li>Delivery address — only if you choose home delivery</li>
        <li>Uploaded files — solely to fulfil your print job</li>
        <li>Payment transaction data — processed by Cashfree; we only receive a transaction ID</li>
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
    '<div class="cta-card"><h3>Ready to print your documents?</h3><p>Upload a file, pick your settings, and get it delivered — usually within 3–4 hours.</p><a href="/order">Start your order →</a></div>'
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

// Password-protected admin dashboard (orders, customers, pricing).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'))
})

// Printable job sheet — admin-only, fetched client-side via the admin token,
// never billed to the customer (separate from order pricing/page counts).
app.get('/jobsheet.html', (req, res) => {
  res.sendFile(path.join(publicDir, 'jobsheet.html'))
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
  app.get('*', (req, res) => {
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
