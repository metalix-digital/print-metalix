// No SMS/email provider is configured yet (see README). These are the integration
// points: swap in a real provider (e.g. MSG91/Twilio for SMS, SES/SMTP for email)
// without touching call sites elsewhere in the server.
function sendOrderConfirmationSms(order) {
  console.log(`[notify] SMS stub -> ${order.customer_mobile}: Order ${order.id} confirmed, total ₹${order.total_amount}, status: ${order.order_status}`)
}

function sendOrderConfirmationEmail(order) {
  if (!order.customer_email) return
  console.log(`[notify] Email stub -> ${order.customer_email}: Order ${order.id} confirmed, total ₹${order.total_amount}, status: ${order.order_status}`)
}

module.exports = { sendOrderConfirmationSms, sendOrderConfirmationEmail }
