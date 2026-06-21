
const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(express.json());

const multer = require('multer')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } })
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf')
const security = require('./securityManager')
const crypto = require('crypto')

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Server-side PDF analysis endpoint (multipart form upload)
app.post('/api/analyze', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' })
  try {
    const data = new Uint8Array(req.file.buffer)
    // require canvas lazily — may not be installed on development machines
    let createCanvas
    try {
      ({ createCanvas } = require('canvas'))
    } catch (err) {
      console.error('canvas not available', err)
      return res.status(500).json({ error: 'canvas_missing', message: 'server requires the canvas package and native libs. See README.' })
    }
    const loadingTask = pdfjsLib.getDocument({ data })
    const doc = await loadingTask.promise
    const n = doc.numPages

    // NodeCanvasFactory for pdfjs
    function NodeCanvasFactory() {}
    NodeCanvasFactory.prototype = {
      create: function (width, height) {
        const canvas = createCanvas(width, height)
        const context = canvas.getContext('2d')
        return { canvas, context, width, height }
      },
      reset: function (canvasAndContext, width, height) {
        canvasAndContext.canvas.width = width
        canvasAndContext.canvas.height = height
        canvasAndContext.width = width
        canvasAndContext.height = height
      },
      destroy: function (canvasAndContext) {
        canvasAndContext.canvas.width = 0
        canvasAndContext.canvas.height = 0
        canvasAndContext.canvas = null
        canvasAndContext.context = null
      }
    }

    const flags = []
    let thumbnail = null
    const canvasFactory = new NodeCanvasFactory()
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i)
      const viewport = page.getViewport({ scale: 1 })
      const maxDim = 800
      const scale = Math.max(1, Math.min(2, maxDim / viewport.width))
      const vp = page.getViewport({ scale })
      const canvasAndContext = canvasFactory.create(Math.floor(vp.width), Math.floor(vp.height))
      await page.render({ canvasContext: canvasAndContext.context, viewport: vp, canvasFactory }).promise

      if (i === 1) {
        thumbnail = canvasAndContext.canvas.toDataURL('image/png')
      }

      const imgData = canvasAndContext.context.getImageData(0, 0, canvasAndContext.width, canvasAndContext.height)
      // detect color similarly to client
      const dataArr = imgData.data
      let colored = 0
      let total = 0
      const step = 4
      for (let k = 0; k < dataArr.length; k += 4 * step) {
        const r = dataArr[k]
        const g = dataArr[k + 1]
        const b = dataArr[k + 2]
        total++
        if (Math.abs(r - g) > 12 || Math.abs(r - b) > 12 || Math.abs(g - b) > 12) colored++
      }
      flags.push(total > 0 && (colored / total) > 0.03)
      canvasFactory.destroy(canvasAndContext)
    }

    const colorCount = flags.filter(Boolean).length
    return res.json({ pageCount: n, colorCount, colorFlags: flags, thumbnail })
  } catch (err) {
    console.error('analyze error', err)
    return res.status(500).json({ error: 'analyze_failed' })
  }
})

// Razorpay webhook endpoint — verify signature
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const secret = process.env.RAZORPAY_KEY_SECRET || ''
  const signature = req.headers['x-razorpay-signature']
  const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex')
  if (signature === expected) {
    try {
      const event = JSON.parse(req.body.toString())
      console.log('Razorpay webhook event:', event.event)
      // TODO: handle event (payment.captured etc.) — update order state in DB
      res.status(200).json({ ok: true })
    } catch (err) {
      res.status(400).end()
    }
  } else {
    res.status(400).json({ error: 'invalid_signature' })
  }
})

app.post('/api/create-order', express.json(), async (req, res) => {
  const amount = Number(req.body.amount) || 0
  const paise = Math.round(amount * 100)
  const meta = req.body.meta || null

  // Try real Razorpay if configured
  const { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET } = process.env
  if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
    try {
      const Razorpay = require('razorpay')
      const instance = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
      const order = await instance.orders.create({ amount: paise, currency: 'INR', receipt: `rcpt_${Date.now()}` })
      // persist order
      try { security.saveOrder({ id: order.id, amount: order.amount, currency: order.currency, status: 'created', meta, createdAt: Date.now() }) } catch (e) {}
      return res.json({ simulated: false, order, key: RAZORPAY_KEY_ID })
    } catch (err) {
      console.error('Razorpay error', err)
      return res.status(500).json({ error: 'payment_error' })
    }
  }

  // Fallback: simulated order
  const simulated = {
    id: `SIM_${Date.now()}`,
    amount: paise,
    currency: 'INR'
  }
  try { security.saveOrder({ id: simulated.id, amount: simulated.amount, currency: simulated.currency, status: 'created', meta, createdAt: Date.now() }) } catch (e) {}
  return res.json({ simulated: true, order: simulated })
})

// mark simulated order complete (used by client after simulated payment)
app.post('/api/order/:id/complete', express.json(), (req, res) => {
  const id = req.params.id
  const order = security.updateOrderStatus(id, { status: 'paid', paidAt: Date.now(), paymentInfo: req.body.payment || null })
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ ok: true, order })
})

app.get('/api/order/:id', (req, res) => {
  const id = req.params.id
  const order = security.getOrder(id)
  if (!order) return res.status(404).json({ error: 'not_found' })
  return res.json({ order })
})

// Serve a logo or other public assets from server/public
const publicDir = path.join(__dirname, 'public');
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

const PORT = process.env.PORT || 5050;
app.listen(PORT, () => console.log(`Running on ${PORT}`));
