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

// Initialize table on startup
(async () => {
  try {
    const connection = await pool.getConnection();
    logger.info(TAG, 'Connected to MySQL database');

    await connection.query(`
      CREATE TABLE IF NOT EXISTS processed_charges (
        charge_id    VARCHAR(255) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_processed_at (processed_at)
      )
    `);

    await connection.query(`
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
      )
    `);

    logger.info(TAG, 'processed_charges and webhook_logs tables verified/created');
    connection.release();
  } catch (err) {
    // CRITICAL: if the DB is unreachable at startup we log it loudly
    // but do NOT crash the server — webhooks will fail safely via try/catch
    logger.error(TAG, 'STARTUP: Could not connect to MySQL. Idempotency checks will fail until DB is reachable.', {
      host: process.env.DB_HOST,
      db:   process.env.DB_NAME,
      error: err.message,
    });
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
  const [result] = await pool.query(
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
  const [result] = await pool.query(
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
  const [rows] = await pool.query(
    'SELECT charge_id FROM processed_charges WHERE charge_id = ?',
    [String(chargeId)]
  );
  return rows.length > 0;
}

/**
 * @deprecated Use claimCharge() instead — it's atomic.
 */
export async function markAsProcessed(chargeId) {
  await pool.query(
    'INSERT IGNORE INTO processed_charges (charge_id) VALUES (?)',
    [String(chargeId)]
  );
}
