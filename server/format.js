// Shared currency formatting — mailer.js and invoice.js used to format
// rupee amounts two different ways (one with Indian-style comma grouping,
// one without), so the same total could look inconsistent depending on
// which message a customer saw. Both go through this now.
function formatRupees(n) {
  return (Number(n) || 0).toLocaleString('en-IN')
}

module.exports = { formatRupees }
