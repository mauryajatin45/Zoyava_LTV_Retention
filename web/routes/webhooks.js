import express from 'express';
import { verifyRechargeWebhook } from '../middleware/verify-recharge-webhook.js';
import { injectOnetime } from '../services/recharge-api.js';
import { LTV_LADDER, MAX_CYCLE } from '../services/ltv-config.js';
import { hasBeenProcessed, markAsProcessed } from '../services/idempotency-store.js';

const router = express.Router();

/**
 * POST /webhooks/recharge/charge-paid
 *
 * Triggered by Recharge when a subscription charge is successfully paid.
 * Injects cycle-mapped gift variants into the customer's next upcoming charge.
 */
router.post(
  '/recharge/charge-paid',
  verifyRechargeWebhook,
  async (req, res) => {
    // ── 1. Immediately ACK Recharge (prevents retry timeout) ──────────────
    res.status(200).json({ received: true });

    // ── 2. Extract fields from charge payload ────────────────────────────
    const charge = req.body?.charge;

    if (!charge) {
      console.error('[LTV] Webhook payload missing charge object');
      return;
    }

    const {
      id: chargeId,
      address_id: addressId,
      orders_count: cycleNumber,   // 1 for first order, 2 for second, etc.
      scheduled_at: chargeDate,
      status,
    } = charge;

    // ── 3. Guard: only process 'success' charges ─────────────────────────
    if (status !== 'SUCCESS' && status !== 'success') {
      console.log(`[LTV] Skipping charge ${chargeId} — status: ${status}`);
      return;
    }

    // ── 4. Idempotency check ─────────────────────────────────────────────
    try {
      const processed = await hasBeenProcessed(chargeId);
      if (processed) {
        console.log(`[LTV] Charge ${chargeId} already processed — skipping`);
        return;
      }
      await markAsProcessed(chargeId);
    } catch (dbError) {
      console.error(`[LTV] Idempotency DB Error for charge ${chargeId}:`, dbError);
      return; // Stop processing if we can't guarantee idempotency
    }

    // ── 5. Determine which gift cycle we are on ──────────────────────────
    // Note: If cycleNumber is 1, the new logic says we skip backend injection
    // and rely on frontend logic. But if cycleNumber is 1, it means order 1
    // just succeeded, so the NEXT charge will be order 2 (Cycle 2 gifts).
    // WAIT: The spec says: "If charge/paid fires and orders_count === 1, 
    // you inject Cycle 2's variants into the next scheduled charge."
    
    // So if orders_count = N, we inject the gifts for Cycle N+1 into the next charge.
    const targetCycle = cycleNumber + 1;
    
    if (targetCycle > MAX_CYCLE) {
      console.log(`[LTV] Charge ${chargeId} — target cycle ${targetCycle} outside ladder range`);
      return;
    }

    const variantIds = LTV_LADDER[targetCycle];
    if (!variantIds || variantIds.length === 0) {
      console.log(`[LTV] No variants mapped for cycle ${targetCycle}`);
      return;
    }

    // ── 6. Calculate next charge date (same date as current charge — ──────
    //       Recharge attaches it to the NEXT queued charge for that address)
    const nextChargeDate = chargeDate
      ? chargeDate.split('T')[0]   // "2025-08-15T00:00:00" → "2025-08-15"
      : new Date().toISOString().split('T')[0];

    // ── 7. Inject all variants as $0.00 onetimes ─────────────────────────
    console.log(`[LTV] Processing charge ${chargeId} | orders_count ${cycleNumber} | targeting Cycle ${targetCycle} gifts`);
    console.log(`[LTV] Address ${addressId} | Injecting variants: ${variantIds.join(', ')}`);

    const results = await Promise.allSettled(
      variantIds.map((variantId) =>
        injectOnetime(addressId, variantId, nextChargeDate)
      )
    );

    // ── 8. Log results ────────────────────────────────────────────────────
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        console.log(`[LTV] ✓ Injected variant ${variantIds[i]} → onetime ID: ${result.value.onetime?.id}`);
      } else {
        console.error(`[LTV] ✗ Failed to inject variant ${variantIds[i]}:`, result.reason?.response?.data || result.reason?.message);
      }
    });
  }
);

export default router;
