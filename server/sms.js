// Real SMS delivery via Twilio's Content API (a pre-approved, DLT-registered
// template — India blocks A2P SMS whose body doesn't exactly match a
// registered template, so the wording lives in Twilio's Content template,
// not here). Falls back to a console-log stub — same pattern as mailer.js —
// when Twilio credentials aren't set (e.g. local dev).
let cachedClient = null
function getClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null
  if (cachedClient) return cachedClient
  const twilio = require('twilio')
  cachedClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  return cachedClient
}

// customer_mobile is stored as a bare 10-digit Indian number (validated at
// checkout); Twilio needs E.164.
function toE164India(mobile) {
  return `+91${mobile}`
}

// Returns whether a real Twilio send happened (true) or the call fell back to
// the console-log stub (false) — callers that surface delivery status to an
// admin (e.g. the payment-link button) need this to avoid claiming "sent"
// when nothing actually went out.
async function sendOrderConfirmationSms(order) {
  if (!order || !order.customer_mobile) return false
  const trackUrl = `https://print.metalix.in/track/${order.id}`
  const client = getClient()
  if (!client || !process.env.TWILIO_ORDER_CONFIRMATION_TEMPLATE_SID) {
    console.log(`[sms] stub -> ${order.customer_mobile}: order ${order.id} confirmed, track ${trackUrl}`)
    return false
  }
  await client.messages.create({
    to: toE164India(order.customer_mobile),
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    contentSid: process.env.TWILIO_ORDER_CONFIRMATION_TEMPLATE_SID,
    contentVariables: JSON.stringify({ '1': order.id, '2': trackUrl })
  })
  return true
}

// Separate DLT template from order-confirmation — India's carrier-side
// filtering is content-locked per template, so a differently-worded message
// needs its own registered template/SID before it can actually deliver.
// Until TWILIO_PAYMENT_LINK_TEMPLATE_SID is set, this just logs — the admin
// can still copy/share the link manually from the dashboard.
async function sendPaymentLinkSms(order, linkUrl) {
  if (!order || !order.customer_mobile) return false
  const client = getClient()
  if (!client || !process.env.TWILIO_PAYMENT_LINK_TEMPLATE_SID) {
    console.log(`[sms] stub -> ${order.customer_mobile}: pay for order ${order.id} at ${linkUrl}`)
    return false
  }
  await client.messages.create({
    to: toE164India(order.customer_mobile),
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    contentSid: process.env.TWILIO_PAYMENT_LINK_TEMPLATE_SID,
    contentVariables: JSON.stringify({ '1': order.id, '2': linkUrl })
  })
  return true
}

module.exports = { sendOrderConfirmationSms, sendPaymentLinkSms }
