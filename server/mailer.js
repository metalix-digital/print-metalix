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

async function sendPasswordResetEmail(toEmail, resetUrl) {
  const transporter = getTransporter()
  if (!transporter) {
    console.log(`[mailer] stub -> ${toEmail}: Reset your password: ${resetUrl}`)
    return
  }
  await transporter.sendMail({
    from: `"Metalix Print (no-reply)" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Metalix Print password',
    html: `
      <p>We received a request to reset your Metalix Print password.</p>
      <p><a href="${resetUrl}">Click here to set a new password</a> (link expires in 1 hour).</p>
      <p>If you didn't request this, you can safely ignore this email.</p>
    `
  })
}

module.exports = { sendPasswordResetEmail }
