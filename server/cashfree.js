// Cashfree Payment Gateway integration — order creation, authoritative
// status checks, and payment links. Falls back to a simulated order (same
// SIM_-prefixed-session convention the previous Razorpay integration used)
// when CASHFREE_APP_ID/CASHFREE_SECRET_KEY aren't set, so local development
// needs no real Cashfree account.
//
// Trust model differs from the old Razorpay integration on purpose: Cashfree's
// client SDK gives no cryptographically verifiable signature back to the
// browser, so nothing the client reports about its own payment is trusted.
// getOrderStatus() always re-asks Cashfree directly, using our own server
// credentials, for the authoritative answer.
const crypto = require('crypto')

const CASHFREE_API_VERSION = '2025-01-01' // update here if Cashfree revises their recommended version

function baseUrl() {
  return process.env.CASHFREE_ENV === 'production'
    ? 'https://api.cashfree.com/pg'
    : 'https://sandbox.cashfree.com/pg'
}

function isConfigured() {
  return !!(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY)
}

async function request(method, path, body) {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'x-client-id': process.env.CASHFREE_APP_ID,
      'x-client-secret': process.env.CASHFREE_SECRET_KEY,
      'x-api-version': CASHFREE_API_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error((data && (data.message || data.code)) || `Cashfree request failed (${res.status})`)
    err.code = 'cashfree_error'
    err.status = res.status
    throw err
  }
  return data
}

// Regular (customer-driven) checkout — creates a Cashfree order and returns
// the payment_session_id the client-side SDK needs to open checkout.
async function createOrder({ orderId, amount, customerName, customerPhone, customerEmail, returnUrl }) {
  if (!isConfigured()) {
    return { order_id: orderId, payment_session_id: `SIM_${orderId}`, cf_order_id: null, simulated: true }
  }
  const data = await request('POST', '/orders', {
    order_id: orderId,
    order_amount: amount,
    order_currency: 'INR',
    customer_details: {
      customer_id: orderId,
      customer_name: customerName,
      customer_email: customerEmail || 'customer@metalix.in',
      customer_phone: customerPhone
    },
    order_meta: { return_url: returnUrl }
  })
  return { order_id: data.order_id, payment_session_id: data.payment_session_id, cf_order_id: data.cf_order_id, simulated: false }
}

// Authoritative status check, used by both verify-payment and the admin
// manual recheck-payment escape hatch. Deliberately does NOT auto-report
// PAID when unconfigured — callers that need simulated-order handling (see
// verify-payment) do that themselves by checking the order's own stored
// cashfree_order_id before ever calling this, so this function stays safe to
// call from anywhere without silently lying about a real order's status.
async function getOrderStatus(orderId) {
  if (!isConfigured()) {
    const err = new Error('Online payments are not configured.')
    err.code = 'cashfree_not_configured'
    throw err
  }
  const data = await request('GET', `/orders/${encodeURIComponent(orderId)}`)
  let cf_payment_id = null
  if (data.order_status === 'PAID') {
    try {
      const payments = await request('GET', `/orders/${encodeURIComponent(orderId)}/payments`)
      const success = Array.isArray(payments) ? payments.find((p) => p.payment_status === 'SUCCESS') : null
      cf_payment_id = success ? success.cf_payment_id : null
    } catch (err) {
      // Status is still authoritative even if the payment-id lookup fails —
      // markOrderPaid works fine without it, it's only used for display.
    }
  }
  return { order_status: data.order_status, cf_payment_id, simulated: false }
}

// Admin-initiated remote payment link (phone/WhatsApp orders, or an existing
// COD order the customer wants to pay for remotely). No simulated form here
// — a fake link handed to a real customer would be actively confusing, not
// useful, so this throws (matching the previous razorpay_not_configured guard)
// rather than pretending to succeed.
async function createPaymentLink({ linkId, amount, customerName, customerPhone, customerEmail, purpose, returnUrl }) {
  if (!isConfigured()) {
    const err = new Error('Online payments are not configured.')
    err.code = 'cashfree_not_configured'
    throw err
  }
  const data = await request('POST', '/links', {
    link_id: linkId,
    link_amount: amount,
    link_currency: 'INR',
    link_purpose: purpose,
    customer_details: {
      customer_phone: customerPhone,
      customer_name: customerName,
      customer_email: customerEmail || undefined
    },
    link_notify: { send_sms: false, send_email: false, send_whatsapp: false },
    // We already know which order this link is for, so point return_url
    // straight at its tracking page — no need to parse anything back out of
    // Cashfree's redirect (see server.js's /api/payment-links/callback,
    // which stays only as a defensive fallback, not the primary path).
    link_meta: returnUrl ? { return_url: returnUrl } : undefined
  })
  return { link_id: data.link_id, cf_link_id: data.cf_link_id, link_url: data.link_url, link_status: data.link_status }
}

async function cancelPaymentLink(linkId) {
  try {
    await request('POST', `/links/${encodeURIComponent(linkId)}/cancel`)
  } catch (err) { /* already paid/expired/cancelled — fine either way */ }
}

// Cashfree signs webhooks as base64(HMAC-SHA256(timestamp + rawBody, secret))
// — base64, not hex, and no delimiter between timestamp and body. Must run
// against the raw, unparsed request body (see server.js's /api/webhook route
// comment for why this route is registered before the global JSON parser).
function verifyWebhookSignature(rawBody, timestamp, signature) {
  if (!process.env.CASHFREE_SECRET_KEY || !timestamp || !signature) return false
  const expected = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY)
    .update(timestamp + rawBody.toString())
    .digest('base64')
  return expected === signature
}

module.exports = { isConfigured, createOrder, getOrderStatus, createPaymentLink, cancelPaymentLink, verifyWebhookSignature }
