// Razorpay Payment Gateway integration — order creation, checkout signature
// verification, and payment links. Falls back to a simulated order (SIM_-
// prefixed order id) when RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET aren't set, so
// local development needs no real Razorpay account.
//
// Trust model: Razorpay's client SDK hands the browser a payment id, order
// id, and an HMAC signature computed with our own key_secret — that's
// cryptographically verifiable locally, with no round trip back to Razorpay
// needed to confirm a regular checkout. Payment Links get the same treatment
// on their redirect callback. getPaymentLinkStatus() is only a manual
// escape-hatch for staff when a webhook is delayed/lost, not the normal path.
const crypto = require('crypto')
const Razorpay = require('razorpay')

function isConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)
}

function client() {
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
}

// Regular (customer-driven) checkout — creates a Razorpay order. The client
// SDK opens its own checkout modal using key_id + this order id directly, no
// separate session id involved.
async function createOrder({ orderId, amount }) {
  if (!isConfigured()) {
    return { id: `SIM_${orderId}`, amount: amount * 100, currency: 'INR', simulated: true }
  }
  const order = await client().orders.create({ amount: amount * 100, currency: 'INR', receipt: orderId })
  return { id: order.id, amount: order.amount, currency: order.currency, simulated: false }
}

// Verifies the signature Razorpay's client SDK hands back after a successful
// checkout — order_id|payment_id signed with our key_secret. Cryptographic
// proof with no server round trip to Razorpay required.
function verifyPaymentSignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET || ''
  if (!secret) return false
  const expected = crypto.createHmac('sha256', secret).update(`${razorpay_order_id}|${razorpay_payment_id}`).digest('hex')
  return expected === razorpay_signature
}

// Admin-initiated remote payment link (phone/WhatsApp orders, or an existing
// COD order the customer wants to pay for remotely). No simulated form here
// — a fake link handed to a real customer would be actively confusing, not
// useful, so this throws rather than pretending to succeed.
async function createPaymentLink({ linkId, amount, customerName, customerPhone, customerEmail, purpose, returnUrl }) {
  if (!isConfigured()) {
    const err = new Error('Online payments are not configured.')
    err.code = 'razorpay_not_configured'
    throw err
  }
  const link = await client().paymentLink.create({
    amount: amount * 100,
    currency: 'INR',
    reference_id: linkId,
    description: purpose,
    customer: {
      name: customerName,
      contact: customerPhone,
      email: customerEmail || undefined
    },
    notify: { sms: false, email: false },
    callback_url: returnUrl,
    callback_method: returnUrl ? 'get' : undefined
  })
  return { link_id: link.id, link_url: link.short_url, link_status: link.status }
}

async function cancelPaymentLink(linkId) {
  try { await client().paymentLink.cancel(linkId) } catch (err) { /* already paid/expired/cancelled — fine either way */ }
}

// Verifies the signature on a Payment Link's post-payment redirect query
// params. Razorpay signs this redirect (unlike some gateways), so it can be
// trusted directly as the primary confirmation path for Payment Links, with
// the webhook below only as a backup.
function verifyPaymentLinkSignature({ razorpay_payment_link_id, razorpay_payment_link_reference_id, razorpay_payment_link_status, razorpay_payment_id, razorpay_signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET || ''
  if (!secret) return false
  const payload = `${razorpay_payment_link_id}|${razorpay_payment_link_reference_id}|${razorpay_payment_link_status}|${razorpay_payment_id}`
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return expected === razorpay_signature
}

// Webhooks are signed with the same key_secret as checkout/payment-link
// signatures (this repo's own established convention — Razorpay's dashboard
// also supports a distinct webhook secret if that's ever preferred instead).
function verifyWebhookSignature(rawBody, signature) {
  const secret = process.env.RAZORPAY_KEY_SECRET || ''
  if (!secret || !signature) return false
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex')
  return expected === signature
}

// Manual escape hatch for staff — ask Razorpay directly whether a Payment
// Link has actually been paid, without waiting on the webhook or redirect.
async function getPaymentLinkStatus(linkId) {
  if (!isConfigured()) {
    const err = new Error('Online payments are not configured.')
    err.code = 'razorpay_not_configured'
    throw err
  }
  const link = await client().paymentLink.fetch(linkId)
  const captured = Array.isArray(link.payments) ? link.payments.find((p) => p.status === 'captured') : null
  return { status: link.status, payment_id: captured ? captured.payment_id : null }
}

module.exports = {
  isConfigured,
  createOrder,
  verifyPaymentSignature,
  createPaymentLink,
  cancelPaymentLink,
  verifyPaymentLinkSignature,
  verifyWebhookSignature,
  getPaymentLinkStatus
}
