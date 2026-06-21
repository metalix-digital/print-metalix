const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const app = express()

app.use(express.json())

const multer = require('multer')
const db = require('./db')
const printQueue = require('./printQueue')
const notify = require('./notify')
const pricing = require('./pricing')
const { analyzePdfBuffer } = require('./pdfAnalyze')
const { convertToPdf } = require('./docConvert')

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

// Create an order: validates the previously-uploaded file still exists,
// computes the authoritative price server-side, and creates a Razorpay order
// (or a simulated one if no live keys are configured).
app.post('/api/orders', express.json(), async (req, res) => {
  const {
    customerName, customerMobile, customerEmail,
    fileId, fileName, fileType, pageCount, colorPageCount,
    orientation, printMode, printSide, paperSize, copies,
    deliveryMethod, deliveryAddress, deliveryCity, deliveryState, deliveryPincode
  } = req.body || {}

  if (!customerName || !customerMobile) {
    return res.status(400).json({ error: 'missing_customer_info' })
  }
  if (!fileId || !pageCount) {
    return res.status(400).json({ error: 'missing_file_info' })
  }
  const safeFileId = path.basename(String(fileId))
  if (!fs.existsSync(path.join(uploadsDir, safeFileId))) {
    return res.status(400).json({ error: 'file_not_found', message: 'Uploaded file expired or was not found. Please re-upload.' })
  }
  if (deliveryMethod === 'delivery' && (!deliveryAddress || !deliveryCity || !deliveryState || !deliveryPincode)) {
    return res.status(400).json({ error: 'missing_delivery_address' })
  }

  const pricingConfig = db.getPricing()
  const calc = pricing.calculate(pricingConfig, {
    pageCount: Number(pageCount) || 0,
    colorPageCount: Number(colorPageCount) || 0,
    printMode: printMode || 'auto',
    printSide: printSide || 'single',
    paperSize: paperSize || 'a4',
    copies: Number(copies) || 1,
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

  const order = db.createOrder({
    id: orderId,
    customer_name: customerName,
    customer_mobile: customerMobile,
    customer_email: customerEmail || null,
    file_name: fileName || safeFileId,
    file_path: safeFileId,
    file_type: fileType || null,
    page_count: Number(pageCount) || 0,
    orientation: orientation || 'portrait',
    print_mode: printMode || 'auto',
    print_side: printSide || 'single',
    copies: Number(copies) || 1,
    paper_size: paperSize || 'a4',
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

// If a production client build exists, serve it (single-process deploy)
const clientDist = path.join(__dirname, '..', 'client', 'dist')
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist))
  app.get('*', (req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

const PORT = process.env.PORT || 5050
app.listen(PORT, () => console.log(`Running on ${PORT}`))
