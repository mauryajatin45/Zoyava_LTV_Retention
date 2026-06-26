import crypto from 'crypto';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Express middleware that:
 * 1. Captures the raw request body buffer.
 * 2. Computes HMAC-SHA256 using RECHARGE_WEBHOOK_SECRET.
 * 3. Compares (timing-safe) against X-Recharge-Hmac-Sha256 header.
 * 4. Attaches parsed body to req.body on success.
 */
export function verifyRechargeWebhook(req, res, next) {
  const signature = req.headers['x-recharge-hmac-sha256'];

  if (!signature) {
    console.warn('[RechargeWebhook] Missing HMAC header');
    return res.status(401).json({ error: 'Missing HMAC signature' });
  }

  // rawBody is populated by the express.raw() middleware mounted BEFORE this
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error('[RechargeWebhook] Raw body not captured');
    return res.status(500).json({ error: 'Server misconfiguration: raw body missing' });
  }

  const secret = process.env.RECHARGE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[RechargeWebhook] RECHARGE_WEBHOOK_SECRET is not configured');
    return res.status(500).json({ error: 'Server misconfiguration: missing webhook secret' });
  }

  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');

  const sigBuffer = Buffer.from(signature, 'base64');
  const expectedBuffer = Buffer.from(expectedHmac, 'base64');

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    console.warn('[RechargeWebhook] HMAC mismatch — request rejected');
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  // Parse the body now that it's verified
  try {
    req.body = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  next();
}
