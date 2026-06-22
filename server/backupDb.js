const fs = require('fs')
const os = require('os')
const path = require('path')
const { db } = require('./db')

const BUCKET_NAME = process.env.DB_BACKUP_BUCKET || 'metalix-print-db-backups'

// Uses better-sqlite3's online backup API, which is safe to run against a
// live database under write load (it doesn't block or corrupt in-flight
// transactions) — a plain file copy of a WAL-mode DB would not be safe.
async function backupDatabase() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const tmpFile = path.join(os.tmpdir(), `metalix-backup-${stamp}.db`)

  try {
    await db.backup(tmpFile)

    let Storage
    try {
      ;({ Storage } = require('@google-cloud/storage'))
    } catch (err) {
      console.warn('[backup] @google-cloud/storage not available, skipping upload')
      return
    }

    const storage = new Storage()
    await storage.bucket(BUCKET_NAME).upload(tmpFile, { destination: `metalix-${stamp}.db` })
    console.log(`[backup] uploaded snapshot metalix-${stamp}.db to gs://${BUCKET_NAME}`)
  } catch (err) {
    console.error('[backup] failed:', err.message)
  } finally {
    fs.unlink(tmpFile, () => {})
  }
}

module.exports = { backupDatabase }
