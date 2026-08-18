// Campaign send orchestration — resolves the (opt-in-only) audience, fans
// out to the right channel sender per recipient, and records a per-
// recipient result so a campaign has a real delivery report, not just a
// "sent" toast. No job queue: audiences here are opt-in-gated (small by
// construction for a shop this size), so a plain batched loop with a short
// pause between batches is enough to stay polite to Gmail/Twilio without
// needing infrastructure. server.js kicks this off fire-and-forget (same
// pattern as notify.js) and the admin UI polls the campaign's status/
// recipients rather than blocking the request on however long a full send
// takes.
const crypto = require('crypto')
const db = require('./db')
const mailer = require('./mailer')
const sms = require('./sms')
const whatsapp = require('./whatsapp')

const PROD_HOST = 'https://print.metalix.in'

function getSecret() {
  return process.env.ADMIN_JWT_SECRET || 'dev-only-insecure-secret'
}

// Unsubscribe links have to keep working indefinitely (a customer might not
// open an email for weeks), so this is a plain HMAC rather than a JWT with
// an expiry — no expiry to get wrong.
function unsubscribeToken(userId) {
  return crypto.createHmac('sha256', getSecret()).update(userId).digest('hex').slice(0, 24)
}
function verifyUnsubscribeToken(userId, token) {
  const expected = unsubscribeToken(userId)
  if (!token || token.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}
function buildUnsubscribeUrl(userId) {
  return `${PROD_HOST}/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubscribeToken(userId)}`
}

// Best-effort physical business address for the email compliance footer —
// there's no single "registered company address" field in Settings, so this
// uses the first active branch's address rather than fabricating one.
function primaryBusinessAddress() {
  const active = (db.getLocations() || []).filter((l) => l.active)
  const l = active[0]
  if (!l) return ''
  return [l.address, l.city, l.pincode].filter(Boolean).join(', ')
}

const BATCH_SIZE = 20
const BATCH_DELAY_MS = 1500
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runCampaignSend(campaignId) {
  const campaign = db.getCampaign(campaignId)
  if (!campaign || campaign.status !== 'draft') throw new Error('Campaign is not in a sendable state')

  const contactField = campaign.channel === 'email' ? 'email' : 'mobile'
  const audience = db.getCampaignAudience(campaign.channel, campaign.audienceFilter)
  const recipients = db.insertCampaignRecipients(campaignId, audience.map((c) => ({ id: c.id, contact: c[contactField] })))

  db.setCampaignStatus(campaignId, 'sending')

  let template = null
  if (campaign.channel !== 'email') {
    template = db.getMessageTemplate(campaign.template_id)
    if (!template) {
      recipients.forEach((r) => db.updateCampaignRecipient(r.id, { status: 'failed', error: 'Template not found' }))
      db.setCampaignStatus(campaignId, 'failed', { sentAt: Date.now(), stats: { total: recipients.length, sent: 0, failed: recipients.length, skipped: 0 } })
      return
    }
  }

  const businessAddress = primaryBusinessAddress()
  let sent = 0, failed = 0, skipped = 0
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE)
    for (const r of batch) {
      try {
        let ok = false
        if (campaign.channel === 'email') {
          ok = await mailer.sendCampaignEmail({
            to: r.contact, subject: campaign.subject, bodyHtml: campaign.body_html,
            unsubscribeUrl: buildUnsubscribeUrl(r.customer_id), businessAddress
          })
        } else if (campaign.channel === 'whatsapp') {
          ok = await whatsapp.sendCampaignWhatsapp(r.contact, template.content_sid, campaign.templateVars)
        } else if (campaign.channel === 'sms') {
          ok = await sms.sendCampaignSms(r.contact, template.content_sid, campaign.templateVars)
        }
        if (ok) {
          db.updateCampaignRecipient(r.id, { status: 'sent', sentAt: Date.now() })
          sent++
        } else {
          db.updateCampaignRecipient(r.id, { status: 'skipped', error: `${campaign.channel} is not configured` })
          skipped++
        }
      } catch (err) {
        db.updateCampaignRecipient(r.id, { status: 'failed', error: err.message })
        failed++
      }
    }
    if (i + BATCH_SIZE < recipients.length) await sleep(BATCH_DELAY_MS)
  }

  const stats = { total: recipients.length, sent, failed, skipped }
  db.setCampaignStatus(campaignId, sent > 0 || recipients.length === 0 ? 'sent' : 'failed', { sentAt: Date.now(), stats })
  return stats
}

module.exports = { buildUnsubscribeUrl, verifyUnsubscribeToken, runCampaignSend, primaryBusinessAddress }
