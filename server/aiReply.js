// Drafts a suggested reply to a Google review — the review's own text is
// never touched or regenerated, only the business's reply. An admin always
// reviews/edits the draft before it's posted live (server.js's
// POST /api/admin/google-reviews/:id/reply), so this only needs to be a
// good starting point, not a final, unreviewed output.
const MODEL = 'claude-haiku-4-5-20251001'

function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY
}

const SYSTEM_PROMPT = `You write short, genuine-sounding replies to Google reviews for Metalix Print, an online print shop (upload a file, get it printed and delivered). Rules:
- 2-4 sentences, warm but professional, not corporate or generic.
- Thank the reviewer by first name if given, and reference something specific from their review.
- Never invent facts, promises, policies, order details, or discounts you weren't told about.
- Never include a phone number, email, URL, or any contact details (Google rejects replies containing them).
- For a critical review, acknowledge the specific issue and keep it brief and non-defensive — do not over-apologize or make commitments about compensation.
- Output only the reply text, nothing else (no quotes, no preamble).`

async function draftReply({ reviewerName, rating, reviewText }) {
  const userMessage = `Reviewer: ${reviewerName || 'Anonymous'}\nRating: ${rating || '?'}/5\nReview: ${reviewText || '(no text, star rating only)'}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }]
    })
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error?.message || 'AI reply drafting failed')
    err.code = 'ai_reply_draft_failed'
    throw err
  }
  return data.content?.[0]?.text?.trim() || ''
}

module.exports = { isConfigured, draftReply }
