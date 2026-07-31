const fs = require('fs')
const path = require('path')
const db = require('./db')

const uploadsDir = path.join(__dirname, 'uploads')

// Removes the on-disk upload(s) for a single order. Safe to call repeatedly —
// missing files are ignored. Does not touch the DB row.
function deleteFilesForOrder(order) {
  let fileIds = []
  if (order.files_json) {
    try { fileIds = JSON.parse(order.files_json).map((f) => f.fileId) } catch (err) { fileIds = [] }
  } else if (order.file_path) {
    fileIds = [order.file_path]
  }
  for (const fileId of fileIds) {
    try { fs.unlinkSync(path.join(uploadsDir, fileId)) } catch (err) { /* already gone, ignore */ }
  }
}

// Deletes the on-disk file for any order that finished 3+ days ago, leaving
// all order metadata (filenames, page counts, amounts, status) untouched —
// matches the privacy policy's "deleted 3 days after order completion" promise.
function cleanupExpiredFiles() {
  const orders = db.listOrdersForFileCleanup()
  for (const order of orders) {
    deleteFilesForOrder(order)
    db.updateOrder(order.id, { files_deleted_at: Date.now() })
  }
  return orders.length
}

// Files land in uploads/ the moment they're picked (before checkout even
// starts, so they can be analyzed/priced) — an abandoned checkout (closed
// tab, never placed an order) leaves that file behind forever, since it's
// never attached to any order for cleanupExpiredFiles() above to find. This
// sweeps uploads/ directly: anything old enough that no legitimate
// in-progress checkout could still need it, and not referenced by any order.
const ORPHANED_UPLOAD_AGE_MS = 48 * 60 * 60 * 1000

function cleanupOrphanedUploads() {
  let entries
  try { entries = fs.readdirSync(uploadsDir) } catch (err) { return 0 }
  const referenced = db.getAllOrderFileIds()
  const cutoff = Date.now() - ORPHANED_UPLOAD_AGE_MS
  let removed = 0
  for (const name of entries) {
    if (referenced.has(name)) continue
    const filePath = path.join(uploadsDir, name)
    let stat
    try { stat = fs.statSync(filePath) } catch (err) { continue }
    if (!stat.isFile() || stat.mtimeMs > cutoff) continue
    try { fs.unlinkSync(filePath) } catch (err) { continue }
    removed++
  }
  return removed
}

// Archived orders are kept for a grace period, then permanently removed.
const ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

// Hard-deletes orders that have sat in the archive longer than 30 days, along
// with their files and print jobs. Returns how many were purged.
function purgeExpiredArchive() {
  const cutoff = Date.now() - ARCHIVE_RETENTION_MS
  const orders = db.listArchivedBefore(cutoff)
  for (const order of orders) {
    deleteFilesForOrder(order)
    db.deleteOrder(order.id)
  }
  if (orders.length) console.log(`[archive] purged ${orders.length} order(s) archived >30 days`)
  return orders.length
}

module.exports = { cleanupExpiredFiles, deleteFilesForOrder, purgeExpiredArchive, cleanupOrphanedUploads }
