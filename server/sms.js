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

// Unlike the status SMS above, this only ever fires from an explicit staff
// action — the admin's "Send payment link" button on an existing order, or
// New Order's "send a payment link" option — never automatically, so it
// stays request-only by construction rather than needing its own gate here.
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

// Separate DLT template again, same reasoning as sendPaymentLinkSms — needs
// TWILIO_ORDER_COMPLETED_TEMPLATE_SID registered with this exact wording
// before it can actually deliver in India; until then it just logs.
async function sendOrderCompletedSms(order, invoiceUrl) {
  if (!order || !order.customer_mobile) return false
  const client = getClient()
  if (!client || !process.env.TWILIO_ORDER_COMPLETED_TEMPLATE_SID) {
    console.log(`[sms] stub -> ${order.customer_mobile}: order ${order.id} completed, download invoice ${invoiceUrl}`)
    return false
  }
  await client.messages.create({
    to: toE164India(order.customer_mobile),
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    contentSid: process.env.TWILIO_ORDER_COMPLETED_TEMPLATE_SID,
    contentVariables: JSON.stringify({ '1': order.id, '2': invoiceUrl })
  })
  return true
}

// Generic sender for the campaign tool — unlike the transactional sends
// above (each locked to its own fixed DLT template + fixed variable shape),
// a campaign's template and variables are both chosen by the admin at send
// time from the message_templates registry, so this just takes them as
// arguments. Same "no client/SID configured -> return false, caller records
// it as a skip rather than a send" contract as the rest of this file.
async function sendCampaignSms(mobile, contentSid, contentVariables) {
  if (!mobile) return false
  const client = getClient()
  if (!client || !contentSid) return false
  await client.messages.create({
    to: toE164India(mobile),
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    contentSid,
    contentVariables: JSON.stringify(contentVariables || {})
  })
  return true
}

// Whether Twilio credentials are present at all — doesn't guarantee any
// specific contentSid is valid/approved, just that a send attempt won't
// immediately no-op for lack of a client. The campaign UI uses this to warn
// before an admin builds a whole SMS campaign around nothing.
function isConfigured() {
  return !!getClient()
}

module.exports = { sendOrderConfirmationSms, sendPaymentLinkSms, sendOrderCompletedSms, sendCampaignSms, isConfigured }
