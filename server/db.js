const fs = require('fs')
const path = require('path')
const Database = require('better-sqlite3')

const dataDir = path.join(__dirname, 'data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const db = new Database(path.join(dataDir, 'metalix.db'))
db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT,
    customer_mobile TEXT,
    customer_email TEXT,
    file_name TEXT,
    file_path TEXT,
    file_type TEXT,
    page_count INTEGER,
    orientation TEXT,
    print_mode TEXT,
    print_side TEXT,
    copies INTEGER,
    paper_size TEXT,
    delivery_method TEXT,
    delivery_address TEXT,
    delivery_city TEXT,
    delivery_state TEXT,
    delivery_pincode TEXT,
    print_cost INTEGER,
    delivery_charge INTEGER,
    gst_amount INTEGER,
    total_amount INTEGER,
    razorpay_order_id TEXT,
    razorpay_payment_id TEXT,
    razorpay_signature TEXT,
    payment_status TEXT DEFAULT 'created',
    order_status TEXT DEFAULT 'Received',
    failure_reason TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS print_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    error_reason TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    mobile TEXT,
    password_hash TEXT NOT NULL,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile) WHERE mobile IS NOT NULL;

  CREATE TABLE IF NOT EXISTS password_resets (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    created_at INTEGER
  );
`)

// Add columns introduced after the initial schema without breaking existing
// SQLite files (ALTER TABLE ADD COLUMN errors if the column already exists).
function ensureColumn(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}
ensureColumn('orders', 'paper_type', "TEXT DEFAULT 'normal'")
ensureColumn('orders', 'files_json', 'TEXT')
ensureColumn('orders', 'customer_id', 'TEXT')
ensureColumn('orders', 'completed_at', 'INTEGER')
ensureColumn('orders', 'files_deleted_at', 'INTEGER')
ensureColumn('orders', 'archived_at', 'INTEGER')
ensureColumn('orders', 'location_id', 'TEXT')
ensureColumn('orders', 'location_name', 'TEXT')
ensureColumn('users', 'google_id', 'TEXT')
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL")

const DEFAULT_PRICING = {
  rates: {
    a4: {
      normal: { bw: { single: 1.5, double: 2.5 }, color: { single: 6, double: 10 } },
      bond: { bw: { single: 2.5, double: 4 }, color: { single: 8, double: 14 } },
      premium: { bw: { single: 4, double: 7 }, color: { single: 12, double: 20 } }
    }
  },
  deliveryCharge: 30,
  gstPercent: 5
}

// Pre-paper-type pricing had a flat rates.a4.bw/color shape. Wrap it under
// a 'normal' paper type and seed bond/premium as clones so the admin can tune
// them from there, instead of breaking already-deployed settings rows.
// (A3 support was removed — any legacy rates.a3 data in already-stored
// settings rows is simply ignored, not migrated.)
function migratePricing(pricing) {
  if (!pricing.rates.a4.normal && pricing.rates.a4.bw) {
    const normal = { bw: pricing.rates.a4.bw, color: pricing.rates.a4.color }
    pricing.rates.a4 = { normal, bond: JSON.parse(JSON.stringify(normal)), premium: JSON.parse(JSON.stringify(normal)) }
  }
  return pricing
}

const seedPricing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
seedPricing.run('pricing', JSON.stringify(DEFAULT_PRICING))

function getPricing() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pricing')
  if (!row) return DEFAULT_PRICING
  const pricing = JSON.parse(row.value)
  if (!pricing.rates.a4.normal) {
    const migrated = migratePricing(pricing)
    setPricing(migrated)
    return migrated
  }
  return pricing
}

function setPricing(pricing) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('pricing', JSON.stringify(pricing))
}

const DEFAULT_SITE_SETTINGS = {
  businessName: 'Metalix Print',
  phone: '+91 98765 43210',
  whatsapp: '+91 98765 43210',
  email: 'hello@metalix.in',
  headOfficeAddress: 'Shop 12, MG Road Market, Near City Center Mall, Gurugram, Haryana 122001',
  pickupAddress: 'Shop 12, MG Road Market, Near City Center Mall, Gurugram, Haryana 122001',
  legal: {
    privacyPolicy: '',
    refundPolicy: '',
    termsConditions: '',
    shippingPolicy: ''
  },
  social: {
    facebook: '',
    instagram: '',
    linkedin: '',
    youtube: ''
  },
  seo: {
    metaTitle: 'Metalix Print — Upload · Print · Deliver',
    metaDescription: 'Upload your PDF, Word, or PPT file, pick your settings, and get it printed and delivered to your door — usually within 3–4 hours.',
    keywords: 'print shop, online printing, document printing, Gurugram'
  }
}

const seedSiteSettings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
seedSiteSettings.run('site', JSON.stringify(DEFAULT_SITE_SETTINGS))

function getSiteSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('site')
  return row ? JSON.parse(row.value) : DEFAULT_SITE_SETTINGS
}

function setSiteSettings(settings) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('site', JSON.stringify(settings))
}

// The single admin credential lives in the settings table (key 'admin_auth')
// as { username, password_hash } — a bcrypt hash, same as customer passwords.
// It is seeded once from ADMIN_USERNAME/ADMIN_PASSWORD env (see server.js) so a
// fresh DB starts with the operator's configured login and can then be changed
// or reset entirely from the web without touching .env again.
function getAdminAuth() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_auth')
  return row ? JSON.parse(row.value) : null
}

function setAdminAuth({ username, password_hash }) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('admin_auth', JSON.stringify({ username, password_hash }))
}

// Order workflow stages are admin-editable (add/delete/reorder) and stored in
// settings under 'order_stages'. Each stage carries a `notify` flag deciding
// whether reaching it emails the customer. These defaults reproduce the
// original hardcoded workflow so existing orders keep working before any edit.
const DEFAULT_ORDER_STAGES = [
  { name: 'Queued For Printing', notify: false },
  { name: 'Printing', notify: false },
  { name: 'Awaiting Customer Pickup', notify: true },
  { name: 'Out For Delivery', notify: true },
  { name: 'Completed', notify: true },
  { name: 'Manual Intervention Required', notify: false },
  { name: 'Failed', notify: false }
]

function getOrderStages() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('order_stages')
  return row ? JSON.parse(row.value) : DEFAULT_ORDER_STAGES
}

function setOrderStages(stages) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('order_stages', JSON.stringify(stages))
}

// Branches / pickup locations are admin-editable and stored in settings under
// 'locations'. Each: { id, name, address, city, pincode, active }. A default
// branch is seeded so the customer always has something to choose.
const DEFAULT_LOCATIONS = [
  { id: 'main', name: 'Main Branch', address: '', city: 'Gurugram', pincode: '', active: true }
]

function getLocations() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('locations')
  return row ? JSON.parse(row.value) : DEFAULT_LOCATIONS
}

function setLocations(locations) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('locations', JSON.stringify(locations))
}

function createOrder(order) {
  const now = order.created_at
  db.prepare(`
    INSERT INTO orders (
      id, customer_id, customer_name, customer_mobile, customer_email,
      file_name, file_path, file_type, page_count, files_json,
      orientation, print_mode, print_side, copies, paper_size, paper_type,
      delivery_method, delivery_address, delivery_city, delivery_state, delivery_pincode,
      location_id, location_name,
      print_cost, delivery_charge, gst_amount, total_amount,
      razorpay_order_id, payment_status, order_status,
      created_at, updated_at
    ) VALUES (
      @id, @customer_id, @customer_name, @customer_mobile, @customer_email,
      @file_name, @file_path, @file_type, @page_count, @files_json,
      @orientation, @print_mode, @print_side, @copies, @paper_size, @paper_type,
      @delivery_method, @delivery_address, @delivery_city, @delivery_state, @delivery_pincode,
      @location_id, @location_name,
      @print_cost, @delivery_charge, @gst_amount, @total_amount,
      @razorpay_order_id, @payment_status, @order_status,
      @created_at, @updated_at
    )
  `).run({ files_json: null, paper_type: 'normal', customer_id: null, location_id: null, location_name: null, ...order, created_at: now, updated_at: now })
  return getOrder(order.id)
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null
}

function updateOrder(id, updates) {
  const fields = Object.keys(updates)
  if (!fields.length) return getOrder(id)
  if (updates.order_status === 'Completed') {
    const current = getOrder(id)
    if (current && !current.completed_at) updates = { ...updates, completed_at: Date.now() }
  }
  const finalFields = Object.keys(updates)
  const setClause = finalFields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE orders SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...updates, id, updated_at: Date.now() })
  return getOrder(id)
}

function listOrdersForFileCleanup() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  return db.prepare(`
    SELECT * FROM orders
    WHERE completed_at IS NOT NULL AND completed_at <= ?
      AND files_deleted_at IS NULL
      AND (files_json IS NOT NULL OR file_path IS NOT NULL)
  `).all(cutoff)
}

// Order history only ever shows orders that actually received payment —
// abandoned checkouts (payment_status 'created') and failed payments never
// show up here, though the rows themselves are kept in the database.
function listOrders({ status, search, limit, offset } = {}) {
  const clauses = ["payment_status = 'paid'", 'archived_at IS NULL']
  const params = {}
  if (status) {
    clauses.push('order_status = @status')
    params.status = status
  }
  if (search) {
    clauses.push('(customer_name LIKE @search OR customer_mobile LIKE @search OR id LIKE @search)')
    params.search = `%${search}%`
  }
  const where = `WHERE ${clauses.join(' AND ')}`
  params.limit = limit || 50
  params.offset = offset || 0
  return db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all(params)
}

// Soft-delete: move an order to the archive. It vanishes from the Orders and
// Customers views (and BigQuery, which skips archived rows) but is kept for a
// 30-day grace period during which it can be restored. Returns the order or
// null if missing / already archived.
function archiveOrder(id) {
  const order = getOrder(id)
  if (!order || order.archived_at) return null
  db.prepare('UPDATE orders SET archived_at = ?, updated_at = ? WHERE id = ?').run(Date.now(), Date.now(), id)
  return getOrder(id)
}

function restoreOrder(id) {
  const order = getOrder(id)
  if (!order || !order.archived_at) return null
  db.prepare('UPDATE orders SET archived_at = NULL, updated_at = ? WHERE id = ?').run(Date.now(), id)
  return getOrder(id)
}

function listArchivedOrders() {
  return db.prepare('SELECT * FROM orders WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all()
}

// Archives every non-archived order for a mobile (the admin "customer" identity,
// since the Customers view is grouped by mobile). Returns the affected rows.
function archiveCustomerByMobile(mobile) {
  const orders = db.prepare('SELECT * FROM orders WHERE customer_mobile = ? AND archived_at IS NULL').all(mobile)
  const now = Date.now()
  const tx = db.transaction(() => {
    for (const o of orders) db.prepare('UPDATE orders SET archived_at = ?, updated_at = ? WHERE id = ?').run(now, now, o.id)
  })
  tx()
  return orders
}

// Hard-deletes an order and its print jobs. Returns the order row (so the
// caller can remove its uploaded files) or null if it didn't exist. Used by
// "delete permanently" and by the 30-day archive purge.
function deleteOrder(id) {
  const order = getOrder(id)
  if (!order) return null
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM print_jobs WHERE order_id = ?').run(id)
    db.prepare('DELETE FROM orders WHERE id = ?').run(id)
  })
  tx()
  return order
}

// Orders archived on/before `cutoff` — the 30-day purge job hard-deletes these.
function listArchivedBefore(cutoff) {
  return db.prepare('SELECT * FROM orders WHERE archived_at IS NOT NULL AND archived_at <= ?').all(cutoff)
}

function listOrdersForCustomer(customerId) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE customer_id = ? AND payment_status = 'paid'
    ORDER BY created_at DESC
  `).all(customerId)
}

function listCustomers() {
  return db.prepare(`
    SELECT
      customer_mobile,
      customer_name,
      customer_email,
      COUNT(*) as order_count,
      SUM(total_amount) as total_spent,
      MAX(created_at) as last_order_at
    FROM orders
    WHERE payment_status = 'paid' AND archived_at IS NULL
    GROUP BY customer_mobile
    ORDER BY last_order_at DESC
  `).all()
}

function createPrintJob(orderId) {
  const now = Date.now()
  const info = db.prepare('INSERT INTO print_jobs (order_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(orderId, 'queued', now, now)
  return db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(info.lastInsertRowid)
}

function updatePrintJob(id, updates) {
  const fields = Object.keys(updates)
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE print_jobs SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...updates, id, updated_at: Date.now() })
  return db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id)
}

function createUser({ id, name, email, mobile, password_hash, google_id }) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO users (id, name, email, mobile, password_hash, google_id, created_at, updated_at)
    VALUES (@id, @name, @email, @mobile, @password_hash, @google_id, @now, @now)
  `).run({ id, name, email: email || null, mobile: mobile || null, password_hash, google_id: google_id || null, now })
  return getUserById(id)
}

function findUserByIdentifier(identifier) {
  return db.prepare('SELECT * FROM users WHERE email = ? OR mobile = ?').get(identifier, identifier) || null
}

function findUserByGoogleId(googleId) {
  return db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId) || null
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email) || null
}

function linkGoogleId(userId, googleId) {
  db.prepare('UPDATE users SET google_id = ?, updated_at = ? WHERE id = ?').run(googleId, Date.now(), userId)
  return getUserById(userId)
}

function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null
}

function updateUserPassword(userId, password_hash) {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(password_hash, Date.now(), userId)
}

function createPasswordReset({ id, user_id, token_hash, expires_at }) {
  db.prepare(`
    INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, user_id, token_hash, expires_at, Date.now())
}

// Only ever looked up by the hash of the raw token (never the raw token
// itself) — mirrors the password_hash pattern so a DB leak alone can't be
// used to reset accounts.
function findValidPasswordReset(token_hash) {
  return db.prepare(`
    SELECT * FROM password_resets
    WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
  `).get(token_hash, Date.now()) || null
}

function markPasswordResetUsed(id) {
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(Date.now(), id)
}

module.exports = {
  db,
  getPricing,
  setPricing,
  createOrder,
  getOrder,
  updateOrder,
  archiveOrder,
  restoreOrder,
  listArchivedOrders,
  archiveCustomerByMobile,
  deleteOrder,
  listArchivedBefore,
  listOrders,
  listOrdersForCustomer,
  listOrdersForFileCleanup,
  listCustomers,
  createPrintJob,
  updatePrintJob,
  getSiteSettings,
  setSiteSettings,
  getAdminAuth,
  setAdminAuth,
  getOrderStages,
  setOrderStages,
  getLocations,
  setLocations,
  createUser,
  findUserByIdentifier,
  findUserByGoogleId,
  findUserByEmail,
  linkGoogleId,
  getUserById,
  updateUserPassword,
  createPasswordReset,
  findValidPasswordReset,
  markPasswordResetUsed
}
