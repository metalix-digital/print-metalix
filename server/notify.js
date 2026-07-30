// Real implementation lives in sms.js (Twilio) — same fire-and-forget
// pattern as the email path below, so a failed/unconfigured SMS send can
// never break order creation.
function sendOrderConfirmationSms(order) {
  const sms = require('./sms')
  sms.sendOrderConfirmationSms(order).catch((err) => console.error(`[sms] order confirmation failed for ${order.id}:`, err.message))
}

// Real implementation lives in mailer.js (same Gmail SMTP as every other
// email) — this just keeps the call sites in server.js unchanged and fire-
// and-forgets the send so a failed email can never break order creation.
function sendOrderConfirmationEmail(order) {
  const mailer = require('./mailer')
  mailer.sendOrderConfirmationEmail(order).catch((err) => console.error(`[mailer] order confirmation failed for ${order.id}:`, err.message))
}

module.exports = { sendOrderConfirmationSms, sendOrderConfirmationEmail }
