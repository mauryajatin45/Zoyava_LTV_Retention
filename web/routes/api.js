import express from 'express';
import shopify from '../shopify.js';
import { LTV_LADDER } from '../services/ltv-config.js';

const router = express.Router();

// GET /api/ltv-config  →  Returns the LTV ladder JSON for the dashboard
router.get('/ltv-config', async (req, res) => {
  const session = res.locals?.shopify?.session;
  console.log(`[API] GET /ltv-config requested by shop: ${session?.shop || 'unknown'}`);
  
  if (!session) {
    return res.status(401).json({ error: 'No active session found.' });
  }

  try {
    // 1. Extract all unique variant IDs from the ladder
    const allVariantIds = new Set();
    Object.values(LTV_LADDER).forEach(variants => {
      variants.forEach(id => allVariantIds.add(id));
    });

    const idsArray = Array.from(allVariantIds);
    const gids = idsArray.map(id => `gid://shopify/ProductVariant/${id}`);

    // 2. Fetch live data via GraphQL Bulk Nodes query
    const client = new shopify.api.clients.Graphql({ session });
    const response = await client.request(`
      query getVariants($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on ProductVariant {
            id
            title
            product {
              title
              featuredImage {
                url
              }
            }
          }
        }
      }
    `, { variables: { ids: gids } });

    // 3. Map responses back to numerical IDs
    const variantDetails = {};
    const nodes = response?.data?.nodes || [];
    
    nodes.forEach((node, index) => {
      const numericId = idsArray[index];
      if (node) {
        variantDetails[numericId] = {
          variantTitle: node.title !== 'Default Title' ? node.title : null,
          productTitle: node.product?.title || 'Unknown Product',
          imageUrl: node.product?.featuredImage?.url || null
        };
      } else {
        variantDetails[numericId] = null; // Node is null if deleted from Shopify
      }
    });

    res.status(200).json({ ladder: LTV_LADDER, variantDetails });
  } catch (error) {
    console.error('[API] Error fetching variant details:', error);
    // Fallback gracefully so the UI still loads the ladder at least
    res.status(200).json({ ladder: LTV_LADDER, variantDetails: {} });
  }
});

export default router;
