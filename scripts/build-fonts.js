#!/usr/bin/env node
/*
 * Regenerates the self-hosted web fonts in server/public/fonts/.
 *
 * landing.html uses Syne, Inter and IBM Plex Mono. Instead of loading them from
 * Google's CDN (an extra third-party connection on the critical path), we host
 * glyph-subset copies ourselves. Each file is subset — via the Google Fonts
 * `text=` API — to only the characters the page actually renders, so every
 * weight is ~10-15 KB instead of the 50-85 KB full latin/latin-ext subsets.
 *
 * Re-run this whenever the page introduces a new character or font weight:
 *   node scripts/build-fonts.js
 * Then commit the regenerated *.woff2 files.
 */
const fs = require('fs')
const path = require('path')
const https = require('https')

const OUTDIR = path.join(__dirname, '..', 'server', 'public', 'fonts')
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120 Safari/537.36'

// Every glyph the page can render in a web font: printable ASCII plus the
// non-emoji special characters found in landing.html. Emoji/pictographs render
// in the system emoji font, not Inter/Syne/Mono, so they're excluded on purpose.
let chars = ''
for (let c = 0x20; c <= 0x7e; c++) chars += String.fromCodePoint(c)
chars += '©·×–—…₹→↓' // © · × – — … ₹ → ↓

// Weights here must match the @font-face rules in landing.html.
const families = [
  { name: 'Syne', weights: [700, 800] },
  { name: 'Inter', weights: [400, 500, 600, 700] },
  { name: 'IBM Plex Mono', weights: [600, 700] },
]

function get(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA } }, (r) => {
        if (r.statusCode !== 200) return reject(new Error(url + ' -> ' + r.statusCode))
        const chunks = []
        r.on('data', (d) => chunks.push(d))
        r.on('end', () => resolve(Buffer.concat(chunks)))
      })
      .on('error', reject)
  })
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true })
  for (const fam of families) {
    for (const w of fam.weights) {
      const cssUrl =
        `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fam.name)}` +
        `:wght@${w}&text=${encodeURIComponent(chars)}`
      const css = (await get(cssUrl)).toString('utf8')
      const woffUrl = /src:\s*url\(([^)]+)\)/.exec(css)[1]
      const buf = await get(woffUrl)
      const slug = fam.name.replace(/\s+/g, '') + '-' + w + '.woff2'
      fs.writeFileSync(path.join(OUTDIR, slug), buf)
      console.log(slug.padEnd(24), buf.length, 'bytes')
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
