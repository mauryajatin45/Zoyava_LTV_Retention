import { pool } from './idempotency-store.js';
import { logger } from './logger.js';

const TAG = '[WebhookLogger]';

/**
 * Log a webhook execution to the MySQL database.
 * 
 * @param {Object} data
 * @param {string} data.webhook_type
 * @param {string} data.charge_id
 * @param {string} data.address_id
 * @param {string} data.funnel_type
 * @param {number} data.cycle_number
 * @param {string} data.status - 'SUCCESS', 'FAILED', 'SKIPPED'
 * @param {Array<number|string>} [data.gifts_injected]
 * @param {string} [data.next_charge_date]
 * @param {Object} [data.request_payload]
 * @param {Object} [data.response_payload]
 * @param {string} [data.error_message]
 */
export async function logWebhook(data) {
  try {
    const {
      webhook_type = null,
      charge_id = null,
      address_id = null,
      funnel_type = null,
      cycle_number = null,
      status = 'PENDING',
      gifts_injected = [],
      next_charge_date = null,
      request_payload = null,
      response_payload = null,
      error_message = null
    } = data;

    const giftsJson = JSON.stringify(gifts_injected || []);
    const reqJson = request_payload ? JSON.stringify(request_payload) : null;
    const resJson = response_payload ? JSON.stringify(response_payload) : null;

    const query = `
      INSERT INTO webhook_logs (
        webhook_type, charge_id, address_id, funnel_type, cycle_number, 
        status, gifts_injected, next_charge_date, request_payload, 
        response_payload, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await pool.query(query, [
      webhook_type,
      String(charge_id),
      String(address_id),
      funnel_type,
      cycle_number,
      status,
      giftsJson,
      next_charge_date,
      reqJson,
      resJson,
      error_message
    ]);

    logger.info(TAG, `Logged webhook for charge ${charge_id} / address ${address_id} with status ${status}`);
  } catch (err) {
    logger.error(TAG, 'Failed to insert webhook log', { error: err.message, data });
  }
}

/**
 * Fetch logs for the frontend dashboard.
 */
export async function getWebhookLogs(limit = 50, offset = 0) {
  try {
    const query = `
      SELECT id, webhook_type, charge_id, address_id, funnel_type, cycle_number, 
             status, gifts_injected, next_charge_date, error_message, created_at
      FROM webhook_logs
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    // pool.query using positional args with integers for LIMIT/OFFSET can sometimes be tricky depending on mysql2 config,
    // so we ensure they are parsed as numbers.
    const [rows] = await pool.query(query, [Number(limit), Number(offset)]);
    return rows;
  } catch (err) {
    logger.error(TAG, 'Failed to fetch webhook logs', { error: err.message });
    throw err;
  }
}
