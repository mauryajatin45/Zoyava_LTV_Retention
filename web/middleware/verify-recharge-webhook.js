import crypto from 'crypto';
import dotenv from 'dotenv';
import { logger } from '../services/logger.js';
dotenv.config();

const TAG = '[RechargeWebhook]';

/**
 * Express middleware that:
 * 1. Reads req.rawBody (set by the raw-body capture middleware in index.js).
 * 2. Validates HMAC-SHA256 signature from Recharge.
 *    In Recharge API v2021-11, the HMAC secret IS the API token (sk_1x1_...).
 *    Both RECHARGE_API_TOKEN and RECHARGE_WEBHOOK_SECRET should have the same value.
 * 3. Parses JSON body and attaches it to req.body.
 */
export function verifyRechargeWebhook(req, res, next) {
  logger.info(TAG, `Incoming ${req.method} ${req.url}`);

  // ── 1. Ensure raw body was captured by the upstream middleware ────────────
  const rawBody = req.rawBody;
  if (!rawBody || rawBody.length === 0) {
    logger.error(TAG, 'req.rawBody is missing — check raw-body capture middleware in index.js');
    return res.status(400).json({ error: 'Raw body missing' });
  }
  logger.debug(TAG, `Raw body captured — ${rawBody.length} bytes`);

  // ── 2. HMAC Validation (ENFORCED) ─────────────────────────────────────────
  const signature = req.headers['x-recharge-hmac-sha256'];
  const secret    = process.env.RECHARGE_WEBHOOK_SECRET;

  if (!signature) {
    logger.error(TAG, 'Rejected — missing X-Recharge-Hmac-Sha256 header');
    return res.status(401).json({ error: 'Missing HMAC signature' });
  }

  if (!secret) {
    logger.error(TAG, 'RECHARGE_WEBHOOK_SECRET not set in .env — cannot verify webhook');
    return res.status(500).json({ error: 'Server misconfiguration: missing webhook secret' });
  }

  // Recharge may send HMAC as hex OR base64 depending on API version.
  // Detect format: if it only contains [0-9a-f] and is 64 chars, it's hex.
  const isHex = /^[0-9a-f]{64}$/i.test(signature);
  const sigEncoding = isHex ? 'hex' : 'base64';

  logger.debug(TAG, `Signature format detected: ${sigEncoding}`, { signatureLength: signature.length });

  // Try verification with the primary secret (RECHARGE_WEBHOOK_SECRET)
  // and fallback to RECHARGE_API_TOKEN if it fails.
  const secretsToTry = [secret];
  if (process.env.RECHARGE_API_TOKEN && process.env.RECHARGE_API_TOKEN !== secret) {
    secretsToTry.push(process.env.RECHARGE_API_TOKEN);
  }

  let valid = false;
  let matchedSecret = null;
  let matchedMethod = null;

  for (const trySecret of secretsToTry) {
    // Method 1: Standard HMAC-SHA256 (What they should do)
    const hmacExpected = crypto
      .createHmac('sha256', trySecret)
      .update(rawBody)
      .digest(sigEncoding);

    // Method 2: Recharge Legacy Quirky SHA256(secret + body) (What their docs say they do for the legacy header)
    // "concatenating the API Client Secret with the JSON-stringified request body and hashing the result with SHA-256"
    const legacyString = trySecret + rawBody.toString('utf8');
    const legacyExpected = crypto
      .createHash('sha256')
      .update(legacyString, 'utf8')
      .digest(sigEncoding);

    const candidates = [
      { value: hmacExpected, method: 'Standard HMAC' },
      { value: legacyExpected, method: 'Legacy SHA256(secret+body)' }
    ];

    for (const candidate of candidates) {
      try {
        const sigBuffer      = Buffer.from(signature,    sigEncoding);
        const expectedBuffer = Buffer.from(candidate.value, sigEncoding);
        if (
          sigBuffer.length === expectedBuffer.length &&
          crypto.timingSafeEqual(sigBuffer, expectedBuffer)
        ) {
          valid = true;
          matchedSecret = trySecret === secret ? 'RECHARGE_WEBHOOK_SECRET' : 'RECHARGE_API_TOKEN';
          matchedMethod = candidate.method;
          break;
        }
      } catch {
        // continue
      }
    }
    
    if (valid) break;
  }

  if (!valid) {
    // Log what we received vs expected for debugging
    const hmacHex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const legacyHex = crypto.createHash('sha256').update(secret + rawBody.toString('utf8'), 'utf8').digest('hex');
    logger.error(TAG, 'Rejected — HMAC signature does not match', {
      received: signature,
      receivedFormat: sigEncoding,
      expectedStandardHmacHex: hmacHex,
      expectedLegacyHashHex: legacyHex,
    });
    return res.status(401).json({ error: 'Invalid HMAC signature' });
  }

  logger.info(TAG, `✓ HMAC verified (matched via ${matchedSecret}, method: ${matchedMethod})`);

  // ── 3. Parse the body ─────────────────────────────────────────────────────
  try {
    req.body = JSON.parse(rawBody.toString('utf8'));
    logger.debug(TAG, 'Body parsed', { keys: Object.keys(req.body) });
  } catch (e) {
    logger.error(TAG, 'Invalid JSON in request body', { error: e.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  next();
}
