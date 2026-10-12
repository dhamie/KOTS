/** Family roles, highest rank first. */
export const FAMILY_ROLES = [
  "don",
  "underboss",
  "consigliere",
  "capo",
  "enforcer",
  "fixer",
  "quartermaster",
  "associate",
] as const;
export type FamilyRole = (typeof FAMILY_ROLES)[number];

/** A member can only manage members of strictly lower rank, and only assign roles below their own. */
export const ROLE_RANK: Record<FamilyRole, number> = {
  don: 100,
  underboss: 80,
  consigliere: 70,
  capo: 50,
  enforcer: 30,
  fixer: 30,
  quartermaster: 30,
  associate: 10,
};

/** Only permissions that some feature checks today. */
export const FAMILY_PERMISSIONS = [
  "members.invite",
  "members.kick",
  "members.manage_roles",
  "activity.view",
  "family.disband",
  "territory.claim",
  "territory.abandon",
  "treasury.view",
  "henchmen.recruit",
  "henchmen.assign",
  "henchmen.dismiss",
  "market.trade",
  "trade.propose",
  "trade.accept",
  "diplomacy.talk",
  "diplomacy.propose",
  "diplomacy.sign",
  "war.declare",
  "war.command",
] as const;
export type FamilyPermission = (typeof FAMILY_PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<FamilyRole, readonly FamilyPermission[]> = {
  don: FAMILY_PERMISSIONS,
  underboss: [
    "members.invite",
    "members.kick",
    "members.manage_roles",
    "activity.view",
    "territory.claim",
    "territory.abandon",
    "treasury.view",
    "henchmen.recruit",
    "henchmen.assign",
    "henchmen.dismiss",
    "market.trade",
    "trade.propose",
    "trade.accept",
    "diplomacy.talk",
    "diplomacy.propose",
    "diplomacy.sign",
    "war.declare",
    "war.command",
  ],
  // The Consigliere negotiates: talks and proposes, but can't commit the family.
  consigliere: ["members.invite", "activity.view", "treasury.view", "diplomacy.talk", "diplomacy.propose"],
  capo: ["members.invite", "members.kick", "activity.view", "territory.claim", "henchmen.recruit", "henchmen.assign", "war.command"],
  enforcer: ["activity.view", "war.command"],
  fixer: ["activity.view"],
  quartermaster: ["activity.view", "treasury.view", "henchmen.recruit", "market.trade", "trade.propose", "trade.accept"],
  associate: ["activity.view"],
};

/** Role given to a player who accepts an invitation. */
export const NEW_MEMBER_ROLE: FamilyRole = "associate";
/** Role the old Don takes after transferring leadership. */
export const FORMER_DON_ROLE: FamilyRole = "underboss";

/** How long an invitation stays open. */
export const INVITATION_TTL_DAYS = 7;
