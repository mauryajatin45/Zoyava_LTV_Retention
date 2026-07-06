import axios from 'axios';
import { logger } from './logger.js';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') }); 

const TAG = '[Klaviyo API]';
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;

/**
 * Fires a custom event to Klaviyo using the Create Event API (revision 2024-02-15).
 * @param {string} email - Customer email
 * @param {string} metricName - Name of the custom event (e.g. 'starter_kit_purchased', 'upcoming_gift_preview')
 * @param {object} properties - Custom properties to attach to the event
 * @param {object} profileData - Optional additional profile fields (e.g. first_name)
 */
export async function trackKlaviyoEvent(email, metricName, properties = {}, profileData = {}) {
  if (!KLAVIYO_API_KEY) {
    logger.warn(TAG, 'KLAVIYO_API_KEY is not defined in .env. Skipping event tracking.');
    return false;
  }

  if (!email) {
    logger.error(TAG, `Cannot track event "${metricName}" - missing email`);
    return false;
  }

  const payload = {
    data: {
      type: "event",
      attributes: {
        properties: properties,
        time: new Date().toISOString(),
        metric: {
          data: {
            type: "metric",
            attributes: {
              name: metricName
            }
          }
        },
        profile: {
          data: {
            type: "profile",
            attributes: {
              email: email,
              ...profileData
            }
          }
        }
      }
    }
  };

  try {
    const response = await axios.post('https://a.klaviyo.com/api/events/', payload, {
      headers: {
        'Authorization': `Klaviyo-API-Key ${KLAVIYO_API_KEY}`,
        'accept': 'application/json',
        'content-type': 'application/json',
        'revision': '2024-02-15'
      }
    });
    
    logger.info(TAG, `Successfully tracked "${metricName}" for ${email}`);
    return true;
  } catch (err) {
    const errorDetails = err.response?.data?.errors || err.message;
    logger.error(TAG, `Failed to track "${metricName}" for ${email}`, { error: errorDetails });
    return false;
  }
}
