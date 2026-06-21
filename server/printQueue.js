const db = require('./db')

// Stub print pipeline — no kiosk/printer hardware is connected yet.
// enqueue() just records a queued job; a future kiosk agent or admin
// action is expected to call markPrinting/markCompleted/markFailed.
function enqueue(orderId) {
  const job = db.createPrintJob(orderId)
  db.updateOrder(orderId, { order_status: 'Queued For Printing' })
  console.log(`[printQueue] order ${orderId} queued for printing (job #${job.id}) — no printer connected, awaiting manual/kiosk pickup`)
  return job
}

function markPrinting(jobId, orderId) {
  db.updatePrintJob(jobId, { status: 'printing' })
  db.updateOrder(orderId, { order_status: 'Printing' })
}

function markCompleted(jobId, orderId) {
  db.updatePrintJob(jobId, { status: 'completed' })
  db.updateOrder(orderId, { order_status: 'Completed' })
}

function markFailed(jobId, orderId, reason) {
  db.updatePrintJob(jobId, { status: 'failed', error_reason: reason })
  db.updateOrder(orderId, { order_status: 'Manual Intervention Required', failure_reason: reason })
}

module.exports = { enqueue, markPrinting, markCompleted, markFailed }
