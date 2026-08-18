// WhatsApp delivery via Twilio's WhatsApp Business API — same Content
// Template requirement as sms.js's DLT templates, for a different reason:
// Meta's commerce policy blocks any message sent outside a customer-
// initiated 24h session unless it uses a pre-approved template, so every
// send here needs a contentSid that's already been submitted and approved
// via the Twilio/Meta console. This app has no WhatsApp sender of its own
// yet — TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_WHATSAPP_NUMBER are the
// same env var names the sibling Metalix (vehicle-tag) app already uses for
// its own, already-approved WhatsApp integration, so the same Twilio
// account's credentials can be reused here once copied into this app's
// environment — approved template content is specific to what's registered
// per contentSid though, so a template approved for that app's wording
// still can't be reused for different campaign content without its own
// approval. Falls back to a stub (returns false, sends nothing) exactly
// like sms.js/mailer.js when unconfigured.
let cachedClient = null
function getClient() {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return null
  if (cachedClient) return cachedClient
  const twilio = require('twilio')
  cachedClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  return cachedClient
}

function toE164India(mobile) {
  return `+91${mobile}`
}

// Generic sender for the campaign tool, same shape as sms.js's
// sendCampaignSms — contentSid and variables are chosen by the admin at
// send time from the message_templates registry, not fixed per call site.
async function sendCampaignWhatsapp(mobile, contentSid, contentVariables) {
  if (!mobile) return false
  const client = getClient()
  if (!client || !process.env.TWILIO_WHATSAPP_NUMBER || !contentSid) return false
  await client.messages.create({
    to: `whatsapp:${toE164India(mobile)}`,
    from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
    contentSid,
    contentVariables: JSON.stringify(contentVariables || {})
  })
  return true
}

// Whether a real send is even possible right now — the campaign UI uses
// this to show "WhatsApp isn't configured yet" rather than let an admin
// build a whole campaign that can only ever fail at send time.
function isConfigured() {
  return !!(getClient() && process.env.TWILIO_WHATSAPP_NUMBER)
}

module.exports = { sendCampaignWhatsapp, isConfigured }
