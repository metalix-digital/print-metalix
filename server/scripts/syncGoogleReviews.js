// Pulls new/updated reviews from the connected Google Business Profile
// location and drafts an AI reply for any that don't have one yet, so a
// draft is already waiting when the admin opens the Google Reviews tab.
// Runs on a systemd timer (see deploy/metalix-reviews-sync.*.example);
// also exported as runSync() for the admin panel's on-demand "Sync now".
const db = require('../db')
const googleBusinessAuth = require('../googleBusinessAuth')
const aiReply = require('../aiReply')

async function runSync() {
  const auth = db.getGoogleBusinessAuth()
  if (!auth || !auth.refreshToken) {
    console.log('[reviews-sync] not connected, skipping')
    return { synced: 0, drafted: 0 }
  }

  const accessToken = await googleBusinessAuth.refreshAccessToken(auth.refreshToken)

  let synced = 0
  let pageToken = null
  do {
    const { reviews, nextPageToken } = await googleBusinessAuth.fetchReviews({
      accessToken,
      accountId: auth.accountId,
      locationId: auth.locationId,
      pageToken
    })
    for (const review of reviews) {
      db.upsertGoogleReview({
        id: review.reviewId,
        location_id: auth.locationId,
        reviewer_name: review.reviewer?.displayName || null,
        rating: googleBusinessAuth.starRatingToInt(review.starRating),
        review_text: review.comment || null,
        review_created_at: review.createTime ? new Date(review.createTime).getTime() : Date.now()
      })
      synced++
    }
    pageToken = nextPageToken
  } while (pageToken)

  let drafted = 0
  if (aiReply.isConfigured()) {
    const pending = db.listGoogleReviews('pending').filter((r) => !r.ai_draft_reply)
    for (const review of pending) {
      try {
        const draft = await aiReply.draftReply({
          reviewerName: review.reviewer_name,
          rating: review.rating,
          reviewText: review.review_text
        })
        db.saveDraftReply(review.id, draft)
        drafted++
      } catch (err) {
        // One bad draft (e.g. a transient API error) shouldn't stop the
        // rest of the sync — the admin can always hit "Regenerate" later.
        console.error(`[reviews-sync] draft failed for review ${review.id}:`, err.message)
      }
    }
  }

  console.log(`[reviews-sync] synced ${synced} reviews, drafted ${drafted} replies`)
  return { synced, drafted }
}

module.exports = { runSync }

if (require.main === module) {
  require('../secrets').loadSecretsIntoEnv().then(runSync).then(() => process.exit(0)).catch((err) => {
    console.error('[reviews-sync] failed:', err.message)
    process.exit(1)
  })
}
