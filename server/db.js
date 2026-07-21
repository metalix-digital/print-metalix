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

  CREATE TABLE IF NOT EXISTS order_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    rating INTEGER NOT NULL,
    comment TEXT,
    created_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_order_feedback_order_id ON order_feedback(order_id);
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
ensureColumn('orders', 'payment_method', "TEXT DEFAULT 'online'") // 'online' | 'cod'
ensureColumn('orders', 'payment_mode', 'TEXT')     // set on collection: 'cash' | 'upi'
ensureColumn('orders', 'payment_collected_at', 'INTEGER')
ensureColumn('users', 'google_id', 'TEXT')
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL")

// Paper types are an admin-managed list: each entry is
// { id, label, bw: { single, double }, color: { single } }. The `id` is a
// stable slug used on stored orders and in lookups; `label` is the editable
// display name. Colour is single-sided only, so there is no color.double rate.
const DEFAULT_PRICING = {
  rates: {
    a4: [
      { id: 'normal', label: 'Normal (70–75 GSM)', bw: { single: 1.5, double: 2.5 }, color: { single: 6 } },
      { id: 'bond', label: 'Bond (100 GSM)', bw: { single: 2.5, double: 4 }, color: { single: 8 } },
      { id: 'premium', label: 'Premium digital color', bw: { single: 4, double: 7 }, color: { single: 12 } }
    ]
  },
  deliveryCharge: 30,
  gstPercent: 5
}

// Default display labels for the three built-in paper-type ids, used when
// migrating older settings rows that stored ids without labels.
const DEFAULT_PAPER_LABELS = { normal: 'Normal (70–75 GSM)', bond: 'Bond (100 GSM)', premium: 'Premium digital color' }

function slugifyPaperType(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// Coerces an admin-supplied rates.a4 array into the canonical shape: every row
// gets a unique non-empty id (slugified from its label when missing) and
// numeric rate cells. Rows without a usable label are dropped.
function normalizePaperTypes(list) {
  const out = []
  const seen = new Set()
  ;(Array.isArray(list) ? list : []).forEach((row, i) => {
    if (!row || typeof row !== 'object') return
    const label = String(row.label || '').trim()
    if (!label) return
    let id = slugifyPaperType(row.id || label) || 'type'
    let unique = id
    let n = 2
    while (seen.has(unique)) unique = `${id}-${n++}`
    seen.add(unique)
    out.push({
      id: unique,
      label,
      bw: { single: num(row.bw && row.bw.single), double: num(row.bw && row.bw.double) },
      color: { single: num(row.color && row.color.single) }
    })
  })
  return out
}

// Older settings rows stored rates.a4 as an object (keyed by paper type) or,
// even earlier, as a flat { bw, color } with no paper types at all. Convert
// both into the current ordered array. Already-array rows pass through
// (normalized). (A3 support was removed — legacy rates.a3 data is ignored.)
function migratePricing(pricing) {
  const a4 = pricing.rates && pricing.rates.a4
  if (Array.isArray(a4)) {
    pricing.rates.a4 = normalizePaperTypes(a4)
    return pricing
  }
  let rows = []
  if (a4 && a4.bw && !a4.normal) {
    // Pre-paper-type flat shape → a single 'normal' type.
    rows = [{ id: 'normal', label: DEFAULT_PAPER_LABELS.normal, bw: a4.bw, color: a4.color }]
  } else if (a4 && typeof a4 === 'object') {
    rows = Object.keys(a4)
      .filter((id) => a4[id] && a4[id].bw)
      .map((id) => ({ id, label: a4[id].label || DEFAULT_PAPER_LABELS[id] || id, bw: a4[id].bw, color: a4[id].color }))
  }
  const normalized = normalizePaperTypes(rows)
  pricing.rates.a4 = normalized.length ? normalized : JSON.parse(JSON.stringify(DEFAULT_PRICING.rates.a4))
  return pricing
}

const seedPricing = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
seedPricing.run('pricing', JSON.stringify(DEFAULT_PRICING))

function getPricing() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('pricing')
  if (!row) return DEFAULT_PRICING
  const pricing = JSON.parse(row.value)
  if (!Array.isArray(pricing.rates && pricing.rates.a4)) {
    const migrated = migratePricing(pricing)
    setPricing(migrated)
    return migrated
  }
  return pricing
}

function setPricing(pricing) {
  // Normalize every page-size's paper-type list before persisting so admin
  // edits always land in canonical shape (unique ids, numeric rates). rates is
  // keyed by page size (a4, a3, …); each value is an array of paper-type rows.
  if (pricing && pricing.rates && typeof pricing.rates === 'object') {
    Object.keys(pricing.rates).forEach((size) => {
      if (Array.isArray(pricing.rates[size])) {
        const rows = normalizePaperTypes(pricing.rates[size])
        if (rows.length) pricing.rates[size] = rows
        else delete pricing.rates[size] // drop empty sizes, except A4 handled below
      }
    })
    if (!Array.isArray(pricing.rates.a4) || !pricing.rates.a4.length) {
      pricing.rates.a4 = JSON.parse(JSON.stringify(DEFAULT_PRICING.rates.a4))
    }
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('pricing', JSON.stringify(pricing))
}

const DEFAULT_SITE_SETTINGS = {
  shopOpen: true,
  businessName: 'Metalix Print',
  phone: '+91 98765 43210',
  whatsapp: '+91 98765 43210',
  email: 'hello@metalix.in',
  gstin: '09AHOPH6696N2Z8',
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
      payment_method,
      print_cost, delivery_charge, gst_amount, total_amount,
      razorpay_order_id, payment_status, order_status,
      created_at, updated_at
    ) VALUES (
      @id, @customer_id, @customer_name, @customer_mobile, @customer_email,
      @file_name, @file_path, @file_type, @page_count, @files_json,
      @orientation, @print_mode, @print_side, @copies, @paper_size, @paper_type,
      @delivery_method, @delivery_address, @delivery_city, @delivery_state, @delivery_pincode,
      @location_id, @location_name,
      @payment_method,
      @print_cost, @delivery_charge, @gst_amount, @total_amount,
      @razorpay_order_id, @payment_status, @order_status,
      @created_at, @updated_at
    )
  `).run({ files_json: null, paper_type: 'normal', customer_id: null, location_id: null, location_name: null, payment_method: 'online', ...order, created_at: now, updated_at: now })
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
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
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
  // Confirmed orders = paid online OR pay-on-delivery (COD); COD isn't prepaid
  // but is a committed order the shop must fulfil.
  const clauses = ["(payment_status = 'paid' OR payment_method = 'cod')", 'archived_at IS NULL']
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
    WHERE customer_id = ? AND (payment_status = 'paid' OR payment_method = 'cod')
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
    WHERE (payment_status = 'paid' OR payment_method = 'cod') AND archived_at IS NULL
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

function getLatestPrintJobForOrder(orderId) {
  return db.prepare('SELECT * FROM print_jobs WHERE order_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(orderId) || null
}

function getOrderFeedback(orderId) {
  return db.prepare('SELECT * FROM order_feedback WHERE order_id = ?').get(orderId) || null
}

// One feedback row per order — the DB's unique index on order_id is the real
// guard; the caller (POST /api/track/:id/feedback) checks first for a clean
// "already submitted" error instead of a raw constraint failure.
function createOrderFeedback({ order_id, rating, comment }) {
  const info = db.prepare('INSERT INTO order_feedback (order_id, rating, comment, created_at) VALUES (?, ?, ?, ?)')
    .run(order_id, rating, comment || null, Date.now())
  return db.prepare('SELECT * FROM order_feedback WHERE id = ?').get(info.lastInsertRowid)
}

function listOrderFeedback() {
  return db.prepare(`
    SELECT order_feedback.*, orders.customer_name, orders.customer_mobile
    FROM order_feedback
    JOIN orders ON orders.id = order_feedback.order_id
    ORDER BY order_feedback.created_at DESC
  `).all()
}

// Feeds the landing page's reviews carousel — 4-5 star only (this is a
// marketing surface, not a full public review log) and only entries with an
// actual comment, since a bare star rating makes a weak testimonial card.
function listPublicFeedback(limit = 20) {
  return db.prepare(`
    SELECT order_feedback.rating, order_feedback.comment, order_feedback.created_at, orders.customer_name
    FROM order_feedback
    JOIN orders ON orders.id = order_feedback.order_id
    WHERE order_feedback.rating >= 4 AND TRIM(COALESCE(order_feedback.comment, '')) != ''
    ORDER BY order_feedback.created_at DESC
    LIMIT ?
  `).all(limit)
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
  getLatestPrintJobForOrder,
  getOrderFeedback,
  createOrderFeedback,
  listOrderFeedback,
  listPublicFeedback,
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
