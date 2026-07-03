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

// Deletes the on-disk file for any order that finished 7+ days ago, leaving
// all order metadata (filenames, page counts, amounts, status) untouched —
// matches the privacy policy's "deleted 7 days after order completion" promise.
function cleanupExpiredFiles() {
  const orders = db.listOrdersForFileCleanup()
  for (const order of orders) {
    deleteFilesForOrder(order)
    db.updateOrder(order.id, { files_deleted_at: Date.now() })
  }
  return orders.length
}

module.exports = { cleanupExpiredFiles, deleteFilesForOrder }
