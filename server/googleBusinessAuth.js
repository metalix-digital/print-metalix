// Google Business Profile (Maps/Search reviews) OAuth + API client.
// Distinct from the existing browser-side Google Sign-In flow (server.js's
// POST /api/auth/google, which only verifies an id_token and never touches
// GOOGLE_CLIENT_SECRET) — this is a real server-side authorization-code
// exchange, since posting review replies needs a refresh token with the
// business.manage scope, not just proof of who signed in.
const REDIRECT_URI = 'https://print.metalix.in/api/admin/google-reviews/oauth/callback'
const SCOPE = 'https://www.googleapis.com/auth/business.manage'
const API_BASE = 'https://mybusiness.googleapis.com/v4'
const ACCOUNT_MGMT_BASE = 'https://mybusinessaccountmanagement.googleapis.com/v1'

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}

function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent'
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

async function exchangeCodeForTokens(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code'
    })
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error_description || 'Google token exchange failed')
    err.code = 'google_oauth_exchange_failed'
    throw err
  }
  // Google only returns a refresh_token on the very first consent (or when
  // prompt=consent forces re-consent, which getAuthUrl always sets) — a
  // missing one here means the caller must not overwrite a previously
  // stored refresh_token with undefined.
  return { refreshToken: data.refresh_token || null, accessToken: data.access_token }
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token'
    })
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error_description || 'Google token refresh failed')
    err.code = 'google_oauth_refresh_failed'
    throw err
  }
  return data.access_token
}

// Used once during the connect flow so the admin can pick which physical
// location to sync — most single-account setups have exactly one.
async function listLocations(accessToken) {
  const accountsRes = await fetch(`${ACCOUNT_MGMT_BASE}/accounts`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const accountsData = await accountsRes.json()
  if (!accountsRes.ok) {
    const err = new Error(accountsData.error?.message || 'Failed to list Google Business accounts')
    err.code = 'google_business_accounts_failed'
    throw err
  }
  const locations = []
  for (const account of accountsData.accounts || []) {
    const locRes = await fetch(`${API_BASE}/${account.name}/locations?readMask=name,title`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    const locData = await locRes.json()
    if (locRes.ok) {
      for (const loc of locData.locations || []) {
        locations.push({ accountId: account.name, locationId: loc.name, title: loc.title })
      }
    }
  }
  return locations
}

async function fetchReviews({ accessToken, accountId, locationId, pageToken }) {
  const params = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''
  const res = await fetch(`${API_BASE}/${accountId}/${locationId}/reviews${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Failed to fetch Google reviews')
    err.code = 'google_reviews_fetch_failed'
    throw err
  }
  return { reviews: data.reviews || [], nextPageToken: data.nextPageToken || null }
}

async function postReply({ accessToken, accountId, locationId, reviewId, replyText }) {
  const res = await fetch(`${API_BASE}/${accountId}/${locationId}/reviews/${reviewId}/reply`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ comment: replyText })
  })
  const data = await res.json()
  if (!res.ok) {
    const err = new Error(data.error?.message || 'Failed to post reply to Google')
    err.code = 'google_reply_post_failed'
    throw err
  }
  return data
}

// Google's STAR_RATING enum ("FIVE", "FOUR", ...) mapped to a plain 1-5 int
// for storage/display, matching order_feedback's rating column shape.
const STAR_RATING_MAP = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }
function starRatingToInt(starRating) {
  return STAR_RATING_MAP[starRating] || null
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  listLocations,
  fetchReviews,
  postReply,
  starRatingToInt
}
