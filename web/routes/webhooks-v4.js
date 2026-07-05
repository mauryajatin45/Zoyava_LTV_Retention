import express from 'express';
import { verifyRechargeWebhook } from '../middleware/verify-recharge-webhook.js';
import { injectOnetime } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V4, LTV_LADDER_V4, MAX_CYCLE_V4 } from '../services/ltv-config-v4.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';

const TAG = '[LTV Webhook V4]';
const router = express.Router();

/**
 * Core automation logic for Offer V4. Can be called from the dedicated route or the main router.
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
  } = charge;

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

  logger.info(TAG, `🎁 Injecting V4 Cycle ${targetCycle} gifts (order #${cycleNumber} just paid)`, {
    targetCycle,
    variantIds,
    addressId,
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

  logger.info(TAG, `━━ V4 Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
}

router.post('/recharge/charge-paid', verifyRechargeWebhook, async (req, res) => {
  res.status(200).json({ received: true });
  logger.section(TAG, '📦 V4 charge/paid webhook received directly');
  await executeV4Automation(req.body?.charge);
});

export default router;
