const path = require('path')
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf')

const STANDARD_FONT_DATA_URL = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep

// Every page still gets rendered (needed for the color-detection pass below)
// regardless of this cap — this only limits how many of those renders we keep
// as preview images, so a 200-page bulk order doesn't balloon the upload
// response or the server's memory. Page count/pricing are unaffected.
const MAX_PREVIEW_PAGES = 60

function NodeCanvasFactory(createCanvas) {
  this.createCanvas = createCanvas
}
NodeCanvasFactory.prototype = {
  create: function (width, height) {
    const canvas = this.createCanvas(width, height)
    const context = canvas.getContext('2d')
    return { canvas, context, width, height }
  },
  reset: function (canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width
    canvasAndContext.canvas.height = height
    canvasAndContext.width = width
    canvasAndContext.height = height
  },
  destroy: function (canvasAndContext) {
    canvasAndContext.canvas.width = 0
    canvasAndContext.canvas.height = 0
    canvasAndContext.canvas = null
    canvasAndContext.context = null
  }
}

async function analyzePdfBuffer(buffer) {
  let createCanvas
  try {
    const canvasPkg = require('canvas')
    createCanvas = canvasPkg.createCanvas
    // pdfjs-dist renders inline images via the global Image/ImageData/Path2D
    // constructors rather than the canvas factory — without these, PDFs with
    // embedded images (logos, photos) throw "Image or Canvas expected".
    if (!global.Image) global.Image = canvasPkg.Image
    if (!global.ImageData) global.ImageData = canvasPkg.ImageData
    if (!global.Path2D) global.Path2D = canvasPkg.Path2D
  } catch (err) {
    throw Object.assign(new Error('canvas_missing'), { code: 'canvas_missing' })
  }

  const data = new Uint8Array(buffer)
  const loadingTask = pdfjsLib.getDocument({ data, standardFontDataUrl: STANDARD_FONT_DATA_URL })
  const doc = await loadingTask.promise
  const n = doc.numPages

  const flags = []
  const pageThumbnails = []
  let thumbnail = null
  const canvasFactory = new NodeCanvasFactory(createCanvas)

  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: 1 })
    const maxDim = 800
    const scale = Math.max(1, Math.min(2, maxDim / viewport.width))
    const vp = page.getViewport({ scale })
    const canvasAndContext = canvasFactory.create(Math.floor(vp.width), Math.floor(vp.height))
    await page.render({ canvasContext: canvasAndContext.context, viewport: vp, canvasFactory }).promise

    // Already rendering every page for the color-detection pass below, so
    // keeping each page's image too (for the customer-facing preview) is
    // free CPU-wise — only cost is response payload size, capped above.
    const pageImg = i <= MAX_PREVIEW_PAGES ? canvasAndContext.canvas.toDataURL('image/png') : null
    if (pageImg) pageThumbnails.push(pageImg)
    if (i === 1) thumbnail = pageImg

    const imgData = canvasAndContext.context.getImageData(0, 0, canvasAndContext.width, canvasAndContext.height)
    const dataArr = imgData.data
    let colored = 0
    let total = 0
    const step = 4
    for (let k = 0; k < dataArr.length; k += 4 * step) {
      const r = dataArr[k]
      const g = dataArr[k + 1]
      const b = dataArr[k + 2]
      total++
      if (Math.abs(r - g) > 12 || Math.abs(r - b) > 12 || Math.abs(g - b) > 12) colored++
    }
    flags.push(total > 0 && colored / total > 0.03)
    canvasFactory.destroy(canvasAndContext)
  }

  const colorCount = flags.filter(Boolean).length
  return { pageCount: n, colorCount, colorFlags: flags, thumbnail, pageThumbnails, previewTruncated: n > MAX_PREVIEW_PAGES }
}

module.exports = { analyzePdfBuffer }
