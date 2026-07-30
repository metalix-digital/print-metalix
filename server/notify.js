// No SMS provider is configured yet (see README) — this is the integration
// point: swap in a real provider (e.g. MSG91/Twilio) without touching call
// sites elsewhere in the server.
function sendOrderConfirmationSms(order) {
  console.log(`[notify] SMS stub -> ${order.customer_mobile}: Order ${order.id} confirmed, total ₹${order.total_amount}, status: ${order.order_status}`)
}

// Real implementation lives in mailer.js (same Gmail SMTP as every other
// email) — this just keeps the call sites in server.js unchanged and fire-
// and-forgets the send so a failed email can never break order creation.
function sendOrderConfirmationEmail(order) {
  const mailer = require('./mailer')
  mailer.sendOrderConfirmationEmail(order).catch((err) => console.error(`[mailer] order confirmation failed for ${order.id}:`, err.message))
}

module.exports = { sendOrderConfirmationSms, sendOrderConfirmationEmail }
