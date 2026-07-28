// Pure rate math — color/B&W page counts, copy count, paper type, and
// printing side are all resolved per-file by the caller (client estimate
// and server authoritative calc both do this the same way) so a single
// order can mix per-file settings correctly.
function calculate(config, { files, deliveryMethod, deliveryPincode }) {
  let printCost = 0
  let colorPages = 0
  let bwPages = 0
  const paperTypes = Array.isArray(config.rates.a4) ? config.rates.a4 : []
  ;(files || []).forEach((f) => {
    const side = f.printSide === 'double' ? 'double' : 'single'
    // Match the file's paper type by id, falling back to the first configured
    // type so an unknown/removed id still prices instead of crashing.
    const rates = paperTypes.find((t) => t.id === f.paperType) || paperTypes[0]
    if (!rates) return
    const copies = Math.max(1, f.copies || 1)
    const c = f.colorPages || 0
    const b = f.bwPages || 0
    colorPages += c * copies
    bwPages += b * copies
    // Colour is single-sided only, so colour pages always price at the single
    // rate (there is no colour double-sided rate); B&W still varies by side.
    printCost += (c * (rates.color.single || 0) + b * rates.bw[side]) * copies
  })
  printCost = Math.round(printCost)

  // Delivery is a flat rate that drops to a cheaper "local" rate inside the
  // shop's own PIN code, and stays at the standard (further-out) rate everywhere
  // else within the delivery zone.
  let deliveryCharge = 0
  if (deliveryMethod === 'delivery') {
    const isLocal = deliveryPincode && String(deliveryPincode).trim() === (config.deliveryLocalPincode || '122505')
    deliveryCharge = isLocal
      ? (config.deliveryLocalCharge != null ? config.deliveryLocalCharge : 20)
      : (config.deliveryCharge != null ? config.deliveryCharge : 30)
  }
  const handlingCharge = Number(config.handlingCharge) || 0
  const subtotal = printCost + deliveryCharge + handlingCharge
  const gstAmount = Math.round((subtotal * (config.gstPercent || 0)) / 100)
  const totalAmount = subtotal + gstAmount

  return { colorPages, bwPages, printCost, deliveryCharge, handlingCharge, gstAmount, totalAmount }
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

module.exports = { calculate, resolveFileColorPages }
