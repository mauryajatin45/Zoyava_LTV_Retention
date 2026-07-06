import cron from 'node-cron';
import { logger } from '../services/logger.js';
import { getUpcomingChargesByDate } from '../services/recharge-api.js';
import { TARGET_PRODUCT_ID_V3, LTV_LADDER_V3 } from '../services/ltv-config-v3.js';
import { TARGET_PRODUCT_ID_V4 } from '../services/ltv-config-v4.js';
import { trackKlaviyoEvent } from '../services/klaviyo-api.js';

const TAG = '[Daily CRON - Klaviyo Upcoming Emails]';

// Target time: 8:00 AM every day
const cronSchedule = '0 8 * * *'; 

export function initDailyKlaviyoCron() {
  logger.info(TAG, `Initializing Daily Klaviyo CRON Job: schedule = ${cronSchedule}`);
  
  cron.schedule(cronSchedule, async () => {
    logger.section(TAG, 'Starting daily scan for upcoming charges (7 days out)');

    try {
      // Calculate exactly 7 days from today
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 7);
      const targetDateString = targetDate.toISOString().split('T')[0];

      logger.info(TAG, `Looking for QUEUED charges on ${targetDateString}`);
      
      const charges = await getUpcomingChargesByDate(targetDateString);
      logger.info(TAG, `Found ${charges.length} queued charges for ${targetDateString}`);

      let processedCount = 0;

      for (const charge of charges) {
        // Skip charges that don't have basic required fields
        if (!charge || !charge.email) continue;

        const {
          email,
          orders_count: currentCycle,
          line_items
        } = charge;

        // Determine if this charge includes V3 or V4 main products
        const isV3 = line_items.some(item => 
          String(item.external_product_id) === TARGET_PRODUCT_ID_V3 ||
          String(item.shopify_product_id) === TARGET_PRODUCT_ID_V3
        );

        const isV4 = line_items.some(item => 
          String(item.external_product_id) === TARGET_PRODUCT_ID_V4 ||
          String(item.shopify_product_id) === TARGET_PRODUCT_ID_V4
        );

        if (!isV3 && !isV4) continue;

        const targetCycle = currentCycle + 1; // The rebill they are about to hit

        const profileData = {
          first_name: charge.customer?.first_name || charge.first_name || '',
          last_name: charge.customer?.last_name || charge.last_name || ''
        };

        if (isV3) {
          // V3 Logic: Check if the upcoming cycle has a gift in the ladder
          const hasGift = (LTV_LADDER_V3[targetCycle] && LTV_LADDER_V3[targetCycle].length > 0);
          
          if (hasGift) {
            await trackKlaviyoEvent(email, 'upcoming_gift_preview', { offer: 'v3', cycle: targetCycle }, profileData);
          } else {
            await trackKlaviyoEvent(email, 'upcoming_standard_rebill', { offer: 'v3', cycle: targetCycle }, profileData);
          }
          processedCount++;
        } 
        else if (isV4) {
          // V4 Logic: The critical Rebill 1 (Day 28) hits when targetCycle === 2
          // This cron runs 7 days prior (Day 21). We MUST fire the gift preview for the water bottle.
          if (targetCycle === 2) {
            await trackKlaviyoEvent(email, 'upcoming_gift_preview', { offer: 'v4', cycle: targetCycle }, profileData);
            processedCount++;
          }
          // For future cycles, can also send standard rebills if needed
          else {
            await trackKlaviyoEvent(email, 'upcoming_standard_rebill', { offer: 'v4', cycle: targetCycle }, profileData);
            processedCount++;
          }
        }
      }

      logger.info(TAG, `Daily CRON complete. Processed ${processedCount} relevant upcoming charges.`);
    } catch (err) {
      logger.error(TAG, 'Error executing daily CRON job', { error: err.message });
    }
  });
}
