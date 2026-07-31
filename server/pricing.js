const shipping = require('./shipping')

// Free above a flat order-value threshold, then a flat rate for the shop's
// own PIN code, a flat (higher) rate for the rest of Gurugram, and — for
// anything further out — a straight-line-distance rate (see shipping.js).
// Falls back to the old flat "standard" rate if the pincode is missing/
// invalid or isn't in our offline pincode dataset, so an order can never
// fail to price just because of an unrecognized PIN code. Exported (not just
// used inside calculate() below) so /api/delivery-estimate can give the
// checkout page's client-side estimate the exact same distance-based number
// for the one case it can't compute itself without the pincode dataset.
// Delivery must never cost more than this, no matter how far the pincode is
// or how the per-km/flat rates are configured.
const DELIVERY_CHARGE_CEILING = 150

function calculateDeliveryCharge(config, { deliveryMethod, deliveryPincode, preDeliveryTotal }) {
  if (deliveryMethod !== 'delivery') return 0
  const freeThreshold = config.freeDeliveryThreshold != null ? config.freeDeliveryThreshold : 500
  if (preDeliveryTotal >= freeThreshold) return 0
  const zone = shipping.classifyZone(deliveryPincode, config.deliveryLocalPincode)
  const fallbackCharge = config.deliveryCharge != null ? config.deliveryCharge : 30
  let charge
  if (zone === 'local') charge = config.deliveryLocalCharge != null ? config.deliveryLocalCharge : 20
  else if (zone === 'gurugram') charge = config.deliveryGurugramCharge != null ? config.deliveryGurugramCharge : 60
  else if (zone === 'outside') {
    const km = shipping.distanceKm(config.deliveryLocalPincode || '122505', deliveryPincode)
    const perKm = config.deliveryPerKmRate != null ? config.deliveryPerKmRate : 5
    charge = km != null ? Math.round(km * perKm) : fallbackCharge
  } else {
    charge = fallbackCharge
  }
  return Math.min(charge, DELIVERY_CHARGE_CEILING)
}

// Pure rate math — color/B&W page counts, copy count, paper type, and
// printing side are all resolved per-file by the caller (client estimate
// and server authoritative calc both do this the same way) so a single
// order can mix per-file settings correctly.
//
// Also returns fileBreakdown (one entry per input file, same order, null for
// an unrecognized paper type) — the per-file paper label / colour split /
// amount actually charged at calculation time. Callers that persist an
// order should store this alongside each file so an invoice generated later
// reflects what was actually charged, not whatever the admin's rates happen
// to be when the invoice is printed (rates can change in between).
function calculate(config, { files, deliveryMethod, deliveryPincode }) {
  let printCost = 0
  let colorPages = 0
  let bwPages = 0
  const paperTypes = Array.isArray(config.rates.a4) ? config.rates.a4 : []
  const fileBreakdown = []
  ;(files || []).forEach((f) => {
    const side = f.printSide === 'double' ? 'double' : 'single'
    // Match the file's paper type by id, falling back to the first configured
    // type so an unknown/removed id still prices instead of crashing.
    const rates = paperTypes.find((t) => t.id === f.paperType) || paperTypes[0]
    if (!rates) { fileBreakdown.push(null); return }
    const copies = Math.max(1, f.copies || 1)
    const c = f.colorPages || 0
    const b = f.bwPages || 0
    colorPages += c * copies
    bwPages += b * copies
    // Colour is single-sided only, so colour pages always price at the single
    // rate (there is no colour double-sided rate); B&W still varies by side.
    const fileAmount = (c * (rates.color.single || 0) + b * rates.bw[side]) * copies
    printCost += fileAmount
    fileBreakdown.push({
      paperLabel: rates.label,
      colorLabel: c && b ? `${c} colour + ${b} B/W` : (c ? 'Colour' : 'Black & White'),
      amount: Math.round(fileAmount)
    })
  })
  printCost = Math.round(printCost)

  const handlingCharge = Number(config.handlingCharge) || 0
  const deliveryCharge = calculateDeliveryCharge(config, {
    deliveryMethod,
    deliveryPincode,
    preDeliveryTotal: printCost + handlingCharge
  })
  const subtotal = printCost + deliveryCharge + handlingCharge
  const gstAmount = Math.round((subtotal * (config.gstPercent || 0)) / 100)
  const totalAmount = subtotal + gstAmount

  return { colorPages, bwPages, printCost, deliveryCharge, handlingCharge, gstAmount, totalAmount, fileBreakdown }
}

// Resolves a single file's effective color/bw page split given its
// detected colorCount and an explicit/auto print mode.
function resolveFileColorPages(file, mode) {
  const pageCount = Number(file.pageCount) || 0
  const colorCount = Number(file.colorCount != null ? file.colorCount : file.colorPageCount) || 0
  let colorPages
  if (mode === 'color') colorPages = pageCount
  else if (mode === 'bw') colorPages = 0
  else colorPages = colorCount
  return { colorPages, bwPages: Math.max(0, pageCount - colorPages) }
}

module.exports = { calculate, resolveFileColorPages, calculateDeliveryCharge }
