// Cycle → array of Shopify Variant IDs to inject as 0.00 onetimes
// Cycle 1 is skipped in backend logic per requirements, handled on frontend.
export const LTV_LADDER = {
  2: [48336838721777, 48336841441521],
  3: [48336856056049],
  4: [48336851009777, 48336854155505],
  5: [48336845046001],
  6: [48336855728369, 48336856056049],
};

// Max cycle tracked — beyond this, no gifts injected
export const MAX_CYCLE = 6;
