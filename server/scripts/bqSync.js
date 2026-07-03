// Daily export of the business tables from SQLite into BigQuery so the data is
// queryable from GCP. Runs as a systemd oneshot on a daily timer (see
// deploy/metalix-bqsync.*.example) under the same service account that already
// backs Secret Manager / Storage — so it authenticates via ADC, no keys.
//
// Strategy: truncate-and-reload. Each run reads every selected table in full
// and replaces the BigQuery table (WRITE_TRUNCATE). The dataset is tiny (MVP),
// so a full reload is simpler and more self-healing than incremental syncing —
// a missed run just corrects itself the next day.
//
// Deliberately NOT exported: users.password_hash, the whole password_resets
// table, and settings — auth secrets / ephemeral tokens / config with no
// analytics value. Timestamps stay as epoch-millisecond INTEGERs; convert in
// BigQuery with TIMESTAMP_MILLIS(created_at) when you need a real timestamp.
const fs = require('fs')
const os = require('os')
const path = require('path')
const Database = require('better-sqlite3')
const { BigQuery } = require('@google-cloud/bigquery')

const SQLITE_PATH = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'metalix.db')
const DATASET = process.env.BQ_DATASET || 'metalix_analytics'
const LOCATION = process.env.BQ_LOCATION || 'asia-south1'

// One entry per BigQuery table: the SQLite query that produces its rows (with
// secret columns left out) and the explicit BigQuery schema. Explicit schemas
// beat autodetect here — a table that happens to be all-NULL in one column on a
// given day won't flip types or fail the load.
const TABLES = [
  {
    name: 'orders',
    query: `SELECT
        id, customer_id, customer_name, customer_mobile, customer_email,
        file_name, file_path, file_type, page_count, files_json,
        orientation, print_mode, print_side, copies, paper_size, paper_type,
        delivery_method, delivery_address, delivery_city, delivery_state, delivery_pincode,
        print_cost, delivery_charge, gst_amount, total_amount,
        razorpay_order_id, razorpay_payment_id, payment_status, order_status, failure_reason,
        created_at, updated_at, completed_at, files_deleted_at
      FROM orders`,
    schema: [
      { name: 'id', type: 'STRING' },
      { name: 'customer_id', type: 'STRING' },
      { name: 'customer_name', type: 'STRING' },
      { name: 'customer_mobile', type: 'STRING' },
      { name: 'customer_email', type: 'STRING' },
      { name: 'file_name', type: 'STRING' },
      { name: 'file_path', type: 'STRING' },
      { name: 'file_type', type: 'STRING' },
      { name: 'page_count', type: 'INTEGER' },
      { name: 'files_json', type: 'STRING' },
      { name: 'orientation', type: 'STRING' },
      { name: 'print_mode', type: 'STRING' },
      { name: 'print_side', type: 'STRING' },
      { name: 'copies', type: 'INTEGER' },
      { name: 'paper_size', type: 'STRING' },
      { name: 'paper_type', type: 'STRING' },
      { name: 'delivery_method', type: 'STRING' },
      { name: 'delivery_address', type: 'STRING' },
      { name: 'delivery_city', type: 'STRING' },
      { name: 'delivery_state', type: 'STRING' },
      { name: 'delivery_pincode', type: 'STRING' },
      { name: 'print_cost', type: 'INTEGER' },
      { name: 'delivery_charge', type: 'INTEGER' },
      { name: 'gst_amount', type: 'INTEGER' },
      { name: 'total_amount', type: 'INTEGER' },
      { name: 'razorpay_order_id', type: 'STRING' },
      { name: 'razorpay_payment_id', type: 'STRING' },
      { name: 'payment_status', type: 'STRING' },
      { name: 'order_status', type: 'STRING' },
      { name: 'failure_reason', type: 'STRING' },
      { name: 'created_at', type: 'INTEGER' },
      { name: 'updated_at', type: 'INTEGER' },
      { name: 'completed_at', type: 'INTEGER' },
      { name: 'files_deleted_at', type: 'INTEGER' }
    ]
  },
  {
    name: 'print_jobs',
    query: `SELECT id, order_id, status, error_reason, created_at, updated_at FROM print_jobs`,
    schema: [
      { name: 'id', type: 'INTEGER' },
      { name: 'order_id', type: 'STRING' },
      { name: 'status', type: 'STRING' },
      { name: 'error_reason', type: 'STRING' },
      { name: 'created_at', type: 'INTEGER' },
      { name: 'updated_at', type: 'INTEGER' }
    ]
  },
  {
    // password_hash is intentionally omitted — no credential material leaves
    // the app DB.
    name: 'users',
    query: `SELECT id, name, email, mobile, google_id, created_at, updated_at FROM users`,
    schema: [
      { name: 'id', type: 'STRING' },
      { name: 'name', type: 'STRING' },
      { name: 'email', type: 'STRING' },
      { name: 'mobile', type: 'STRING' },
      { name: 'google_id', type: 'STRING' },
      { name: 'created_at', type: 'INTEGER' },
      { name: 'updated_at', type: 'INTEGER' }
    ]
  }
]

async function ensureDataset(bq) {
  const dataset = bq.dataset(DATASET)
  const [exists] = await dataset.exists()
  if (!exists) {
    await bq.createDataset(DATASET, { location: LOCATION })
    console.log(`[bqsync] created dataset ${DATASET} (${LOCATION})`)
  }
  return dataset
}

// Loads one table via a WRITE_TRUNCATE load job from a temp NDJSON file — the
// standard, free (no streaming-insert cost) way to fully replace a table.
async function loadTable(dataset, db, table) {
  const rows = db.prepare(table.query).all()
  const tmpFile = path.join(os.tmpdir(), `bqsync-${table.name}-${process.pid}.ndjson`)
  // NDJSON: one JSON object per line. better-sqlite3 already returns JS values
  // of the right types (numbers / strings / null), so a plain stringify is a
  // valid BigQuery row.
  fs.writeFileSync(tmpFile, rows.map((r) => JSON.stringify(r)).join('\n'))
  try {
    await dataset.table(table.name).load(tmpFile, {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      schema: { fields: table.schema },
      writeDisposition: 'WRITE_TRUNCATE',
      createDisposition: 'CREATE_IF_NEEDED',
      location: LOCATION
    })
    console.log(`[bqsync] loaded ${rows.length} rows -> ${DATASET}.${table.name}`)
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

async function main() {
  if (!fs.existsSync(SQLITE_PATH)) {
    throw new Error(`SQLite database not found at ${SQLITE_PATH}`)
  }
  // readonly so the sync can never mutate production data.
  const db = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true })
  const bq = new BigQuery({ location: LOCATION })
  try {
    const dataset = await ensureDataset(bq)
    for (const table of TABLES) {
      await loadTable(dataset, db, table)
    }
    console.log('[bqsync] done')
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error('[bqsync] failed:', err.message)
  process.exit(1)
})
