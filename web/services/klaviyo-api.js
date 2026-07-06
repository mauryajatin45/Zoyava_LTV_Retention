/**
 * Zoyava LTV — Klaviyo API Service
 *
 * Uses Klaviyo REST API revision: 2026-04-15 (latest stable)
 * Endpoint: POST https://a.klaviyo.com/api/events/
 * Docs: https://developers.klaviyo.com/en/reference/create_event
 *
 * Payload structure MUST follow JSON:API spec with nested `data` wrappers
 * for both `metric` and `profile` relationships. This was verified to work
 * with a 202 Accepted response against the live Klaviyo API.
 */

import axios from 'axios';
import { logger } from './logger.js';

const TAG = '[Klaviyo API]';

// Read API key from environment (loaded by dotenv in index.js at boot)
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

// Latest stable Klaviyo API revision as of July 2026
const KLAVIYO_API_REVISION = '2026-04-15';
const KLAVIYO_EVENTS_URL = 'https://a.klaviyo.com/api/events/';

/**
 * Fires a custom event to Klaviyo for a given customer profile.
 *
 * Klaviyo returns HTTP 202 Accepted on success (not 200).
 * The event is processed asynchronously by Klaviyo after receipt.
 *
 * @param {string} email       - Customer email address (required identifier)
 * @param {string} metricName  - Klaviyo metric/event name (e.g. 'starter_kit_purchased')
 * @param {object} properties  - Flat key/value object of custom event properties
 * @param {object} profileData - Optional profile fields: { first_name, last_name, phone_number }
 * @returns {boolean}          - true on success (202), false on any error
 */
export async function trackKlaviyoEvent(email, metricName, properties = {}, profileData = {}) {
  logger.section(TAG, `Attempting to track Klaviyo event: "${metricName}"`);

  // ── Guard: API Key ────────────────────────────────────────────────────────
  if (!KLAVIYO_API_KEY) {
    logger.error(TAG, 'KLAVIYO_API_KEY is not set in environment variables!', {
      hint: 'Ensure KLAVIYO_API_KEY is set in .env and the server was restarted after the change.',
    });
    return false;
  }
  logger.info(TAG, `Using API Key: ${KLAVIYO_API_KEY.slice(0, 10)}...${KLAVIYO_API_KEY.slice(-4)} (revision: ${KLAVIYO_API_REVISION})`);

  // ── Guard: Email ──────────────────────────────────────────────────────────
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    logger.error(TAG, `Cannot track event "${metricName}" — email is missing or invalid`, {
      receivedEmail: email,
    });
    return false;
  }

  // ── Build Payload ─────────────────────────────────────────────────────────
  // Klaviyo JSON:API format requires nested `data` objects for relationships.
  // The `metric` and `profile` fields MUST use this wrapper format.
  const payload = {
    data: {
      type: 'event',
      attributes: {
        // Event properties: flat key/value object with custom data
        properties: {
          ...properties,
          source: 'zoyava-ltv-retention-app',
        },
        // ISO 8601 timestamp of when the event occurred
        time: new Date().toISOString(),
        // Metric (event name) — must use JSON:API relationship wrapper
        metric: {
          data: {
            type: 'metric',
            attributes: {
              name: metricName,
            },
          },
        },
        // Profile (customer) — must use JSON:API relationship wrapper
        profile: {
          data: {
            type: 'profile',
            attributes: {
              email: email.toLowerCase().trim(),
              ...profileData, // first_name, last_name, phone_number if available
            },
          },
        },
      },
    },
  };

  logger.info(TAG, `Payload built for "${metricName}"`, {
    email,
    metricName,
    properties: payload.data.attributes.properties,
    profileFields: Object.keys(profileData),
  });

  // ── POST to Klaviyo ───────────────────────────────────────────────────────
  try {
    logger.info(TAG, `Sending POST to ${KLAVIYO_EVENTS_URL}`);

    const response = await axios.post(KLAVIYO_EVENTS_URL, payload, {
      headers: {
        Authorization:    `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        accept:           'application/json',
        'content-type':   'application/json',
        revision:         KLAVIYO_API_REVISION,
      },
      // 10 second timeout — Klaviyo is reliable but protect against hangs
      timeout: 10000,
    });

    // Klaviyo returns 202 Accepted, not 200 OK
    logger.info(TAG, `✅ SUCCESS — "${metricName}" event accepted by Klaviyo`, {
      email,
      httpStatus: response.status, // Expected: 202
      klaviyoResponse: response.data || '(empty body — normal for 202)',
    });

    return true;

  } catch (err) {
    // ── Detailed Error Logging ────────────────────────────────────────────
    if (err.response) {
      // Klaviyo returned an HTTP error response (4xx, 5xx)
      logger.error(TAG, `❌ Klaviyo API returned HTTP ${err.response.status} for "${metricName}"`, {
        email,
        httpStatus:       err.response.status,
        klaviyoErrors:    err.response.data?.errors || err.response.data,
        requestUrl:       KLAVIYO_EVENTS_URL,
        requestRevision:  KLAVIYO_API_REVISION,
        payloadSent:      JSON.stringify(payload, null, 2),
      });
    } else if (err.code === 'ECONNABORTED') {
      // Timeout
      logger.error(TAG, `❌ Klaviyo API request timed out after 10s for "${metricName}"`, {
        email,
        errorCode: err.code,
      });
    } else {
      // Network error (DNS failure, no internet, etc.)
      logger.error(TAG, `❌ Network error sending "${metricName}" to Klaviyo`, {
        email,
        errorMessage: err.message,
        errorCode:    err.code,
      });
    }

    return false;
  }
}
