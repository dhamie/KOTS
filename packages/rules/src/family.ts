import { ECONOMY, ROLE_PERMISSIONS, ROLE_RANK, type FamilyPermission, type FamilyRole } from "@kots/content";

export type FamilyAction =
  | { kind: "invite" }
  | { kind: "view_activity" }
  | { kind: "disband" }
  | { kind: "transfer_leadership" }
  | { kind: "claim_territory" }
  | { kind: "abandon_territory" }
  | { kind: "view_treasury" }
  | { kind: "recruit_henchman" }
  | { kind: "assign_henchman" }
  | { kind: "dismiss_henchman" }
  | { kind: "trade_market" }
  | { kind: "propose_trade" }
  | { kind: "accept_trade" }
  | { kind: "diplomacy_talk" }
  | { kind: "diplomacy_propose" }
  | { kind: "diplomacy_sign" }
  | { kind: "declare_battle" }
  | { kind: "command_battle" }
  | { kind: "kick"; target: FamilyRole }
  | { kind: "set_role"; target: FamilyRole; newRole: FamilyRole };

export type FamilyCheck = { ok: true } | { ok: false; reason: "missing_permission" | "rank" | "invalid_role" };

export function hasPermission(role: FamilyRole, permission: FamilyPermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/** Whether a member with role `actor` may perform `action`. The single source of truth for family authorisation. */
export function checkFamilyAction(actor: FamilyRole, action: FamilyAction): FamilyCheck {
  const need = (permission: FamilyPermission): FamilyCheck =>
    hasPermission(actor, permission) ? { ok: true } : { ok: false, reason: "missing_permission" };
  const outranks = (target: FamilyRole) => ROLE_RANK[actor] > ROLE_RANK[target];

  switch (action.kind) {
    case "invite":
      return need("members.invite");
    case "view_activity":
      return need("activity.view");
    case "disband":
      return need("family.disband");
    case "transfer_leadership":
      return actor === "don" ? { ok: true } : { ok: false, reason: "missing_permission" };
    case "claim_territory":
      return need("territory.claim");
    case "abandon_territory":
      return need("territory.abandon");
    case "view_treasury":
      return need("treasury.view");
    case "recruit_henchman":
      return need("henchmen.recruit");
    case "assign_henchman":
      return need("henchmen.assign");
    case "dismiss_henchman":
      return need("henchmen.dismiss");
    case "trade_market":
      return need("market.trade");
    case "propose_trade":
      return need("trade.propose");
    case "accept_trade":
      return need("trade.accept");
    case "diplomacy_talk":
      return need("diplomacy.talk");
    case "diplomacy_propose":
      return need("diplomacy.propose");
    case "diplomacy_sign":
      return need("diplomacy.sign");
    case "declare_battle":
      return need("war.declare");
    case "command_battle":
      return need("war.command");
    case "kick": {
      const base = need("members.kick");
      if (!base.ok) return base;
      return outranks(action.target) ? base : { ok: false, reason: "rank" };
    }
    case "set_role": {
      const base = need("members.manage_roles");
      if (!base.ok) return base;
      if (!outranks(action.target)) return { ok: false, reason: "rank" };
      // The Don only changes through transfer_leadership; a role can't be "changed" to itself.
      if (action.newRole === "don" || action.newRole === action.target) return { ok: false, reason: "invalid_role" };
      return ROLE_RANK[action.newRole] < ROLE_RANK[actor] ? base : { ok: false, reason: "rank" };
    }
  }
}

export interface SuccessionCandidate {
  playerId: string;
  role: FamilyRole;
  joinedAtMs: number;
  lastActiveAtMs: number;
}

const INACTIVE_MS = ECONOMY.donInactiveDays * 24 * 60 * 60 * 1000;

export const isInactive = (lastActiveAtMs: number, nowMs: number) => nowMs - lastActiveAtMs >= INACTIVE_MS;

/**
 * Who takes over from an inactive Don: the highest-ranked member who is still active, earliest joiner on a tie.
 * Returns null while the Don is active, or when nobody else is.
 */
export function pickSuccessor(don: SuccessionCandidate, others: readonly SuccessionCandidate[], nowMs: number): string | null {
  if (!isInactive(don.lastActiveAtMs, nowMs)) return null;
  const active = others.filter((m) => m.role !== "don" && !isInactive(m.lastActiveAtMs, nowMs));
  active.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.joinedAtMs - b.joinedAtMs || (a.playerId < b.playerId ? -1 : 1));
  return active[0]?.playerId ?? null;
}
