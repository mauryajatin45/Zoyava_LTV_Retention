import { injectOnetime, getAddressById, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V4, V4_VARIANT_TO_KIDS, LTV_LADDER_V4, MAX_CYCLE_V4 } from '../services/ltv-config-v4.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';
import { trackKlaviyoEvent } from '../services/klaviyo-api.js';

const TAG = '[LTV Webhook V4]';

/**
 * Handles the initial entry into the V4 Funnel via the 'subscription/created' webhook.
 * - Fires Klaviyo Welcome Email (scaled by kidCount)
 * - Adjusts Rebill 1 date to 28 days from now
 * - Injects Rebill 1 gifts ($0 onetimes) onto the address, multiplied by kidCount
 */
export async function executeV4NewSubscription(subscription) {
  logger.section(TAG, `🚀 New V4 Subscription Created: ${subscription.id}`);

  const {
    id: subscriptionId,
    address_id: addressId,
    email,
    shopify_variant_id: variantId
  } = subscription;

  // Extract kid count from variant
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

  // 1. Trigger Klaviyo Welcome Email for digital PDFs
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

  // 3. Inject Cycle 2 gifts
  const targetCycle = 2;
  const variantIds = LTV_LADDER_V4[targetCycle];
  
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER_V4 for cycle ${targetCycle}`);
    return;
  }

  const nextChargeDate = plus28DaysStr || new Date().toISOString().split('T')[0];

  logger.info(TAG, `🎁 Injecting V4 Cycle 2 gifts (${kidCount}x) onto address ${addressId}`, { variantIds, nextChargeDate });

  const results = await Promise.allSettled(
    variantIds.map((vId) => injectOnetime(addressId, vId, nextChargeDate, kidCount))
  );

  let successCount = 0;
  let failCount    = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      successCount++;
      logger.info(TAG, `✓ Gift injected (${kidCount}x)`, { variantId: variantIds[i], onetimeId: result.value.onetime?.id });
    } else {
      failCount++;
      logger.error(TAG, `Failed to inject gift`, { variantId: variantIds[i], error: result.reason?.response?.data || result.reason?.message });
    }
  });

  logger.info(TAG, `━━ V4 New Sub ${subscriptionId} complete: ${successCount} injected, ${failCount} failed ━━`);
}

/**
 * Core automation logic for Offer V4 recurring charges via 'charge/paid' webhook.
 * Handles Cycle 3 through N.
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
    status
  } = charge;

  logger.info(TAG, 'V4 Recurring Charge details', { chargeId, addressId, status, cycleNumber });

  if (status !== 'SUCCESS' && status !== 'success') {
    logger.info(TAG, `Skipping — status is "${status}", not SUCCESS`);
    return;
  }

  // Since SCI handles checkout, the first recurring charge is Order 2 (Cycle 2)
  if (cycleNumber === 1) {
    logger.info(TAG, `Skipping charge/paid for Order #1 - initial checkout logic is now handled by subscription/created webhook`);
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

  // Determine Kid Count from the V4 line item
  const v4Item = charge.line_items?.find(
    (item) =>
      String(item.external_product_id) === TARGET_PRODUCT_ID_V4 ||
      String(item.shopify_product_id)  === TARGET_PRODUCT_ID_V4
  );

  let kidCount = 2; // Default fallback
  if (v4Item) {
    const variantId = String(v4Item.external_variant_id || v4Item.shopify_variant_id);
    kidCount = V4_VARIANT_TO_KIDS[variantId] || parseInt(v4Item.quantity, 10) || 2;
  }

  // Determine next cycle's gift
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

  const nextChargeDate = chargeDate ? chargeDate.split('T')[0] : new Date().toISOString().split('T')[0];

  logger.info(TAG, `🎁 Injecting V4 Cycle ${targetCycle} gifts scaled by ${kidCount}x (order #${cycleNumber} just paid)`, {
    targetCycle,
    variantIds,
    addressId,
    nextChargeDate,
    kidCount,
  });

  const results = await Promise.allSettled(
    variantIds.map((vId) => injectOnetime(addressId, vId, nextChargeDate, kidCount))
  );

  let successCount = 0;
  let failCount    = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      successCount++;
    } else {
      failCount++;
      logger.error(TAG, `Failed to inject gift`, { variantId: variantIds[i], error: result.reason?.response?.data || result.reason?.message });
    }
  });

  logger.info(TAG, `━━ V4 Recurring Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
}
