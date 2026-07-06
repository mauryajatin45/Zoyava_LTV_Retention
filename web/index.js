// @ts-check
import { join } from 'path';
import { readFileSync } from 'fs';
import express from 'express';
import serveStatic from 'serve-static';
import { logger } from './services/logger.js';

// ── Global crash guards ────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.error('[FATAL]', 'Uncaught Exception — server will continue', {
    message: err.message,
    stack: err.stack,
  });
});

process.on('unhandledRejection', (reason) => {
  logger.error('[FATAL]', 'Unhandled Promise Rejection', { reason: String(reason) });
});

import shopify from './shopify.js';
import PrivacyWebhookHandlers from './privacy.js';
import webhookRoutes from './routes/webhooks.js';
import webhookRoutesV3 from './routes/webhooks-v3.js';
import webhookRoutesV4 from './routes/webhooks-v4.js';
import apiRoutes from './routes/api.js';
import { injectOnetime } from './services/recharge-api.js';
import { LTV_LADDER, MAX_CYCLE } from './services/ltv-config.js';
import { initDailyKlaviyoCron } from './cron/daily-upcoming-charges.js';

initDailyKlaviyoCron();

const PORT = parseInt(process.env.BACKEND_PORT || process.env.PORT || '3000', 10);

const STATIC_PATH =
  process.env.NODE_ENV === 'production'
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// ── Global Request Logger ──────────────────────────────────────────────────
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    logger.info('[HTTP]', `${req.method} ${req.url} → ${res.statusCode} (${ms}ms)`, { ip });
  });
  next();
});

// ── Shopify auth & webhooks ────────────────────────────────────────────────
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);

// ── Raw body capture — MUST come before express.json() and before webhook routes ──
app.use('/webhooks', (req, res, next) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', (err) => {
    logger.error('[RawBody]', 'Error reading request stream', { message: err.message });
    res.status(500).json({ error: 'Stream error' });
  });
});

// ── Recharge webhook routes (HMAC-validated, unauthenticated) ──────────────
app.use('/webhooks', webhookRoutes);
app.use('/webhooks/v3', webhookRoutesV3);
app.use('/webhooks/v4', webhookRoutesV4);

// ── JSON body parser for all other routes ─────────────────────────────────
app.use(express.json());

// ── Manual Gift Injection (recovery / testing endpoint) ────────────────────
// POST /inject-gifts  { addressId, cycleNumber, secretKey }
app.post('/inject-gifts', async (req, res) => {
  const TAG = '[ManualInject]';

  const { addressId, cycleNumber, secretKey } = req.body || {};

  if (secretKey !== 'zoyava-inject-2026') {
    logger.warn(TAG, 'Unauthorized inject attempt blocked');
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!addressId || cycleNumber === undefined) {
    return res.status(400).json({ error: 'addressId and cycleNumber are required' });
  }

  const targetCycle = parseInt(cycleNumber, 10) + 1;

  logger.section(TAG, `Manual inject triggered — addressId=${addressId} cycleNumber=${cycleNumber} → targetCycle=${targetCycle}`);

  if (targetCycle > MAX_CYCLE) {
    logger.info(TAG, `Cycle ${targetCycle} exceeds MAX_CYCLE (${MAX_CYCLE}) — nothing to inject`);
    return res.status(200).json({ message: `Cycle ${targetCycle} is beyond the gift ladder.` });
  }

  const variantIds = LTV_LADDER[targetCycle];
  if (!variantIds || variantIds.length === 0) {
    logger.warn(TAG, `No variants mapped in LTV_LADDER for cycle ${targetCycle}`);
    return res.status(200).json({ message: `No variants mapped for cycle ${targetCycle}` });
  }

  const nextChargeDate = new Date().toISOString().split('T')[0];
  logger.info(TAG, `Injecting ${variantIds.length} gift(s) for Cycle ${targetCycle}`, {
    addressId,
    variantIds,
    nextChargeDate,
  });

  const results = await Promise.allSettled(
    variantIds.map((variantId) => injectOnetime(addressId, variantId, nextChargeDate))
  );

  let successCount = 0;
  let failCount = 0;

  const report = results.map((result, i) => {
    if (result.status === 'fulfilled') {
      successCount++;
      const onetimeId = result.value.onetime?.id;
      logger.info(TAG, `✓ Gift injected`, { variantId: variantIds[i], onetimeId });
      return { variantId: variantIds[i], status: 'injected', onetimeId };
    } else {
      failCount++;
      const errDetail = result.reason?.response?.data || result.reason?.message;
      logger.error(TAG, `Failed to inject gift`, { variantId: variantIds[i], error: errDetail });
      return { variantId: variantIds[i], status: 'failed', error: errDetail };
    }
  });

  logger.info(TAG, `━━ Done: ${successCount} injected, ${failCount} failed ━━`);

  return res.status(200).json({ targetCycle, successCount, failCount, results: report });
});

// ── Shopify-authenticated API routes ──────────────────────────────────────
app.use('/api/*', shopify.validateAuthenticatedSession());
app.use('/api', apiRoutes);

// ── Static frontend & fallback ─────────────────────────────────────────────
app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use('/*', shopify.ensureInstalledOnShop(), async (_req, res) => {
  return res
    .status(200)
    .set('Content-Type', 'text/html')
    .send(
      readFileSync(join(STATIC_PATH, 'index.html'))
        .toString()
        .replace('%VITE_SHOPIFY_API_KEY%', process.env.SHOPIFY_API_KEY || '')
    );
});

app.listen(PORT, () => {
  logger.info('[Server]', `🚀 Zoyava LTV server running on port ${PORT}`, {
    env: process.env.NODE_ENV || 'development',
    port: PORT,
  });
});
