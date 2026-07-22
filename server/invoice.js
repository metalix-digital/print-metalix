// Generates a one-page A4 PDF invoice for a completed order using pdf-lib
// (already a dependency, no browser needed). Returns a Buffer.
//
// Note: the built-in Helvetica font is WinAnsi-encoded and cannot render the
// rupee glyph (₹), so amounts are prefixed with "Rs." to avoid encode errors.
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')
const db = require('./db')
const pricing = require('./pricing')

const ORANGE = rgb(1, 0.4, 0)
const INK = rgb(0.1, 0.13, 0.22)
const MUTED = rgb(0.42, 0.45, 0.5)
const LINE = rgb(0.85, 0.84, 0.79)
const SOFT = rgb(0.97, 0.96, 0.93)
const WHITE = rgb(1, 1, 1)

function money(n) { return 'Rs. ' + (Number(n) || 0).toLocaleString('en-IN') }

// Per-file paper type label, colour label, and cost — recomputed from the
// *current* admin pricing rates, since no historical rate snapshot is kept
// per order (matches the same per-file rate lookup pricing.calculate() uses
// at order time; only drifts from what was actually charged if the admin
// changes rates in the narrow window between an order being placed and
// completed — the order's own TOTAL below is unaffected either way).
function fileLineItem(f, pages, copies, paperTypes) {
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

  const text = (s, x, yy, size, f = font, color = INK) => page.drawText(String(s == null ? '' : s), { x, y: yy, size, font: f, color })
  const right = (s, xRight, yy, size, f = font, color = INK) => {
    const str = String(s == null ? '' : s)
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
  const dateStr = new Date(order.completed_at || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
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
      printMode: order.print_mode, printSide: order.print_side, paperType: order.paper_type,
      colorPageCount: order.color_page_count,
    }]
  }
  let paperTypes = []
  try { paperTypes = db.getPricing().rates.a4 || [] } catch (e) { paperTypes = [] }
  for (const f of files) {
    const desc = String(f.fileName || 'Document')
    const pages = f.pageCount != null ? f.pageCount : (order.page_count || 0)
    const copies = f.copies || 1
    const { paperLabel, colorLabel, amount } = fileLineItem(f, pages, copies, paperTypes)
    text(desc.length > 54 ? desc.slice(0, 51) + '...' : desc, M + 8, y, 10, font)
    right(pages + ' pg x ' + copies, width - M - 110, y, 10, font, MUTED)
    right(money(amount), width - M - 8, y, 10, font)
    y -= 13
    text(paperLabel + ' · ' + colorLabel, M + 8, y, 8.5, font, MUTED)
    y -= 19
    if (y < 170) break
  }
  y -= 6
  page.drawLine({ start: { x: M, y }, end: { x: width - M, y }, thickness: 1, color: LINE })
  y -= 22

  // Totals block (right-aligned)
  const labelX = width - M - 220
  const totalRow = (label, val, f = font, color = INK, size = 10) => { text(label, labelX, y, size, f, MUTED); right(money(val), width - M, y, size, f, color); y -= 17 }
  totalRow('Print cost', order.print_cost)
  if (order.delivery_charge) totalRow('Delivery', order.delivery_charge)
  if (order.gst_amount) totalRow('GST', order.gst_amount)
  page.drawLine({ start: { x: labelX, y: y + 6 }, end: { x: width - M, y: y + 6 }, thickness: 1, color: LINE })
  y -= 6
  text('TOTAL', labelX, y, 12, bold)
  right(money(order.total_amount), width - M, y, 13, bold, ORANGE)
  y -= 34

  if (order.razorpay_payment_id) text('Payment ID: ' + order.razorpay_payment_id, M, y, 9, font, MUTED)

  // Footer
  text('Thank you for choosing ' + bizName + '.', M, 58, 10, font, MUTED)
  text('This is a computer-generated invoice and does not require a signature.', M, 44, 9, font, MUTED)

  return Buffer.from(await pdf.save())
}

module.exports = { buildInvoicePdf }
