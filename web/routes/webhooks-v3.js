import { injectOnetime, getAddressById, getActiveSubscriptionsByAddress, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V3, LTV_LADDER_V3, MAX_CYCLE_V3 } from '../services/ltv-config-v3.js';
import { claimCharge, claimKey } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';
import { trackKlaviyoEvent } from '../services/klaviyo-api.js';

const TAG = '[LTV Webhook V3]';

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
      logger.info(TAG, `✓ Gift injected`, { variantId, onetimeId: result.onetime?.id });
    } catch (err) {
      failCount++;
      logger.error(TAG, `Failed to inject gift`, { variantId, error: err.response?.data || err.message });
    }
  }

  return { successCount, failCount };
}

/**
 * Handles the initial entry into the V3 Funnel via the 'subscription/created' webhook.
 * - Fires Klaviyo Welcome Email
 * - Adjusts Rebill 1 date to 50 days from now
 * - Injects Rebill 1 gifts ($0 onetimes) onto the address
 */
export async function executeV3NewSubscription(subscription) {
  logger.section(TAG, `🚀 New V3 Subscription Created: ${subscription.id}`);

  const {
    id: subscriptionId,
    address_id: addressId,
    email
  } = subscription;

  let firstName = '';
  let lastName = '';

  try {
    const address = await getAddressById(addressId);
    firstName = address?.first_name || '';
    lastName = address?.last_name || '';
  } catch (err) {
    logger.warn(TAG, `Could not fetch address ${addressId} for name — proceeding without names for Klaviyo`);
  }

  // 1. Race for the shared first-order idempotency key.
  const firstOrderKey = `first-order-addr-${addressId}`;
  let claimed = false;
  try {
    claimed = await claimKey(firstOrderKey);
  } catch (dbErr) {
    logger.error(TAG, 'DB error during first-order idempotency claim', { error: dbErr.message });
    return;
  }

  if (!claimed) {
    logger.warn(TAG, `First-order automation for address ${addressId} already handled by charge/paid — skipping duplicate from subscription/created`);
    return;
  }

  // 2. Trigger Klaviyo Welcome Email for digital PDFs
  logger.info(TAG, `Triggering Klaviyo welcome flow for ${email}`);
  await trackKlaviyoEvent(email, 'starter_kit_purchased', { offer: 'v3' }, { first_name: firstName, last_name: lastName });

  // 3. Adjust Rebill date to +50 days
  let plus50DaysStr = null;
  try {
    const baseDate = new Date();
    baseDate.setDate(baseDate.getDate() + 50);
    plus50DaysStr = baseDate.toISOString().split('T')[0];

    logger.info(TAG, `🕒 Delaying Rebill 1 to 50 days (${plus50DaysStr}) for sub ${subscriptionId}`);
    await updateSubscriptionNextChargeDate(subscriptionId, plus50DaysStr);
  } catch (err) {
    logger.error(TAG, 'Error during 50-day first rebill scheduling', { error: err.message });
  }

  // 4. Inject Cycle 2 gifts (Water Bottle + Stickers)
  const targetCycle = 2;
  const variantIds = LTV_LADDER_V3[targetCycle];
  
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER_V3 for cycle ${targetCycle}`);
    return;
  }

  const nextChargeDate = plus50DaysStr || new Date().toISOString().split('T')[0];

  logger.info(TAG, `🎁 Injecting V3 Cycle 2 gifts onto address ${addressId}`, { variantIds, nextChargeDate });

  const { successCount, failCount } = await injectGiftsSequentially(addressId, variantIds, nextChargeDate);

  logger.info(TAG, `━━ V3 New Sub ${subscriptionId} complete: ${successCount} injected, ${failCount} failed ━━`);
}

/**
 * Core automation logic for Offer V3 charges via 'charge/paid' webhook.
 * Handles ALL cycles including Order #1 (since Recharge SCI fires charge/paid for first order too).
 */
export async function executeV3Automation(charge) {
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

  logger.info(TAG, 'V3 Charge details', { chargeId, addressId, status, cycleNumber, chargeDate });

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

  // ── Order #1: Initial Starter Kit purchase ──────────────────────────────
  // Recharge SCI fires BOTH subscription/created AND charge/paid for Order #1.
  // We use a shared idempotency key so whichever fires first handles Klaviyo,
  // date adjustment, and gifts, and the second one is silently skipped.
  let plus50DaysStr = null;
  if (cycleNumber === 1) {
    logger.info(TAG, `🎉 Order #1 detected — running first-purchase automation`);

    // 1. Race for the shared first-order idempotency key.
    const firstOrderKey = `first-order-addr-${addressId}`;
    let firstOrderClaimed = false;
    try {
      firstOrderClaimed = await claimKey(firstOrderKey);
    } catch (dbErr) {
      logger.error(TAG, 'DB error during first-order idempotency claim', { error: dbErr.message });
      return;
    }

    if (!firstOrderClaimed) {
      logger.warn(TAG, `First-order automation for address ${addressId} already handled by subscription/created — skipping from charge/paid`);
      return; // Order #1 fully handled by the other webhook — exit here
    }

    // 2. Trigger Klaviyo Welcome Email for digital PDFs
    await trackKlaviyoEvent(email, 'starter_kit_purchased', { offer: 'v3' }, { first_name: first_name || '', last_name: last_name || '' });

    // 3. Adjust Rebill date to +50 days
    try {
      const baseDate = chargeDate ? new Date(chargeDate) : new Date();
      baseDate.setDate(baseDate.getDate() + 50);
      plus50DaysStr = baseDate.toISOString().split('T')[0];

      logger.info(TAG, `🕒 Delaying Rebill 1 to 50 days (${plus50DaysStr})...`);
      const activeSubs = await getActiveSubscriptionsByAddress(addressId);
      
      for (const sub of activeSubs) {
        if (
          String(sub.external_product_id?.ecommerce) === TARGET_PRODUCT_ID_V3 ||
          String(sub.shopify_product_id) === TARGET_PRODUCT_ID_V3 ||
          activeSubs.length === 1
        ) {
          await updateSubscriptionNextChargeDate(sub.id, plus50DaysStr);
        }
      }
    } catch (err) {
      logger.error(TAG, 'Error during 50-day first rebill scheduling', { error: err.message });
    }

    // 4. Inject Cycle 2 gifts here
    const firstCycleVariants = LTV_LADDER_V3[2];
    if (firstCycleVariants && firstCycleVariants.length > 0) {
      const firstCycleDate = plus50DaysStr || (chargeDate ? chargeDate.split('T')[0] : new Date().toISOString().split('T')[0]);
      logger.info(TAG, `🎁 Injecting V3 Cycle 2 gifts (won race from charge/paid)`, { firstCycleVariants, firstCycleDate });
      const { successCount, failCount } = await injectGiftsSequentially(addressId, firstCycleVariants, firstCycleDate);
      logger.info(TAG, `━━ V3 Order #1 Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
    }
    return; // Order #1 fully handled — exit here
  }

  // ── Gift injection for next cycle ───────────────────────────────────────
  const targetCycle = cycleNumber + 1;
  if (targetCycle > MAX_CYCLE_V3) {
    logger.info(TAG, `Cycle ${targetCycle} is beyond MAX_CYCLE_V3 (${MAX_CYCLE_V3})`);
    return;
  }

  const variantIds = LTV_LADDER_V3[targetCycle];
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER_V3 for cycle ${targetCycle}`);
    return;
  }

  const nextChargeDate = plus50DaysStr || (chargeDate ? chargeDate.split('T')[0] : new Date().toISOString().split('T')[0]);

  logger.info(TAG, `🎁 Injecting V3 Cycle ${targetCycle} gifts (order #${cycleNumber} just paid)`, {
    targetCycle,
    variantIds,
    addressId,
    nextChargeDate,
  });

  // Inject gifts SEQUENTIALLY to avoid Recharge 409 race condition
  const { successCount, failCount } = await injectGiftsSequentially(addressId, variantIds, nextChargeDate);

  logger.info(TAG, `━━ V3 Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
}
