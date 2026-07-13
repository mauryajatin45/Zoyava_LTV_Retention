import { injectOnetime, getAddressById, getActiveSubscriptionsByAddress, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V4, V4_VARIANT_TO_KIDS, LTV_LADDER_V4, MAX_CYCLE_V4 } from '../services/ltv-config-v4.js';
import { claimCharge, claimKey } from '../services/idempotency-store.js';
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

  // 3. Inject Cycle 2 gifts — guarded by a shared idempotency key so charge/paid
  //    (which also fires for Order #1) cannot inject a second time.
  const firstOrderKey = `first-order-addr-${addressId}`;
  let claimed = false;
  try {
    claimed = await claimKey(firstOrderKey);
  } catch (dbErr) {
    logger.error(TAG, 'DB error during first-order idempotency claim', { error: dbErr.message });
    return;
  }

  if (!claimed) {
    logger.warn(TAG, `First-order gifts for address ${addressId} already injected by charge/paid — skipping duplicate from subscription/created`);
    return;
  }

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
  // Recharge SCI fires BOTH subscription/created AND charge/paid for Order #1.
  // We use a shared idempotency key so whichever fires first injects the Cycle 2
  // gifts, and the second one is silently skipped — preventing double injection.
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

    // 3. Race for the shared first-order idempotency key.
    //    subscription/created may have already claimed it — if so, skip gift injection.
    const firstOrderKey = `first-order-addr-${addressId}`;
    let firstOrderClaimed = false;
    try {
      firstOrderClaimed = await claimKey(firstOrderKey);
    } catch (dbErr) {
      logger.error(TAG, 'DB error during first-order idempotency claim', { error: dbErr.message });
      return;
    }

    if (!firstOrderClaimed) {
      logger.warn(TAG, `First-order gifts for address ${addressId} already injected by subscription/created — skipping Cycle 2 from charge/paid`);
      return;
    }

    // Won the race — inject Cycle 2 gifts here
    const firstCycleVariants = LTV_LADDER_V4[2];
    if (firstCycleVariants && firstCycleVariants.length > 0) {
      const firstCycleDate = plus28DaysStr || (chargeDate ? chargeDate.split('T')[0] : new Date().toISOString().split('T')[0]);
      logger.info(TAG, `🎁 Injecting V4 Cycle 2 gifts (${kidCount}x, won race from charge/paid)`, { firstCycleVariants, firstCycleDate });
      const { successCount, failCount } = await injectGiftsSequentially(addressId, firstCycleVariants, firstCycleDate, kidCount);
      logger.info(TAG, `━━ V4 Order #1 Charge ${chargeId} complete: ${successCount} injected (${kidCount}x each), ${failCount} failed ━━`);
    }
    return; // Order #1 fully handled — exit here
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
