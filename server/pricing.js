// Pure rate math — color/B&W page counts are resolved per-file by the
// caller (client estimate and server authoritative calc both do this the
// same way) so a single order can mix per-file print modes correctly.
function calculate(config, { colorPages, bwPages, printSide, paperType, copies, deliveryMethod }) {
  const side = printSide === 'double' ? 'double' : 'single'
  const type = config.rates.a4[paperType] ? paperType : 'normal'
  const rates = config.rates.a4[type]

  const perCopy = (colorPages || 0) * rates.color[side] + (bwPages || 0) * rates.bw[side]
  const printCost = Math.round(perCopy * Math.max(1, copies || 1))
  const deliveryCharge = deliveryMethod === 'delivery' ? config.deliveryCharge : 0
  const subtotal = printCost + deliveryCharge
  const gstAmount = Math.round((subtotal * (config.gstPercent || 0)) / 100)
  const totalAmount = subtotal + gstAmount

  return { colorPages: colorPages || 0, bwPages: bwPages || 0, printCost, deliveryCharge, gstAmount, totalAmount }
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
