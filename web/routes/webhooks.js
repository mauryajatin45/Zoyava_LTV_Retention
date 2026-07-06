import express from 'express';
import { verifyRechargeWebhook } from '../middleware/verify-recharge-webhook.js';
import { injectOnetime } from '../services/recharge-api.js';
import { LTV_LADDER, MAX_CYCLE } from '../services/ltv-config.js';
import { claimCharge } from '../services/idempotency-store.js';
import { logger } from '../services/logger.js';
import { executeV3Automation, executeV3NewSubscription } from './webhooks-v3.js';
import { executeV4Automation, executeV4NewSubscription } from './webhooks-v4.js';

const TAG = '[LTV Webhook]';
const router = express.Router();

/**
 * POST /webhooks/recharge/charge-paid
 *
 * Triggered by Recharge when a subscription charge successfully processes.
 * Injects the next cycle's gift variants as $0.00 onetimes on the address.
 */
router.post('/recharge/charge-paid', verifyRechargeWebhook, async (req, res) => {

  // ── 1. ACK Recharge immediately (must be within 5s or Recharge retries) ──
  res.status(200).json({ received: true });

  logger.section(TAG, '📦 charge/paid webhook received');

  // ── 2. Extract the charge object ─────────────────────────────────────────
  const charge = req.body?.charge;

  if (!charge) {
    logger.error(TAG, 'Payload missing "charge" object — nothing to process', {
      receivedKeys: Object.keys(req.body || {}),
    });
    return;
  }

  const {
    id:            chargeId,
    address_id:    addressId,
    orders_count:  cycleNumber,  // 1 = first order just paid, 2 = second, etc.
    scheduled_at:  chargeDate,
    status,
  } = charge;

  logger.info(TAG, 'Charge details', {
    chargeId,
    addressId,
    status,
    cycleNumber,
    chargeDate,
    lineItems: charge.line_items?.map((i) => ({
      title:     i.title,
      productId: i.external_product_id || i.shopify_product_id,
    })),
  });

  // ── 3. Guard: status must be SUCCESS ─────────────────────────────────────
  if (status !== 'SUCCESS' && status !== 'success') {
    logger.info(TAG, `Skipping — status is "${status}", not SUCCESS`);
    return;
  }

  // ── 4. Product ID Inspection & Automatic Funnel Routing ──────────────────
  const TARGET_PRODUCT_ID_OLD = process.env.TARGET_PRODUCT_ID_OLD || '9636915151089';
  const TARGET_PRODUCT_ID_V3  = process.env.TARGET_PRODUCT_ID_V3  || '9656256463089';
  const TARGET_PRODUCT_ID_V4  = process.env.TARGET_PRODUCT_ID_V4  || '9656359256305';

  const hasV3Product = charge.line_items?.some(
    (item) =>
      String(item.external_product_id) === TARGET_PRODUCT_ID_V3 ||
      String(item.shopify_product_id)  === TARGET_PRODUCT_ID_V3
  );
  if (hasV3Product) {
    logger.info(TAG, `✓ Zoyava Offer V3 Product (${TARGET_PRODUCT_ID_V3}) detected — routing to V3 automation`);
    return await executeV3Automation(charge);
  }

  const hasV4Product = charge.line_items?.some(
    (item) =>
      String(item.external_product_id) === TARGET_PRODUCT_ID_V4 ||
      String(item.shopify_product_id)  === TARGET_PRODUCT_ID_V4
  );
  if (hasV4Product) {
    logger.info(TAG, `✓ Zoyava Offer V4 Product (${TARGET_PRODUCT_ID_V4}) detected — routing to V4 automation`);
    return await executeV4Automation(charge);
  }

  const hasTargetProduct = charge.line_items?.some(
    (item) =>
      String(item.external_product_id) === TARGET_PRODUCT_ID_OLD ||
      String(item.shopify_product_id)  === TARGET_PRODUCT_ID_OLD
  );

  if (!hasTargetProduct) {
    logger.info(TAG, `Skipping — No known ZeoShield product (Old, V3, or V4) found in line items`);
    return;
  }
  logger.info(TAG, '✓ Old ZeoShield production product confirmed — executing original production ladder');

  // ── 5. Atomic idempotency claim — prevents duplicate gift injection ───────
  let claimed = false;
  try {
    claimed = await claimCharge(chargeId);
  } catch (dbErr) {
    logger.error(TAG, 'DB error during idempotency claim — aborting to prevent duplicates', {
      chargeId,
      error: dbErr.message,
    });
    return;
  }

  if (!claimed) {
    logger.warn(TAG, `Charge ${chargeId} already processed — skipping (idempotency guard)`);
    return;
  }
  logger.info(TAG, `✓ Charge ${chargeId} claimed — proceeding with gift injection`);

  // ── 6. Determine which gift cycle to inject ───────────────────────────────
  // orders_count = N means order N just succeeded.
  // We inject gifts for the NEXT order (cycle N+1).
  const targetCycle = cycleNumber + 1;

  if (targetCycle > MAX_CYCLE) {
    logger.info(TAG, `Cycle ${targetCycle} is beyond MAX_CYCLE (${MAX_CYCLE}) — customer has received all ladder gifts`);
    return;
  }

  const variantIds = LTV_LADDER[targetCycle];
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER for cycle ${targetCycle}`);
    return;
  }

  logger.info(TAG, `🎁 Injecting Cycle ${targetCycle} gifts (order #${cycleNumber} just paid)`, {
    targetCycle,
    variantIds,
    addressId,
  });

  // ── 7. Calculate the date for the next charge ─────────────────────────────
  const nextChargeDate = chargeDate
    ? chargeDate.split('T')[0]
    : new Date().toISOString().split('T')[0];

  logger.info(TAG, `Next charge date: ${nextChargeDate}`);

  // ── 8. Inject all gifts (each has retry logic inside injectOnetime) ───────
  const results = await Promise.allSettled(
    variantIds.map((variantId) => injectOnetime(addressId, variantId, nextChargeDate))
  );

  // ── 9. Summary ────────────────────────────────────────────────────────────
  let successCount = 0;
  let failCount    = 0;

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      successCount++;
      logger.info(TAG, `✓ Gift injected`, {
        variantId:  variantIds[i],
        onetimeId:  result.value.onetime?.id,
      });
    } else {
      failCount++;
      logger.error(TAG, `Failed to inject gift`, {
        variantId: variantIds[i],
        error:     result.reason?.response?.data || result.reason?.message,
      });
    }
  });

  logger.info(TAG, `━━ Charge ${chargeId} complete: ${successCount} injected, ${failCount} failed ━━`);
});

/**
 * POST /webhooks/recharge/subscription-created
 *
 * Triggered by Recharge when a new subscription is created (e.g. from Shopify Checkout Integration).
 * This replaces charge/paid for Order #1.
 */
router.post('/recharge/subscription-created', verifyRechargeWebhook, async (req, res) => {
  res.status(200).json({ received: true });
  logger.section(TAG, '🆕 subscription/created webhook received');

  const subscription = req.body?.subscription;
  if (!subscription) {
    logger.error(TAG, 'Payload missing "subscription" object');
    return;
  }

  const { shopify_product_id, external_product_id } = subscription;
  
  const TARGET_PRODUCT_ID_V3  = process.env.TARGET_PRODUCT_ID_V3  || '9656256463089';
  const TARGET_PRODUCT_ID_V4  = process.env.TARGET_PRODUCT_ID_V4  || '9656359256305';

  const isV3 = String(shopify_product_id) === TARGET_PRODUCT_ID_V3 || String(external_product_id) === TARGET_PRODUCT_ID_V3;
  if (isV3) {
    logger.info(TAG, `✓ Zoyava Offer V3 Product (${TARGET_PRODUCT_ID_V3}) detected for new subscription`);
    return await executeV3NewSubscription(subscription);
  }

  const isV4 = String(shopify_product_id) === TARGET_PRODUCT_ID_V4 || String(external_product_id) === TARGET_PRODUCT_ID_V4;
  if (isV4) {
    logger.info(TAG, `✓ Zoyava Offer V4 Product (${TARGET_PRODUCT_ID_V4}) detected for new subscription`);
    return await executeV4NewSubscription(subscription);
  }

  logger.info(TAG, `Skipping new subscription — Product ID ${shopify_product_id} is neither V3 nor V4 target`);
});

export default router;
