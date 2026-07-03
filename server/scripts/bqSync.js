// Daily export of the business tables from SQLite into BigQuery so the data is
// queryable from GCP. Runs as a systemd oneshot on a daily timer (see
// deploy/metalix-bqsync.*.example) under the same service account that already
// backs Secret Manager / Storage — so it authenticates via ADC, no keys.
//
// Strategy: incremental UPSERT (never full-reload). Each run loads the current
// SQLite rows into a per-table staging table, then MERGEs them into the target
// on `id`: new rows are INSERTed, rows that already exist are UPDATEd in place.
// So BigQuery keeps growing with new orders AND reflects later changes (an
// order's status/payment/completed_at update instead of freezing at first
// capture). Nothing in the target is ever deleted by the sync. The dataset is
// tiny (MVP), so staging every row each run is cheap; if volume grows, stage
// only rows with updated_at past a watermark.
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
const STG_PREFIX = 'stg_' // staging tables are overwritten every run

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

// MERGE requires the target to already exist, so create it (empty, with the
// explicit schema) on first run. WRITE_TRUNCATE on staging handles itself.
async function ensureTable(dataset, table) {
  const t = dataset.table(table.name)
  const [exists] = await t.exists()
  if (!exists) {
    await dataset.createTable(table.name, { schema: { fields: table.schema }, location: LOCATION })
    console.log(`[bqsync] created table ${DATASET}.${table.name}`)
  }
}

// Loads the current SQLite rows into the staging table via a WRITE_TRUNCATE
// load job — the standard, free (no streaming-insert cost) way to replace it.
async function loadStaging(dataset, table, rows) {
  const stgName = STG_PREFIX + table.name
  const tmpFile = path.join(os.tmpdir(), `bqsync-${table.name}-${process.pid}.ndjson`)
  // NDJSON: one JSON object per line. better-sqlite3 already returns JS values
  // of the right types (numbers / strings / null), so a plain stringify is a
  // valid BigQuery row.
  fs.writeFileSync(tmpFile, rows.map((r) => JSON.stringify(r)).join('\n'))
  try {
    await dataset.table(stgName).load(tmpFile, {
      sourceFormat: 'NEWLINE_DELIMITED_JSON',
      schema: { fields: table.schema },
      writeDisposition: 'WRITE_TRUNCATE',
      createDisposition: 'CREATE_IF_NEEDED',
      location: LOCATION
    })
  } finally {
    fs.rmSync(tmpFile, { force: true })
  }
}

// Upserts staging into the target on the key column: update every matched row,
// insert every unmatched one. Returns BigQuery's DML stats for logging.
async function mergeStagingIntoTarget(bq, table) {
  const key = table.key || 'id'
  const cols = table.schema.map((f) => f.name)
  const nonKey = cols.filter((c) => c !== key)
  const setClause = nonKey.map((c) => `T.\`${c}\` = S.\`${c}\``).join(', ')
  const insertCols = cols.map((c) => `\`${c}\``).join(', ')
  const insertVals = cols.map((c) => `S.\`${c}\``).join(', ')
  const sql = `
    MERGE \`${DATASET}.${table.name}\` T
    USING \`${DATASET}.${STG_PREFIX}${table.name}\` S
    ON T.\`${key}\` = S.\`${key}\`
    WHEN MATCHED THEN UPDATE SET ${setClause}
    WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${insertVals})`
  const [job] = await bq.createQueryJob({ query: sql, location: LOCATION })
  await job.getQueryResults()
  const [meta] = await job.getMetadata()
  return (meta.statistics && meta.statistics.query && meta.statistics.query.dmlStats) || {}
}

async function syncTable(bq, dataset, db, table) {
  await ensureTable(dataset, table)
  const rows = db.prepare(table.query).all()
  if (rows.length === 0) {
    console.log(`[bqsync] ${table.name}: no source rows, nothing to merge`)
    return
  }
  await loadStaging(dataset, table, rows)
  const stats = await mergeStagingIntoTarget(bq, table)
  const inserted = stats.insertedRowCount || 0
  const updated = stats.updatedRowCount || 0
  console.log(`[bqsync] ${DATASET}.${table.name}: +${inserted} inserted, ~${updated} updated (from ${rows.length} staged)`)
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
      await syncTable(bq, dataset, db, table)
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
