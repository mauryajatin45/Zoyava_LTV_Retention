import { injectOnetime, getAddressById, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { LTV_LADDER_V3, MAX_CYCLE_V3 } from '../services/ltv-config-v3.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';
import { trackKlaviyoEvent } from '../services/klaviyo-api.js';

const TAG = '[LTV Webhook V3]';

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

  // 1. Trigger Klaviyo Welcome Email for digital PDFs
  logger.info(TAG, `Triggering Klaviyo welcome flow for ${email}`);
  await trackKlaviyoEvent(email, 'starter_kit_purchased', { offer: 'v3' }, { first_name: firstName, last_name: lastName });

  // 2. Adjust Rebill date to +50 days
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

  // 3. Inject Cycle 2 gifts (Water Bottle + Stickers)
  const targetCycle = 2;
  const variantIds = LTV_LADDER_V3[targetCycle];
  
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER_V3 for cycle ${targetCycle}`);
    return;
  }

  const nextChargeDate = plus50DaysStr || new Date().toISOString().split('T')[0];

  logger.info(TAG, `🎁 Injecting V3 Cycle 2 gifts onto address ${addressId}`, { variantIds, nextChargeDate });

  const results = await Promise.allSettled(
    variantIds.map((variantId) => injectOnetime(addressId, variantId, nextChargeDate))
  );

  let successCount = 0;
  let failCount    = 0;
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      successCount++;
      logger.info(TAG, `✓ Gift injected`, { variantId: variantIds[i], onetimeId: result.value.onetime?.id });
    } else {
      failCount++;
      logger.error(TAG, `Failed to inject gift`, { variantId: variantIds[i], error: result.reason?.response?.data || result.reason?.message });
    }
  });

  logger.info(TAG, `━━ V3 New Sub ${subscriptionId} complete: ${successCount} injected, ${failCount} failed ━━`);
}

/**
 * Core automation logic for Offer V3 recurring charges via 'charge/paid' webhook.
 * Handles Cycle 3 through 6.
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
    status
  } = charge;

  logger.info(TAG, 'V3 Recurring Charge details', { chargeId, addressId, status, cycleNumber });

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

  // Determine next cycle's gift
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

  const nextChargeDate = chargeDate ? chargeDate.split('T')[0] : new Date().toISOString().split('T')[0];

  logger.info(TAG, `🎁 Injecting V3 Cycle ${targetCycle} gifts (order #${cycleNumber} just paid)`, {
    targetCycle,
    variantIds,
    addressId,
    nextChargeDate,
  });

  const results = await Promise.allSettled(
    variantIds.map((variantId) => injectOnetime(addressId, variantId, nextChargeDate))
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

  logger.info(TAG, `━━ V3 Recurring Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
}
