// Real email delivery via Gmail SMTP (app password). Falls back to a
// console-log stub — same pattern as notify.js — when GMAIL_USER/
// GMAIL_APP_PASSWORD aren't set (e.g. local dev without those secrets).
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
  const total = (order.total_amount === 0 || order.total_amount) ? `₹${order.total_amount}` : '—'
  const trackBtn = trackUrl ? `<tr><td style="padding:4px 40px 8px 40px;">${button('Track your order', trackUrl, copy.accent)}</td></tr>` : ''

  const cardHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td style="padding:34px 40px 6px 40px;font-family:Arial,Helvetica,sans-serif;">
      ${pill}
      <h1 style="margin:16px 0 10px 0;font-size:23px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">${copy.title}</h1>
      <p style="margin:0 0 22px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">Hi ${name}, ${copy.line}${invoiceLine}</p>
    </td></tr>
    ${trackBtn}
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

  const text = [`${copy.title}`, '', `Hi ${name}, ${copy.line}${invoiceLine}`, '', `Order ID: ${order.id}`, `Status: ${order.order_status}`, `Order total: ${total}`, trackUrl ? `\nTrack your order: ${trackUrl}` : '', "\nThis is an automated message from Metalix Print — please don't reply."].join('\n')
  return { html, text, subject: `Order ${order.id}: ${order.order_status}` }
}

// Emails the customer that their order status changed. No-op (with a stub log)
// when the customer has no email on file or SMTP isn't configured.
async function sendOrderStatusEmail(order, trackUrl, attachments) {
  if (!order || !order.customer_email) return
  const hasInvoice = !!(attachments && attachments.length)
  const { html, text, subject } = orderStatusTemplate(order, trackUrl, { invoice: hasInvoice })
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

module.exports = { sendPasswordResetEmail, sendAdminPasswordResetEmail, sendOrderStatusEmail, sendContactMessageEmail }
