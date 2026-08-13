// Generates a one-page A4 PDF invoice for a completed order using pdf-lib
// (already a dependency, no browser needed). Returns a Buffer.
//
// Note: the built-in Helvetica font is WinAnsi-encoded and cannot render the
// rupee glyph (₹), so amounts are prefixed with "Rs." to avoid encode errors.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
const db = require('./db')
const pricing = require('./pricing')
const { formatRupees } = require('./format')

const ORANGE = rgb(1, 0.4, 0)
const INK = rgb(0.1, 0.13, 0.22)
const MUTED = rgb(0.42, 0.45, 0.5)
const LINE = rgb(0.85, 0.84, 0.79)
const SOFT = rgb(0.97, 0.96, 0.93)
const WHITE = rgb(1, 1, 1)
const GREEN = rgb(0.09, 0.5, 0.31)

function money(n) { return 'Rs. ' + formatRupees(n) }

// pdf-lib's Standard fonts are WinAnsi-encoded and can't represent ₹ or most
// non-Latin1 characters (see the file-level comment above) — a customer- or
// admin-entered value (file name, paper/service label, discount reason,
// customer name, etc.) containing one would otherwise crash the whole PDF
// with "WinAnsi cannot encode ...". Swap ₹ for "Rs." (matching money() above)
// and drop anything else the font can't encode, one character at a time,
// rather than failing the invoice over a single stray character.
function sanitizeForFont(str, f) {
  let out = ''
  for (const ch of str) {
    if (ch === '₹') { out += 'Rs.'; continue }
    try {
      f.widthOfTextAtSize(ch, 10)
      out += ch
    } catch (e) {
      // unencodable in this font — drop it
    }
  }
  return out
}

// Per-file paper type label, colour label, and cost. Orders created after
// pricing.calculate() started returning a fileBreakdown (see pricing.js)
// have this baked into files_json at order time, so the invoice always
// matches what was actually charged, even if the admin changes rates
// before the invoice is printed. Older orders that predate that change
// don't have it stored, so fall back to recomputing from *current* rates —
// only those can drift from what was actually charged.
function fileLineItem(f, pages, copies, paperTypes) {
  // colorLabel is deliberately null for a qty-1 Additional Service (see
  // pricing.js's 'service' branch — no "×" suffix needed) — a baked-in
  // breakdown is still valid with a null colorLabel, so it can't be part of
  // this check, or a real service amount gets discarded in favour of
  // recomputing it as if it were a print file (wrong rate, wrong page count).
  if (f.amount != null && f.paperLabel != null) {
    return { paperLabel: f.paperLabel, colorLabel: f.colorLabel, amount: f.amount }
  }
  const rates = paperTypes.find((t) => t.id === f.paperType) || paperTypes[0]
  const paperLabel = rates ? rates.label : (f.paperType || 'Paper')
  const { colorPages, bwPages } = pricing.resolveFileColorPages(
    { pageCount: pages, colorCount: f.colorPageCount },
    f.printMode
  )
  if (!rates) return { paperLabel, colorLabel: 'Mixed', amount: 0 }
  const side = f.printSide === 'double' ? 'double' : 'single'
  if (colorPages && bwPages) {
    const amount = (colorPages * (rates.color.single || 0) + bwPages * rates.bw[side]) * copies
    return { paperLabel, colorLabel: colorPages + ' colour + ' + bwPages + ' B/W', amount: Math.round(amount) }
  }
  if (colorPages) {
    return { paperLabel, colorLabel: 'Colour', amount: Math.round(colorPages * (rates.color.single || 0) * copies) }
  }
  return { paperLabel, colorLabel: 'Black & White', amount: Math.round(bwPages * rates.bw[side] * copies) }
}

async function buildInvoicePdf(order) {
  let settings = {}
  try { settings = db.getSiteSettings() || {} } catch (e) { settings = {} }
  const bizName = settings.businessName || 'Metalix Print'
  const bizPhone = settings.phone || ''
  const bizEmail = settings.email || ''
  const bizAddr = settings.headOfficeAddress || ''
  const gstin = settings.gstin || '09AHOPH6696N2Z8'

  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595.28, 841.89]) // A4
  const { width, height } = page.getSize()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
  const M = 48
  let y = height - M

  const text = (s, x, yy, size, f = font, color = INK) => page.drawText(sanitizeForFont(String(s == null ? '' : s), f), { x, y: yy, size, font: f, color })
  const right = (s, xRight, yy, size, f = font, color = INK) => {
    const str = sanitizeForFont(String(s == null ? '' : s), f)
    page.drawText(str, { x: xRight - f.widthOfTextAtSize(str, size), y: yy, size, font: f, color })
  }

  // Header: logo mark (orange disc + white "M") next to the business block
  const R = 17
  const cx = M + R
  const cy = y - R + 3
  page.drawCircle({ x: cx, y: cy, size: R, color: ORANGE })
  const mW = bold.widthOfTextAtSize('M', 19)
  page.drawText('M', { x: cx - mW / 2, y: cy - 6.5, size: 19, font: bold, color: WHITE })

  const tx = M + R * 2 + 12
  text(bizName, tx, y - 6, 18, bold)
  const trunc = (s, max) => (s.length > max ? s.slice(0, max - 1) + '.' : s)
  let iy = y - 21
  if (bizAddr) { text(trunc(bizAddr, 84), tx, iy, 8.5, font, MUTED); iy -= 11 }
  const contact = [bizPhone, bizEmail].filter(Boolean).join('   |   ')
  if (contact) { text(contact, tx, iy, 8.5, font, MUTED); iy -= 11 }
  if (gstin) { text('GSTIN: ' + gstin, tx, iy, 8.5, bold, MUTED); iy -= 11 }

  right('TAX INVOICE', width - M, y, 15, bold, ORANGE)

  y = Math.min(iy - 4, y - 46)
  page.drawRectangle({ x: M, y, width: width - 2 * M, height: 2, color: ORANGE })
  y -= 26

  // Meta row
  const dateStr = new Date(order.completed_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })
  text('INVOICE NO', M, y, 8.5, bold, MUTED)
  text('DATE', M + 200, y, 8.5, bold, MUTED)
  text('PAYMENT', M + 340, y, 8.5, bold, MUTED)
  y -= 14
  text(order.id, M, y, 11, font)
  text(dateStr, M + 200, y, 11, font)
  text((String(order.payment_status || 'paid')).toUpperCase(), M + 340, y, 11, font)
  y -= 30

  // Bill to + branch
  text('BILL TO', M, y, 8.5, bold, MUTED)
  if (order.location_name) text('BRANCH', M + 300, y, 8.5, bold, MUTED)
  y -= 15
  text(order.customer_name || '-', M, y, 11, bold)
  if (order.location_name) text(order.location_name, M + 300, y, 11, bold)
  y -= 14
  if (order.customer_mobile) { text(order.customer_mobile, M, y, 10, font, MUTED); y -= 13 }
  if (order.customer_email) { text(order.customer_email, M, y, 10, font, MUTED); y -= 13 }
  y -= 14

  // Items table header
  page.drawRectangle({ x: M, y: y - 6, width: width - 2 * M, height: 22, color: SOFT })
  text('DESCRIPTION', M + 8, y, 8.5, bold, MUTED)
  right('QTY', width - M - 110, y, 8.5, bold, MUTED)
  right('AMOUNT', width - M - 8, y, 8.5, bold, MUTED)
  y -= 24

  // Line items from files_json (fallback to the single-file summary)
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (e) { files = [] }
  if (!files.length && order.file_name) {
    files = [{
      fileName: order.file_name, pageCount: order.page_count, copies: order.copies,
      printMode: order.print_mode, printSide: order.print_side, pageSize: order.paper_size, paperType: order.paper_type,
      colorPageCount: order.color_page_count,
    }]
  }
  // Additional Services (spiral binding, photo editing, etc.), Stationery
  // (ready-made products — pens, Rent Receipt Booklets, ...), and Custom
  // Stamps are all flat fee x quantity, not a print job — no page count,
  // paper type, or copies — so they each get their own spread below instead
  // of sharing this page-oriented table, where they'd otherwise show a
  // nonsense "N pg x 1" quantity borrowed from an unrelated leftover field.
  const NON_PRINT_TYPES = ['service', 'stationery', 'stamp']
  const printFiles = files.filter((f) => !NON_PRINT_TYPES.includes(f.productType))
  const serviceFiles = files.filter((f) => f.productType === 'service')
  const stationeryFiles = files.filter((f) => f.productType === 'stationery')
  const stampFiles = files.filter((f) => f.productType === 'stamp')

  let pricingConfig = {}
  try { pricingConfig = db.getPricing() } catch (e) { pricingConfig = {} }
  for (const f of printFiles) {
    const desc = String(f.fileName || 'Document')
    const pages = f.pageCount != null ? f.pageCount : (order.page_count || 0)
    const copies = f.copies || 1
    // Legacy-order fallback only (see fileLineItem's comment) — new orders
    // already have paperLabel/amount baked in, so f.pageSize doesn't need to
    // be looked up here. Undefined f.pageSize (orders predating this field)
    // falls through to rates.a4, its actual size at the time.
    const paperTypes = (pricingConfig.rates && (pricingConfig.rates[f.pageSize] || pricingConfig.rates.a4)) || []
    const { paperLabel, colorLabel, amount } = fileLineItem(f, pages, copies, paperTypes)
    const qtyLabel = f.productType === 'passport-photo' ? (f.packQty || 0) + '-pack' : pages + ' pg x ' + copies
    text(desc.length > 54 ? desc.slice(0, 51) + '...' : desc, M + 8, y, 10, font)
    right(qtyLabel, width - M - 110, y, 10, font, MUTED)
    right(money(amount), width - M - 8, y, 10, font)
    y -= 13
    text(paperLabel + (colorLabel ? ' · ' + colorLabel : ''), M + 8, y, 8.5, font, MUTED)
    y -= 19
    if (y < 170) break
  }
  y -= 6
  page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE })
  y -= 22

  // Additional Services get their own mini-table — Service / Qty / Amount —
  // clearly separated from the print items above rather than mixed into a
  // table whose columns (pages, paper type) don't apply to them.
  if (serviceFiles.length) {
    page.drawRectangle({ x: M, y: y - 6, width: width - 2 * M, height: 22, color: SOFT })
    text('ADDITIONAL SERVICES', M + 8, y, 8.5, bold, MUTED)
    right('QTY', width - M - 110, y, 8.5, bold, MUTED)
    right('AMOUNT', width - M - 8, y, 8.5, bold, MUTED)
    y -= 24
    for (const f of serviceFiles) {
      const qty = f.quantity || 1
      const { paperLabel, amount } = fileLineItem(f, 0, qty, [])
      text(String(f.fileName || paperLabel || 'Service'), M + 8, y, 10, font)
      right(qty + '×', width - M - 110, y, 10, font, MUTED)
      right(money(amount), width - M - 8, y, 10, font)
      y -= 19
      if (y < 170) break
    }
    y -= 6
    page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE })
    y -= 22
  }

  // Stationery gets its own mini-table too — same reasoning as Additional
  // Services above (flat unit price x quantity, no page/paper columns).
  if (stationeryFiles.length) {
    page.drawRectangle({ x: M, y: y - 6, width: width - 2 * M, height: 22, color: SOFT })
    text('STATIONERY', M + 8, y, 8.5, bold, MUTED)
    right('QTY', width - M - 110, y, 8.5, bold, MUTED)
    right('AMOUNT', width - M - 8, y, 8.5, bold, MUTED)
    y -= 24
    for (const f of stationeryFiles) {
      const qty = f.quantity || 1
      const { paperLabel, amount } = fileLineItem(f, 0, qty, [])
      text(String(f.name || f.fileName || paperLabel || 'Product'), M + 8, y, 10, font)
      right(qty + '×', width - M - 110, y, 10, font, MUTED)
      right(money(amount), width - M - 8, y, 10, font)
      y -= 19
      if (y < 170) break
    }
    y -= 6
    page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE })
    y -= 22
  }

  // Custom Stamps get their own mini-table too — same reasoning as
  // Stationery/Additional Services above.
  if (stampFiles.length) {
    page.drawRectangle({ x: M, y: y - 6, width: width - 2 * M, height: 22, color: SOFT })
    text('CUSTOM STAMPS', M + 8, y, 8.5, bold, MUTED)
    right('QTY', width - M - 110, y, 8.5, bold, MUTED)
    right('AMOUNT', width - M - 8, y, 8.5, bold, MUTED)
    y -= 24
    for (const f of stampFiles) {
      const qty = f.quantity || 1
      const { paperLabel, amount } = fileLineItem(f, 0, qty, [])
      text(String(paperLabel || 'Custom Stamp'), M + 8, y, 10, font)
      right(qty + '×', width - M - 110, y, 10, font, MUTED)
      right(money(amount), width - M - 8, y, 10, font)
      y -= 13
      if (f.textLines && f.textLines.length) {
        text(f.textLines.join(' / '), M + 8, y, 8.5, font, MUTED)
        y -= 6
      } else if (f.artworkFileId) {
        text('Customer-supplied design', M + 8, y, 8.5, font, MUTED)
        y -= 6
      }
      y -= 13
      if (y < 170) break
    }
    y -= 6
    page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE })
    y -= 22
  }

  // Totals block (right-aligned)
  const labelX = width - M - 220
  const totalRow = (label, val, f = font, color = INK, size = 10) => { text(label, labelX, y, size, f, MUTED); right(money(val), width - M, y, size, f, color); y -= 17 }
  totalRow('Print cost', order.print_cost)
  if (order.services_cost) totalRow('Additional services', order.services_cost)
  if (order.stationery_cost) totalRow('Stationery', order.stationery_cost)
  if (order.stamp_cost) totalRow('Custom Stamps', order.stamp_cost)
  if (order.handling_charge) totalRow('Handling charge', order.handling_charge)
  // Keyed off delivery_method, not delivery_charge — a free-delivery order
  // (above the threshold) has delivery_charge: 0, and the old `if
  // (order.delivery_charge)` check silently dropped the line entirely
  // instead of showing it as free, same class of bug as the Additional
  // Services fix above (a real, applicable charge of "0" getting treated as
  // "not applicable"). A pickup order still shows nothing here.
  if (order.delivery_method === 'delivery') {
    const isFree = !order.delivery_charge
    text('Delivery', labelX, y, 10, font, MUTED)
    right(isFree ? 'Free' : money(order.delivery_charge), width - M, y, 10, font, isFree ? GREEN : INK)
    y -= 17
  }
  if (order.discount_amount) {
    // A staff-applied discount can carry a free-text reason instead of a
    // coupon code (see resolveDiscountInput's allowAdHoc path) — that reason
    // is exactly as "recorded" on the order as a code is, so it shouldn't
    // silently disappear here just because there's no code to show instead.
    const reason = order.discount_reason ? String(order.discount_reason).trim() : ''
    const discountLabel = order.discount_code
      ? `Discount (${order.discount_code})`
      : reason
        ? `Discount (${reason.length > 34 ? reason.slice(0, 31) + '...' : reason})`
        : 'Discount'
    text(discountLabel, labelX, y, 10, font, MUTED)
    right('- ' + money(order.discount_amount), width - M, y, 10, font, GREEN)
    y -= 17
  }
  if (order.gst_amount) totalRow('GST', order.gst_amount)
  page.drawLine({ start: { x: labelX, y: y + 6 }, end: { x: width - M, y: y + 6 }, thickness: 1, color: LINE })
  y -= 6
  text('TOTAL', labelX, y, 12, bold)
  right(money(order.total_amount), width - M, y, 13, bold, ORANGE)
  y -= 34

  const txnId = order.cashfree_payment_id || order.razorpay_payment_id
  if (txnId) text('Payment ID: ' + txnId, M, y, 9, font, MUTED)

  // Footer
  text('Thank you for choosing ' + bizName + '.', M, 58, 10, font, MUTED)
  text('This is a computer-generated invoice and does not require a signature.', M, 44, 9, font, MUTED)

  return Buffer.from(await pdf.save())
}

module.exports = { buildInvoicePdf }
