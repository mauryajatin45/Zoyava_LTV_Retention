import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import { logger } from './logger.js';
dotenv.config();

const TAG = '[IdempotencyStore]';

export const pool = mysql.createPool({
  host:     process.env.DB_HOST,
  user:     process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // Keep-alive: reconnect automatically if the connection drops
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
});

// ─────────────────────────────────────────────────────────────
// Self-healing table setup
// - Retries at startup (MySQL may still be booting after a VPS restart)
// - Re-creates tables on demand if they ever go missing (ER_NO_SUCH_TABLE)
// ─────────────────────────────────────────────────────────────
const CREATE_PROCESSED_CHARGES = `
  CREATE TABLE IF NOT EXISTS processed_charges (
    charge_id    VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_processed_at (processed_at)
  )`;

const CREATE_WEBHOOK_LOGS = `
  CREATE TABLE IF NOT EXISTS webhook_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    webhook_type VARCHAR(100),
    charge_id VARCHAR(255),
    address_id VARCHAR(255),
    funnel_type VARCHAR(50),
    cycle_number INT,
    status ENUM('SUCCESS', 'FAILED', 'SKIPPED', 'PENDING'),
    gifts_injected JSON,
    next_charge_date DATE,
    request_payload JSON,
    response_payload JSON,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_address_id (address_id),
    INDEX idx_status (status),
    INDEX idx_created_at (created_at)
  )`;

let tablesReady = null;

export function ensureTables() {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(CREATE_PROCESSED_CHARGES);
      await pool.query(CREATE_WEBHOOK_LOGS);
      logger.info(TAG, 'processed_charges and webhook_logs tables verified/created');
    })().catch((err) => {
      tablesReady = null; // allow the next call to retry
      throw err;
    });
  }
  return tablesReady;
}

const isMissingTable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.errno === 1146);

/** Run a query; if the table is missing, recreate tables and retry once. */
export async function safeQuery(sql, params) {
  try {
    return await pool.query(sql, params);
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    logger.warn(TAG, 'Table missing — recreating tables and retrying', { error: err.message });
    tablesReady = null;
    await ensureTables();
    return await pool.query(sql, params);
  }
}

// Startup: retry for ~2 minutes so a slow MySQL boot never leaves us without tables
(async () => {
  const delays = [2, 4, 8, 15, 30, 60];
  for (let i = 0; i <= delays.length; i++) {
    try {
      await ensureTables();
      logger.info(TAG, 'Connected to MySQL database');
      return;
    } catch (err) {
      if (i === delays.length) {
        logger.error(TAG, 'STARTUP: Could not prepare MySQL tables after retries. Will retry on first query.', {
          host: process.env.DB_HOST, db: process.env.DB_NAME, error: err.message || String(err),
        });
        return;
      }
      logger.warn(TAG, `STARTUP: MySQL not ready (${err.code || err.message || err}) — retrying in ${delays[i]}s`);
      await new Promise((r) => setTimeout(r, delays[i] * 1000));
    }
  }
})();

/**
 * Atomically checks AND marks a charge as processed in one query.
 * Uses INSERT IGNORE so if two webhooks arrive simultaneously,
 * only ONE will get rowsAffected=1. The other gets 0 and knows to skip.
 *
 * @param {string|number} chargeId
 * @returns {Promise<boolean>} true = first time seen (process it), false = duplicate (skip)
 */
export async function claimCharge(chargeId) {
  const [result] = await safeQuery(
    'INSERT IGNORE INTO processed_charges (charge_id) VALUES (?)',
    [String(chargeId)]
  );
  // affectedRows === 1 means INSERT succeeded (first time)
  // affectedRows === 0 means INSERT was ignored (duplicate)
  return result.affectedRows === 1;
}

/**
 * Generic atomic idempotency claim that accepts any string key.
 * Used to prevent double-processing across different webhook types
 * (e.g. subscription/created AND charge/paid both firing for Order #1).
 *
 * @param {string} key - Any unique string key (e.g. 'first-order-addr-12345')
 * @returns {Promise<boolean>} true = first time seen (process it), false = duplicate (skip)
 */
export async function claimKey(key) {
  const [result] = await safeQuery(
    'INSERT IGNORE INTO processed_charges (charge_id) VALUES (?)',
    [String(key)]
  );
  return result.affectedRows === 1;
}

/**
 * @deprecated Use claimCharge() instead — it's atomic.
 * Kept for backward compatibility with any direct callers.
 */
export async function hasBeenProcessed(chargeId) {
  const [rows] = await safeQuery(
    'SELECT charge_id FROM processed_charges WHERE charge_id = ?',
    [String(chargeId)]
  );
  return rows.length > 0;
}

/**
 * @deprecated Use claimCharge() instead — it's atomic.
 */
export async function markAsProcessed(chargeId) {
  await safeQuery(
    'INSERT IGNORE INTO processed_charges (charge_id) VALUES (?)',
    [String(chargeId)]
  );
}
