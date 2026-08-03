// Computes how a passport-photo pack tiles onto physical sheets — a grid of
// the same cropped photo, repeated packQty times, split across as many
// sheets as needed. Pure math, no I/O, so it's safe to mirror client-side
// (client/index.html's computePassportGridLayout) for an instant live
// preview that always matches what actually gets printed — same reasoning
// as pricing.js's resolveFileColorPages being mirrored client-side.
//
// SHEET_MARGIN_MM keeps the grid off the sheet edge (most printers can't
// print edge-to-edge anyway); GUTTER_MM leaves room to cut between photos
// with scissors/a cutter without clipping the image itself.
const SHEET_MARGIN_MM = 5
const GUTTER_MM = 3

function computeGridLayout({ sheetWidthMm, sheetHeightMm, photoWidthMm, photoHeightMm, qty }) {
  const usableW = sheetWidthMm - 2 * SHEET_MARGIN_MM
  const usableH = sheetHeightMm - 2 * SHEET_MARGIN_MM
  const cols = Math.max(1, Math.floor((usableW + GUTTER_MM) / (photoWidthMm + GUTTER_MM)))
  const rows = Math.max(1, Math.floor((usableH + GUTTER_MM) / (photoHeightMm + GUTTER_MM)))
  const perSheet = cols * rows
  const numSheets = Math.max(1, Math.ceil((qty || 1) / perSheet))
  // Center the grid block within the usable area rather than pinning it to
  // one corner, so a pack that doesn't fill the sheet still looks intentional.
  const gridW = cols * photoWidthMm + (cols - 1) * GUTTER_MM
  const gridH = rows * photoHeightMm + (rows - 1) * GUTTER_MM
  const offsetX = SHEET_MARGIN_MM + (usableW - gridW) / 2
  const offsetY = SHEET_MARGIN_MM + (usableH - gridH) / 2

  const sheets = []
  let remaining = qty || 1
  for (let s = 0; s < numSheets; s++) {
    const onThisSheet = Math.min(remaining, perSheet)
    const positions = []
    for (let i = 0; i < onThisSheet; i++) {
      const col = i % cols
      const row = Math.floor(i / cols)
      positions.push({
        x: offsetX + col * (photoWidthMm + GUTTER_MM),
        y: offsetY + row * (photoHeightMm + GUTTER_MM)
      })
    }
    sheets.push({ positions })
    remaining -= onThisSheet
  }

  return { cols, rows, perSheet, numSheets, sheets, photoWidthMm, photoHeightMm, sheetWidthMm, sheetHeightMm }
}

module.exports = { computeGridLayout, SHEET_MARGIN_MM, GUTTER_MM }
