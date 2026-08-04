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

  -- Multi-branch admin access: a 'super_admin' sees every location; a
  -- 'branch_admin' is scoped to exactly one location_id (see requireAdmin /
  -- scopeLocation in server.js). The legacy single admin_auth settings row is
  -- migrated into this table as the first super_admin (see seedAdminAuth).
  CREATE TABLE IF NOT EXISTS admin_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'super_admin',
    location_id TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);

  -- Branches/pickup locations, promoted from a settings-JSON blob to a real
  -- table so each can own its admin_users, its own open/closed toggle, and
  -- its own hours independent of the site-wide shopOpen kill switch.
  CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    pincode TEXT,
    active INTEGER DEFAULT 1,
    shop_open INTEGER DEFAULT 1,
    hours_weekdays TEXT,
    hours_saturday TEXT,
    hours_sunday TEXT,
    maps_url TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );

  -- SEO blog posts, managed from the admin Blog tab and published at /blog.
  -- tags is a JSON array; body is Markdown, rendered to HTML on read.
  CREATE TABLE IF NOT EXISTS blog_posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    author TEXT,
    excerpt TEXT,
    cover_image TEXT,
    category TEXT,
    tags TEXT,
    author_bio TEXT,
    body TEXT,
    meta_title TEXT,
    meta_description TEXT,
    meta_keywords TEXT,
    published INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER,
    published_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_posts_slug ON blog_posts(slug);
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
ensureColumn('orders', 'handling_charge', 'INTEGER DEFAULT 0')
ensureColumn('orders', 'delivery_timing', "TEXT DEFAULT 'instant'") // 'instant' | 'scheduled', delivery orders only
ensureColumn('orders', 'scheduled_at', 'INTEGER') // epoch ms, set only when delivery_timing = 'scheduled'
ensureColumn('orders', 'payment_link_id', 'TEXT')   // gateway Payment Link id, set when a link is generated for this order
ensureColumn('orders', 'payment_link_url', 'TEXT')
ensureColumn('orders', 'cashfree_order_id', 'TEXT')   // Cashfree's internal order reference — support/audit only, not used for lookups (Cashfree's order_id is our own order id by construction)
ensureColumn('orders', 'cashfree_payment_id', 'TEXT') // shown to customers/staff as "Transaction ID" — the functional replacement for razorpay_payment_id going forward
ensureColumn('orders', 'notes', 'TEXT') // optional free-text instructions from the customer (or added by staff) for whoever fulfils the order
// Summary of the productType(s) present across files_json's entries — 'document'
// (the only kind that existed before this column), 'passport-photo', or 'mixed'
// when an order contains both. Mirrors how paper_size/paper_type are already
// denormalized summaries of files_json rather than authoritative data.
ensureColumn('orders', 'product_type', "TEXT DEFAULT 'document'")
// Discount fields — discount_amount is the computed ₹ actually applied,
// baked in at order time (same reasoning as files_json's fileBreakdown: a
// later coupon/rate change must never rewrite what a past order was charged
// or what its invoice shows). discount_type/value record what produced that
// amount (for display); discount_code is set only when a coupon was used
// (vs a staff ad-hoc discount, which is discount_code IS NULL); discount_reason
// is optional free text staff can attach to an ad-hoc discount.
ensureColumn('orders', 'discount_type', 'TEXT')
ensureColumn('orders', 'discount_value', 'REAL DEFAULT 0')
ensureColumn('orders', 'discount_amount', 'INTEGER DEFAULT 0')
ensureColumn('orders', 'discount_code', 'TEXT')
ensureColumn('orders', 'discount_reason', 'TEXT')
ensureColumn('users', 'google_id', 'TEXT')
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL")
ensureColumn('locations', 'maps_url', 'TEXT')
// NULL/empty means "all tabs" (every existing branch_admin keeps full access
// to their existing tab set — this is additive, not a default lockdown).
ensureColumn('admin_users', 'allowed_tabs', 'TEXT')

// orders had no indexes beyond the implicit primary key on id — every list/
// filter query (listOrders, listCustomers, archived-orders, file-cleanup,
// per-branch scoping) was a full table scan, worsening as orders accumulate.
// These cover the columns actually filtered/sorted on above.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_archived_at ON orders(archived_at);
  CREATE INDEX IF NOT EXISTS idx_orders_location_id ON orders(location_id);
  CREATE INDEX IF NOT EXISTS idx_orders_customer_mobile ON orders(customer_mobile);
  CREATE INDEX IF NOT EXISTS idx_orders_order_status ON orders(order_status);
  CREATE INDEX IF NOT EXISTS idx_orders_payment_status ON orders(payment_status);
  CREATE INDEX IF NOT EXISTS idx_orders_discount_code ON orders(discount_code);
`)

// Paper types are an admin-managed list: each entry is
// { id, label, bw: { single, double }, color: { single } }. The `id` is a
// stable slug used on stored orders and in lookups; `label` is the editable
// display name. Colour is single-sided only, so there is no color.double rate.
//
// pageSizes is a separate admin-managed list of { id, label, active, widthMm,
// heightMm } that populates the page-size dropdown customers pick from per
// file, and the per-size paper-type rates below. widthMm/heightMm are the
// physical print dimensions — used to size job-sheet PDF pages and the
// customer-facing print preview — and are deliberately admin-owned data, not
// a hardcoded lookup keyed by id: renaming a row's label (e.g. "Letter" ->
// "4R" for a photo size) never changes its id, so a static id->dimensions
// table would silently keep sizing that row as the old physical size. 'a4'
// must always be present and active — every order falls back to it.
const DEFAULT_PRICING = {
  pageSizes: [
    { id: 'a4', label: 'A4', active: true, widthMm: 210, heightMm: 297, isPhotoDefault: false },
    { id: 'a3', label: 'A3', active: true, widthMm: 297, heightMm: 420, isPhotoDefault: false },
    { id: 'a5', label: 'A5', active: true, widthMm: 148, heightMm: 210, isPhotoDefault: false },
    { id: 'letter', label: 'Letter', active: true, widthMm: 215.9, heightMm: 279.4, isPhotoDefault: false },
    { id: 'legal', label: 'Legal', active: true, widthMm: 215.9, heightMm: 355.6, isPhotoDefault: false },
    { id: '4r', label: '4R', active: true, widthMm: 101.6, heightMm: 152.4, isPhotoDefault: true, photoOnly: true }
  ],
  rates: {
    a4: [
      { id: 'normal', label: 'Normal (70–75 GSM)', bw: { single: 1.5, double: 2.5 }, color: { single: 6 }, photoOnly: false },
      { id: 'bond', label: 'Bond (100 GSM)', bw: { single: 2.5, double: 4 }, color: { single: 8 }, photoOnly: false },
      { id: 'premium-gloss', label: 'Premium digital color (Gloss)', bw: { single: 4, double: 7 }, color: { single: 12 }, photoOnly: true },
      { id: 'premium-matte', label: 'Premium digital color (Matte)', bw: { single: 4, double: 7 }, color: { single: 12 }, photoOnly: true }
    ]
  },
  deliveryCharge: 30,          // fallback rate: unrecognized/missing PIN code
  deliveryLocalPincode: '122505',
  deliveryLocalCharge: 20,
  deliveryGurugramCharge: 60,  // rest of Gurugram (122xxx), outside the local PIN
  deliveryPerKmRate: 5,        // outside Gurugram: straight-line km × this rate
  freeDeliveryThreshold: 500,  // order value (print + handling) at/above which delivery is free
  handlingCharge: 10,
  gstPercent: 5,
  // Passport Photos is a flat-pack product (see pricing.js calculate()), not
  // priced per-page like documents above. sizePresets are admin-managed mm
  // dimensions the customer crops to; packPrices are the three fixed
  // quantity tiers — same price at every size preset by design.
  passportPhotos: {
    sizePresets: [
      { id: 'standard', label: 'Standard', active: true, widthMm: 35, heightMm: 45 },
      { id: 'indian-passport', label: 'Indian Passport', active: true, widthMm: 51, heightMm: 51 },
      { id: 'us-visa', label: 'US Visa', active: true, widthMm: 51, heightMm: 51 },
      { id: 'uk-visa', label: 'UK Visa', active: true, widthMm: 35, heightMm: 45 },
      { id: 'schengen-visa', label: 'Schengen Visa', active: true, widthMm: 35, heightMm: 45 }
    ],
    packPrices: [
      { qty: 8, price: 97 },
      { qty: 16, price: 146 },
      { qty: 32, price: 194 }
    ]
  },
  // Admin-configurable starting values for a freshly uploaded file's per-file
  // options (client/index.html's file cards) — separate for the Documents
  // and Photos tabs since they warrant different sensible defaults (e.g. a
  // photo defaults to Color, a document to B&W). The customer can always
  // change any of these; they just save a click for the common case.
  orderDefaults: {
    document: { printMode: 'bw', pageSize: 'a4', paperType: 'normal', orientation: 'portrait', printSide: 'single' },
    photo: { printMode: 'color', pageSize: 'a4', paperType: 'premium-gloss', orientation: 'portrait', printSide: 'single' }
  },
  // Admin-managed coupon codes for public checkout (flat ₹ or % off). A
  // staff-entered ad-hoc discount on a walk-in order doesn't live here — it's
  // typed directly at order time and never goes through this list. Usage caps
  // (maxUses) are enforced by counting matching paid/COD orders live (see
  // countCouponUses below), not a stored counter, so it can't drift out of
  // sync with what was actually charged.
  coupons: []
}

// Default display labels for the three built-in paper-type ids, used when
// migrating older settings rows that stored ids without labels.
const DEFAULT_PAPER_LABELS = { normal: 'Normal (70–75 GSM)', bond: 'Bond (100 GSM)', premium: 'Premium digital color' }

function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

// Fallback physical dimensions used only when a pageSizes row doesn't carry
// its own widthMm/heightMm yet (rows saved before this field existed). Keyed
// by id, so it's only ever correct for a row whose id still matches its
// original meaning — a renamed row (id 'letter', label '4R') intentionally
// does NOT get fixed by this table; the admin must set real dimensions for it.
const STANDARD_SIZE_MM = {
  a4: [210, 297],
  a3: [297, 420],
  a5: [148, 210],
  letter: [215.9, 279.4],
  legal: [215.9, 355.6],
  '4r': [101.6, 152.4]
}

// Coerces an admin-supplied pageSizes array into the canonical shape: unique
// non-empty ids/labels, with 'a4' always present and always active (it's
// required by rates — every order is priced/placed against rates.a4).
// isPhotoDefault marks the one size a JPG/PNG upload should default to in the
// admin "New order" flow (staff placing phone/WhatsApp orders) — at most one
// row can carry it, and only an active row; an inactive/removed candidate
// just means no photo default until the admin picks another. photoOnly is a
// separate, independent flag: it hides this size from the customer order
// page's Documents/Photos-shared file list when the file wasn't added via the
// Photos tab (see client/index.html pageSizesForFile()) — e.g. a small 4R
// print size that should never show up as a Documents option.
function normalizePageSizes(list) {
  const out = []
  const seen = new Set()
  let photoDefaultSet = false
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const label = String(row.label || '').trim()
    if (!label) return
    let id = slugify(row.id || label) || 'size'
    let unique = id
    let n = 2
    while (seen.has(unique)) unique = `${id}-${n++}`
    seen.add(unique)
    const fallback = STANDARD_SIZE_MM[unique] || STANDARD_SIZE_MM.a4
    const active = unique === 'a4' || row.active !== false
    const isPhotoDefault = !photoDefaultSet && active && !!row.isPhotoDefault
    if (isPhotoDefault) photoDefaultSet = true
    out.push({
      id: unique,
      label,
      active,
      widthMm: num(row.widthMm, fallback[0]) || fallback[0],
      heightMm: num(row.heightMm, fallback[1]) || fallback[1],
      isPhotoDefault,
      photoOnly: !!row.photoOnly
    })
  })
  if (!seen.has('a4')) out.unshift({ id: 'a4', label: 'A4', active: true, widthMm: 210, heightMm: 297, isPhotoDefault: false, photoOnly: false })
  return out
}

function num(v, fallback = 0) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

// Coerces an admin-supplied rates.a4 array into the canonical shape: every row
// gets a unique non-empty id (slugified from its label when missing) and
// numeric rate cells. Rows without a usable label are dropped. photoOnly
// marks a paper type (e.g. "Premium digital color (Gloss/Matte)") as only
// offered to files added via the Photos tab, even though it lives under a
// page size (like A4) that Documents also uses — see client/index.html
// paperTypesForFile().
function normalizePaperTypes(list) {
  const out = []
  const seen = new Set()
  ;(Array.isArray(list) ? list : []).forEach((row, i) => {
    if (!row || typeof row !== 'object') return
    const label = String(row.label || '').trim()
    if (!label) return
    let id = slugify(row.id || label) || 'type'
    let unique = id
    let n = 2
    while (seen.has(unique)) unique = `${id}-${n++}`
    seen.add(unique)
    out.push({
      id: unique,
      label,
      bw: { single: num(row.bw && row.bw.single), double: num(row.bw && row.bw.double) },
      color: { single: num(row.color && row.color.single) },
      photoOnly: !!row.photoOnly
    })
  })
  return out
}

// Same id/label normalization as normalizePageSizes, but for the Passport
// Photos size-preset list — there's no "a4 must exist" equivalent here since
// nothing in this product is mandatory.
function normalizePassportSizePresets(list) {
  const out = []
  const seen = new Set()
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const label = String(row.label || '').trim()
    if (!label) return
    let id = slugify(row.id || label) || 'size'
    let unique = id
    let n = 2
    while (seen.has(unique)) unique = `${id}-${n++}`
    seen.add(unique)
    out.push({
      id: unique,
      label,
      active: row.active !== false,
      widthMm: num(row.widthMm, 35) || 35,
      heightMm: num(row.heightMm, 45) || 45
    })
  })
  return out
}

// Pack quantities are admin-managed, like size presets above — coerces to
// unique positive-integer qtys (sorted ascending, first occurrence wins on a
// duplicate) with numeric prices. Never left empty: if the admin's submitted
// list normalizes to nothing (e.g. every row had a blank/invalid qty), falls
// back to the seeded defaults rather than silently offering zero pack sizes.
function normalizePassportPackPrices(list) {
  const seen = new Set()
  const out = []
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    if (!row) return
    const qty = Math.round(Number(row.qty))
    if (!Number.isFinite(qty) || qty <= 0 || seen.has(qty)) return
    seen.add(qty)
    out.push({ qty, price: num(row.price) })
  })
  out.sort((a, b) => a.qty - b.qty)
  return out.length ? out : JSON.parse(JSON.stringify(DEFAULT_PRICING.passportPhotos.packPrices))
}

// Coupon codes for public checkout. Unlike the lists above, an empty result
// here is a valid end state (no coupons configured) rather than something to
// fall back to defaults for — DEFAULT_PRICING.coupons is already []. Codes
// are uppercased/stripped to [A-Z0-9] so lookups never depend on how staff
// happened to type a code, and de-duped (first occurrence wins on a repeat).
function normalizeCoupons(list) {
  const seen = new Set()
  const out = []
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const code = String(row.code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!code || seen.has(code)) return
    const type = row.type === 'flat' ? 'flat' : 'percent'
    let value = num(row.value)
    if (type === 'percent') value = Math.min(value, 100)
    if (value <= 0) return
    seen.add(code)
    out.push({
      code,
      type,
      value,
      active: row.active !== false,
      minOrderValue: Math.max(0, num(row.minOrderValue)),
      maxUses: row.maxUses != null && Number(row.maxUses) > 0 ? Math.round(Number(row.maxUses)) : null,
      expiresAt: row.expiresAt != null && Number(row.expiresAt) > 0 ? Math.round(Number(row.expiresAt)) : null
    })
  })
  return out
}

const VALID_PRINT_MODES = ['auto', 'color', 'bw']
const VALID_ORIENTATIONS_LIST = ['portrait', 'landscape']
const VALID_PRINT_SIDES = ['single', 'double']

// Resolves one context's (document or photo) admin-configured file-option
// defaults against the ALREADY-normalized pageSizes/rates for this same
// settings row, so a default referencing a since-removed/renamed size or
// paper type can never leave a customer with an invalid pre-selection —
// falls back to the first active page size / first paper type under it.
function normalizeOneOrderDefaults(input, pageSizes, rates, fallbackPrintMode) {
  const d = input || {}
  const activeIds = pageSizes.filter((s) => s.active).map((s) => s.id)
  const pageSize = activeIds.includes(d.pageSize) ? d.pageSize : (activeIds[0] || 'a4')
  const typeIds = (rates[pageSize] || []).map((t) => t.id)
  const paperType = typeIds.includes(d.paperType) ? d.paperType : (typeIds[0] || '')
  return {
    printMode: VALID_PRINT_MODES.includes(d.printMode) ? d.printMode : fallbackPrintMode,
    pageSize,
    paperType,
    orientation: VALID_ORIENTATIONS_LIST.includes(d.orientation) ? d.orientation : 'portrait',
    printSide: VALID_PRINT_SIDES.includes(d.printSide) ? d.printSide : 'single'
  }
}
function normalizeOrderDefaults(input, pageSizes, rates) {
  const d = input || {}
  return {
    document: normalizeOneOrderDefaults(d.document, pageSizes, rates, 'bw'),
    photo: normalizeOneOrderDefaults(d.photo, pageSizes, rates, 'color')
  }
}

// Older settings rows stored rates.a4 as an object (keyed by paper type) or,
// even earlier, as a flat { bw, color } with no paper types at all. Convert
// both into the current ordered array. Already-array rows pass through
// (normalized). Also backfills pageSizes for rows saved before that field
// existed. (A3 support was removed — legacy rates.a3 data is ignored.)
function migratePricing(pricing) {
  // Rows saved before pageSizes existed had the a3/a5/letter/legal options
  // hardcoded client-side regardless of DB content — backfill from that same
  // default list (not just 'a4') so migrating doesn't silently drop them.
  pricing.pageSizes = normalizePageSizes(
    Array.isArray(pricing.pageSizes) ? pricing.pageSizes : DEFAULT_PRICING.pageSizes
  )
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
  const needsCoreMigration = !Array.isArray(pricing.rates && pricing.rates.a4) || !Array.isArray(pricing.pageSizes)
  // Rows saved before Passport Photos existed won't have this key at all —
  // backfill it independently of the core migration above, which only runs
  // for pre-pageSizes rows and would otherwise never touch an already-valid
  // existing settings row, leaving passportPhotos undefined forever.
  const needsPassportBackfill = !pricing.passportPhotos ||
    !Array.isArray(pricing.passportPhotos.sizePresets) ||
    !Array.isArray(pricing.passportPhotos.packPrices)
  // Same reasoning as needsPassportBackfill — a settings row saved before
  // per-context order defaults existed won't have this key, and an already-
  // valid row otherwise never gets touched again to backfill it.
  const needsOrderDefaultsBackfill = !pricing.orderDefaults || !pricing.orderDefaults.document || !pricing.orderDefaults.photo
  // Rows saved before coupons existed won't have this key at all — same
  // backfill-independently-of-core-migration reasoning as passport photos above.
  const needsCouponsBackfill = !Array.isArray(pricing.coupons)
  if (needsCoreMigration || needsPassportBackfill || needsOrderDefaultsBackfill || needsCouponsBackfill) {
    const migrated = needsCoreMigration ? migratePricing(pricing) : pricing
    migrated.passportPhotos = {
      sizePresets: normalizePassportSizePresets(
        Array.isArray(migrated.passportPhotos && migrated.passportPhotos.sizePresets)
          ? migrated.passportPhotos.sizePresets
          : DEFAULT_PRICING.passportPhotos.sizePresets
      ),
      packPrices: normalizePassportPackPrices(migrated.passportPhotos && migrated.passportPhotos.packPrices)
    }
    migrated.orderDefaults = normalizeOrderDefaults(migrated.orderDefaults, migrated.pageSizes, migrated.rates)
    migrated.coupons = normalizeCoupons(migrated.coupons)
    setPricing(migrated)
    return migrated
  }
  return pricing
}

function setPricing(pricing) {
  // Page sizes populate the print-rates table's Page Size dropdown; 'a4' is
  // always kept present since rates.a4 is required below.
  if (pricing) pricing.pageSizes = normalizePageSizes(pricing.pageSizes)
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
  // Always normalize passportPhotos too, same convention as pageSizes/rates
  // above: the admin Pricing tab re-collects and PUTs its *entire* current
  // state on every save (see admin.html savePricing()), so this never needs
  // to preserve a previous value across calls — it only needs to coerce
  // whatever the client sent into canonical shape before persisting.
  if (pricing) {
    pricing.passportPhotos = {
      sizePresets: normalizePassportSizePresets(
        pricing.passportPhotos && pricing.passportPhotos.sizePresets
      ),
      packPrices: normalizePassportPackPrices(pricing.passportPhotos && pricing.passportPhotos.packPrices)
    }
    // Depends on pageSizes/rates already being normalized above (it validates
    // the chosen default size/paper type against them), so this must run last.
    pricing.orderDefaults = normalizeOrderDefaults(pricing.orderDefaults, pricing.pageSizes, pricing.rates)
    pricing.coupons = normalizeCoupons(pricing.coupons)
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
  // Shown to customers who leave a 4-5 star rating on the order-tracking
  // page's feedback form, prompting them to also post it publicly.
  googleReviewUrl: '',
  headOfficeAddress: 'Shop 12, MG Road Market, Near City Center Mall, Gurugram, Haryana 122001',
  pickupAddress: 'Shop 12, MG Road Market, Near City Center Mall, Gurugram, Haryana 122001',
  storeTimings: {
    weekdays: '9:00 AM – 9:00 PM',
    saturday: '9:00 AM – 8:00 PM',
    sunday: '10:00 AM – 6:00 PM'
  },
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
  },
  analytics: {
    // GA4 is configured *inside* the GTM container (a tag + trigger on
    // Google's side), not loaded directly here — avoids double-counting
    // pageviews/events between a direct gtag.js load and a GTM-managed one.
    gtmContainerId: '',
    searchConsoleVerification: ''
  }
}

const seedSiteSettings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
seedSiteSettings.run('site', JSON.stringify(DEFAULT_SITE_SETTINGS))

// Shallow-merged with defaults so fields added after an install's 'site' row
// was first seeded (shopOpen, storeTimings) show sensible values instead of
// undefined until an admin explicitly overrides them.
function getSiteSettings() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('site')
  if (!row) return DEFAULT_SITE_SETTINGS
  const stored = JSON.parse(row.value)
  return {
    ...DEFAULT_SITE_SETTINGS,
    ...stored,
    storeTimings: { ...DEFAULT_SITE_SETTINGS.storeTimings, ...(stored.storeTimings || {}) }
  }
}

function setSiteSettings(settings) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('site', JSON.stringify(settings))
}

// The legacy single-admin credential lived in the settings table (key
// 'admin_auth') as { username, password_hash }. Read-only now — its only
// remaining purpose is as the one-time migration source into admin_users
// (see seedAdminAuth in server.js, which ensures the first super_admin row
// always exists on boot); nothing writes to this key anymore.
function getAdminAuth() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('admin_auth')
  return row ? JSON.parse(row.value) : null
}

// Multi-admin accounts (super_admin sees every location; branch_admin is
// scoped to one location_id).
function countAdminUsers() {
  return db.prepare('SELECT COUNT(*) as n FROM admin_users').get().n
}

// null means "every tab" (a fresh branch_admin, or any super_admin, is never
// restricted by default) — only an explicit array locks them down.
function parseAllowedTabs(raw) {
  if (!raw) return null
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : null
  } catch (err) {
    return null
  }
}

function createAdminUser({ id, username, password_hash, role, location_id, allowed_tabs }) {
  const now = Date.now()
  db.prepare(`INSERT INTO admin_users (id, username, password_hash, role, location_id, allowed_tabs, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, username, password_hash, role, location_id || null, allowed_tabs ? JSON.stringify(allowed_tabs) : null, now, now)
  return getAdminUserById(id)
}

function getAdminUserById(id) {
  const row = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(id)
  if (!row) return null
  return { ...row, allowed_tabs: parseAllowedTabs(row.allowed_tabs) }
}

function getAdminUserByUsername(username) {
  const row = db.prepare('SELECT * FROM admin_users WHERE LOWER(username) = LOWER(?)').get(String(username || '').trim())
  if (!row) return null
  return { ...row, allowed_tabs: parseAllowedTabs(row.allowed_tabs) }
}

// Omits password_hash — this backs the Staff management list, never a login check.
function listAdminUsers() {
  return db.prepare('SELECT id, username, role, location_id, allowed_tabs, created_at, updated_at FROM admin_users ORDER BY created_at ASC').all()
    .map((r) => ({ ...r, allowed_tabs: parseAllowedTabs(r.allowed_tabs) }))
}

function updateAdminUser(id, updates) {
  const fields = Object.keys(updates)
  if (!fields.length) return getAdminUserById(id)
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE admin_users SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...updates, id, updated_at: Date.now() })
  return getAdminUserById(id)
}

function deleteAdminUser(id) {
  db.prepare('DELETE FROM admin_users WHERE id = ?').run(id)
}

// Blog posts (admin Blog tab + public /blog). tags is stored as a JSON array
// and parsed back out on every read, mirroring the allowed_tabs pattern above.
function parseTags(raw) {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch (err) {
    return []
  }
}

function hydrateBlogPost(row) {
  if (!row) return null
  return { ...row, tags: parseTags(row.tags), published: !!row.published }
}

function createBlogPost({ id, title, slug, author, excerpt, cover_image, category, tags, author_bio, body, meta_title, meta_description, meta_keywords, published }) {
  const now = Date.now()
  db.prepare(`INSERT INTO blog_posts
    (id, title, slug, author, excerpt, cover_image, category, tags, author_bio, body, meta_title, meta_description, meta_keywords, published, created_at, updated_at, published_at)
    VALUES (@id, @title, @slug, @author, @excerpt, @cover_image, @category, @tags, @author_bio, @body, @meta_title, @meta_description, @meta_keywords, @published, @created_at, @updated_at, @published_at)`)
    .run({
      id, title, slug,
      author: author || null,
      excerpt: excerpt || null,
      cover_image: cover_image || null,
      category: category || null,
      tags: JSON.stringify(tags || []),
      author_bio: author_bio || null,
      body: body || '',
      meta_title: meta_title || null,
      meta_description: meta_description || null,
      meta_keywords: meta_keywords || null,
      published: published ? 1 : 0,
      created_at: now,
      updated_at: now,
      published_at: published ? now : null
    })
  return getBlogPostById(id)
}

function getBlogPostById(id) {
  return hydrateBlogPost(db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(id))
}

function getBlogPostBySlug(slug) {
  return hydrateBlogPost(db.prepare('SELECT * FROM blog_posts WHERE slug = ?').get(slug))
}

function listBlogPosts({ includeUnpublished } = {}) {
  const rows = includeUnpublished
    ? db.prepare('SELECT * FROM blog_posts ORDER BY created_at DESC').all()
    : db.prepare('SELECT * FROM blog_posts WHERE published = 1 ORDER BY published_at DESC').all()
  return rows.map(hydrateBlogPost)
}

function updateBlogPost(id, updates) {
  const existing = getBlogPostById(id)
  if (!existing) return null
  const patch = { ...updates }
  if ('tags' in patch) patch.tags = JSON.stringify(patch.tags || [])
  if ('published' in patch) {
    const wasPublished = !!existing.published
    const nowPublished = !!patch.published
    patch.published = nowPublished ? 1 : 0
    if (nowPublished && !wasPublished) patch.published_at = Date.now()
    if (!nowPublished) patch.published_at = null
  }
  const fields = Object.keys(patch)
  if (!fields.length) return existing
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE blog_posts SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...patch, id, updated_at: Date.now() })
  return getBlogPostById(id)
}

function deleteBlogPost(id) {
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(id)
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

// Branches / pickup locations live in the `locations` table (promoted from a
// settings-JSON blob — see migrateLocations below). Each row also carries its
// own shop_open + hours, independent of the site-wide shopOpen kill switch.
const DEFAULT_LOCATIONS = [
  { id: 'main', name: 'Main Branch', address: '', city: 'Gurugram', pincode: '', active: true }
]
const DEFAULT_LOCATION_HOURS = { weekdays: '9:00 AM – 9:00 PM', saturday: '9:00 AM – 8:00 PM', sunday: '10:00 AM – 6:00 PM' }

function rowToLocation(r) {
  return {
    id: r.id,
    name: r.name,
    address: r.address || '',
    city: r.city || '',
    pincode: r.pincode || '',
    active: !!r.active,
    mapsUrl: r.maps_url || '',
    shopOpen: r.shop_open !== 0,
    storeTimings: {
      weekdays: r.hours_weekdays || DEFAULT_LOCATION_HOURS.weekdays,
      saturday: r.hours_saturday || DEFAULT_LOCATION_HOURS.saturday,
      sunday: r.hours_sunday || DEFAULT_LOCATION_HOURS.sunday
    }
  }
}

function getLocations() {
  return db.prepare('SELECT * FROM locations ORDER BY created_at ASC').all().map(rowToLocation)
}

function getLocationById(id) {
  const r = db.prepare('SELECT * FROM locations WHERE id = ?').get(id)
  return r ? rowToLocation(r) : null
}

// Identity fields only (name/address/city/pincode/active) — upserts by id and
// deletes rows no longer present in `locations`, matching the admin Locations
// tab's "send the whole list back" editing pattern. Deliberately never
// touches shop_open/hours here; see updateLocationOperatingInfo for those.
function setLocations(locations) {
  const now = Date.now()
  const existingIds = new Set(db.prepare('SELECT id FROM locations').all().map((r) => r.id))
  const incomingIds = new Set(locations.map((l) => l.id))

  // Refuse to delete a branch that a staff login is still assigned to —
  // otherwise that branch_admin is silently orphaned (location_id pointing
  // at a row that no longer exists). Reassign them in Staff first.
  const toRemove = [...existingIds].filter((id) => !incomingIds.has(id))
  if (toRemove.length) {
    const placeholders = toRemove.map(() => '?').join(',')
    const staffStillAssigned = db.prepare(`SELECT username FROM admin_users WHERE location_id IN (${placeholders})`).all(...toRemove)
    if (staffStillAssigned.length) {
      const err = new Error(`Can't remove this branch — staff still assigned to it: ${staffStillAssigned.map((s) => s.username).join(', ')}. Reassign them in the Staff tab first.`)
      err.code = 'location_has_staff'
      throw err
    }
  }

  const tx = db.transaction(() => {
    for (const l of locations) {
      const params = { id: l.id, name: l.name, address: l.address || '', city: l.city || '', pincode: l.pincode || '', active: l.active ? 1 : 0, maps_url: l.mapsUrl || '', now }
      if (existingIds.has(l.id)) {
        db.prepare('UPDATE locations SET name=@name, address=@address, city=@city, pincode=@pincode, active=@active, maps_url=@maps_url, updated_at=@now WHERE id=@id').run(params)
      } else {
        db.prepare(`INSERT INTO locations (id, name, address, city, pincode, active, maps_url, shop_open, hours_weekdays, hours_saturday, hours_sunday, created_at, updated_at)
          VALUES (@id, @name, @address, @city, @pincode, @active, @maps_url, 1, @weekdays, @saturday, @sunday, @now, @now)`)
          .run({ ...params, weekdays: DEFAULT_LOCATION_HOURS.weekdays, saturday: DEFAULT_LOCATION_HOURS.saturday, sunday: DEFAULT_LOCATION_HOURS.sunday })
      }
    }
    for (const id of existingIds) {
      if (!incomingIds.has(id)) db.prepare('DELETE FROM locations WHERE id = ?').run(id)
    }
  })
  tx()
}

// Operating info only (shop_open/hours) — used by the super admin's Locations
// save. Deliberately separate from setLocations' identity fields above.
function updateLocationOperatingInfo(id, { shopOpen, storeTimings } = {}) {
  const sets = []
  const params = { id, updated_at: Date.now() }
  if (shopOpen !== undefined) { sets.push('shop_open = @shop_open'); params.shop_open = shopOpen ? 1 : 0 }
  if (storeTimings) {
    if (storeTimings.weekdays !== undefined) { sets.push('hours_weekdays = @hours_weekdays'); params.hours_weekdays = storeTimings.weekdays }
    if (storeTimings.saturday !== undefined) { sets.push('hours_saturday = @hours_saturday'); params.hours_saturday = storeTimings.saturday }
    if (storeTimings.sunday !== undefined) { sets.push('hours_sunday = @hours_sunday'); params.hours_sunday = storeTimings.sunday }
  }
  if (!sets.length) return getLocationById(id)
  db.prepare(`UPDATE locations SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`).run(params)
  return getLocationById(id)
}

// One-time migration: import the legacy settings-JSON locations (or the
// single default branch) into the new table so existing installs keep their
// branch list with zero manual steps.
;(function migrateLocations() {
  const count = db.prepare('SELECT COUNT(*) as n FROM locations').get().n
  if (count > 0) return
  const row = db.prepare("SELECT value FROM settings WHERE key = 'locations'").get()
  const legacy = row ? JSON.parse(row.value) : DEFAULT_LOCATIONS
  setLocations(legacy)
})()

function createOrder(order) {
  const now = order.created_at
  db.prepare(`
    INSERT INTO orders (
      id, customer_id, customer_name, customer_mobile, customer_email,
      file_name, file_path, file_type, page_count, files_json,
      orientation, print_mode, print_side, copies, paper_size, paper_type, product_type,
      delivery_method, delivery_address, delivery_city, delivery_state, delivery_pincode,
      location_id, location_name,
      payment_method,
      delivery_timing, scheduled_at,
      print_cost, delivery_charge, handling_charge, gst_amount, total_amount,
      discount_type, discount_value, discount_amount, discount_code, discount_reason,
      razorpay_order_id, cashfree_order_id, payment_status, order_status, notes,
      created_at, updated_at
    ) VALUES (
      @id, @customer_id, @customer_name, @customer_mobile, @customer_email,
      @file_name, @file_path, @file_type, @page_count, @files_json,
      @orientation, @print_mode, @print_side, @copies, @paper_size, @paper_type, @product_type,
      @delivery_method, @delivery_address, @delivery_city, @delivery_state, @delivery_pincode,
      @location_id, @location_name,
      @payment_method,
      @delivery_timing, @scheduled_at,
      @print_cost, @delivery_charge, @handling_charge, @gst_amount, @total_amount,
      @discount_type, @discount_value, @discount_amount, @discount_code, @discount_reason,
      @razorpay_order_id, @cashfree_order_id, @payment_status, @order_status, @notes,
      @created_at, @updated_at
    )
  `).run({
    files_json: null, paper_type: 'normal', product_type: 'document', customer_id: null, location_id: null, location_name: null, payment_method: 'online', delivery_timing: 'instant', scheduled_at: null, handling_charge: 0, notes: null, razorpay_order_id: null, cashfree_order_id: null,
    discount_type: null, discount_value: 0, discount_amount: 0, discount_code: null, discount_reason: null,
    ...order, created_at: now, updated_at: now
  })
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

// Atomically marks an order paid — the UPDATE only touches rows still unpaid
// (payment_status != 'paid'), so if two payment-confirmation paths race for
// the same order (verify-payment vs. the payment-link callback vs. the
// webhook — any two can arrive close together for the same order), only the
// first one's write takes effect. Returns null when the caller lost the
// race, so it can skip a duplicate print-queue enqueue + SMS/email.
function markOrderPaid(id, updates = {}) {
  const fields = { ...updates, payment_status: 'paid' }
  const setClause = Object.keys(fields).map((f) => `${f} = @${f}`).join(', ')
  const result = db.prepare(`UPDATE orders SET ${setClause}, updated_at = @updated_at WHERE id = @id AND payment_status != 'paid'`)
    .run({ ...fields, id, updated_at: Date.now() })
  return result.changes > 0 ? getOrder(id) : null
}

// Every fileId referenced by any order, any status — lets fileRetention's
// orphaned-upload sweep tell "still needed by some order" apart from
// "uploaded (e.g. an abandoned checkout) but never attached to one."
function getAllOrderFileIds() {
  const ids = new Set()
  const rows = db.prepare('SELECT files_json, file_path FROM orders').all()
  for (const row of rows) {
    if (row.files_json) {
      try { JSON.parse(row.files_json).forEach((f) => { if (f.fileId) ids.add(f.fileId) }) } catch (err) { /* ignore malformed row */ }
    }
    if (row.file_path) ids.add(row.file_path)
  }
  return ids
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
// locationId: pass a branch admin's scoped location to filter to only their
// branch's orders; omit (or null) for a super admin's unfiltered view.
function listOrders({ status, search, limit, offset, locationId } = {}) {
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
  if (locationId) {
    clauses.push('location_id = @locationId')
    params.locationId = locationId
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

function listArchivedOrders(locationId) {
  if (locationId) {
    return db.prepare('SELECT * FROM orders WHERE archived_at IS NOT NULL AND location_id = ? ORDER BY archived_at DESC').all(locationId)
  }
  return db.prepare('SELECT * FROM orders WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all()
}

// There's no dedicated customers table — the Customers view is a GROUP BY
// over orders.customer_mobile (see listCustomers below), so "editing a
// customer" means rewriting their name/mobile/email on every one of their
// own (non-archived) orders. Returns the number of order rows touched (0 if
// the mobile matched nothing, so the caller can 404).
function updateCustomerByMobile(mobile, { name, newMobile, email }, locationId) {
  const sets = []
  const setParams = {}
  if (name != null) { sets.push('customer_name = @name'); setParams.name = name }
  if (newMobile != null) { sets.push('customer_mobile = @newMobile'); setParams.newMobile = newMobile }
  if (email !== undefined) { sets.push('customer_email = @email'); setParams.email = email || null }
  if (!sets.length) return 0
  const clauses = ['customer_mobile = @mobile', 'archived_at IS NULL']
  if (locationId) clauses.push('location_id = @locationId')
  const info = db.prepare(`UPDATE orders SET ${sets.join(', ')}, updated_at = @updatedAt WHERE ${clauses.join(' AND ')}`)
    .run({ ...setParams, mobile, locationId, updatedAt: Date.now() })
  return info.changes
}

// Archives every non-archived order for a mobile (the admin "customer" identity,
// since the Customers view is grouped by mobile). Returns the affected rows.
// locationId: a branch admin only archives this customer's orders placed at
// their own branch, never a same-mobile order placed at a different branch.
function archiveCustomerByMobile(mobile, locationId) {
  const orders = locationId
    ? db.prepare('SELECT * FROM orders WHERE customer_mobile = ? AND archived_at IS NULL AND location_id = ?').all(mobile, locationId)
    : db.prepare('SELECT * FROM orders WHERE customer_mobile = ? AND archived_at IS NULL').all(mobile)
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

// How many times a coupon code has actually been used — counted live from
// paid/COD orders (the same "confirmed order" definition used everywhere
// else in this file) rather than a stored counter, so it can never drift
// out of sync with what was actually charged if an order is later deleted
// or a payment never completes.
function countCouponUses(code) {
  const row = db.prepare(`
    SELECT COUNT(*) as n FROM orders
    WHERE discount_code = ? AND (payment_status = 'paid' OR payment_method = 'cod')
  `).get(code)
  return row ? row.n : 0
}

function listCustomers(locationId) {
  const clauses = ["(payment_status = 'paid' OR payment_method = 'cod')", 'archived_at IS NULL']
  const params = []
  if (locationId) { clauses.push('location_id = ?'); params.push(locationId) }
  return db.prepare(`
    SELECT
      customer_mobile,
      customer_name,
      customer_email,
      COUNT(*) as order_count,
      SUM(total_amount) as total_spent,
      MAX(created_at) as last_order_at
    FROM orders
    WHERE ${clauses.join(' AND ')}
    GROUP BY customer_mobile
    ORDER BY last_order_at DESC
  `).all(params)
}

// Daily revenue/order-count series (gap-filled — every day in range appears
// even with zero orders, so charts never have to special-case missing dates)
// plus range totals, for the admin Analytics tab. Same "confirmed order"
// definition as listOrders/listCustomers: paid online or COD, not archived.
// Day boundaries are UTC (SQLite's own 'unixepoch' grouping), not IST —
// close enough for a trend chart, not worth the tz-conversion complexity.
function getSalesAnalytics(days) {
  const now = Date.now()
  const DAY_MS = 24 * 60 * 60 * 1000
  const since = now - (days - 1) * DAY_MS

  const rows = db.prepare(`
    SELECT
      date(created_at / 1000, 'unixepoch') as day,
      SUM(total_amount) as revenue,
      COUNT(*) as orders
    FROM orders
    WHERE (payment_status = 'paid' OR payment_method = 'cod')
      AND archived_at IS NULL
      AND created_at >= ?
    GROUP BY day
  `).all(since)
  const byDay = new Map(rows.map((r) => [r.day, r]))

  const daily = []
  for (let i = 0; i < days; i++) {
    const key = new Date(since + i * DAY_MS).toISOString().slice(0, 10)
    const row = byDay.get(key)
    daily.push({ day: key, revenue: row ? row.revenue : 0, orders: row ? row.orders : 0 })
  }

  const summary = db.prepare(`
    SELECT
      COUNT(*) as totalOrders,
      COALESCE(SUM(total_amount), 0) as totalRevenue,
      COALESCE(SUM(CASE WHEN payment_method = 'cod' THEN total_amount ELSE 0 END), 0) as codRevenue,
      COALESCE(SUM(CASE WHEN payment_method != 'cod' THEN total_amount ELSE 0 END), 0) as onlineRevenue
    FROM orders
    WHERE (payment_status = 'paid' OR payment_method = 'cod')
      AND archived_at IS NULL
      AND created_at >= ?
  `).get(since)
  summary.avgOrderValue = summary.totalOrders ? Math.round(summary.totalRevenue / summary.totalOrders) : 0

  // "Today" is always the current IST calendar day, independent of the
  // days/range filter above (staff want "how much have we made today"
  // regardless of whether the Last 7/30/90 days toggle is selected) — and
  // must be an IST day boundary, not a UTC one, since a naive UTC midnight
  // would roll over at 5:30am IST and misattribute early-morning orders to
  // "yesterday" for a business that operates in Asia/Kolkata.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
  const istDateStr = new Date(now + IST_OFFSET_MS).toISOString().slice(0, 10)
  const todayStartMs = new Date(istDateStr + 'T00:00:00.000Z').getTime() - IST_OFFSET_MS
  const today = db.prepare(`
    SELECT
      COUNT(*) as orders,
      COALESCE(SUM(total_amount), 0) as revenue
    FROM orders
    WHERE (payment_status = 'paid' OR payment_method = 'cod')
      AND archived_at IS NULL
      AND created_at >= ?
  `).get(todayStartMs)

  return { daily, summary, today }
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

function listOrderFeedback(locationId) {
  const where = locationId ? 'WHERE orders.location_id = ?' : ''
  return db.prepare(`
    SELECT order_feedback.*, orders.customer_name, orders.customer_mobile
    FROM order_feedback
    JOIN orders ON orders.id = order_feedback.order_id
    ${where}
    ORDER BY order_feedback.created_at DESC
  `).all(locationId ? [locationId] : [])
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

// The true average across every rating ever submitted (unlike
// listPublicFeedback's curated 4-5★-with-comment subset) — this is the
// number that goes into the homepage's AggregateRating structured data, so
// it has to reflect all ratings or the markup would be misleading.
function getFeedbackStats() {
  const row = db.prepare('SELECT COUNT(*) AS count, AVG(rating) AS average FROM order_feedback').get()
  return { count: row.count || 0, average: row.average || 0 }
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

// Resolves a walk-in order's staff-entered contact details to a registered
// account, if one exists — mobile takes priority (the more reliable match: a
// customer's own account almost always uses their real number, while email is
// optional and more often skipped or mistyped by staff on a phone order).
// Lets an admin-placed order still land in that person's own order history if
// they ever log in, same as it already would for a customer checking out
// signed-in themselves.
function findUserByMobileOrEmail(mobile, email) {
  if (mobile) {
    const byMobile = db.prepare('SELECT * FROM users WHERE mobile = ?').get(mobile)
    if (byMobile) return byMobile
  }
  if (email) {
    const byEmail = db.prepare('SELECT * FROM users WHERE email = ?').get(email)
    if (byEmail) return byEmail
  }
  return null
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
  markOrderPaid,
  archiveOrder,
  restoreOrder,
  listArchivedOrders,
  archiveCustomerByMobile,
  updateCustomerByMobile,
  deleteOrder,
  listArchivedBefore,
  listOrders,
  listOrdersForCustomer,
  listOrdersForFileCleanup,
  getAllOrderFileIds,
  listCustomers,
  countCouponUses,
  findUserByMobileOrEmail,
  getSalesAnalytics,
  createPrintJob,
  updatePrintJob,
  getLatestPrintJobForOrder,
  getOrderFeedback,
  createOrderFeedback,
  listOrderFeedback,
  listPublicFeedback,
  getFeedbackStats,
  getSiteSettings,
  setSiteSettings,
  getAdminAuth,
  countAdminUsers,
  createAdminUser,
  getAdminUserById,
  getAdminUserByUsername,
  listAdminUsers,
  updateAdminUser,
  deleteAdminUser,
  createBlogPost,
  getBlogPostById,
  getBlogPostBySlug,
  listBlogPosts,
  updateBlogPost,
  deleteBlogPost,
  getOrderStages,
  setOrderStages,
  getLocations,
  getLocationById,
  setLocations,
  updateLocationOperatingInfo,
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
