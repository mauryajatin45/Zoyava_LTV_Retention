import express from 'express';
import { verifyRechargeWebhook } from '../middleware/verify-recharge-webhook.js';
import { injectOnetime, getActiveSubscriptionsByAddress, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V4, V4_VARIANT_TO_KIDS, LTV_LADDER_V4, MAX_CYCLE_V4 } from '../services/ltv-config-v4.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';
import { trackKlaviyoEvent } from '../services/klaviyo-api.js';

const TAG = '[LTV Webhook V4]';
const router = express.Router();

/**
 * Core automation logic for Offer V4 (Hiya-Style Per-Kid Selector).
 * 1. Automates the 28-day first rebill interval when Order #1 is paid.
 * 2. Multiplies physical gift variants by the kid count (N) on recurring rebills.
 */
export async function executeV4Automation(charge) {
  if (!charge) {
    logger.error(TAG, 'Payload missing "charge" object — nothing to process');
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
    logger.error(TAG, 'DB error during idempotency claim — aborting to prevent duplicates', { chargeId, error: dbErr.message });
    return;
  }

  if (!claimed) {
    logger.warn(TAG, `Charge ${chargeId} already processed — skipping (idempotency guard)`);
    return;
  }
  logger.info(TAG, `✓ Charge ${chargeId} claimed — proceeding with V4 automation`);

  // Find target line item to determine Kid Count (N)
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
  logger.info(TAG, `👶 Household size determined: ${kidCount} Kid(s)`);

  // 1. The 28-Day First Rebill Interval Automation for Order #1
  let plus28DaysStr = null;
  if (cycleNumber === 1) {
    // 1. Trigger Klaviyo Welcome Email for digital PDFs
    await trackKlaviyoEvent(email, 'starter_kit_purchased', { offer: 'v4', kidCount }, { first_name: first_name, last_name: last_name });

    // 2. Adjust Rebill date
    try {
      const baseDate = chargeDate ? new Date(chargeDate) : new Date();
      baseDate.setDate(baseDate.getDate() + 28);
      plus28DaysStr = baseDate.toISOString().split('T')[0];

      logger.info(TAG, `🕒 Order #1 detected! Forcing Rebill 1 to 28 days (${plus28DaysStr})...`);
      const activeSubs = await getActiveSubscriptionsByAddress(addressId);
      
      for (const sub of activeSubs) {
        if (
          String(sub.external_product_id) === TARGET_PRODUCT_ID_V4 ||
          String(sub.shopify_product_id)  === TARGET_PRODUCT_ID_V4 ||
          activeSubs.length === 1
        ) {
          await updateSubscriptionNextChargeDate(sub.id, plus28DaysStr);
        }
      }
    } catch (err) {
      logger.error(TAG, 'Error during 28-day first rebill scheduling automation', { error: err.message });
    }
  }

  // 2. Determine which gift cycle to inject
  const targetCycle = cycleNumber + 1;
  if (targetCycle > MAX_CYCLE_V4) {
    logger.info(TAG, `Cycle ${targetCycle} is beyond MAX_CYCLE_V4 (${MAX_CYCLE_V4}) — customer has completed ladder`);
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

  // 3. Inject gifts multiplied by Kid Count (quantity = kidCount)
  const results = await Promise.allSettled(
    variantIds.map((variantId) => injectOnetime(addressId, variantId, nextChargeDate, kidCount))
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

  logger.info(TAG, `━━ V4 Charge ${chargeId} complete: ${successCount} injected (${kidCount}x each), ${failCount} failed ━━`);
}

router.post('/recharge/charge-paid', verifyRechargeWebhook, async (req, res) => {
  res.status(200).json({ received: true });
  logger.section(TAG, '📦 V4 charge/paid webhook received directly');
  await executeV4Automation(req.body?.charge);
});

export default router;
