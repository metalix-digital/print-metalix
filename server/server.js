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

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'unauthorized' })
  try {
    const decoded = jwt.verify(token, getJwtSecret())
    if (decoded.role !== 'admin') return res.status(401).json({ error: 'unauthorized' })
    next()
  } catch (err) {
    return res.status(401).json({ error: 'unauthorized' })
  }
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
        thumbnail: analysis.thumbnail
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

app.put('/api/admin/settings', requireAdmin, express.json(), (req, res) => {
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
  const admin = db.getAdminAuth()
  const usernameOk = admin && String(username).trim().toLowerCase() === String(admin.username).trim().toLowerCase()
  if (!admin || !usernameOk || !(await bcrypt.compare(password, admin.password_hash))) {
    return res.status(401).json({ error: 'invalid_credentials', message: 'Incorrect login ID or password.' })
  }
  const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: '12h' })
  return res.json({ token })
})

// Requires the correct admin login id before anything is sent — this stops a
// Requires the correct admin login id before any email is sent — this both
// stops a random visitor from spamming the admin inbox and gives the operator
// clear feedback (a wrong id is rejected outright, no email). Enumeration isn't
// a concern here: there is a single admin whose id is a known business email,
// and the reset link only ever goes to the fixed, server-side ADMIN_RESET_EMAIL
// (never an address from the request body), so knowing the id buys nothing.
app.post('/api/admin/forgot-password', express.json(), async (req, res) => {
  const { username } = req.body || {}
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'missing_username', message: 'Enter your Login ID first.' })
  }
  const admin = db.getAdminAuth()
  const usernameOk = admin && String(username).trim().toLowerCase() === String(admin.username).trim().toLowerCase()
  if (!usernameOk) {
    return res.status(401).json({ error: 'unknown_login_id', message: 'That Login ID is not recognized — no email was sent.' })
  }

  const rawToken = crypto.randomBytes(32).toString('hex')
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
  db.createPasswordReset({
    id: crypto.randomUUID(),
    user_id: 'admin', // sentinel: distinguishes admin resets from customer resets
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
  if (!reset || reset.user_id !== 'admin') return res.status(400).json({ error: 'invalid_or_expired_token' })

  const admin = db.getAdminAuth()
  const password_hash = await bcrypt.hash(newPassword, 10)
  db.setAdminAuth({ username: admin ? admin.username : (process.env.ADMIN_USERNAME || 'support@metalix.in'), password_hash })
  db.markPasswordResetUsed(reset.id)
  return res.json({ message: 'Admin password updated — you can now log in.' })
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
  // reset.user_id === 'admin' is an admin reset token — it must go through
  // /api/admin/reset-password, never this customer endpoint.
  if (!reset || reset.user_id === 'admin') return res.status(400).json({ error: 'invalid_or_expired_token' })

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

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const { status, search, limit, offset } = req.query
  const orders = db.listOrders({
    status: status || undefined,
    search: search || undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined
  })
  return res.json({ orders })
})

// Full single-order lookup for the printable job sheet — distinct from the
// public /api/orders/:id (which any customer with the order ID can hit) since
// this is gated behind requireAdmin.
app.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ order })
})

// Merges the job-sheet cover/back pages (rendered to images client-side via
// html2canvas, since we deliberately avoid a headless-Chromium server
// dependency) with the customer's actual print-ready document(s) into one
// PDF — page 1 cover, middle pages the real document(s), last page branding.
const A4_PT = { width: 595.28, height: 841.89 }
app.post('/api/admin/orders/:id/jobsheet-pdf', requireAdmin, async (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  const { coverImage, backImage } = req.body || {}
  if (!coverImage || !backImage) return res.status(400).json({ error: 'missing_images' })
  if (order.files_deleted_at) {
    return res.status(410).json({ error: 'files_deleted', message: 'The original files for this order were already auto-deleted (7 days after completion) — only the job sheet cover/back pages can be generated, not the merged document.' })
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

app.patch('/api/admin/orders/:id', requireAdmin, express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  const { order_status, failure_reason } = req.body || {}
  const updates = {}
  if (order_status !== undefined) updates.order_status = order_status
  if (failure_reason !== undefined) updates.failure_reason = failure_reason
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_updates' })
  const updated = db.updateOrder(order.id, updates)

  // Email the customer when the status actually changed. Fire-and-forget so a
  // mail hiccup never fails the admin's update.
  if (order.order_status !== updated.order_status) {
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
  if (order.order_status === 'Completed') {
    ;(async () => {
      let attachments = []
      try {
        attachments = [{ filename: `Invoice-${order.id}.pdf`, content: await buildInvoicePdf(order) }]
      } catch (err) {
        console.error(`[invoice] generation failed for ${order.id}:`, err.message)
      }
      await mailer.sendOrderStatusEmail(order, trackUrl, attachments)
    })().catch((err) => console.error(`[orders] completed email failed for ${order.id}:`, err.message))
    return
  }
  if (stageNotifies(order.order_status)) {
    mailer.sendOrderStatusEmail(order, trackUrl).catch((err) => console.error(`[orders] status email failed for ${order.id}:`, err.message))
  }
}

// Bulk status update: apply one status to many orders at once. Skips orders
// that are missing or already at that status, and emails each customer whose
// new stage is notify-enabled.
app.post('/api/admin/orders/bulk-status', requireAdmin, express.json(), (req, res) => {
  const { ids, order_status } = req.body || {}
  if (!Array.isArray(ids) || !ids.length || !order_status) {
    return res.status(400).json({ error: 'missing_fields', message: 'Select at least one order and a status.' })
  }
  const base = `${req.protocol}://${req.get('host')}`
  let updated = 0
  let emailed = 0
  for (const id of ids) {
    const order = db.getOrder(id)
    if (!order || order.order_status === order_status) continue
    const u = db.updateOrder(id, { order_status })
    updated++
    if (u.customer_email && willEmailOnStatus(u.order_status)) {
      emailed++
      emailStatusChange(u, base)
    }
  }
  return res.json({ updated, emailed })
})

// Record a pay-on-delivery collection (Cash/UPI) — marks the order paid.
app.post('/api/admin/orders/:id/collect-payment', requireAdmin, express.json(), (req, res) => {
  const { mode } = req.body || {}
  if (!['cash', 'upi'].includes(mode)) {
    return res.status(400).json({ error: 'invalid_mode', message: 'Payment mode must be cash or upi.' })
  }
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  const updated = db.updateOrder(order.id, { payment_status: 'paid', payment_mode: mode, payment_collected_at: Date.now() })
  return res.json({ order: updated })
})

// Archive (soft-delete) a single order. It leaves the Orders/Customers views
// and BigQuery immediately, but is recoverable for 30 days before the purge
// job removes it for good.
app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.archiveOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ archived: true })
})

// Bulk archive of orders.
app.post('/api/admin/orders/bulk-delete', requireAdmin, express.json(), (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'missing_fields', message: 'Select at least one order.' })
  let archived = 0
  for (const id of ids) { if (db.archiveOrder(id)) archived++ }
  return res.json({ archived })
})

// Archive a customer (identified by mobile) — archives all their orders.
app.delete('/api/admin/customers/:mobile', requireAdmin, (req, res) => {
  const orders = db.archiveCustomerByMobile(req.params.mobile)
  return res.json({ archived: true, archivedOrders: orders.length })
})

// Archive management: list, restore, or permanently delete now.
app.get('/api/admin/archive', requireAdmin, (req, res) => {
  return res.json({ orders: db.listArchivedOrders(), retentionDays: 30 })
})

app.post('/api/admin/orders/:id/restore', requireAdmin, (req, res) => {
  const order = db.restoreOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ restored: true })
})

app.delete('/api/admin/orders/:id/purge', requireAdmin, (req, res) => {
  const order = db.deleteOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  try { deleteFilesForOrder(order) } catch (err) { console.error('[archive] file cleanup on purge failed:', err.message) }
  return res.json({ deleted: true })
})

// Public: active branches the customer can pick from (no admin-only fields).
app.get('/api/locations', (req, res) => {
  const active = db.getLocations().filter((l) => l.active).map((l) => ({
    id: l.id, name: l.name, address: l.address || '', city: l.city || '', pincode: l.pincode || ''
  }))
  return res.json({ locations: active })
})

// Admin-managed branches / pickup locations (add / edit / delete / activate).
app.get('/api/admin/locations', requireAdmin, (req, res) => {
  return res.json({ locations: db.getLocations() })
})

app.put('/api/admin/locations', requireAdmin, express.json(), (req, res) => {
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
    clean.push({
      id,
      name,
      address: String((l && l.address) || '').trim().slice(0, 200),
      city: String((l && l.city) || '').trim().slice(0, 80),
      pincode: String((l && l.pincode) || '').trim().slice(0, 12),
      active: !!(l && l.active)
    })
  }
  db.setLocations(clean)
  return res.json({ locations: db.getLocations() })
})

// Admin-managed order workflow stages (add / delete / reorder / notify flag).
app.get('/api/admin/stages', requireAdmin, (req, res) => {
  return res.json({ stages: db.getOrderStages() })
})

app.put('/api/admin/stages', requireAdmin, express.json(), (req, res) => {
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

app.get('/api/admin/customers', requireAdmin, (req, res) => {
  return res.json({ customers: db.listCustomers() })
})

app.get('/api/admin/orders/:id/files/:fileId/download', requireAdmin, (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })

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
    return res.status(404).json({ error: 'file_not_found', message: 'This file has been auto-deleted (files are removed 7 days after order completion).' })
  }
  return res.download(filePath, fileName || safeFileId)
})

app.put('/api/admin/pricing', requireAdmin, express.json(), (req, res) => {
  const pricing = req.body
  if (!pricing || !pricing.rates) return res.status(400).json({ error: 'invalid_pricing' })
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
  const VALID_PAPER_TYPES = ['normal', 'bond', 'premium']
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
    const fileSide = VALID_SIDES.includes(f.printSide) ? f.printSide : 'single'
    const filePaperType = VALID_PAPER_TYPES.includes(f.paperType) ? f.paperType : 'normal'
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

// Minimal public tracking lookup behind the job sheet's QR code — deliberately
// returns only status/timing, never customer name, contact, or files, since
// order IDs aren't secret enough to gate anything sensitive behind.
const READY_BY_WINDOW_MS = 4 * 60 * 60 * 1000
app.get('/api/track/:id', (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order || order.payment_status !== 'paid') return res.status(404).json({ error: 'not_found' })
  return res.json({
    id: order.id,
    order_status: order.order_status,
    ready_by: (order.updated_at || order.created_at) + READY_BY_WINDOW_MS
  })
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

// Marketing landing page at the root path, served ahead of the SPA catch-all below.
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'landing.html'))
})

// Policies live as a view inside the landing page, but expose a real, crawlable
// URL for them (the footer/nav link here). landing.html reads the path on load
// and opens the policy view; see initFromUrl() there.
app.get('/policies', (req, res) => {
  res.sendFile(path.join(publicDir, 'landing.html'))
})

// SEO: robots.txt (references the sitemap) and the sitemap itself.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').sendFile(path.join(publicDir, 'robots.txt'))
})
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').sendFile(path.join(publicDir, 'sitemap.xml'))
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
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

// Seed the DB-backed admin credential once, from env, if it doesn't exist yet.
// After this the login id / password are managed entirely from the web (change
// or reset), so ADMIN_PASSWORD in .env only matters for the very first boot.
async function seedAdminAuth() {
  if (db.getAdminAuth()) return
  const username = process.env.ADMIN_USERNAME || 'support@metalix.in'
  const password = process.env.ADMIN_PASSWORD || 'metalix-admin'
  const password_hash = await bcrypt.hash(password, 10)
  db.setAdminAuth({ username, password_hash })
  console.log(`[admin] seeded initial admin credential (login id: ${username})`)
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
