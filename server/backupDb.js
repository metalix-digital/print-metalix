const fs = require('fs')
const os = require('os')
const path = require('path')
const { db } = require('./db')

const BUCKET_NAME = process.env.DB_BACKUP_BUCKET || 'metalix-print-db-backups'
// Local fallback lives next to the live DB file — used whenever the cloud
// upload fails or isn't configured (e.g. GCP billing disabled), which
// previously meant backups were silently not happening at all.
const LOCAL_BACKUP_DIR = path.join(__dirname, 'data', 'backups')
const LOCAL_KEEP = Number(process.env.DB_BACKUP_LOCAL_KEEP) || 28

function pruneLocalBackups() {
  let files
  try { files = fs.readdirSync(LOCAL_BACKUP_DIR).filter((f) => f.startsWith('metalix-') && f.endsWith('.db')) } catch (err) { return }
  files.sort() // ISO timestamp in the filename sorts chronologically
  const excess = files.length - LOCAL_KEEP
  if (excess <= 0) return
  files.slice(0, excess).forEach((f) => fs.unlink(path.join(LOCAL_BACKUP_DIR, f), () => {}))
}

async function pruneRemoteBackups(bucket) {
  try {
    const [files] = await bucket.getFiles({ prefix: 'metalix-' })
    const names = files.map((f) => f.name).sort()
    const excess = names.length - LOCAL_KEEP
    if (excess <= 0) return
    await Promise.all(names.slice(0, excess).map((name) => bucket.file(name).delete().catch(() => {})))
  } catch (err) {
    console.error('[backup] failed to prune old remote snapshots:', err.message)
  }
}

// Uses better-sqlite3's online backup API, which is safe to run against a
// live database under write load (it doesn't block or corrupt in-flight
// transactions) — a plain file copy of a WAL-mode DB would not be safe.
async function backupDatabase() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tmpFile = path.join(os.tmpdir(), `metalix-backup-${stamp}.db`)
  let uploaded = false

  try {
    await db.backup(tmpFile)

    let Storage
    try {
      ;({ Storage } = require('@google-cloud/storage'))
    } catch (err) {
      console.warn('[backup] @google-cloud/storage not available, falling back to a local copy')
    }

    if (Storage) {
      try {
        const storage = new Storage()
        const bucket = storage.bucket(BUCKET_NAME)
        await bucket.upload(tmpFile, { destination: `metalix-${stamp}.db` })
        console.log(`[backup] uploaded snapshot metalix-${stamp}.db to gs://${BUCKET_NAME}`)
        uploaded = true
        await pruneRemoteBackups(bucket)
      } catch (err) {
        console.error('[backup] cloud upload failed, falling back to a local copy:', err.message)
      }
    }

    if (!uploaded) {
      fs.mkdirSync(LOCAL_BACKUP_DIR, { recursive: true })
      fs.copyFileSync(tmpFile, path.join(LOCAL_BACKUP_DIR, `metalix-${stamp}.db`))
      console.log(`[backup] saved local snapshot metalix-${stamp}.db (cloud upload unavailable)`)
      pruneLocalBackups()
    }
  } catch (err) {
    console.error('[backup] failed:', err.message)
  } finally {
    fs.unlink(tmpFile, () => {})
  }
}

module.exports = { backupDatabase }
