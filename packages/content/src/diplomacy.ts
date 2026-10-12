/** Diplomacy rooms and proposals. See docs/CHAT.md. */
export const DIPLOMACY = {
  /** An unsigned proposal expires after this long. */
  proposalTtlHours: 48,
  /** Most open proposals between two families, counting both directions. */
  maxOpenPerPair: 5,
  /** Most a territory transfer can cost the receiving family. */
  maxPrice: 10_000_000,
  /** The ceasefire lengths a proposal can ask for. */
  ceasefireHours: [24, 72, 168],
} as const;

export const PROPOSAL_KINDS = ["territory_transfer", "ceasefire"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
