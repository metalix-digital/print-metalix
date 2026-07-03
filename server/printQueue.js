const db = require('./db')

// Stub print pipeline — no kiosk/printer hardware is connected yet. enqueue()
// records a queued job when an order is confirmed. Since the admin drives the
// workflow via order status, syncPrintJobStatus() keeps the print_jobs record
// in step whenever the order's status changes.
function enqueue(orderId) {
  const job = db.createPrintJob(orderId)
  db.updateOrder(orderId, { order_status: 'Queued For Printing' })
  console.log(`[printQueue] order ${orderId} queued for printing (job #${job.id}) — no printer connected, awaiting manual/kiosk pickup`)
  return job
}

// Maps an order status (including admin-defined custom stages) to the physical
// print-job lifecycle state, or null for stages that shouldn't move the job.
function jobStatusForOrderStatus(orderStatus) {
  const s = String(orderStatus || '').toLowerCase()
  if (s.includes('fail') || s.includes('manual') || s.includes('cancel')) return 'failed'
  if (s.includes('queue')) return 'queued'
  if (s.includes('print')) return 'printing' // "Printing" (queued handled above)
  // Everything past printing — completed / delivered / collected / pickup /
  // out for delivery / ready to ship — means the print itself is done.
  if (['complet', 'deliver', 'collect', 'pickup', 'ship', 'ready', 'out for'].some((k) => s.includes(k))) return 'completed'
  return null
}

// Keeps the order's latest print job in sync with its order status. No-op if
// there's no job, the status doesn't map, or it's already correct.
function syncPrintJobStatus(orderId, orderStatus) {
  const target = jobStatusForOrderStatus(orderStatus)
  if (!target) return
  const job = db.getLatestPrintJobForOrder(orderId)
  if (!job || job.status === target) return
  db.updatePrintJob(job.id, { status: target })
}

module.exports = { enqueue, syncPrintJobStatus }
