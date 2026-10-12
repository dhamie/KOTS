import { CITY, DIPLOMACY } from "@kots/content";
import { checkClaim } from "./economy";

export const PROPOSAL_TTL_MS = DIPLOMACY.proposalTtlHours * 60 * 60 * 1000;

/** What a proposal asks for. `giver` says which side hands the territory over; the other side pays `price`. */
export type ProposalTerms =
  | { kind: "territory_transfer"; territory: string; giver: "proposer" | "recipient"; price: number }
  | { kind: "ceasefire"; hours: number };

export type ProposalCheck = { ok: true } | { ok: false; reason: "unknown_territory" | "bad_price" | "bad_length" };

/** Whether the terms make sense on their own. Ownership, borders and money are checked against state when it runs. */
export function checkProposalTerms(terms: ProposalTerms): ProposalCheck {
  if (terms.kind === "ceasefire") {
    return (DIPLOMACY.ceasefireHours as readonly number[]).includes(terms.hours) ? { ok: true } : { ok: false, reason: "bad_length" };
  }
  if (!CITY.territories.has(terms.territory)) return { ok: false, reason: "unknown_territory" };
  if (!Number.isInteger(terms.price) || terms.price < 0 || terms.price > DIPLOMACY.maxPrice) return { ok: false, reason: "bad_price" };
  return { ok: true };
}

/** A family can receive a territory on the same terms as claiming it: it borders their land, or they hold none. */
export function canReceive(territory: string, receiverHeld: readonly string[]): boolean {
  return checkClaim(CITY.territories.get(territory)?.borders ?? [], receiverHeld).ok;
}
