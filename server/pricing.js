function calculate(config, { pageCount, colorPageCount, printMode, printSide, paperSize, copies, deliveryMethod }) {
  const size = paperSize === 'a3' ? 'a3' : 'a4'
  const side = printSide === 'double' ? 'double' : 'single'
  const rates = config.rates[size]

  let colorPages
  if (printMode === 'color') colorPages = pageCount
  else if (printMode === 'bw') colorPages = 0
  else colorPages = colorPageCount || 0
  const bwPages = Math.max(0, pageCount - colorPages)

  const perCopy = colorPages * rates.color[side] + bwPages * rates.bw[side]
  const printCost = Math.round(perCopy * Math.max(1, copies || 1))
  const deliveryCharge = deliveryMethod === 'delivery' ? config.deliveryCharge : 0
  const subtotal = printCost + deliveryCharge
  const gstAmount = Math.round((subtotal * (config.gstPercent || 0)) / 100)
  const totalAmount = subtotal + gstAmount

  return { colorPages, bwPages, printCost, deliveryCharge, gstAmount, totalAmount }
}

module.exports = { calculate }
