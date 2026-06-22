const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')
const app = express()

app.use(express.json())

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
const { cleanupExpiredFiles } = require('./fileRetention')
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

app.post('/api/admin/login', express.json(), (req, res) => {
  const { password } = req.body || {}
  const adminPassword = process.env.ADMIN_PASSWORD || 'metalix-admin'
  if (password !== adminPassword) {
    return res.status(401).json({ error: 'invalid_password' })
  }
  const token = jwt.sign({ role: 'admin' }, getJwtSecret(), { expiresIn: '12h' })
  return res.json({ token })
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
  if (!reset) return res.status(400).json({ error: 'invalid_or_expired_token' })

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

app.patch('/api/admin/orders/:id', requireAdmin, express.json(), (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  const { order_status, failure_reason } = req.body || {}
  const updates = {}
  if (order_status !== undefined) updates.order_status = order_status
  if (failure_reason !== undefined) updates.failure_reason = failure_reason
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'no_updates' })
  const updated = db.updateOrder(order.id, updates)
  return res.json({ order: updated })
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
    printSide, paperType,
    deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode
  } = req.body || {}

  if (!customerName || !customerMobile) {
    return res.status(400).json({ error: 'missing_customer_info' })
  }
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'missing_file_info' })
  }

  const VALID_MODES = ['auto', 'color', 'bw']
  const VALID_ORIENTATIONS = ['portrait', 'landscape']
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
      copies: fileCopies,
      password: filePassword
    }
    const { colorPages, bwPages } = pricing.resolveFileColorPages(
      { pageCount: fileData.pageCount, colorCount: fileData.colorPageCount },
      fileMode
    )
    pricingFiles.push({ colorPages, bwPages, copies: fileCopies })
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
  const totalCopies = safeFiles.reduce((sum, f) => sum + f.copies, 0)

  const pricingConfig = db.getPricing()
  const calc = pricing.calculate(pricingConfig, {
    files: pricingFiles,
    printSide: printSide || 'single',
    paperType: paperType || 'normal',
    deliveryMethod: deliveryMethod || 'pickup'
  })

  const orderId = `ORD_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env
  let razorpayOrder = null
  let simulated = true

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

  const fileNameSummary = safeFiles.length > 1
    ? `${safeFiles[0].fileName} +${safeFiles.length - 1} more`
    : safeFiles[0].fileName

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
    print_side: printSide || 'single',
    copies: totalCopies,
    paper_size: 'a4', // A3 support removed — every order is A4 regardless of client input
    paper_type: paperType || 'normal',
    delivery_method: deliveryMethod || 'pickup',
    delivery_address: deliveryAddress || null,
    delivery_city: deliveryCity || null,
    delivery_state: deliveryState || null,
    delivery_pincode: deliveryPincode || null,
    print_cost: calc.printCost,
    delivery_charge: calc.deliveryCharge,
    gst_amount: calc.gstAmount,
    total_amount: calc.totalAmount,
    razorpay_order_id: razorpayOrder.id,
    payment_status: 'created',
    order_status: 'Received',
    created_at: Date.now()
  })

  return res.json({ order, razorpayOrder, key: RAZORPAY_KEY_ID || '', simulated })
})

app.get('/api/orders/:id', (req, res) => {
  const order = db.getOrder(req.params.id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ order })
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
      payment_status: 'paid',
      order_status: 'Payment Successful'
    })
    printQueue.enqueue(order.id)
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
    payment_status: 'paid',
    order_status: 'Payment Successful'
  })
  printQueue.enqueue(order.id)
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
  app.get('/logo.png', (req, res) => {
    const file = path.join(publicDir, 'logo.png')
    if (fs.existsSync(file)) return res.sendFile(file)
    return res.status(404).end()
  })
  app.get('/logo.svg', (req, res) => {
    const file = path.join(publicDir, 'logo.svg')
    if (fs.existsSync(file)) return res.sendFile(file)
    return res.status(404).end()
  })
}

// Marketing landing page at the root path, served ahead of the SPA catch-all below.
app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'landing.html'))
})

// Password-protected admin dashboard (orders, customers, pricing).
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'))
})

// If a production client build exists, serve it (single-process deploy)
const clientDist = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

const { loadSecretsIntoEnv } = require('./secrets')
const PORT = process.env.PORT || 5050
loadSecretsIntoEnv().then(() => {
  if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_JWT_SECRET) {
    console.warn('Warning: ADMIN_PASSWORD/ADMIN_JWT_SECRET not set, using insecure development defaults.')
  }
  app.listen(PORT, () => console.log(`Running on ${PORT}`))
  cleanupExpiredFiles()
  setInterval(cleanupExpiredFiles, 60 * 60 * 1000)
  backupDatabase()
  setInterval(backupDatabase, 6 * 60 * 60 * 1000)
})
