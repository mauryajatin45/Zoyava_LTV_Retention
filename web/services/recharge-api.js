import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const recharge = axios.create({
  baseURL: 'https://api.rechargeapps.com',
  headers: {
    'X-Recharge-Version': '2021-11',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

// Set token dynamically to ensure env vars are loaded
recharge.interceptors.request.use((config) => {
  config.headers['X-Recharge-Access-Token'] = process.env.RECHARGE_API_TOKEN;
  return config;
});

/**
 * Injects a single variant as a $0.00 one-time into the address's
 * next upcoming charge.
 *
 * @param {number} addressId   - Recharge address_id from the charge payload
 * @param {number} variantId   - Shopify variant ID to inject
 * @param {string} nextChargeDate - ISO date string (YYYY-MM-DD) for scheduling
 */
export async function injectOnetime(addressId, variantId, nextChargeDate) {
  const payload = {
    address_id: addressId,
    shopify_variant_id: variantId,
    quantity: 1,
    price: 0.00,          // 100% discounted
    next_charge_scheduled_at: nextChargeDate,  // Attach to the next charge date
  };

  const response = await recharge.post(
    `/addresses/${addressId}/onetimes`,
    payload
  );

  return response.data;
}
