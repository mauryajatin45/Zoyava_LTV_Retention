// Target Product ID for Offer v4 in Shopify
export const TARGET_PRODUCT_ID_V4 = '9656359256305';

// Mapping of Shopify Variant IDs to Household Size (Kid Count N)
export const V4_VARIANT_TO_KIDS = {
  '48374448095473': 1, // 1 Kid
  '48374448128241': 2, // 2 Kid
  '48374448161009': 3, // 3 kid
  '48374449242353': 4, // 4 Kid
  '48374449471729': 5, // 5 Kid
};

// Cycle -> array of base Shopify Variant IDs to inject (multiplied by Kid Count N)
// Rebill 1 (Cycle 2 / Day 28): Water Bottle + Sticker Pack
// Rebill 2 (Cycle 3 / Month 3): Travel Gummies Tin
// Rebill 3 (Cycle 4 / Month 4): Coloring Book and Crayons
// Rebill 4 (Cycle 5 / Month 5): Insulated Lunch Box
// Rebill 5 (Cycle 6 / Month 6): Mini Backpack
export const LTV_LADDER_V4 = {
  2: [48336838721777, 48336841441521], // Water Bottle + Sticker Pack
  3: [48336856056049],                 // Travel Gummies Tin
  4: [48336851009777, 48336854155505], // Coloring Book + Crayons
  5: [48336845046001],                 // Insulated Lunch Box
  6: [48336855728369],                 // Mini Backpack
};

// Max cycle tracked
export const MAX_CYCLE_V4 = 6;
