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
function calculate(config, { files, deliveryMethod, deliveryPincode, discount }) {
  let printCost = 0
  let colorPages = 0
  let bwPages = 0
  const fileBreakdown = []
  ;(files || []).forEach((f) => {
    // Passport Photos is a flat-pack product (8/16/32 photos at a fixed price,
    // same regardless of size preset) — entirely different math from the
    // per-page/per-copy pricing below, so it's resolved and pushed here and
    // skips the rest of this iteration. paperLabel/colorLabel are reused
    // (not e.g. sizeLabel/packLabel) so every downstream consumer that
    // already reads a file's paperLabel/colorLabel/amount — invoice.js in
    // particular — works unchanged for this product too.
    if ((f.productType || 'document') === 'passport-photo') {
      const presets = (config.passportPhotos || {}).sizePresets || []
      const preset = presets.find((s) => s.id === f.sizePresetId)
      const tier = ((config.passportPhotos || {}).packPrices || []).find((p) => p.qty === f.packQty)
      const packPrice = tier ? Number(tier.price) || 0 : 0
      printCost += packPrice
      fileBreakdown.push({
        paperLabel: preset ? preset.label : (f.sizePresetId || 'Passport Photo'),
        colorLabel: (f.packQty || 0) + '-pack',
        amount: Math.round(packPrice)
      })
      return
    }
    const side = f.printSide === 'double' ? 'double' : 'single'
    // Paper types are resolved per file by page size — callers (server.js's
    // buildPricedOrderFiles) are expected to have already validated f.pageSize
    // against the admin's active page sizes before calling this.
    const paperTypes = Array.isArray(config.rates[f.pageSize]) ? config.rates[f.pageSize] : []
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
  // GST is charged on the post-discount (taxable) value, standard invoicing
  // practice — not on the full pre-discount subtotal.
  const discountAmount = calculateDiscountAmount(subtotal, discount)
  const taxableAmount = subtotal - discountAmount
  const gstAmount = Math.round((taxableAmount * (config.gstPercent || 0)) / 100)
  const totalAmount = taxableAmount + gstAmount

  return { colorPages, bwPages, printCost, deliveryCharge, handlingCharge, discountAmount, gstAmount, totalAmount, fileBreakdown }
}

// `discount` is already-resolved data the caller looked up (a coupon row, or
// a staff-entered ad-hoc value) — pricing.js stays pure math and never itself
// looks anything up. minOrderValue is enforced here (against the subtotal
// this same calculate() call just computed) rather than by the caller, since
// the caller can't know the subtotal until calculate() runs. Result is always
// clamped to [0, subtotal] so a total can never go negative or a discount
// exceed what there was to discount.
function calculateDiscountAmount(subtotal, discount) {
  if (!discount || !discount.type) return 0
  if (discount.minOrderValue && subtotal < discount.minOrderValue) return 0
  const value = Number(discount.value) || 0
  if (value <= 0) return 0
  let amount = 0
  if (discount.type === 'percent') amount = (subtotal * Math.min(value, 100)) / 100
  else if (discount.type === 'flat') amount = value
  return Math.max(0, Math.min(Math.round(amount), subtotal))
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

module.exports = { calculate, resolveFileColorPages, calculateDeliveryCharge, calculateDiscountAmount }
