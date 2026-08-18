const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
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

  -- Stationery catalog: categories, then products. Soft-delete only (active
  -- flag) once a product has been referenced by any order — see
  -- deleteProductHardIfUnreferenced — so a historical order's line item never
  -- points at a vanished row. cost_price is admin/reporting-only and must
  -- never be forwarded by any public/customer-facing endpoint.
  CREATE TABLE IF NOT EXISTS product_categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_product_categories_slug ON product_categories(slug);

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    sku TEXT NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    description TEXT,
    category_id TEXT,
    price INTEGER NOT NULL DEFAULT 0,
    mrp INTEGER,
    cost_price INTEGER,
    stock_qty INTEGER NOT NULL DEFAULT 0,
    low_stock_threshold INTEGER NOT NULL DEFAULT 5,
    images TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    meta_title TEXT,
    meta_description TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_products_slug ON products(slug);
  CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
  CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

  -- Append-only stock audit trail — every adjustment (manual receive/damage,
  -- or system-driven order/return) writes exactly one row here, never mutated
  -- or deleted, so Stock History is always a true reconstruction of how a
  -- product's stock_qty got to its current value.
  CREATE TABLE IF NOT EXISTS stock_ledger (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    delta INTEGER NOT NULL,
    reason TEXT NOT NULL,
    reference TEXT,
    admin_id TEXT,
    note TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_stock_ledger_product_id ON stock_ledger(product_id);
  CREATE INDEX IF NOT EXISTS idx_stock_ledger_created_at ON stock_ledger(created_at);

  -- Admin-configured "you may also need" recommendations. trigger_type is
  -- either 'productType:<document|stationery|stamp>' (shown after adding any
  -- item of that type) or 'product:<id>' (shown after adding that specific
  -- product) — see cross-sell lookup in server.js.
  CREATE TABLE IF NOT EXISTS cross_sell_rules (
    id TEXT PRIMARY KEY,
    trigger_type TEXT NOT NULL,
    recommended_product_id TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_cross_sell_rules_trigger ON cross_sell_rules(trigger_type);

  -- Custom-stamp proof-approval history. One order/item can accumulate
  -- several rows over a changes-requested → re-upload cycle; the latest row
  -- for a given (order_id, item_id) is authoritative.
  CREATE TABLE IF NOT EXISTS stamp_proofs (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    uploaded_by_admin_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    customer_comment TEXT,
    created_at INTEGER,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_stamp_proofs_order_id ON stamp_proofs(order_id);
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
// Sum of any 'service' productType line items in files_json (e.g. photo
// editing) — kept as its own summary column, same denormalized-from-
// files_json convention as print_cost, so invoices/breakdowns can show
// "Additional services" as its own line without re-summing files_json every
// render. Distinct from print_cost since these aren't a per-page print rate.
ensureColumn('orders', 'services_cost', 'INTEGER DEFAULT 0')
// Sum of any 'stationery' productType line items in files_json — own summary
// column, same denormalized-from-files_json convention as services_cost.
ensureColumn('orders', 'stationery_cost', 'INTEGER DEFAULT 0')
// Sum of any 'stamp' productType line items in files_json.
ensureColumn('orders', 'stamp_cost', 'INTEGER DEFAULT 0')
// Set when a stock-decrement race meant a paid/confirmed order could not be
// fully covered by available stock (see decrementStockForOrder) — surfaced as
// a warning badge in the admin Orders tab. Never blocks an already-captured
// payment; staff resolve it manually (contact customer / restock / refund)
// and dismiss the flag via the normal order PATCH route.
ensureColumn('orders', 'needs_attention', 'INTEGER DEFAULT 0')
ensureColumn('orders', 'needs_attention_reason', 'TEXT')
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
  coupons: [],
  // Flat-priced catalog of staff-side extra work that isn't captured by the
  // per-page print rates above — e.g. photo editing before printing. Added
  // to an order as its own line item (productType 'service' in files_json)
  // by staff in New Order or Edit Order, never something a customer picks
  // themselves at checkout. Priced as a flat fee × quantity, same shape as
  // passportPhotos.packPrices, not a per-page rate.
  additionalServices: [],
  // Custom Stamp Printing config (see pricing.js calculate() 'stamp' branch).
  // A stamp's price = type.basePrice + size.priceModifier +
  // (hasLogo ? logoPrice : 0) + extraQuantityPrice × (quantity - 1). Each
  // type owns its own sizes list (real-world stamp models come in different
  // size charts per type — a Self-Inking "Code 0" and a Pre-Inked "Trodat
  // 6900" are unrelated products, not the same size under different names).
  // priceModifier left at 0 for the real Self-Inking/Pre-Inked size charts
  // below — admin fills these in from the Stamp Settings tab once pricing
  // is decided; never hardcoded into the pricing logic itself.
  stamps: {
    types: [
      {
        id: 'self-inking', label: 'Self-Inking Stamp', active: true, basePrice: 250, imageUrl: null,
        sizes: [
          { id: 'code-0', label: 'Code 0', code: '0', widthMm: 46, heightMm: 11, active: true, priceModifier: 0, imageUrl: null },
          { id: 'code-1', label: 'Code 1', code: '1', widthMm: 29, heightMm: 29, active: true, priceModifier: 0, imageUrl: null },
          { id: 'code-2', label: 'Code 2', code: '2', widthMm: 50, heightMm: 20, active: true, priceModifier: 0, imageUrl: null },
          { id: 'code-3', label: 'Code 3', code: '3', widthMm: 64, heightMm: 22, active: true, priceModifier: 0, imageUrl: null }
        ]
      },
      {
        id: 'pre-inked', label: 'Pre-Inked Stamp', active: true, basePrice: 350, imageUrl: null,
        sizes: [
          { id: 'trodat-6900', label: 'Trodat 6900', code: '6900', widthMm: 32, heightMm: 16, active: true, priceModifier: 0, imageUrl: null },
          { id: 'trodat-6901', label: 'Trodat 6901', code: '6901', widthMm: 45, heightMm: 12, active: true, priceModifier: 0, imageUrl: null },
          { id: 'trodat-6902', label: 'Trodat 6902', code: '6902', widthMm: 59, heightMm: 17, active: true, priceModifier: 0, imageUrl: null },
          { id: 'trodat-6903', label: 'Trodat 6903', code: '6903', widthMm: 49, heightMm: 22, active: true, priceModifier: 0, imageUrl: null },
          { id: 'trodat-6904', label: 'Trodat 6904', code: '6904', widthMm: 63, heightMm: 23, active: true, priceModifier: 0, imageUrl: null },
          { id: 'trodat-6330', label: 'Trodat 6330', code: '6330', widthMm: 30, heightMm: 30, active: true, priceModifier: 0, imageUrl: null }
        ]
      },
      {
        // No real size chart yet — kept as a placeholder with the old generic
        // sizes and switched off (inactive) so it's invisible to customers
        // and excluded from admin/staff pickers until it's ready to launch.
        id: 'rubber', label: 'Rubber Stamp (wooden handle)', active: false, basePrice: 150, imageUrl: null,
        sizes: [
          { id: 'small', label: 'Small (up to 25×10mm)', code: '', widthMm: 25, heightMm: 10, active: true, priceModifier: 0, imageUrl: null },
          { id: 'medium', label: 'Medium (up to 38×14mm)', code: '', widthMm: 38, heightMm: 14, active: true, priceModifier: 50, imageUrl: null },
          { id: 'large', label: 'Large (up to 60×40mm)', code: '', widthMm: 60, heightMm: 40, active: true, priceModifier: 150, imageUrl: null },
          { id: 'custom', label: 'Custom Size', code: '', widthMm: 50, heightMm: 30, active: true, priceModifier: 100, imageUrl: null }
        ]
      }
    ],
    logoPrice: 100,
    extraQuantityPrice: 200,
    // Custom stamps go through a proof-approval step before production by
    // default (see the item-status workflow in server.js) — admin can turn
    // this off for a low-friction "produce immediately" flow instead.
    requireProofApproval: true
  }
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

// Flat-priced catalog of staff-side extra work (e.g. "Photo editing" — ₹50).
// Same id/label shape as page sizes/paper types (slugified, stable, unique)
// since these get referenced by id from an order's files_json line item, not
// looked up by a user-typed string like coupon codes are. `active` lets the
// admin retire an offering from the New/Edit Order dropdowns without losing
// what it's already been charged as on past orders (those keep their own
// baked-in label/amount regardless — see fileBreakdown's reasoning in
// pricing.js).
function normalizeAdditionalServices(list) {
  const out = []
  const seen = new Set()
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const label = String(row.label || '').trim()
    if (!label) return
    let id = slugify(row.id || label) || 'service'
    let unique = id
    let n = 2
    while (seen.has(unique)) unique = `${id}-${n++}`
    seen.add(unique)
    const price = num(row.price)
    if (price <= 0) return
    out.push({ id: unique, label, price, active: row.active !== false })
  })
  return out
}

// Stamp types/sizes: same id/label normalization convention as paper types
// above (slugified stable id, unique, numeric prices) — referenced by id from
// a stamp order's files_json line item, same reasoning as additionalServices.
// Sizes live inside their type (a Self-Inking size chart and a Pre-Inked size
// chart are unrelated real-world products, not the same list reused) — each
// type normalizes its own `sizes` array, falling back to that same type id's
// DEFAULT_PRICING sizes (not a generic shared list) when missing/empty, which
// is also how a pre-restructure settings row (flat top-level `sizes`, no
// per-type list yet) picks up the real size charts on its next read/write.
function normalizeStampTypes(list) {
  const out = []
  const seen = new Set()
  ;(Array.isArray(list) ? list : []).forEach((row) => {
    if (!row || typeof row !== 'object') return
    const label = String(row.label || '').trim()
    if (!label) return
    let id = slugify(row.id || label) || 'type'
    let unique = id
    let n = 2
    while (seen.has(unique)) unique = `${id}-${n++}`
    seen.add(unique)
    // A reference photo of what this stamp type physically looks like
    // (e.g. a real self-inking stamp) — admin-uploaded via the same public
    // /product-uploads pipeline product photos use (see
    // POST /api/admin/products/upload-image), shown on /stamps step 1 so a
    // customer can see the actual product, not just a price card.
    const imageUrl = typeof row.imageUrl === 'string' && row.imageUrl.startsWith('/product-uploads/') ? row.imageUrl : null
    const defaultType = DEFAULT_PRICING.stamps.types.find((t) => t.id === unique)
    out.push({
      id: unique,
      label,
      active: row.active !== false,
      basePrice: num(row.basePrice),
      imageUrl,
      sizes: normalizeStampSizes(row.sizes, defaultType ? defaultType.sizes : [])
    })
  })
  return out.length ? out : JSON.parse(JSON.stringify(DEFAULT_PRICING.stamps.types))
}
function normalizeStampSizes(list, fallback) {
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
    // Manufacturer/catalog code (e.g. Trodat model "6900") — display-only,
    // shown alongside the label; not used as the id (ids are slugified from
    // the label above so they stay stable if the code is edited later).
    const code = String(row.code || '').trim()
    // Same admin-uploaded /product-uploads reference-photo convention as a
    // stamp type's imageUrl above — shown on the /stamps size-picker step.
    const imageUrl = typeof row.imageUrl === 'string' && row.imageUrl.startsWith('/product-uploads/') ? row.imageUrl : null
    out.push({
      id: unique,
      label,
      code,
      active: row.active !== false,
      widthMm: num(row.widthMm, 25) || 25,
      heightMm: num(row.heightMm, 10) || 10,
      priceModifier: num(row.priceModifier),
      imageUrl
    })
  })
  return out.length ? out : JSON.parse(JSON.stringify(fallback || []))
}
function normalizeStamps(input) {
  const d = input || {}
  return {
    types: normalizeStampTypes(d.types),
    logoPrice: num(d.logoPrice, DEFAULT_PRICING.stamps.logoPrice),
    extraQuantityPrice: num(d.extraQuantityPrice, DEFAULT_PRICING.stamps.extraQuantityPrice),
    requireProofApproval: d.requireProofApproval !== false
  }
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
  // Same reasoning again for additionalServices.
  const needsServicesBackfill = !Array.isArray(pricing.additionalServices)
  // Same reasoning again for stamps (Custom Stamp Printing). Checks that
  // every type already carries its OWN sizes array — a pre-restructure row
  // (flat top-level `stamps.sizes` shared across types, no per-type list)
  // fails this and gets migrated via normalizeStamps below.
  const needsStampsBackfill = !pricing.stamps ||
    !Array.isArray(pricing.stamps.types) ||
    !pricing.stamps.types.every((t) => t && Array.isArray(t.sizes))
  if (needsCoreMigration || needsPassportBackfill || needsOrderDefaultsBackfill || needsCouponsBackfill || needsServicesBackfill || needsStampsBackfill) {
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
    migrated.additionalServices = normalizeAdditionalServices(migrated.additionalServices)
    migrated.stamps = normalizeStamps(migrated.stamps)
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
    pricing.additionalServices = normalizeAdditionalServices(pricing.additionalServices)
    pricing.stamps = normalizeStamps(pricing.stamps)
  }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('pricing', JSON.stringify(pricing))
}

const DEFAULT_SITE_SETTINGS = {
  shopOpen: true,
  // Soft-launch gates for Stationery and Stamps — independent opt-INs
  // (default false, unlike shopOpen's opt-out) so a fresh install, or an
  // existing settings row saved before these keys existed, never
  // accidentally exposes either to customers. Toggled independently from
  // the General settings tab; each gates its own routes and public catalog
  // API down to a real 404 while off (see stationeryEnabled()/
  // stampsEnabled() in server.js) — admin tooling (Products/Inventory/
  // Stamp Settings tabs, walk-in order creation) stays fully usable
  // throughout so either catalog can be prepared ahead of its own launch.
  // /cart is live whenever either one is, since it's shared checkout
  // infrastructure for both, not a vertical of its own.
  stationeryEnabled: false,
  stampsEnabled: false,
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
    metaDescription: 'Upload your PDF, Word, or PPT file, pick your settings, and get it printed and delivered to your door — instantly.',
    keywords: 'print shop, online printing, document printing, Gurugram'
  },
  analytics: {
    // GA4 is configured *inside* the GTM container (a tag + trigger on
    // Google's side), not loaded directly here — avoids double-counting
    // pageviews/events between a direct gtag.js load and a GTM-managed one.
    gtmContainerId: '',
    searchConsoleVerification: '',
    adsensePublisherId: ''
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
  // One-time migration: the old single newVerticalsEnabled flag (which
  // gated Stationery, Stamps, and Cart together) split into independent
  // per-vertical toggles. A row saved before this split carries the old
  // key but neither new one — backfill both from it so a site that was
  // already live doesn't silently go dark the moment this deploys.
  if (stored.newVerticalsEnabled !== undefined && stored.stationeryEnabled === undefined && stored.stampsEnabled === undefined) {
    stored.stationeryEnabled = stored.newVerticalsEnabled === true
    stored.stampsEnabled = stored.newVerticalsEnabled === true
    delete stored.newVerticalsEnabled
    setSiteSettings(stored)
  }
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

// ---------------------------------------------------------------------------
// Stationery catalog: product_categories, products, stock_ledger.
// ---------------------------------------------------------------------------

function createProductCategory({ id, name, slug, description, sort_order, active }) {
  const now = Date.now()
  db.prepare(`INSERT INTO product_categories (id, name, slug, description, sort_order, active, created_at, updated_at)
    VALUES (@id, @name, @slug, @description, @sort_order, @active, @now, @now)`)
    .run({ id, name, slug, description: description || null, sort_order: sort_order || 0, active: active === false ? 0 : 1, now })
  return getProductCategoryById(id)
}

function getProductCategoryById(id) {
  return db.prepare('SELECT * FROM product_categories WHERE id = ?').get(id) || null
}

function getProductCategoryBySlug(slug) {
  return db.prepare('SELECT * FROM product_categories WHERE slug = ?').get(slug) || null
}

function listProductCategories({ includeInactive } = {}) {
  return includeInactive
    ? db.prepare('SELECT * FROM product_categories ORDER BY sort_order ASC, name ASC').all()
    : db.prepare('SELECT * FROM product_categories WHERE active = 1 ORDER BY sort_order ASC, name ASC').all()
}

function updateProductCategory(id, updates) {
  const existing = getProductCategoryById(id)
  if (!existing) return null
  const patch = { ...updates }
  if ('active' in patch) patch.active = patch.active ? 1 : 0
  const fields = Object.keys(patch)
  if (!fields.length) return existing
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE product_categories SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...patch, id, updated_at: Date.now() })
  return getProductCategoryById(id)
}

// Categories are just labels — deleting one detaches (not deletes) any
// products that referenced it, same "never break historical/existing rows"
// reasoning as products themselves (see deleteProductHardIfUnreferenced).
function deleteProductCategory(id) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE products SET category_id = NULL, updated_at = ? WHERE category_id = ?').run(Date.now(), id)
    db.prepare('DELETE FROM product_categories WHERE id = ?').run(id)
  })
  tx()
}

function hydrateProduct(row) {
  if (!row) return null
  let images = []
  try { images = row.images ? JSON.parse(row.images) : [] } catch (err) { images = [] }
  return { ...row, images, active: !!row.active }
}

function createProduct({ id, sku, name, slug, description, category_id, price, mrp, cost_price, stock_qty, low_stock_threshold, images, active, meta_title, meta_description }) {
  const now = Date.now()
  db.prepare(`INSERT INTO products
    (id, sku, name, slug, description, category_id, price, mrp, cost_price, stock_qty, low_stock_threshold, images, active, meta_title, meta_description, created_at, updated_at)
    VALUES (@id, @sku, @name, @slug, @description, @category_id, @price, @mrp, @cost_price, @stock_qty, @low_stock_threshold, @images, @active, @meta_title, @meta_description, @now, @now)`)
    .run({
      id, sku, name, slug,
      description: description || null,
      category_id: category_id || null,
      price: Math.max(0, Math.round(Number(price) || 0)),
      mrp: mrp != null && Number(mrp) > 0 ? Math.round(Number(mrp)) : null,
      cost_price: cost_price != null && Number(cost_price) >= 0 ? Math.round(Number(cost_price)) : null,
      stock_qty: Math.max(0, Math.round(Number(stock_qty) || 0)),
      low_stock_threshold: Math.max(0, Math.round(Number(low_stock_threshold) || 5)),
      images: JSON.stringify(Array.isArray(images) ? images : []),
      active: active === false ? 0 : 1,
      meta_title: meta_title || null,
      meta_description: meta_description || null,
      now
    })
  return getProductById(id)
}

function getProductById(id) {
  return hydrateProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id))
}

function getProductBySku(sku) {
  return hydrateProduct(db.prepare('SELECT * FROM products WHERE sku = ?').get(sku))
}

function getProductBySlug(slug) {
  return hydrateProduct(db.prepare('SELECT * FROM products WHERE slug = ?').get(slug))
}

function listProducts({ includeInactive, categoryId } = {}) {
  const clauses = []
  const params = {}
  if (!includeInactive) clauses.push('active = 1')
  if (categoryId) { clauses.push('category_id = @categoryId'); params.categoryId = categoryId }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM products ${where} ORDER BY name ASC`).all(params).map(hydrateProduct)
}

function updateProduct(id, updates) {
  const existing = getProductById(id)
  if (!existing) return null
  const patch = { ...updates }
  if ('images' in patch) patch.images = JSON.stringify(Array.isArray(patch.images) ? patch.images : [])
  if ('active' in patch) patch.active = patch.active ? 1 : 0
  if ('price' in patch) patch.price = Math.max(0, Math.round(Number(patch.price) || 0))
  if ('mrp' in patch) patch.mrp = patch.mrp != null && Number(patch.mrp) > 0 ? Math.round(Number(patch.mrp)) : null
  if ('cost_price' in patch) patch.cost_price = patch.cost_price != null && Number(patch.cost_price) >= 0 ? Math.round(Number(patch.cost_price)) : null
  if ('low_stock_threshold' in patch) patch.low_stock_threshold = Math.max(0, Math.round(Number(patch.low_stock_threshold) || 0))
  const fields = Object.keys(patch)
  if (!fields.length) return existing
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE products SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...patch, id, updated_at: Date.now() })
  return getProductById(id)
}

// A product referenced by any order's files_json line items can never be
// hard-deleted — its row must keep existing so that order's line item still
// resolves (name/price were already baked into the order at purchase time,
// but admin screens like the jobsheet PICK page still look up the product by
// id for current stock/SKU context). Same LIKE-scan approach as
// getAllOrderFileIds, which already treats files_json this way.
function isProductReferencedByOrders(productId) {
  const row = db.prepare(`SELECT id FROM orders WHERE files_json LIKE ? LIMIT 1`).get(`%"productId":"${productId}"%`)
  return !!row
}

function deleteProductHardIfUnreferenced(id) {
  if (isProductReferencedByOrders(id)) {
    const err = new Error('This product has past orders and can’t be deleted — deactivate it instead.')
    err.code = 'product_referenced'
    throw err
  }
  db.prepare('DELETE FROM products WHERE id = ?').run(id)
  return true
}

// Applies a stock change and appends one immutable stock_ledger row, inside a
// single transaction so the two can never drift apart. Clamped so stock_qty
// can never go negative (see spec: "never allow stock to become negative") —
// if delta would take it below zero, only the amount down to zero is applied
// and the ledger records the actual applied delta, not the requested one.
// reason: 'received' | 'order' | 'damaged' | 'return' | 'adjustment'.
// reference: free text, e.g. 'order_id:itemId' for order/return rows.
function adjustStock(productId, delta, reason, adminId, note) {
  const tx = db.transaction(() => {
    const product = getProductById(productId)
    if (!product) { const err = new Error('Product not found'); err.code = 'not_found'; throw err }
    const requested = Math.round(Number(delta) || 0)
    const applied = requested < 0 ? -Math.min(-requested, product.stock_qty) : requested
    const newQty = Math.max(0, product.stock_qty + applied)
    db.prepare('UPDATE products SET stock_qty = ?, updated_at = ? WHERE id = ?').run(newQty, Date.now(), productId)
    db.prepare(`INSERT INTO stock_ledger (id, product_id, delta, reason, reference, admin_id, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(crypto.randomUUID(), productId, applied, reason, null, adminId || null, note || null, Date.now())
    return { product: getProductById(productId), applied }
  })
  return tx()
}

function listStockLedger(productId, { limit } = {}) {
  return db.prepare('SELECT * FROM stock_ledger WHERE product_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(productId, limit || 200)
}

// Called exactly once per order, at the moment it's actually confirmed
// (COD-at-creation, admin walk-in creation, or paid-online via
// verify-payment/recheck-payment/the webhook) — the same set of "order just
// got confirmed" call sites printQueue.enqueue() already fires from (see
// confirmStockForOrder in server.js). Walks the order's stationery line
// items in array order, decrementing a per-productId running counter seeded
// ONCE per product from the DB (not re-read per line), so two lines of the
// same product in one order correctly split whatever stock is actually
// available between them rather than each independently reading stale stock
// and jointly overselling. Never lets stock go negative: if a race means
// less is available now than buildPricedOrderFiles's pre-check saw (only
// possible if two confirmations for different orders of the same product
// land concurrently — rare at this business's volume), decrements only what
// remains and reports it as a shortfall; the caller flags the order for
// staff attention but never blocks or unwinds an already-captured payment
// over it. The actual decremented quantity is stamped onto each item
// (stockDecrementedQty) so a later cancellation restores exactly what was
// taken, not the original request (see restoreStockForOrder below).
function decrementStockForOrder(order) {
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  const stationeryItems = files.filter((f) => f.productType === 'stationery' && f.productId)
  if (!stationeryItems.length) return { shortfalls: [] }
  const shortfalls = []
  const tx = db.transaction(() => {
    const remaining = new Map()
    for (const item of stationeryItems) {
      if (!remaining.has(item.productId)) {
        const product = getProductById(item.productId)
        remaining.set(item.productId, product ? product.stock_qty : 0)
      }
      const avail = remaining.get(item.productId)
      const requested = Math.max(0, Math.round(Number(item.quantity)) || 0)
      const decrement = Math.min(requested, avail)
      remaining.set(item.productId, avail - decrement)
      if (decrement > 0) {
        db.prepare('UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ?').run(decrement, Date.now(), item.productId)
        db.prepare(`INSERT INTO stock_ledger (id, product_id, delta, reason, reference, admin_id, note, created_at)
          VALUES (?, ?, ?, 'order', ?, NULL, NULL, ?)`).run(crypto.randomUUID(), item.productId, -decrement, `${order.id}:${item.itemId}`, Date.now())
      }
      item.stockDecrementedQty = decrement
      if (decrement < requested) shortfalls.push({ itemId: item.itemId, productId: item.productId, name: item.name, requested, decremented: decrement })
    }
    db.prepare('UPDATE orders SET files_json = ? WHERE id = ?').run(JSON.stringify(files), order.id)
  })
  tx()
  return { shortfalls }
}

// Decrements stock for exactly one item — used when staff add a stationery
// line to an order that's already been confirmed (and already had its
// original lines decremented via decrementStockForOrder above). That
// function re-decrements every stationery line's FULL quantity on each
// call rather than skipping ones already accounted for, so calling it again
// here would double-decrement every pre-existing line; this instead touches
// only the one product/quantity/reference the caller passes in. The caller
// is expected to have already rejected an over-quantity request — this
// always decrements the full requested amount (no partial/shortfall
// handling, unlike decrementStockForOrder's payment-already-captured case).
function decrementStockForNewItem(productId, quantity, reference) {
  db.prepare('UPDATE products SET stock_qty = stock_qty - ?, updated_at = ? WHERE id = ?').run(quantity, Date.now(), productId)
  db.prepare(`INSERT INTO stock_ledger (id, product_id, delta, reason, reference, admin_id, note, created_at)
    VALUES (?, ?, ?, 'order', ?, NULL, NULL, ?)`).run(crypto.randomUUID(), productId, -quantity, reference, Date.now())
}

// Symmetric to decrementStockForOrder — restores exactly what was actually
// decremented for each item (stockDecrementedQty), never the original
// requested quantity, so a previously-undersold order (see shortfalls above)
// can't over-credit stock on cancellation/refund. Zeroes stockDecrementedQty
// afterward so a later duplicate restore call (e.g. staff toggling an order's
// status back and forth) can't double-credit the same stock twice — the
// second call finds nothing left to restore for any item.
function restoreStockForOrder(order) {
  let files = []
  try { files = order.files_json ? JSON.parse(order.files_json) : [] } catch (err) { files = [] }
  const toRestore = files.filter((f) => f.productType === 'stationery' && f.productId && Number(f.stockDecrementedQty) > 0)
  if (!toRestore.length) return
  const tx = db.transaction(() => {
    for (const item of toRestore) {
      const qty = Math.round(Number(item.stockDecrementedQty))
      db.prepare('UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?').run(qty, Date.now(), item.productId)
      db.prepare(`INSERT INTO stock_ledger (id, product_id, delta, reason, reference, admin_id, note, created_at)
        VALUES (?, ?, ?, 'return', ?, NULL, NULL, ?)`).run(crypto.randomUUID(), item.productId, qty, `${order.id}:${item.itemId}`, Date.now())
      item.stockDecrementedQty = 0
    }
    db.prepare('UPDATE orders SET files_json = ? WHERE id = ?').run(JSON.stringify(files), order.id)
  })
  tx()
}

// ---------------------------------------------------------------------------
// Custom Stamp proof-approval history (stamp_proofs). Several rows can
// accumulate per (order_id, item_id) over a changes-requested -> re-upload
// cycle — the latest one for that pair is authoritative, which is what
// getLatestStampProofForItem returns.
// ---------------------------------------------------------------------------

function createStampProof({ order_id, item_id, file_id, uploaded_by_admin_id }) {
  const id = crypto.randomUUID()
  const now = Date.now()
  db.prepare(`INSERT INTO stamp_proofs (id, order_id, item_id, file_id, uploaded_by_admin_id, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?)`).run(id, order_id, item_id, file_id, uploaded_by_admin_id || null, now)
  return db.prepare('SELECT * FROM stamp_proofs WHERE id = ?').get(id)
}

function getLatestStampProofForItem(orderId, itemId) {
  return db.prepare('SELECT * FROM stamp_proofs WHERE order_id = ? AND item_id = ? ORDER BY created_at DESC LIMIT 1').get(orderId, itemId) || null
}

function listStampProofsForOrder(orderId) {
  return db.prepare('SELECT * FROM stamp_proofs WHERE order_id = ? ORDER BY created_at DESC').all(orderId)
}

function updateStampProof(id, { status, customer_comment, resolved_at }) {
  const sets = []
  const params = { id }
  if (status !== undefined) { sets.push('status = @status'); params.status = status }
  if (customer_comment !== undefined) { sets.push('customer_comment = @customer_comment'); params.customer_comment = customer_comment }
  if (resolved_at !== undefined) { sets.push('resolved_at = @resolved_at'); params.resolved_at = resolved_at }
  if (!sets.length) return db.prepare('SELECT * FROM stamp_proofs WHERE id = ?').get(id)
  db.prepare(`UPDATE stamp_proofs SET ${sets.join(', ')} WHERE id = @id`).run(params)
  return db.prepare('SELECT * FROM stamp_proofs WHERE id = ?').get(id)
}

// ---------------------------------------------------------------------------
// Cross-sell rules — admin-configured "you may also need" recommendations.
// trigger_type is either 'productType:<document|stationery|stamp>' (shown
// after adding any item of that type) or 'product:<id>' (shown after adding
// that specific product).
// ---------------------------------------------------------------------------

function createCrossSellRule({ id, trigger_type, recommended_product_id, sort_order, active }) {
  const now = Date.now()
  db.prepare(`INSERT INTO cross_sell_rules (id, trigger_type, recommended_product_id, sort_order, active, created_at, updated_at)
    VALUES (@id, @trigger_type, @recommended_product_id, @sort_order, @active, @now, @now)`)
    .run({ id, trigger_type, recommended_product_id, sort_order: sort_order || 0, active: active === false ? 0 : 1, now })
  return getCrossSellRuleById(id)
}

function getCrossSellRuleById(id) {
  return db.prepare('SELECT * FROM cross_sell_rules WHERE id = ?').get(id) || null
}

function listCrossSellRules({ includeInactive } = {}) {
  return includeInactive
    ? db.prepare('SELECT * FROM cross_sell_rules ORDER BY trigger_type ASC, sort_order ASC').all()
    : db.prepare('SELECT * FROM cross_sell_rules WHERE active = 1 ORDER BY trigger_type ASC, sort_order ASC').all()
}

// Active rules for one trigger, joined with their (also active) recommended
// item — the public cross-sell endpoint's exact query. A rule pointing at a
// since-deactivated/deleted product or stamp type is silently skipped, never
// shown as a broken recommendation. Looks up each product via getProductById
// (not a raw SQL JOIN) specifically so `images` comes back hydrated into a
// real array — a raw `p.*` join would leak the column's raw JSON-string value
// instead, same bug class `hydrateProduct` exists to prevent everywhere else.
// recommended_product_id is either a plain product id, or 'stamp:<id>' for a
// rule recommending a stamp type (see resolveCrossSellRecommendation in
// server.js) — returns { kind: 'product', product } or { kind: 'stamp',
// stampType } so the caller can shape each into its own public DTO.
function listCrossSellRulesForTrigger(triggerType) {
  const rules = db.prepare('SELECT * FROM cross_sell_rules WHERE trigger_type = ? AND active = 1 ORDER BY sort_order ASC').all(triggerType)
  const stampTypes = ((getPricing().stamps || {}).types || [])
  return rules
    .map((r) => {
      const rid = r.recommended_product_id
      if (typeof rid === 'string' && rid.startsWith('stamp:')) {
        const stampType = stampTypes.find((t) => t.id === rid.slice('stamp:'.length) && t.active)
        return stampType ? { kind: 'stamp', stampType } : null
      }
      const product = getProductById(rid)
      return (product && product.active) ? { kind: 'product', product } : null
    })
    .filter(Boolean)
}

function updateCrossSellRule(id, updates) {
  const existing = getCrossSellRuleById(id)
  if (!existing) return null
  const patch = { ...updates }
  if ('active' in patch) patch.active = patch.active ? 1 : 0
  const fields = Object.keys(patch)
  if (!fields.length) return existing
  const setClause = fields.map((f) => `${f} = @${f}`).join(', ')
  db.prepare(`UPDATE cross_sell_rules SET ${setClause}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...patch, id, updated_at: Date.now() })
  return getCrossSellRuleById(id)
}

function deleteCrossSellRule(id) {
  db.prepare('DELETE FROM cross_sell_rules WHERE id = ?').run(id)
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
      print_cost, delivery_charge, handling_charge, gst_amount, total_amount, services_cost, stationery_cost, stamp_cost,
      discount_type, discount_value, discount_amount, discount_code, discount_reason,
      razorpay_order_id, payment_status, order_status, notes,
      created_at, updated_at
    ) VALUES (
      @id, @customer_id, @customer_name, @customer_mobile, @customer_email,
      @file_name, @file_path, @file_type, @page_count, @files_json,
      @orientation, @print_mode, @print_side, @copies, @paper_size, @paper_type, @product_type,
      @delivery_method, @delivery_address, @delivery_city, @delivery_state, @delivery_pincode,
      @location_id, @location_name,
      @payment_method,
      @delivery_timing, @scheduled_at,
      @print_cost, @delivery_charge, @handling_charge, @gst_amount, @total_amount, @services_cost, @stationery_cost, @stamp_cost,
      @discount_type, @discount_value, @discount_amount, @discount_code, @discount_reason,
      @razorpay_order_id, @payment_status, @order_status, @notes,
      @created_at, @updated_at
    )
  `).run({
    files_json: null, paper_type: 'normal', product_type: 'document', customer_id: null, location_id: null, location_name: null, payment_method: 'online', delivery_timing: 'instant', scheduled_at: null, handling_charge: 0, notes: null, razorpay_order_id: null,
    discount_type: null, discount_value: 0, discount_amount: 0, discount_code: null, discount_reason: null, services_cost: 0, stationery_cost: 0, stamp_cost: 0,
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
  // Same shape as `summary` above (not just orders/revenue) so the frontend
  // can treat "Today" as a full-fledged range option — driving the payment-
  // split chart too, not just the dedicated stat tile — with the exact same
  // rendering code as the Last 7/30/90 days summary.
  const today = db.prepare(`
    SELECT
      COUNT(*) as totalOrders,
      COALESCE(SUM(total_amount), 0) as totalRevenue,
      COALESCE(SUM(CASE WHEN payment_method = 'cod' THEN total_amount ELSE 0 END), 0) as codRevenue,
      COALESCE(SUM(CASE WHEN payment_method != 'cod' THEN total_amount ELSE 0 END), 0) as onlineRevenue
    FROM orders
    WHERE (payment_status = 'paid' OR payment_method = 'cod')
      AND archived_at IS NULL
      AND created_at >= ?
  `).get(todayStartMs)
  today.avgOrderValue = today.totalOrders ? Math.round(today.totalRevenue / today.totalOrders) : 0

  return { daily, summary, today }
}

// Backs the admin Reports tab's line-item export — same "what counts as a
// sale" filter as getSalesAnalytics above (paid, or COD regardless of
// collection status, excluding archived orders) so the two stay consistent.
// Selects every column (not just the ones the report currently flattens/
// offers as extras) so server.js can read any order field without a matching
// schema change here — this is the live DB, not a hand-maintained BigQuery
// mirror.
function getOrdersForLineItemReport(fromMs, toMs) {
  return db.prepare(`
    SELECT * FROM orders
    WHERE (payment_status = 'paid' OR payment_method = 'cod')
      AND archived_at IS NULL
      AND created_at BETWEEN ? AND ?
    ORDER BY created_at
  `).all(fromMs, toMs)
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

function getOrderFeedbackById(id) {
  return db.prepare('SELECT * FROM order_feedback WHERE id = ?').get(id) || null
}

// Staff correcting a garbled submission or moderating an inappropriate
// comment — only touches the fields actually passed (undefined = leave as
// is), same convention as db.updateOrder.
function updateOrderFeedback(id, { rating, comment }) {
  const sets = []
  const params = []
  if (rating !== undefined) { sets.push('rating = ?'); params.push(rating) }
  if (comment !== undefined) { sets.push('comment = ?'); params.push(comment || null) }
  if (sets.length) {
    params.push(id)
    db.prepare(`UPDATE order_feedback SET ${sets.join(', ')} WHERE id = ?`).run(...params)
  }
  return getOrderFeedbackById(id)
}

function deleteOrderFeedback(id) {
  db.prepare('DELETE FROM order_feedback WHERE id = ?').run(id)
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
  getOrdersForLineItemReport,
  createPrintJob,
  updatePrintJob,
  getLatestPrintJobForOrder,
  getOrderFeedback,
  getOrderFeedbackById,
  createOrderFeedback,
  updateOrderFeedback,
  deleteOrderFeedback,
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
  markPasswordResetUsed,
  createProductCategory,
  getProductCategoryById,
  getProductCategoryBySlug,
  listProductCategories,
  updateProductCategory,
  deleteProductCategory,
  createProduct,
  getProductById,
  getProductBySku,
  getProductBySlug,
  listProducts,
  updateProduct,
  isProductReferencedByOrders,
  deleteProductHardIfUnreferenced,
  adjustStock,
  listStockLedger,
  decrementStockForOrder,
  decrementStockForNewItem,
  restoreStockForOrder,
  createStampProof,
  getLatestStampProofForItem,
  listStampProofsForOrder,
  updateStampProof,
  createCrossSellRule,
  getCrossSellRuleById,
  listCrossSellRules,
  listCrossSellRulesForTrigger,
  updateCrossSellRule,
  deleteCrossSellRule
}
