import { injectOnetime, getAddressById, getActiveSubscriptionsByAddress, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V4, V4_VARIANT_TO_KIDS, LTV_LADDER_V4, MAX_CYCLE_V4 } from '../services/ltv-config-v4.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';
import { trackKlaviyoEvent } from '../services/klaviyo-api.js';

const TAG = '[LTV Webhook V4]';

/**
 * Helper: Inject an array of gift variants sequentially (NOT in parallel).
 * Recharge returns 409 if two calls to /onetimes hit the same address simultaneously.
 */
async function injectGiftsSequentially(addressId, variantIds, nextChargeDate, quantity = 1) {
  let successCount = 0;
  let failCount = 0;

  for (const variantId of variantIds) {
    try {
      const result = await injectOnetime(addressId, variantId, nextChargeDate, quantity);
      successCount++;
      logger.info(TAG, `✓ Gift injected (${quantity}x)`, { variantId, onetimeId: result.onetime?.id });
    } catch (err) {
      failCount++;
      logger.error(TAG, `Failed to inject gift`, { variantId, error: err.response?.data || err.message });
    }
  }

  return { successCount, failCount };
}

/**
 * Handles the initial entry into the V4 Funnel via the 'subscription/created' webhook.
 */
export async function executeV4NewSubscription(subscription) {
  logger.section(TAG, `🚀 New V4 Subscription Created: ${subscription.id}`);

  const {
    id: subscriptionId,
    address_id: addressId,
    email,
    shopify_variant_id: variantId
  } = subscription;

  const kidCount = V4_VARIANT_TO_KIDS[String(variantId)] || 2;
  logger.info(TAG, `👶 Household size determined: ${kidCount} Kid(s) from variant ${variantId}`);

  let firstName = '';
  let lastName = '';

  try {
    const address = await getAddressById(addressId);
    firstName = address?.first_name || '';
    lastName = address?.last_name || '';
  } catch (err) {
    logger.warn(TAG, `Could not fetch address ${addressId} for name — proceeding without names for Klaviyo`);
  }

  // 1. Trigger Klaviyo Welcome Email
  logger.info(TAG, `Triggering Klaviyo welcome flow for ${email}`);
  await trackKlaviyoEvent(email, 'starter_kit_purchased', { offer: 'v4', kidCount }, { first_name: firstName, last_name: lastName });

  // 2. Adjust Rebill date to +28 days
  let plus28DaysStr = null;
  try {
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + 28);
    plus28DaysStr = baseDate.toISOString().split('T')[0];

    logger.info(TAG, `🕒 Forcing Rebill 1 to 28 days (${plus28DaysStr}) for sub ${subscriptionId}`);
    await updateSubscriptionNextChargeDate(subscriptionId, plus28DaysStr);
  } catch (err) {
    logger.error(TAG, 'Error during 28-day first rebill scheduling', { error: err.message });
  }

  // 3. Inject Cycle 2 gifts — SEQUENTIALLY
  const targetCycle = 2;
  const variantIds = LTV_LADDER_V4[targetCycle];
  
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER_V4 for cycle ${targetCycle}`);
    return;
  }

  const nextChargeDate = plus28DaysStr || new Date().toISOString().split('T')[0];

  logger.info(TAG, `🎁 Injecting V4 Cycle 2 gifts (${kidCount}x) onto address ${addressId}`, { variantIds: variantIds, nextChargeDate });

  const { successCount, failCount } = await injectGiftsSequentially(addressId, variantIds, nextChargeDate, kidCount);

  logger.info(TAG, `━━ V4 New Sub ${subscriptionId} complete: ${successCount} injected, ${failCount} failed ━━`);
}

/**
 * Core automation logic for Offer V4 charges via 'charge/paid' webhook.
 * Handles ALL cycles including Order #1.
 */
export async function executeV4Automation(charge) {
  if (!charge) {
    logger.error(TAG, 'Payload missing "charge" object');
    return;
  }

  const {
    id:            chargeId,
    address_id:    addressId,
    orders_count:  cycleNumber,
    scheduled_at:  chargeDate,
    status,
    email,
    first_name,
    last_name
  } = charge;

  logger.info(TAG, 'V4 Charge details', { chargeId, addressId, status, cycleNumber, chargeDate });

  if (status !== 'SUCCESS' && status !== 'success') {
    logger.info(TAG, `Skipping — status is "${status}", not SUCCESS`);
    return;
  }

  let claimed = false;
  try {
    claimed = await claimCharge(chargeId);
  } catch (dbErr) {
    logger.error(TAG, 'DB error during idempotency claim', { error: dbErr.message });
    return;
  }

  if (!claimed) {
    logger.warn(TAG, `Charge ${chargeId} already processed (idempotency guard)`);
    return;
  }

  // Find target line item to determine Kid Count (N)
  const v4Item = charge.line_items?.find(
    (item) =>
      String(item.external_product_id) === TARGET_PRODUCT_ID_V4 ||
      String(item.shopify_product_id)  === TARGET_PRODUCT_ID_V4
  );

  let kidCount = 2; // Default fallback
  if (v4Item) {
    const vId = String(v4Item.external_variant_id || v4Item.shopify_variant_id);
    kidCount = V4_VARIANT_TO_KIDS[vId] || parseInt(v4Item.quantity, 10) || 2;
  }
  logger.info(TAG, `👶 Household size determined: ${kidCount} Kid(s)`);

  // ── Order #1: Initial Starter Kit purchase ──────────────────────────────
  let plus28DaysStr = null;
  if (cycleNumber === 1) {
    logger.info(TAG, `🎉 Order #1 detected — running first-purchase automation`);

    // 1. Trigger Klaviyo Welcome Email
    await trackKlaviyoEvent(email, 'starter_kit_purchased', { offer: 'v4', kidCount }, { first_name: first_name || '', last_name: last_name || '' });

    // 2. Adjust Rebill date to +28 days
    try {
      const baseDate = chargeDate ? new Date(chargeDate) : new Date();
      baseDate.setDate(baseDate.getDate() + 28);
      plus28DaysStr = baseDate.toISOString().split('T')[0];

      logger.info(TAG, `🕒 Forcing Rebill 1 to 28 days (${plus28DaysStr})...`);
      const activeSubs = await getActiveSubscriptionsByAddress(addressId);
      
      for (const sub of activeSubs) {
        if (
          String(sub.external_product_id?.ecommerce) === TARGET_PRODUCT_ID_V4 ||
          String(sub.shopify_product_id) === TARGET_PRODUCT_ID_V4 ||
          activeSubs.length === 1
        ) {
          await updateSubscriptionNextChargeDate(sub.id, plus28DaysStr);
        }
      }
    } catch (err) {
      logger.error(TAG, 'Error during 28-day first rebill scheduling', { error: err.message });
    }
  }

  // ── Gift injection for next cycle ───────────────────────────────────────
  const targetCycle = cycleNumber + 1;
  if (targetCycle > MAX_CYCLE_V4) {
    logger.info(TAG, `Cycle ${targetCycle} is beyond MAX_CYCLE_V4 (${MAX_CYCLE_V4})`);
    return;
  }

  const variantIds = LTV_LADDER_V4[targetCycle];
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER_V4 for cycle ${targetCycle}`);
    return;
  }

  const nextChargeDate = plus28DaysStr || (chargeDate ? chargeDate.split('T')[0] : new Date().toISOString().split('T')[0]);

  logger.info(TAG, `🎁 Injecting V4 Cycle ${targetCycle} gifts scaled by ${kidCount}x (order #${cycleNumber} just paid)`, {
    targetCycle,
    variantIds,
    addressId,
    nextChargeDate,
    kidCount,
  });

  // Inject gifts SEQUENTIALLY to avoid Recharge 409 race condition
  const { successCount, failCount } = await injectGiftsSequentially(addressId, variantIds, nextChargeDate, kidCount);

  logger.info(TAG, `━━ V4 Charge ${chargeId} complete: ${successCount} injected (${kidCount}x each), ${failCount} failed ━━`);
}
