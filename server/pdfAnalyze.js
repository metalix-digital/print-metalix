const pdfjsLib = require('pdfjs-dist/legacy/build/pdf')

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
    ;({ createCanvas } = require('canvas'))
  } catch (err) {
    throw Object.assign(new Error('canvas_missing'), { code: 'canvas_missing' })
  }

  const data = new Uint8Array(buffer)
  const loadingTask = pdfjsLib.getDocument({ data })
  const doc = await loadingTask.promise
  const n = doc.numPages

  const flags = []
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

    if (i === 1) {
      thumbnail = canvasAndContext.canvas.toDataURL('image/png')
    }

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
  return { pageCount: n, colorCount, colorFlags: flags, thumbnail }
}

module.exports = { analyzePdfBuffer }
