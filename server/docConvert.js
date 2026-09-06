const { execFile } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const SOFFICE_BIN = process.env.SOFFICE_BIN || 'soffice'

// Headless LibreOffice is CPU/RAM-heavy enough that running several at once
// (e.g. the admin "Print Job Sheet" converts every file in an order in
// parallel — see server.js — while a customer's own upload is converting)
// thrashes a small VM and makes every conversion slow enough to trip its own
// timeout below. This caps how many soffice processes run at once, process-
// wide, queueing the rest instead of letting them all fight for resources.
const MAX_CONCURRENT_CONVERSIONS = Number(process.env.SOFFICE_MAX_CONCURRENCY) || 2
let activeConversions = 0
const waiting = []

function acquireSlot() {
  if (activeConversions < MAX_CONCURRENT_CONVERSIONS) {
    activeConversions++
    return Promise.resolve()
  }
  return new Promise((resolve) => waiting.push(resolve))
}

function releaseSlot() {
  const next = waiting.shift()
  if (next) next()
  else activeConversions--
}

// Converts a DOC/DOCX/PPT/PPTX buffer to a PDF buffer using headless LibreOffice.
// Each call uses its own temp dir + unique LibreOffice user profile so concurrent
// conversions don't collide (soffice locks its profile directory).
function convertToPdf(buffer, originalExt) {
  return acquireSlot().then(() => runConversion(buffer, originalExt).finally(releaseSlot))
}

function runConversion(buffer, originalExt) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metalix-convert-'))
    const inputPath = path.join(tmpDir, `input${originalExt}`)
    fs.writeFileSync(inputPath, buffer)

    const profileDir = path.join(tmpDir, 'profile')
    const userInstallation = `-env:UserInstallation=file://${profileDir}`

    execFile(
      SOFFICE_BIN,
      [userInstallation, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', tmpDir, inputPath],
      { timeout: 60000 },
      (err) => {
        if (err) {
          fs.rmSync(tmpDir, { recursive: true, force: true })
          return reject(Object.assign(new Error('conversion_failed'), { cause: err }))
        }
        const outputPath = path.join(tmpDir, 'input.pdf')
        if (!fs.existsSync(outputPath)) {
          fs.rmSync(tmpDir, { recursive: true, force: true })
          return reject(new Error('conversion_failed'))
        }
        const pdfBuffer = fs.readFileSync(outputPath)
        fs.rmSync(tmpDir, { recursive: true, force: true })
        resolve(pdfBuffer)
      }
    )
  })
}

module.exports = { convertToPdf }
