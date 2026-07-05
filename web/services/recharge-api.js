import axios from 'axios';
import dotenv from 'dotenv';
import { logger } from './logger.js';
dotenv.config();

const TAG = '[RechargeAPI]';

const recharge = axios.create({
  baseURL: 'https://api.rechargeapps.com',
  headers: {
    'X-Recharge-Version': '2021-11',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 15000, // 15-second timeout — prevents hanging indefinitely
});

// Attach API token on every request
recharge.interceptors.request.use((config) => {
  config.headers['X-Recharge-Access-Token'] = process.env.RECHARGE_API_TOKEN;
  if (!process.env.RECHARGE_API_TOKEN) {
    logger.error(TAG, 'RECHARGE_API_TOKEN is not set in .env — API calls will fail');
  }
  return config;
});

// Log every API response error clearly
recharge.interceptors.response.use(
  (res) => res,
  (err) => {
    const status  = err.response?.status;
    const data    = err.response?.data;
    const url     = err.config?.url;
    logger.error(TAG, `Recharge API error → ${url}`, { status, data, message: err.message });
    return Promise.reject(err);
  }
);

/**
 * Injects a single variant as a $0.00 one-time into the address's
 * next upcoming charge. Retries up to 3 times on network/5xx errors.
 *
 * @param {number} addressId      - Recharge address_id from the charge payload
 * @param {number} variantId      - Shopify variant ID to inject
 * @param {string} nextChargeDate - ISO date string (YYYY-MM-DD) for scheduling
 */
export async function injectOnetime(addressId, variantId, nextChargeDate, quantity = 1) {
  const payload = {
    address_id: addressId,
    shopify_variant_id: variantId,
    quantity: quantity,
    price: 0.00,
    next_charge_scheduled_at: nextChargeDate,
  };

  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.debug(TAG, `Attempt ${attempt}/${MAX_RETRIES} — injecting variant ${variantId}`, {
        addressId,
        nextChargeDate,
      });

      const response = await recharge.post(`/addresses/${addressId}/onetimes`, payload);

      logger.info(TAG, `✓ Onetime created`, {
        variantId,
        addressId,
        onetimeId: response.data?.onetime?.id,
        attempt,
      });

      return response.data;
    } catch (err) {
      lastError = err;
      const status = err.response?.status;

      // Do NOT retry on 4xx client errors (bad variant ID, wrong address, etc.)
      if (status && status >= 400 && status < 500) {
        logger.error(TAG, `Non-retryable error (${status}) injecting variant ${variantId}`, {
          error: err.response?.data,
        });
        throw err;
      }

      // Retry on network errors and 5xx server errors
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 1500; // 1.5s, 3s back-off
        logger.warn(TAG, `Attempt ${attempt} failed — retrying in ${delay}ms`, {
          variantId,
          error: err.message,
        });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  logger.error(TAG, `All ${MAX_RETRIES} attempts failed for variant ${variantId}`, {
    addressId,
    error: lastError?.message,
  });
  throw lastError;
}

/**
 * Fetches active subscriptions for a given address ID from Recharge.
 */
export async function getActiveSubscriptionsByAddress(addressId) {
  try {
    const response = await recharge.get(`/subscriptions`, {
      params: { address_id: addressId, status: 'ACTIVE' },
    });
    return response.data?.subscriptions || [];
  } catch (err) {
    logger.error(TAG, `Failed to get active subscriptions for address ${addressId}`, {
      error: err.response?.data || err.message,
    });
    throw err;
  }
}

/**
 * Updates the next charge scheduled date for a specific subscription in Recharge.
 *
 * @param {number} subscriptionId - Recharge subscription ID
 * @param {string} nextChargeDate - ISO date string (YYYY-MM-DD)
 */
export async function updateSubscriptionNextChargeDate(subscriptionId, nextChargeDate) {
  const payload = {
    next_charge_scheduled_at: nextChargeDate,
  };
  try {
    logger.info(TAG, `Updating subscription ${subscriptionId} next charge date to ${nextChargeDate}`);
    const response = await recharge.put(`/subscriptions/${subscriptionId}`, payload);
    logger.info(TAG, `✓ Subscription ${subscriptionId} updated successfully to ${nextChargeDate}`);
    return response.data;
  } catch (err) {
    logger.error(TAG, `Failed to update subscription ${subscriptionId} next charge date`, {
      error: err.response?.data || err.message,
    });
    throw err;
  }
}
