// Delivery-zone classification and distance pricing for pincodes outside
// Gurugram. The lat/long table (server/geodata/in-pincodes.json) is a
// pincode-level centroid dataset derived from GeoNames' free India postal
// code export (download.geonames.org/export/zip/IN.zip), averaged per
// pincode — good enough for a delivery-fee estimate, not turn-by-turn
// navigation. Looked up and computed entirely offline: no network call (and
// therefore no external failure mode) sits on the checkout path.
const PINCODES = require('./geodata/in-pincodes.json')

// Gurugram district pincodes all fall in the 122xxx range.
const GURUGRAM_PREFIX = '122'

function normalizePincode(pincode) {
  const s = String(pincode || '').trim()
  return /^\d{6}$/.test(s) ? s : null
}

// 'local' (the shop's own pincode) | 'gurugram' (rest of the 122xxx range) |
// 'outside' (anything else) | null (not a valid 6-digit pincode).
function classifyZone(pincode, localPincode) {
  const p = normalizePincode(pincode)
  if (!p) return null
  if (p === String(localPincode || '122505')) return 'local'
  if (p.startsWith(GURUGRAM_PREFIX)) return 'gurugram'
  return 'outside'
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// Straight-line distance between two pincodes' centroids, in km (rounded to
// 1 decimal). Returns null if either pincode isn't a valid 6-digit code or
// isn't in the dataset (an unrecognized/new pincode) — callers must handle
// that by falling back to a flat rate rather than pricing off a null distance.
function distanceKm(fromPincode, toPincode) {
  const from = PINCODES[normalizePincode(fromPincode)]
  const to = PINCODES[normalizePincode(toPincode)]
  if (!from || !to) return null
  return Math.round(haversineKm(from[0], from[1], to[0], to[1]) * 10) / 10
}

module.exports = { classifyZone, distanceKm }
