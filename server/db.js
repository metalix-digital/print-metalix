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

const DEFAULT_PRICING = {
  rates: {
    a4: {
      normal: { bw: { single: 1.5, double: 2.5 }, color: { single: 6, double: 10 } },
      bond: { bw: { single: 2.5, double: 4 }, color: { single: 8, double: 14 } },
      premium: { bw: { single: 4, double: 7 }, color: { single: 12, double: 20 } }
    },
    a3: {
      normal: { bw: { single: 4, double: 7 }, color: { single: 14, double: 24 } }
    }
  },
  deliveryCharge: 30,
  gstPercent: 5
}

// Pre-paper-type pricing had a flat rates.<size>.bw/color shape. Wrap it under
// a 'normal' paper type and seed bond/premium as clones so the admin can tune
// them from there, instead of breaking already-deployed settings rows.
function migratePricing(pricing) {
  if (!pricing.rates.a4.normal && pricing.rates.a4.bw) {
    const normal = { bw: pricing.rates.a4.bw, color: pricing.rates.a4.color }
    pricing.rates.a4 = { normal, bond: JSON.parse(JSON.stringify(normal)), premium: JSON.parse(JSON.stringify(normal)) }
  }
  if (!pricing.rates.a3.normal && pricing.rates.a3.bw) {
    pricing.rates.a3 = { normal: { bw: pricing.rates.a3.bw, color: pricing.rates.a3.color } }
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

function createOrder(order) {
  const now = order.created_at
  db.prepare(`
    INSERT INTO orders (
      id, customer_name, customer_mobile, customer_email,
      file_name, file_path, file_type, page_count, files_json,
      orientation, print_mode, print_side, copies, paper_size, paper_type,
      delivery_method, delivery_address, delivery_city, delivery_state, delivery_pincode,
      print_cost, delivery_charge, gst_amount, total_amount,
      razorpay_order_id, payment_status, order_status,
      created_at, updated_at
    ) VALUES (
      @id, @customer_name, @customer_mobile, @customer_email,
      @file_name, @file_path, @file_type, @page_count, @files_json,
      @orientation, @print_mode, @print_side, @copies, @paper_size, @paper_type,
      @delivery_method, @delivery_address, @delivery_city, @delivery_state, @delivery_pincode,
      @print_cost, @delivery_charge, @gst_amount, @total_amount,
      @razorpay_order_id, @payment_status, @order_status,
      @created_at, @updated_at
    )
  `).run({ files_json: null, paper_type: 'normal', ...order, created_at: now, updated_at: now })
  return getOrder(order.id)
}

function getOrder(id) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) || null
}

function updateOrder(id, updates) {
  const fields = Object.keys(updates)
  if (!fields.length) return getOrder(id)
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE orders SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...updates, id, updated_at: Date.now() })
  return getOrder(id)
}

function listOrders({ status, search, limit, offset } = {}) {
  const clauses = []
  const params = {}
  if (status) {
    clauses.push('order_status = @status')
    params.status = status
  }
  if (search) {
    clauses.push('(customer_name LIKE @search OR customer_mobile LIKE @search OR id LIKE @search)')
    params.search = `%${search}%`
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  params.limit = limit || 50
  params.offset = offset || 0
  return db.prepare(`SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`).all(params)
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

module.exports = {
  db,
  getPricing,
  setPricing,
  createOrder,
  getOrder,
  updateOrder,
  listOrders,
  listCustomers,
  createPrintJob,
  updatePrintJob,
  getSiteSettings,
  setSiteSettings
}
