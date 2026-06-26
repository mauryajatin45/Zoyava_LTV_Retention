import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

// Create a connection pool instead of a single connection
// This ensures connections are automatically managed and re-established
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize table
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log('[IdempotencyStore] Connected to MySQL database.');
    
    await connection.query(`
      CREATE TABLE IF NOT EXISTS processed_charges (
        charge_id VARCHAR(255) PRIMARY KEY,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    connection.release();
  } catch (err) {
    console.error('[IdempotencyStore] Error connecting to MySQL DB:', err.message);
  }
})();

/**
 * Checks if a charge has already been processed.
 * @param {string|number} chargeId 
 * @returns {Promise<boolean>}
 */
export async function hasBeenProcessed(chargeId) {
  const [rows] = await pool.query(
    'SELECT charge_id FROM processed_charges WHERE charge_id = ?',
    [String(chargeId)]
  );
  return rows.length > 0;
}

/**
 * Marks a charge as processed.
 * @param {string|number} chargeId 
 * @returns {Promise<void>}
 */
export async function markAsProcessed(chargeId) {
  await pool.query(
    'INSERT IGNORE INTO processed_charges (charge_id) VALUES (?)',
    [String(chargeId)]
  );
}
