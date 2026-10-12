/**
 * Economy tuning. All money is whole ₦. Formulas that use these live in packages/rules/src/economy.ts;
 * see docs/ECONOMY.md for what each value does.
 */
export const ECONOMY = {
  /** Paid into a new family's treasury when it is founded. */
  startingGrant: 20_000,
  /** Claim fee, in days of the territory's base upkeep. Waived while the family holds no territory. */
  claimFeeDays: 5,
  /** Each territory's upkeep rises by this fraction for every other territory the family holds. */
  upkeepGrowthPerTerritory: 0.1,
  /** Length of one upkeep period. */
  upkeepPeriodHours: 24,
  /** How long a territory can stay unpaid (neglected) before it returns to neutral. */
  graceHours: 48,
  /** A Don with no activity for this long is replaced by the most senior active member. */
  donInactiveDays: 7,
} as const;

/** Trades between families. See docs/ECONOMY.md. */
export const TRADES = {
  /** Both families must be at least this old to make or accept an offer, so throwaway families can't pass on their grants. */
  minFamilyAgeDays: 3,
  /** An open offer expires after this long. */
  offerTtlHours: 24,
  /** Most open offers a family can have out at once. */
  maxOpenOutgoing: 10,
  /** Most items (goods or cash) on each side of an offer. */
  maxLinesPerSide: 5,
  /** Most cash on one side of an offer. */
  maxCash: 10_000_000,
} as const;
