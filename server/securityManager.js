const fs = require('fs')
const path = require('path')

const dataDir = path.join(__dirname, 'data')
const ordersFile = path.join(dataDir, 'orders.json')

function ensure() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
  if (!fs.existsSync(ordersFile)) fs.writeFileSync(ordersFile, JSON.stringify([]))
}

function readOrders() {
  ensure()
  try {
    const raw = fs.readFileSync(ordersFile, 'utf8')
    return JSON.parse(raw || '[]')
  } catch (err) {
    return []
  }
}

function writeOrders(list) {
  ensure()
  fs.writeFileSync(ordersFile, JSON.stringify(list, null, 2))
}

function saveOrder(order) {
  const list = readOrders()
  list.push(order)
  writeOrders(list)
  return order
}

function updateOrderStatus(id, updates) {
  const list = readOrders()
  const idx = list.findIndex((o) => o.id === id)
  if (idx === -1) return null
  list[idx] = Object.assign({}, list[idx], updates)
  writeOrders(list)
  return list[idx]
}

function getOrder(id) {
  const list = readOrders()
  return list.find((o) => o.id === id) || null
}

module.exports = { saveOrder, updateOrderStatus, getOrder }
