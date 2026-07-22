const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const app = express()

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
const BRANCH_TABS = ['orders', 'customers', 'archive', 'feedback', 'mybranch']

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
const pricing = require('./pricing')
const { analyzePdfBuffer } = require('./pdfAnalyze')
const { convertToPdf } = require('./docConvert')
const { cleanupExpiredFiles, deleteFilesForOrder, purgeExpiredArchive } = require('./fileRetention')
const { buildInvoicePdf } = require('./invoice')

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
const { backupDatabase } = require('./backupDb')

const uploadsDir = path.join(__dirname, 'uploads')
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

const ALLOWED_EXTENSIONS = {
  '.pdf': 'pdf',
  '.doc': 'doc',
  '.docx': 'docx',
  '.ppt': 'ppt',
  '.pptx': 'pptx'
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

app.get('/api/pricing', (req, res) => {
  res.json(db.getPricing())
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
  res.json({ pricing: db.getPricing(), settings: db.getSiteSettings(), locations, testimonials })
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
// The admin credential (login id + bcrypt password hash) lives in the DB via
// db.getAdminAuth/setAdminAuth so it can be changed or reset from the web. It's
// seeded once at startup from env (see seedAdminAuth at the bottom of the file).
// The forgot-password link always goes to this fixed, server-side address — the
// client never supplies a destination, so a stranger can't redirect the reset.
const ADMIN_RESET_EMAIL = process.env.ADMIN_RESET_EMAIL || 'support@metalix.in'

app.post('/api/admin/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect login ID or password.' })
  }
  const admin = db.getAdminUserByUsername(username)
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect login ID or password.' })
  }
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
  return res.json({ post })
})

app.delete('/api/admin/blog/:id', requireSuperAdmin, (req, res) => {
  const existing = db.getBlogPostById(req.params.id)
  if (!existing) return res.status(404).json({ error: 'not_found' })
  db.deleteBlogPost(existing.id)
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
  const user = db.findUserByIdentifier(identifier)
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect email/mobile or password.' })
  }
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

    async function addImagePage(dataUrl) {
      const base64 = dataUrl.split(',')[1] || ''
      const bytes = Buffer.from(base64, 'base64')
      const img = dataUrl.startsWith('data:image/png') ? await merged.embedPng(bytes) : await merged.embedJpg(bytes)
      const scale = A4_PT.width / img.width
      const drawHeight = Math.min(img.height * scale, A4_PT.height)
      const page = merged.addPage([A4_PT.width, A4_PT.height])
      page.drawImage(img, { x: 0, y: A4_PT.height - drawHeight, width: A4_PT.width, height: drawHeight })
    }

    await addImagePage(coverImage)

    const font = await merged.embedFont(StandardFonts.Helvetica)
    for (const f of files) {
      const safeFileId = path.basename(String(f.fileId || ''))
      const filePath = path.join(uploadsDir, safeFileId)
      if (!safeFileId || !fs.existsSync(filePath)) continue
      try {
        const buffer = fs.readFileSync(filePath)
        const ext = path.extname(f.fileName || safeFileId).toLowerCase() || '.pdf'
        const pdfBuffer = ext === '.pdf' ? buffer : await convertToPdf(buffer, ext)
        // Normalize every document page onto an A4 sheet: fit-to-page (preserve
        // aspect ratio, centered), using A4 portrait or landscape to match the
        // source page's orientation. Guarantees the whole job sheet prints on A4.
        const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
        for (const idx of srcDoc.getPageIndices()) {
          // Content-less pages can't be embedded (pdf-lib throws at save), so
          // detect them and emit a blank A4 sheet — preserving page count/order.
          let hasContents = false
          try { hasContents = !!srcDoc.getPage(idx).node.Contents() } catch (e) { hasContents = false }
          if (!hasContents) { merged.addPage([A4_PT.width, A4_PT.height]); continue }
          try {
            const [ep] = await merged.embedPdf(srcDoc, [idx])
            const pw = ep.width
            const ph = ep.height
            const landscape = pw > ph
            const pageW = landscape ? A4_PT.height : A4_PT.width
            const pageH = landscape ? A4_PT.width : A4_PT.height
            const scale = Math.min(pageW / pw, pageH / ph)
            const w = pw * scale
            const h = ph * scale
            const pg = merged.addPage([pageW, pageH])
            pg.drawPage(ep, { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h })
          } catch (pageErr) {
            merged.addPage([A4_PT.width, A4_PT.height])
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
  const { order_status, failure_reason } = req.body || {}
  if (order_status === 'Completed' && order.payment_method === 'cod' && order.payment_status !== 'paid') {
    return res.status(400).json({ error: 'payment_not_collected', message: 'This is a pay-on-delivery order — collect cash/UPI payment before marking it Completed.' })
  }
  const updates = {}
  if (order_status !== undefined) updates.order_status = order_status
  if (failure_reason !== undefined) updates.failure_reason = failure_reason
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
  db.setLocations(clean)
  // Identity fields (above) and operating info (shopOpen/hours) are separate
  // updates in db.js so a branch admin's own PUT (below) can never touch
  // identity fields — but the super admin's single request here can include
  // both, so apply any operating-info fields per location too.
  for (const l of locations) {
    if (l && l.id && (l.shopOpen !== undefined || l.storeTimings)) {
      db.updateLocationOperatingInfo(l.id, { shopOpen: l.shopOpen, storeTimings: l.storeTimings })
    }
  }
  return res.json({ locations: db.getLocations() })
})

// A branch admin's self-serve view of their own branch — shop open/closed +
// hours only, never identity fields (name/address/etc. stay super-admin-only
// via /api/admin/locations). Super admins have no "my location" — they use
// the full locations list instead.
app.get('/api/admin/my-location', requireAdmin, requireTab('mybranch'), (req, res) => {
  if (req.admin.adminRole !== 'branch_admin') return res.status(403).json({ error: 'forbidden', message: 'This is for branch logins only — use Locations instead.' })
  const location = db.getLocationById(req.admin.locationId)
  if (!location) return res.status(404).json({ error: 'not_found' })
  return res.json({ location })
})

app.put('/api/admin/my-location', requireAdmin, requireTab('mybranch'), express.json(), (req, res) => {
  if (req.admin.adminRole !== 'branch_admin') return res.status(403).json({ error: 'forbidden', message: 'This is for branch logins only — use Locations instead.' })
  const { shopOpen, storeTimings } = req.body || {}
  const location = db.updateLocationOperatingInfo(req.admin.locationId, { shopOpen, storeTimings })
  if (!location) return res.status(404).json({ error: 'not_found' })
  return res.json({ location })
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

app.post('/api/orders', express.json(), async (req, res) => {
  const {
    customerName, customerMobile, customerEmail,
    files,
    deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode,
    locationId, paymentMethod
  } = req.body || {}
  const isCod = paymentMethod === 'cod'

  if (!customerName || !customerMobile) {
    return res.status(400).json({ error: 'missing_customer_info' })
  }
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'missing_file_info' })
  }

  const VALID_MODES = ['auto', 'color', 'bw']
  const VALID_ORIENTATIONS = ['portrait', 'landscape']
  const VALID_SIDES = ['single', 'double']
  // Paper types are admin-managed, so the valid set comes from the live pricing
  // config (its ids), not a hardcoded list. Unknown ids fall back to the first.
  const paperTypeConfig = db.getPricing()
  const paperTypeIds = (paperTypeConfig.rates.a4 || []).map((t) => t.id)
  const defaultPaperType = paperTypeIds[0] || 'normal'
  let totalFileSize = 0
  const safeFiles = []
  const pricingFiles = []
  for (const f of files) {
    const safeFileId = path.basename(String(f.fileId || ''))
    if (!safeFileId || !fs.existsSync(path.join(uploadsDir, safeFileId))) {
      return res.status(400).json({ error: 'file_not_found', message: 'One or more uploaded files expired or were not found. Please re-upload.' })
    }
    const fileMode = VALID_MODES.includes(f.printMode) ? f.printMode : 'auto'
    const fileOrientation = VALID_ORIENTATIONS.includes(f.orientation) ? f.orientation : 'portrait'
    // Colour prints are single-sided only — enforce server-side regardless of input.
    const fileSide = fileMode === 'color' ? 'single' : (VALID_SIDES.includes(f.printSide) ? f.printSide : 'single')
    const filePaperType = paperTypeIds.includes(f.paperType) ? f.paperType : defaultPaperType
    const fileCopies = Math.max(1, Math.min(999, Math.round(Number(f.copies)) || 1))
    const filePassword = String(f.password || '').trim().slice(0, 200) || null
    const fileData = {
      fileId: safeFileId,
      fileName: f.fileName || safeFileId,
      fileType: f.fileType || null,
      pageCount: Number(f.pageCount) || 0,
      colorPageCount: Number(f.colorPageCount) || 0,
      fileSize: Number(f.fileSize) || 0,
      printMode: fileMode,
      orientation: fileOrientation,
      printSide: fileSide,
      paperType: filePaperType,
      copies: fileCopies,
      password: filePassword
    }
    const { colorPages, bwPages } = pricing.resolveFileColorPages(
      { pageCount: fileData.pageCount, colorCount: fileData.colorPageCount },
      fileMode
    )
    pricingFiles.push({ colorPages, bwPages, copies: fileCopies, printSide: fileSide, paperType: filePaperType })
    totalFileSize += fileData.fileSize
    safeFiles.push(fileData)
  }
  if (totalFileSize > MAX_TOTAL_UPLOAD_BYTES) {
    return res.status(400).json({ error: 'files_too_large', message: 'Total upload size exceeds 100 MB.' })
  }
  if (deliveryMethod === 'delivery' && (!deliveryAddress || !deliveryCity || !deliveryState || !deliveryPincode)) {
    return res.status(400).json({ error: 'missing_delivery_address' })
  }

  const totalPageCount = safeFiles.reduce((sum, f) => sum + f.pageCount, 0)
  const fileModes = new Set(safeFiles.map((f) => f.printMode))
  const summaryMode = fileModes.size === 1 ? safeFiles[0].printMode : 'mixed'
  const fileOrientations = new Set(safeFiles.map((f) => f.orientation))
  const summaryOrientation = fileOrientations.size === 1 ? safeFiles[0].orientation : 'mixed'
  const fileSides = new Set(safeFiles.map((f) => f.printSide))
  const summarySide = fileSides.size === 1 ? safeFiles[0].printSide : 'mixed'
  const filePaperTypes = new Set(safeFiles.map((f) => f.paperType))
  const summaryPaperType = filePaperTypes.size === 1 ? safeFiles[0].paperType : 'mixed'
  const totalCopies = safeFiles.reduce((sum, f) => sum + f.copies, 0)

  const pricingConfig = db.getPricing()
  const calc = pricing.calculate(pricingConfig, {
    files: pricingFiles,
    deliveryMethod: deliveryMethod || 'pickup'
  })

  const orderId = generateOrderId()
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env
  let razorpayOrder = null
  let simulated = true

  // Pay-on-delivery (Cash/UPI) skips the online gateway entirely — the order is
  // confirmed now and payment is collected by staff at delivery/pickup.
  if (!isCod) {
    if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
      try {
        const Razorpay = require('razorpay')
        const instance = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
        razorpayOrder = await instance.orders.create({
          amount: calc.totalAmount * 100,
          currency: 'INR',
          receipt: orderId
        })
        simulated = false
      } catch (err) {
        console.error('Razorpay order creation failed', err)
        return res.status(500).json({ error: 'payment_error' })
      }
    } else {
      razorpayOrder = { id: `SIM_${orderId}`, amount: calc.totalAmount * 100, currency: 'INR' }
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
    paper_size: 'a4', // A3 support removed — every order is A4 regardless of client input
    paper_type: summaryPaperType,
    delivery_method: deliveryMethod || 'pickup',
    delivery_address: deliveryAddress || null,
    delivery_city: deliveryCity || null,
    delivery_state: deliveryState || null,
    delivery_pincode: deliveryPincode || null,
    location_id: chosenLocation ? chosenLocation.id : (locationId || null),
    location_name: chosenLocation ? chosenLocation.name : null,
    payment_method: isCod ? 'cod' : 'online',
    print_cost: calc.printCost,
    delivery_charge: calc.deliveryCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount,
    razorpay_order_id: isCod ? null : razorpayOrder.id,
    payment_status: isCod ? 'pending' : 'created',
    order_status: 'Received',
    created_at: Date.now()
  })

  // COD orders are confirmed immediately: queue them for printing and notify,
  // just like a paid online order does after verify-payment.
  if (isCod) {
    printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
    const fresh = db.getOrder(order.id)
    notify.sendOrderConfirmationSms(fresh)
    notify.sendOrderConfirmationEmail(fresh)
    return res.json({ order: fresh, cod: true })
  }

  return res.json({ order, razorpayOrder, key: RAZORPAY_KEY_ID || '', simulated })
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
// A "confirmed" order is paid online OR pay-on-delivery — matches the
// definition used everywhere else (db.listOrders/listMyOrders/listCustomers).
// COD orders are queued for printing immediately on creation, so a customer
// tracking one before it's paid at delivery is normal, not an error.
function isConfirmedOrder(order) {
  return !!order && (order.payment_status === 'paid' || order.payment_method === 'cod')
}
app.get('/api/track/:id', (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!isConfirmedOrder(order)) return res.status(404).json({ error: 'not_found' })
  const stages = db.getOrderStages().map((s) => s.name)
  return res.json({
    id: order.id,
    order_status: order.order_status,
    stages,
    stage_index: stages.indexOf(order.order_status),
    ready_by: (order.updated_at || order.created_at) + READY_BY_WINDOW_MS,
    created_at: order.created_at,
    completed: !!order.completed_at,
    feedback_submitted: !!db.getOrderFeedback(order.id),
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
  return res.json({ feedback })
})

// Verify the Razorpay checkout response (or simulated payment) and advance the order.
app.post('/api/orders/:id/verify-payment', express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  if (order.payment_status === 'paid') {
    return res.json({ order })
  }

  const { simulated, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body || {}

  if (simulated) {
    db.updateOrder(order.id, {
      razorpay_payment_id: `SIM_PAY_${order.id}`,
      payment_status: 'paid'
    })
    printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
    const fresh = db.getOrder(order.id)
    notify.sendOrderConfirmationSms(fresh)
    notify.sendOrderConfirmationEmail(fresh)
    return res.json({ order: fresh })
  }

  const secret = process.env.RAZORPAY_KEY_SECRET || ''
  const expected = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex')
  if (!secret || expected !== razorpay_signature) {
    db.updateOrder(order.id, { payment_status: 'failed', order_status: 'Failed', failure_reason: 'signature_mismatch' })
    return res.status(400).json({ error: 'invalid_signature' })
  }

  db.updateOrder(order.id, {
    razorpay_payment_id,
    razorpay_signature,
    payment_status: 'paid'
  })
  printQueue.enqueue(order.id) // stamps order_status: 'Queued For Printing'
  const fresh = db.getOrder(order.id)
  notify.sendOrderConfirmationSms(fresh)
  notify.sendOrderConfirmationEmail(fresh)
  return res.json({ order: fresh })
})

// Razorpay webhook — secondary source of truth for payment status.
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
    if (payment && payment.order_id) {
      const order = db.db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(payment.order_id)
      if (order && order.payment_status !== 'paid') {
        db.updateOrder(order.id, {
          razorpay_payment_id: payment.id,
          payment_status: 'paid',
          order_status: 'Payment Successful'
        })
        printQueue.enqueue(order.id)
        const fresh = db.getOrder(order.id)
        notify.sendOrderConfirmationSms(fresh)
        notify.sendOrderConfirmationEmail(fresh)
      }
    }
    res.status(200).json({ ok: true })
  } catch (err) {
    res.status(400).end()
  }
})

// Serve a logo or other public assets from server/public
const publicDir = path.join(__dirname, 'public')
if (fs.existsSync(publicDir)) {
  // The logo is a static brand asset that effectively never changes, so let
  // browsers cache it for a year instead of re-fetching it on every visit
  // (Lighthouse flags the default max-age=0 as an inefficient cache policy).
  const logoCache = { maxAge: '365d', immutable: true }
  app.get('/logo.png', (req, res) => {
    const file = path.join(publicDir, 'logo.png')
    if (fs.existsSync(file)) return res.sendFile(file, logoCache)
    return res.status(404).end()
  })
  app.get('/logo.svg', (req, res) => {
    const file = path.join(publicDir, 'logo.svg')
    if (fs.existsSync(file)) return res.sendFile(file, logoCache)
    return res.status(404).end()
  })
  // Default cover art shown on blog posts with no cover_image — same
  // effectively-immutable caching as the logo above.
  app.get('/blog-placeholder.png', (req, res) => {
    const file = path.join(publicDir, 'blog-placeholder.png')
    if (fs.existsSync(file)) return res.sendFile(file, logoCache)
    return res.status(404).end()
  })

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
}

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
  { q: 'Which file formats can I upload?', a: 'PDF, Word (.doc/.docx), and PowerPoint (.ppt/.pptx). We convert and calculate your page count automatically, so there’s no need to export to PDF yourself first.' },
  { q: 'Do you deliver, or is it pickup only?', a: 'Both. Shop pickup is free. Home delivery is a flat ₹30 within Gurugram city limits. If your PIN code is outside our delivery zone, we’ll contact you to arrange pickup instead and refund the delivery charge.' },
  { q: 'What’s the difference between color and black & white pricing?', a: 'Color pages cost more per page than black & white. You can print a file entirely in black & white, entirely in color, or use auto-detect so only the pages that actually contain color are billed at the color rate.' },
  { q: 'How do I pay, and is it secure?', a: 'All payments are processed securely through Razorpay before your order enters the print queue. Metalix Print never stores your card or banking details.' },
  { q: 'Can I track my order?', a: 'Yes — after payment you get a tracking link showing whether your order is queued, printing, or out for delivery. No account or app install required.' },
  { q: 'What if something’s wrong with my print?', a: 'Report it within 24 hours of pickup or delivery by calling or WhatsApp-ing us. If we made a mistake, we reprint it free; if the issue is with the uploaded file, we can offer a paid reprint.' }
]

function faqJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ_ITEMS.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a }
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
    logo: 'https://print.metalix.in/logo.svg',
    image: 'https://print.metalix.in/logo.svg',
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
const LANDING_ROUTES = {
  '/': {
    title: 'Metalix Print — Upload · Print · Deliver',
    description: 'Upload your PDF, Word, or PPT file, pick your settings, and get it printed and delivered to your door — usually within 3–4 hours.',
    keywords: 'print shop, online printing, document printing, Gurugram',
    canonical: 'https://print.metalix.in/',
    includeFaq: true
  },
  '/policies': {
    title: 'Terms, Privacy & Delivery Policies — Metalix Print',
    description: 'Read Metalix Print’s terms of service, privacy policy, refund & reprint policy, and delivery policy for our Gurugram print-and-deliver service.',
    keywords: 'refund policy, delivery policy, terms of service, privacy policy, Metalix Print',
    canonical: 'https://print.metalix.in/policies',
    includeFaq: false
  }
}

function renderLanding(route) {
  const meta = LANDING_ROUTES[route]
  const template = fs.readFileSync(path.join(publicDir, 'landing.html'), 'utf8')
  return template
    .split('__META_TITLE__').join(escAttr(meta.title))
    .split('__META_DESCRIPTION__').join(escAttr(meta.description))
    .split('__META_KEYWORDS__').join(escAttr(meta.keywords))
    .split('__CANONICAL_URL__').join(escAttr(meta.canonical))
    .split('__LOCALBUSINESS_JSON_LD__').join(localBusinessJsonLd())
    .split('__FAQ_JSON_LD_SCRIPT__').join(meta.includeFaq ? `<script type="application/ld+json">${faqJsonLd()}</script>` : '')
}

// Marketing landing page at the root path, served ahead of the SPA catch-all below.
app.get('/', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.send(renderLanding('/'))
})

// Policies live as a view inside the landing page, but expose a real, crawlable
// URL for them (the footer/nav link here). landing.html reads the path on load
// and opens the policy view; see initFromUrl() there.
app.get('/policies', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.send(renderLanding('/policies'))
})

// Blog list + article pages — the SPA-style views inside landing.html handle
// their own routing, but the blog is plain server-rendered HTML + client JS
// (like track.html) since each post needs its own crawlable, shareable URL.
app.get('/blog', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  res.sendFile(path.join(publicDir, 'blog.html'))
})

// Attribute-safe (not full HTML-safe) — only used inside "..." attribute
// values and <title>/<meta content> text nodes in the template below.
function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Server-renders the SEO-critical <head> tags (title, description, OG,
// canonical, JSON-LD) into the static template before sending it, so
// crawlers and social-media unfurlers see the real per-post metadata even
// without executing JS. The visible article body is still filled in
// client-side (see blog-post.html) — same pattern as the rest of the site.
app.get('/blog/:slug', (req, res) => {
  if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
  const post = db.getBlogPostBySlug(req.params.slug)
  const template = fs.readFileSync(path.join(publicDir, 'blog-post.html'), 'utf8')
  const canonical = `https://print.metalix.in/blog/${req.params.slug}`

  if (!post || !post.published) {
    const html = template
      .split('__META_TITLE__').join(escAttr('Post not found — Metalix Print Blog'))
      .split('__META_DESCRIPTION__').join(escAttr('This blog post could not be found.'))
      .split('__META_KEYWORDS__').join('')
      .split('__CANONICAL_URL__').join(escAttr(canonical))
      .split('__OG_IMAGE__').join('https://print.metalix.in/logo.svg')
      .split('__JSON_LD__').join('null')
    return res.status(404).send(html)
  }

  const title = post.meta_title || post.title
  const description = post.meta_description || post.excerpt || ''
  const image = post.cover_image
    ? (post.cover_image.startsWith('http') ? post.cover_image : `https://print.metalix.in${post.cover_image}`)
    : 'https://print.metalix.in/logo.svg'
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

  const html = template
    .split('__META_TITLE__').join(escAttr(title))
    .split('__META_DESCRIPTION__').join(escAttr(description))
    .split('__META_KEYWORDS__').join(escAttr(post.meta_keywords || (post.tags || []).join(', ')))
    .split('__CANONICAL_URL__').join(escAttr(canonical))
    .split('__OG_IMAGE__').join(escAttr(image))
    .split('__JSON_LD__').join(jsonLd)
  res.send(html)
})

// SEO: robots.txt (references the sitemap) and the sitemap itself. The
// sitemap is generated on request (not a static file) so published blog
// posts appear/disappear automatically as they're published/unpublished.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'robots.txt'))
})
app.get('/sitemap.xml', (req, res) => {
  const staticUrls = [
    { loc: 'https://print.metalix.in/', freq: 'weekly', priority: '1.0' },
    { loc: 'https://print.metalix.in/order', freq: 'weekly', priority: '0.9' },
    { loc: 'https://print.metalix.in/blog', freq: 'weekly', priority: '0.7' },
    { loc: 'https://print.metalix.in/policies', freq: 'monthly', priority: '0.3' }
  ]
  const postUrls = db.listBlogPosts({ includeUnpublished: false }).map((p) => ({
    loc: `https://print.metalix.in/blog/${p.slug}`, freq: 'monthly', priority: '0.6'
  }))
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    staticUrls.concat(postUrls).map((u) =>
      `  <url>\n    <loc>${u.loc}</loc>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    ).join('\n') +
    '\n</urlset>'
  res.type('application/xml').send(xml)
})

// llms.txt — a machine-readable site summary for AI agents (llmstxt.org). Checked
// by Lighthouse's Agentic Browsing category; must expose an H1, a summary, and links.
app.get('/llms.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'llms.txt'))
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
  res.sendFile(path.join(publicDir, 'track.html'))
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
  app.get('*', (req, res) => {
    if (!isShopOpen()) return res.sendFile(path.join(publicDir, 'closed.html'))
    res.sendFile(path.join(clientDist, 'index.html'))
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
  purgeExpiredArchive()
  setInterval(purgeExpiredArchive, 6 * 60 * 60 * 1000)
  backupDatabase()
  setInterval(backupDatabase, 6 * 60 * 60 * 1000)
})
