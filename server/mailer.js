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
  ink: '#18181B',
  body: '#3F3F46',
  muted: '#71717A',
  line: '#E4E4E7',
  pageBg: '#F4F4F5',
  cardBg: '#FFFFFF'
}

// A single, reusable transactional-email template for password resets. Uses a
// table-based, inline-styled layout with a "bulletproof" CTA button so it
// renders consistently across Gmail / Outlook / Apple Mail, plus a plain-text
// alternative for accessibility and deliverability.
function resetEmailTemplate({ preheader, badge, heading, intro, buttonLabel, resetUrl, expiryNote, disclaimer }) {
  const badgeHtml = badge
    ? `<span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background:#FFF1E6;color:${BRAND.orangeDark};font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;vertical-align:middle;">${badge}</span>`
    : ''

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light only">
<title>${heading}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.pageBg};">
  <!-- Preheader: shown as the inbox preview, hidden in the body -->
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${BRAND.pageBg};font-size:1px;line-height:1px;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.pageBg};">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">

          <!-- Brand header -->
          <tr>
            <td style="padding:8px 4px 22px 4px;font-family:Arial,Helvetica,sans-serif;">
              <span style="font-size:22px;font-weight:800;color:${BRAND.ink};letter-spacing:-.02em;">Metalix<span style="color:${BRAND.orange};">.</span> Print</span>
              ${badgeHtml}
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background:${BRAND.cardBg};border:1px solid ${BRAND.line};border-radius:16px;overflow:hidden;">
              <!-- Accent bar -->
              <div style="height:4px;background:${BRAND.orange};line-height:4px;font-size:0;">&nbsp;</div>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:36px 40px 8px 40px;font-family:Arial,Helvetica,sans-serif;">
                    <h1 style="margin:0 0 14px 0;font-size:24px;line-height:1.25;color:${BRAND.ink};font-weight:800;letter-spacing:-.01em;">${heading}</h1>
                    <p style="margin:0 0 26px 0;font-size:15px;line-height:1.65;color:${BRAND.body};">${intro}</p>
                  </td>
                </tr>

                <!-- Bulletproof CTA button -->
                <tr>
                  <td style="padding:0 40px 8px 40px;">
                    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                      <tr>
                        <td align="center" bgcolor="${BRAND.orange}" style="border-radius:10px;">
                          <a href="${resetUrl}" target="_blank" style="display:inline-block;padding:14px 34px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:10px;">${buttonLabel}</a>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>

                <tr>
                  <td style="padding:18px 40px 4px 40px;font-family:Arial,Helvetica,sans-serif;">
                    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">${expiryNote}</p>
                  </td>
                </tr>

                <!-- Fallback link -->
                <tr>
                  <td style="padding:14px 40px 36px 40px;font-family:Arial,Helvetica,sans-serif;">
                    <p style="margin:0 0 6px 0;font-size:12px;color:${BRAND.muted};">Button not working? Copy and paste this link into your browser:</p>
                    <a href="${resetUrl}" style="font-size:12px;color:${BRAND.orangeDark};word-break:break-all;">${resetUrl}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:22px 8px;font-family:Arial,Helvetica,sans-serif;">
              <p style="margin:0 0 4px 0;font-size:12px;line-height:1.6;color:${BRAND.muted};">${disclaimer}</p>
              <p style="margin:0;font-size:12px;color:${BRAND.muted};">This is an automated message from Metalix Print — please don't reply.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  // Plain-text alternative (strip the HTML emphasis tags from intro/disclaimer).
  const strip = (s) => s.replace(/<[^>]+>/g, '')
  const text = [
    heading,
    '',
    strip(intro),
    '',
    `Set a new password: ${resetUrl}`,
    '',
    strip(expiryNote),
    '',
    strip(disclaimer),
    '',
    'This is an automated message from Metalix Print — please don\'t reply.'
  ].join('\n')

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
  await transporter.sendMail({
    from: `"Metalix Print (no-reply)" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Metalix Print password',
    html,
    text
  })
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
  await transporter.sendMail({
    from: `"Metalix Print (no-reply)" <${process.env.GMAIL_USER}>`,
    to: toEmail,
    subject: 'Reset your Metalix Print ADMIN password',
    html,
    text
  })
}

module.exports = { sendPasswordResetEmail, sendAdminPasswordResetEmail, resetEmailTemplate }
