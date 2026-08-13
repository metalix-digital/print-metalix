// Real email delivery via Gmail SMTP (app password). Falls back to a
// console-log stub — same pattern as notify.js — when GMAIL_USER/
// GMAIL_APP_PASSWORD aren't set (e.g. local dev without those secrets).
const { formatRupees } = require('./format')
let cachedTransporter = null
function getTransporter() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null
  if (cachedTransporter) return cachedTransporter
  const nodemailer = require('nodemailer')
  cachedTransporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  })
  return cachedTransporter
}

// Metalix brand palette (kept inline — email clients strip <style>/<head>).
const BRAND = {
  orange: '#FF6600',
  orangeDark: '#E05500',
  green: '#16A34A',
  red: '#DC2626',
  ink: '#18181B',
  body: '#3F3F46',
  muted: '#71717A',
  line: '#E4E4E7',
  softBg: '#FAFAFA',
  pageBg: '#F4F4F5',
  cardBg: '#FFFFFF'
}

// A "bulletproof" CTA button (renders in Outlook/Gmail/Apple Mail).
function button(label, url, color = BRAND.orange) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" bgcolor="${color}" style="border-radius:10px;">
      <a href="${url}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${label}</a>
    </td></tr>
  </table>`
}

// Shared page shell: branded header, white card with an accent bar, and a
// footer. Callers supply the card's inner rows (cardHtml) and the footer copy.
function renderEmailShell({ preheader, badge, accent = BRAND.orange, cardHtml, footerHtml }) {
  const badgeHtml = badge
    ? `<span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background:#FFF1E6;color:${BRAND.orangeDark};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;vertical-align:middle;">${badge}</span>`
    : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.pageBg};font-size:1px;line-height:1px;">${preheader}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
          <tr>
            <td style="padding:8px 4px 22px 4px;font-family:Arial,Helvetica,sans-serif;">
              <span style="font-size:22px;font-weight:800;color:${BRAND.ink};letter-spacing:-.02em;">Metalix<span style="color:${BRAND.orange};">.</span> Print</span>${badgeHtml}
            </td>
          </tr>
          <tr>
            <td style="background:${BRAND.cardBg};border:1px solid ${BRAND.line};border-radius:16px;overflow:hidden;">
              <div style="height:4px;background:${accent};line-height:4px;font-size:0;">&nbsp;</div>
              ${cardHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:22px 8px;font-family:Arial,Helvetica,sans-serif;">
              ${footerHtml}
              <p style="margin:6px 0 0 0;font-size:12px;color:${BRAND.muted};">This is an automated message from Metalix Print — please don't reply.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

// ---- Password reset (admin + customer) ----------------------------------

function resetEmailTemplate({ preheader, badge, heading, intro, buttonLabel, resetUrl, expiryNote, disclaimer }) {
  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:36px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
      <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">${heading}</h1>
      <p style="margin:0 0 26px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">${intro}</p>
    </td></tr>
    <tr><td style="padding:0 40px 8px 40px;">${button(buttonLabel, resetUrl)}</td></tr>
    <tr><td style="padding:18px 40px 4px 40px;font-family:Arial,Helvetica,sans-serif;">
      <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${expiryNote}</p>
    </td></tr>
    <tr><td style="padding:14px 40px 36px 40px;font-family:Arial,Helvetica,sans-serif;">
      <p style="margin:0 0 6px 0;font-size:12px;color:${BRAND.muted};">Button not working? Copy and paste this link into your browser:</p>
      <a href="${resetUrl}" style="font-size:12px;color:${BRAND.orangeDark};word-break:break-all;">${resetUrl}</a>
    </td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">${disclaimer}</p>`
  const html = renderEmailShell({ preheader, badge, cardHtml, footerHtml })

  const strip = (s) => s.replace(/<[^>]+>/g, '')
  const text = [heading, '', strip(intro), '', `Set a new password: ${resetUrl}`, '', strip(expiryNote), '', strip(disclaimer), '', "This is an automated message from Metalix Print — please don't reply."].join('\n')
  return { html, text }
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${toEmail}: Reset your password: ${resetUrl}`)
    return
  }
  const { html, text } = resetEmailTemplate({
    preheader: 'Reset your Metalix Print password — this link expires in 1 hour.',
    heading: 'Reset your password',
    intro: 'We received a request to reset your Metalix Print account password. Click the button below to choose a new one.',
    buttonLabel: 'Set a new password',
    resetUrl,
    expiryNote: 'For your security, this link expires in 1 hour and can only be used once.',
    disclaimer: "If you didn't request this, you can safely ignore this email — your password won't change."
  })
  await transporter.sendMail({ from: `"Metalix Print (no-reply)" <${process.env.GMAIL_USER}>`, to: toEmail, subject: 'Reset your Metalix Print password', html, text })
}

async function sendAdminPasswordResetEmail(toEmail, resetUrl) {
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${toEmail}: Reset admin password: ${resetUrl}`)
    return
  }
  const { html, text } = resetEmailTemplate({
    preheader: 'Reset your Metalix Print admin password — this link expires in 1 hour.',
    badge: 'Admin',
    heading: 'Reset your admin password',
    intro: 'We received a request to reset the password for the Metalix Print <strong>admin dashboard</strong>. Click the button below to choose a new password.',
    buttonLabel: 'Set a new admin password',
    resetUrl,
    expiryNote: 'For security, this link expires in 1 hour and can only be used once.',
    disclaimer: "If you didn't request this, you can safely ignore this email — the admin password won't change."
  })
  await transporter.sendMail({ from: `"Metalix Print (no-reply)" <${process.env.GMAIL_USER}>`, to: toEmail, subject: 'Reset your Metalix Print ADMIN password', html, text })
}

// ---- Order status updates -----------------------------------------------

// Customer-facing copy for each status. Keys match order_status values set by
// the app (server.js / printQueue.js). Unlisted statuses fall back to generic.
const STATUS_COPY = {
  'Queued For Printing': { title: "You're in the queue", line: "We've received your order and it's queued for printing. We'll let you know as it progresses.", accent: BRAND.orange },
  'Printing': { title: 'Your order is printing', line: 'Good news — your documents are on the press right now.', accent: BRAND.orange },
  'Awaiting Customer Pickup': { title: 'Ready for pickup', line: 'Your order is printed and ready to collect at our store.', accent: BRAND.orange },
  'Out For Delivery': { title: 'Out for delivery', line: "Your order is on its way and should reach you shortly.", accent: BRAND.orange },
  'Completed': { title: 'Order completed', line: 'Your order is complete. Thank you for choosing Metalix Print!', accent: BRAND.green },
  'Manual Intervention Required': { title: 'We need a moment', line: "We've hit a snag with your order and our team is looking into it. We'll be in touch shortly.", accent: BRAND.red },
  'Failed': { title: 'There was a problem', line: 'We ran into a problem processing your order. Our team will reach out with next steps.', accent: BRAND.red }
}

function orderStatusTemplate(order, trackUrl, opts) {
  opts = opts || {}
  const invoiceLine = opts.invoice ? ' A copy of your invoice is attached to this email.' : ''
  const copy = { ...(STATUS_COPY[order.order_status] || { title: 'Order update', line: `Your order status is now "${order.order_status}".`, accent: BRAND.orange }) }
  // "Completed" means delivered (delivery) or collected (pickup) — say which.
  if (order.order_status === 'Completed') {
    if (order.delivery_method === 'delivery') copy.line = 'Your order has been delivered. Thank you for choosing Metalix Print!'
    else if (order.delivery_method === 'pickup') copy.line = 'Your order has been collected. Thank you for choosing Metalix Print!'
  }
  const name = order.customer_name ? String(order.customer_name).split(' ')[0] : 'there'
  const pill = `<span style="display:inline-block;padding:5px 12px;border-radius:999px;background:${copy.accent};color:#ffffff;font-size:12px;font-weight:700;letter-spacing:.02em;">${order.order_status}</span>`
  const total = (order.total_amount === 0 || order.total_amount) ? `₹${formatRupees(order.total_amount)}` : '—'
  // Once completed, "Track your order" is moot — the tracking page shows a
  // rating form instead, so point the button there.
  const isCompleted = order.order_status === 'Completed'
  const trackBtnLabel = isCompleted ? 'Rate your order' : 'Track your order'
  const trackBtn = trackUrl ? `<tr><td style="padding:4px 40px 8px 40px;">${button(trackBtnLabel, trackUrl, copy.accent)}</td></tr>` : ''
  // Only meaningful once the order is actually sitting at the store waiting
  // to be collected — irrelevant for every other status, including delivery.
  // Same button treatment as "Track your order" (not a small text link), just
  // outlined instead of solid so the two don't visually compete.
  const directionsRow = (order.order_status === 'Awaiting Customer Pickup' && opts.mapsUrl)
    ? `<tr><td style="padding:4px 40px 8px 40px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td align="center" style="border-radius:10px;border:2px solid ${copy.accent};">
            <a href="${opts.mapsUrl}" target="_blank" style="display:inline-block;padding:12px 32px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:${copy.accent};text-decoration:none;border-radius:10px;">🗺️ Get directions to the store</a>
          </td></tr>
        </table>
      </td></tr>`
    : ''

  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:34px 40px 6px 40px;font-family:Arial,Helvetica,sans-serif;">
      ${pill}
      <h1 style="margin:16px 0 10px 0;font-size:23px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">${copy.title}</h1>
      <p style="margin:0 0 22px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">Hi ${name}, ${copy.line}${invoiceLine}</p>
    </td></tr>
    ${trackBtn}
    ${directionsRow}
    <tr><td style="padding:18px 40px 34px 40px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.softBg};border:1px solid ${BRAND.line};border-radius:10px;">
        <tr>
          <td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">Order ID<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${order.id}</span></td>
          <td align="right" style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">Order total<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${total}</span></td>
        </tr>
      </table>
    </td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">Questions about your order? Reply to the message you received from our team, or contact Metalix Print support.</p>`
  const html = renderEmailShell({ preheader: `${copy.title} — order ${order.id}`, accent: copy.accent, cardHtml, footerHtml })

  const text = [`${copy.title}`, '', `Hi ${name}, ${copy.line}${invoiceLine}`, '', `Order ID: ${order.id}`, `Status: ${order.order_status}`, `Order total: ${total}`, trackUrl ? `\n${trackBtnLabel}: ${trackUrl}` : '', (order.order_status === 'Awaiting Customer Pickup' && opts.mapsUrl) ? `Get directions: ${opts.mapsUrl}` : '', "\nThis is an automated message from Metalix Print — please don't reply."].join('\n')
  return { html, text, subject: `Order ${order.id}: ${order.order_status}` }
}

// Emails the customer that their order status changed. No-op (with a stub log)
// when the customer has no email on file or SMTP isn't configured.
async function sendOrderStatusEmail(order, trackUrl, attachments, mapsUrl) {
  if (!order || !order.customer_email) return
  const hasInvoice = !!(attachments && attachments.length)
  const { html, text, subject } = orderStatusTemplate(order, trackUrl, { invoice: hasInvoice, mapsUrl })
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${order.customer_email}: ${subject}${hasInvoice ? ' (+invoice attached)' : ''}`)
    return
  }
  await transporter.sendMail({ from: `"Metalix Print" <${process.env.GMAIL_USER}>`, to: order.customer_email, subject, html, text, attachments: attachments || [] })
}

// Emails a website "contact us" submission to the business inbox. Reply-To is
// set to the sender when they gave an email, so staff can reply directly.
async function sendContactMessageEmail({ name, email, phone, message }) {
  const to = process.env.CONTACT_EMAIL || 'support@metalix.in'
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const row = (label, valueHtml) => `<tr><td style="padding:10px 16px;border-bottom:1px solid ${BRAND.line};font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">${label}<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${valueHtml}</span></td></tr>`
  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:34px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
      <h1 style="margin:0 0 18px 0;font-size:22px;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">New contact message</h1>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.softBg};border:1px solid ${BRAND.line};border-radius:10px;margin-bottom:18px;">
        ${row('Name', esc(name))}
        ${row('Email', `<a href="mailto:${esc(email)}" style="color:${BRAND.orangeDark};text-decoration:none;">${esc(email)}</a>`)}
        ${row('Phone', `<a href="tel:${esc(phone)}" style="color:${BRAND.orangeDark};text-decoration:none;">${esc(phone)}</a>`)}
      </table>
      <p style="margin:0 0 6px 0;font-size:12px;color:${BRAND.muted};font-family:Arial,Helvetica,sans-serif;">Message</p>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:${BRAND.body};padding-bottom:34px;">${esc(message).replace(/\n/g, '<br>')}</div>
    </td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">Sent from the print.metalix.in contact form. Reply to this email to respond to the customer.</p>`
  const html = renderEmailShell({ preheader: `New message from ${name}`, cardHtml, footerHtml })
  const text = `New contact message\n\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\n\n${message}`

  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${to}: contact from ${name} <${email}> ${phone}: ${message}`)
    return
  }
  await transporter.sendMail({
    from: `"Metalix Print (website)" <${process.env.GMAIL_USER}>`,
    to,
    replyTo: email,
    subject: `New website message from ${name}`,
    html,
    text
  })
}

// Alerts the business inbox the moment a new order is confirmed (paid online,
// COD, or via the Cashfree webhook) — same recipient as the "contact us" form,
// so staff have one inbox to watch rather than a second address to configure.
async function sendNewOrderAlertEmail(order) {
  const to = process.env.CONTACT_EMAIL || 'support@metalix.in'
  const isCod = order.payment_method === 'cod'
  const deliveryLine = order.delivery_method === 'delivery'
    ? 'Home delivery' + (order.delivery_timing === 'scheduled' ? ' (scheduled)' : ' (instant)')
    : 'Shop pickup'
  const row = (label, valueHtml) => `<tr><td style="padding:10px 16px;border-bottom:1px solid ${BRAND.line};font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">${label}<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${valueHtml}</span></td></tr>`
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:34px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
      <h1 style="margin:0 0 18px 0;font-size:22px;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">New order arrived</h1>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.softBg};border:1px solid ${BRAND.line};border-radius:10px;margin-bottom:8px;">
        ${row('Order ID', esc(order.id))}
        ${row('Customer', esc(order.customer_name) + (order.customer_mobile ? ' · ' + esc(order.customer_mobile) : ''))}
        ${row('Total', `₹${formatRupees(order.total_amount)}` + (isCod ? ' (pay on delivery)' : ' (paid online)'))}
        ${row('Fulfilment', esc(deliveryLine) + (order.location_name ? ' · ' + esc(order.location_name) : ''))}
        ${order.notes ? row('Customer notes', esc(order.notes).replace(/\n/g, '<br>')) : ''}
      </table>
    </td></tr>
    <tr><td style="padding:4px 40px 34px 40px;">${button('Open admin dashboard', 'https://print.metalix.in/admin')}</td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">Sent automatically whenever a new order is confirmed.</p>`
  const html = renderEmailShell({ preheader: `Order ${order.id} — ₹${formatRupees(order.total_amount)}`, badge: 'New order', cardHtml, footerHtml })
  const text = `New order arrived\n\nOrder ID: ${order.id}\nCustomer: ${order.customer_name} (${order.customer_mobile})\nTotal: ₹${formatRupees(order.total_amount)} (${isCod ? 'pay on delivery' : 'paid online'})\nFulfilment: ${deliveryLine}${order.location_name ? ' · ' + order.location_name : ''}${order.notes ? '\nCustomer notes: ' + order.notes : ''}\n\nOpen admin dashboard: https://print.metalix.in/admin`

  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${to}: new order ${order.id} (₹${formatRupees(order.total_amount)})`)
    return
  }
  await transporter.sendMail({ from: `"Metalix Print" <${process.env.GMAIL_USER}>`, to, subject: `New order ${order.id} — ₹${formatRupees(order.total_amount)}`, html, text })
}

// ---- Order confirmation (sent once, to the customer, right at placement) --
// The only customer-facing email that fires immediately when an order is
// placed (COD or a successful online payment) — everything else
// (orderStatusTemplate above) only fires later, on a status change an admin
// triggers. Must therefore be the one place delivery timing/address actually
// gets communicated for a scheduled delivery.

// Customers always pick a delivery slot in IST, so this must render in IST
// regardless of what timezone the server process itself happens to be
// running in (a bare Date.getHours()/getMinutes() would use the server's
// local time, which is UTC by default on most cloud VMs — 5:30h off).
function formatScheduledTime(ms) {
  if (!ms) return ''
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(new Date(ms))
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || ''
  return `${get('day')} ${get('month')} · ${get('hour')}:${get('minute')} ${get('dayPeriod').toUpperCase()}`
}

function orderConfirmationTemplate(order, trackUrl) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const name = order.customer_name ? String(order.customer_name).split(' ')[0] : 'there'
  const isCod = order.payment_method === 'cod'
  const isDelivery = order.delivery_method === 'delivery'

  // Delivery charge is 0 both for a free-delivery-threshold order and for an
  // unset/legacy charge — only call it out as "Free delivery" once we know
  // it's actually a delivery order, so it never appears for pickup.
  const isFreeDelivery = isDelivery && Number(order.delivery_charge) === 0
  const fulfilmentLines = isDelivery
    ? [
        isFreeDelivery ? 'Home delivery — 🎉 free delivery' : 'Home delivery',
        [order.delivery_address, order.delivery_city, order.delivery_state, order.delivery_pincode].filter(Boolean).join(', '),
        order.delivery_timing === 'scheduled'
          ? `Scheduled for ${formatScheduledTime(order.scheduled_at)}`
          : 'Instant delivery (within 2 hrs)'
      ].filter(Boolean)
    : ['Shop pickup', order.location_name ? `From ${order.location_name}` : null].filter(Boolean)

  const row = (label, valueHtml) => `<tr><td style="padding:10px 16px;border-bottom:1px solid ${BRAND.line};font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">${label}<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${valueHtml}</span></td></tr>`

  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:34px 40px 6px 40px;font-family:Arial,Helvetica,sans-serif;">
      <h1 style="margin:0 0 10px 0;font-size:23px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">Order confirmed!</h1>
      <p style="margin:0 0 22px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">Hi ${esc(name)}, we've got your order — it's queued for printing now.</p>
    </td></tr>
    <tr><td style="padding:4px 40px 8px 40px;">${button('Track your order', trackUrl, BRAND.green)}</td></tr>
    <tr><td style="padding:18px 40px 34px 40px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.softBg};border:1px solid ${BRAND.line};border-radius:10px;">
        ${row('Order ID', esc(order.id))}
        ${row('Total', `₹${formatRupees(order.total_amount)}` + (isCod ? ' (pay on ' + (isDelivery ? 'delivery' : 'pickup') + ')' : ' (paid online)'))}
        ${row('Fulfilment', fulfilmentLines.map(esc).join('<br>'))}
      </table>
    </td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">Questions about your order? Reply to the message you received from our team, or contact Metalix Print support.</p>`
  const html = renderEmailShell({ preheader: `Order ${order.id} confirmed — ₹${formatRupees(order.total_amount)}`, accent: BRAND.green, cardHtml, footerHtml })
  const text = [
    'Order confirmed!', '',
    `Hi ${name}, we've got your order — it's queued for printing now.`, '',
    `Order ID: ${order.id}`,
    `Total: ₹${formatRupees(order.total_amount)}${isCod ? ' (pay on ' + (isDelivery ? 'delivery' : 'pickup') + ')' : ' (paid online)'}`,
    `Fulfilment: ${fulfilmentLines.join(' · ')}`,
    `\nTrack your order: ${trackUrl}`,
    "\nThis is an automated message from Metalix Print — please don't reply."
  ].join('\n')
  return { html, text, subject: `Order confirmed — ${order.id}` }
}

async function sendOrderConfirmationEmail(order) {
  if (!order || !order.customer_email) return
  const trackUrl = `https://print.metalix.in/track/${order.id}`
  const { html, text, subject } = orderConfirmationTemplate(order, trackUrl)
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${order.customer_email}: ${subject}`)
    return
  }
  await transporter.sendMail({ from: `"Metalix Print" <${process.env.GMAIL_USER}>`, to: order.customer_email, subject, html, text })
}

// ---- Invoice (sent on demand by an admin, independent of status emails) --

function invoiceEmailTemplate(order) {
  const name = order.customer_name ? String(order.customer_name).split(' ')[0] : 'there'
  const total = (order.total_amount === 0 || order.total_amount) ? `₹${formatRupees(order.total_amount)}` : '—'
  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:34px 40px 6px 40px;font-family:Arial,Helvetica,sans-serif;">
      <h1 style="margin:0 0 10px 0;font-size:23px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">Your invoice</h1>
      <p style="margin:0 0 22px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">Hi ${name}, here's a copy of your invoice for order ${order.id} — see the attached PDF.</p>
    </td></tr>
    <tr><td style="padding:18px 40px 34px 40px;font-family:Arial,Helvetica,sans-serif;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.softBg};border:1px solid ${BRAND.line};border-radius:10px;">
        <tr>
          <td style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">Order ID<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${order.id}</span></td>
          <td align="right" style="padding:14px 16px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${BRAND.muted};">Order total<br><span style="font-size:14px;color:${BRAND.ink};font-weight:700;">${total}</span></td>
        </tr>
      </table>
    </td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">Questions about your order? Reply to the message you received from our team, or contact Metalix Print support.</p>`
  const html = renderEmailShell({ preheader: `Your invoice for order ${order.id}`, cardHtml, footerHtml })
  const text = ['Your invoice', '', `Hi ${name}, here's a copy of your invoice for order ${order.id} — see the attached PDF.`, '', `Order ID: ${order.id}`, `Order total: ${total}`, "\nThis is an automated message from Metalix Print — please don't reply."].join('\n')
  return { html, text, subject: `Invoice — Order ${order.id}` }
}

// Emails a PDF invoice to the customer on demand (admin-triggered), separate
// from the automatic invoice that ships with the "Completed" status email.
async function sendInvoiceEmail(order, invoiceBuffer) {
  if (!order || !order.customer_email) return
  const { html, text, subject } = invoiceEmailTemplate(order)
  const attachments = [{ filename: `Invoice-${order.id}.pdf`, content: invoiceBuffer }]
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${order.customer_email}: ${subject} (+invoice attached)`)
    return
  }
  await transporter.sendMail({ from: `"Metalix Print" <${process.env.GMAIL_USER}>`, to: order.customer_email, subject, html, text, attachments })
}

// ---- Custom Stamp proof-approval ----------------------------------------

function stampProofReadyTemplate(order, trackUrl) {
  const name = order.customer_name || 'there'
  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:36px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
      <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">Your stamp proof is ready</h1>
      <p style="margin:0 0 26px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">Hi ${name}, we've uploaded a proof for the custom stamp in order ${order.id}. Please review it carefully and approve it, or let us know if anything needs to change — production only starts once you approve.</p>
    </td></tr>
    <tr><td style="padding:0 40px 8px 40px;">${button('Review your stamp proof', trackUrl)}</td></tr>
    <tr><td style="padding:18px 40px 36px 40px;font-family:Arial,Helvetica,sans-serif;">
      <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">Please check the spelling and every detail carefully before approving — once production starts, changes may not be possible.</p>
    </td></tr>
  </table>`
  const footerHtml = `<p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted};">Questions about your order? Contact Metalix Print support.</p>`
  const html = renderEmailShell({ preheader: `Review your stamp proof for order ${order.id}`, badge: 'Action needed', cardHtml, footerHtml })
  const text = ['Your stamp proof is ready', '', `Hi ${name}, please review the proof for order ${order.id}:`, trackUrl, '', 'Check spelling and every detail carefully before approving.', "\nThis is an automated message from Metalix Print — please don't reply."].join('\n')
  return { html, text, subject: `Action needed — Review your stamp proof (Order ${order.id})` }
}

async function sendStampProofReadyEmail(order, trackUrl) {
  if (!order || !order.customer_email) return
  const { html, text, subject } = stampProofReadyTemplate(order, trackUrl)
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${order.customer_email}: ${subject}`)
    return
  }
  await transporter.sendMail({ from: `"Metalix Print" <${process.env.GMAIL_USER}>`, to: order.customer_email, subject, html, text })
}

module.exports = { sendPasswordResetEmail, sendAdminPasswordResetEmail, sendOrderStatusEmail, sendContactMessageEmail, sendNewOrderAlertEmail, sendOrderConfirmationEmail, sendInvoiceEmail, sendStampProofReadyEmail }
