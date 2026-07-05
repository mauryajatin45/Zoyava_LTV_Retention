import express from 'express';
import { verifyRechargeWebhook } from '../middleware/verify-recharge-webhook.js';
import { injectOnetime, getActiveSubscriptionsByAddress, updateSubscriptionNextChargeDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V3, LTV_LADDER_V3, MAX_CYCLE_V3 } from '../services/ltv-config-v3.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';

const TAG = '[LTV Webhook V3]';
const router = express.Router();

/**
 * Core automation logic for Offer V3. Can be called from the dedicated route or the main router.
 */
export async function executeV3Automation(charge) {
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
    logger.error(TAG, 'DB error during idempotency claim — aborting to prevent duplicates', { chargeId, error: dbErr.message });
    return;
  }

  if (!claimed) {
    logger.warn(TAG, `Charge ${chargeId} already processed — skipping (idempotency guard)`);
    return;
  }
  logger.info(TAG, `✓ Charge ${chargeId} claimed — proceeding with V3 automation`);

  // Special V3 Automation: 50-Day First Rebill Interval for Order #1
  let plus50DaysStr = null;
  if (cycleNumber === 1) {
    try {
      const baseDate = chargeDate ? new Date(chargeDate) : new Date();
      baseDate.setDate(baseDate.getDate() + 50);
      plus50DaysStr = baseDate.toISOString().split('T')[0];

      logger.info(TAG, `🕒 Order #1 detected! Delaying Rebill 1 to 50 days (${plus50DaysStr})...`);
      const activeSubs = await getActiveSubscriptionsByAddress(addressId);
      
      for (const sub of activeSubs) {
        if (
          String(sub.external_product_id) === TARGET_PRODUCT_ID_V3 ||
          String(sub.shopify_product_id)  === TARGET_PRODUCT_ID_V3 ||
          activeSubs.length === 1
        ) {
          await updateSubscriptionNextChargeDate(sub.id, plus50DaysStr);
        }
      }
    } catch (err) {
      logger.error(TAG, 'Error during 50-day first rebill scheduling automation', { error: err.message });
    }
  }

  const targetCycle = cycleNumber + 1;
  if (targetCycle > MAX_CYCLE_V3) {
    logger.info(TAG, `Cycle ${targetCycle} is beyond MAX_CYCLE_V3 (${MAX_CYCLE_V3}) — customer has completed ladder`);
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

  logger.info(TAG, `━━ V3 Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
}

router.post('/recharge/charge-paid', verifyRechargeWebhook, async (req, res) => {
  res.status(200).json({ received: true });
  logger.section(TAG, '📦 V3 charge/paid webhook received directly');
  await executeV3Automation(req.body?.charge);
});

export default router;
