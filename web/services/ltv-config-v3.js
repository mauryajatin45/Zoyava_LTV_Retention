// Target Product ID for Offer v3 in Shopify
export const TARGET_PRODUCT_ID_V3 = '9656256463089';

// Cycle -> array of Shopify Variant IDs to inject as 0.00 onetimes
// Rebill 1 (Cycle 2 / Day 50): Water Bottle + Sticker Pack
// Rebill 2 (Cycle 3 / Month 3): Travel Gummies Tin
// Rebill 3 (Cycle 4 / Month 4): Coloring Book and Crayons
// Rebill 4 (Cycle 5 / Month 5): Insulated Lunch Box
// Rebill 5 (Cycle 6 / Month 6): Mini Backpack
export const LTV_LADDER_V3 = {
  2: [48336838721777, 48336841441521], // Water Bottle + Sticker Pack
  3: [48336856056049],                 // Travel Gummies Tin
  4: [48336851009777, 48336854155505], // Coloring Book + Crayons
  5: [48336845046001],                 // Insulated Lunch Box
  6: [48336855728369],                 // Mini Backpack
};

// Max cycle tracked — beyond this, no gifts injected
export const MAX_CYCLE_V3 = 6;
