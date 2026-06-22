// Pure rate math — color/B&W page counts, copy count, paper type, and
// printing side are all resolved per-file by the caller (client estimate
// and server authoritative calc both do this the same way) so a single
// order can mix per-file settings correctly.
function calculate(config, { files, deliveryMethod }) {
  let printCost = 0
  let colorPages = 0
  let bwPages = 0
  ;(files || []).forEach((f) => {
    const side = f.printSide === 'double' ? 'double' : 'single'
    const type = config.rates.a4[f.paperType] ? f.paperType : 'normal'
    const rates = config.rates.a4[type]
    const copies = Math.max(1, f.copies || 1)
    const c = f.colorPages || 0
    const b = f.bwPages || 0
    colorPages += c * copies
    bwPages += b * copies
    printCost += (c * rates.color[side] + b * rates.bw[side]) * copies
  })
  printCost = Math.round(printCost)
  const deliveryCharge = deliveryMethod === 'delivery' ? config.deliveryCharge : 0
  const subtotal = printCost + deliveryCharge
  const gstAmount = Math.round((subtotal * (config.gstPercent || 0)) / 100)
  const totalAmount = subtotal + gstAmount

  return { colorPages, bwPages, printCost, deliveryCharge, gstAmount, totalAmount }
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
