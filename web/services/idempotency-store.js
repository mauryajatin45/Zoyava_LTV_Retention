import sqlite3 from 'sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '../../idempotency.sqlite');

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('[IdempotencyStore] Error connecting to SQLite DB:', err.message);
  } else {
    console.log('[IdempotencyStore] Connected to SQLite database.');
    db.run(
      `CREATE TABLE IF NOT EXISTS processed_charges (
        charge_id TEXT PRIMARY KEY,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`
    );
  }
});

/**
 * Checks if a charge has already been processed.
 * @param {string|number} chargeId 
 * @returns {Promise<boolean>}
 */
export function hasBeenProcessed(chargeId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT charge_id FROM processed_charges WHERE charge_id = ?',
      [String(chargeId)],
      (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      }
    );
  });
}

/**
 * Marks a charge as processed.
 * @param {string|number} chargeId 
 * @returns {Promise<void>}
 */
export function markAsProcessed(chargeId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO processed_charges (charge_id) VALUES (?)',
      [String(chargeId)],
      (err) => {
        if (err) return reject(err);
        resolve();
      }
    );
  });
}
