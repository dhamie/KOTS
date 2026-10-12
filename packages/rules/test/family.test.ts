import { FAMILY_ROLES, ROLE_RANK, type FamilyRole } from "@kots/content";
import { describe, expect, it } from "vitest";
import { checkFamilyAction, pickSuccessor, type SuccessionCandidate } from "../src";

const allowed = (actor: FamilyRole, action: Parameters<typeof checkFamilyAction>[1]) => checkFamilyAction(actor, action).ok;

describe("checkFamilyAction", () => {
  it("lets every member view activity", () => {
    for (const role of FAMILY_ROLES) expect(allowed(role, { kind: "view_activity" })).toBe(true);
  });

  it("limits inviting to don, underboss, consigliere and capo", () => {
    const inviters = FAMILY_ROLES.filter((r) => allowed(r, { kind: "invite" }));
    expect(inviters).toEqual(["don", "underboss", "consigliere", "capo"]);
  });

  it("only the don can disband or transfer leadership", () => {
    for (const role of FAMILY_ROLES) {
      expect(allowed(role, { kind: "disband" })).toBe(role === "don");
      expect(allowed(role, { kind: "transfer_leadership" })).toBe(role === "don");
    }
  });

  it("kick needs the permission and a strictly lower-ranked target", () => {
    for (const actor of FAMILY_ROLES) {
      for (const target of FAMILY_ROLES) {
        const expected = ["don", "underboss", "capo"].includes(actor) && ROLE_RANK[actor] > ROLE_RANK[target];
        expect(allowed(actor, { kind: "kick", target }), `${actor} kicks ${target}`).toBe(expected);
      }
    }
  });

  it("nobody can kick the don, and equal ranks can't kick each other", () => {
    for (const actor of FAMILY_ROLES) expect(allowed(actor, { kind: "kick", target: "don" })).toBe(false);
    expect(allowed("enforcer", { kind: "kick", target: "fixer" })).toBe(false);
  });

  it("set_role: permission, outranks target, new role below actor, never don, never unchanged", () => {
    for (const actor of FAMILY_ROLES) {
      for (const target of FAMILY_ROLES) {
        for (const newRole of FAMILY_ROLES) {
          const expected =
            ["don", "underboss"].includes(actor) &&
            ROLE_RANK[actor] > ROLE_RANK[target] &&
            ROLE_RANK[actor] > ROLE_RANK[newRole] &&
            newRole !== "don" &&
            newRole !== target;
          expect(allowed(actor, { kind: "set_role", target, newRole }), `${actor}: ${target} -> ${newRole}`).toBe(expected);
        }
      }
    }
  });

  it("explains why an action is refused", () => {
    expect(checkFamilyAction("associate", { kind: "kick", target: "associate" })).toEqual({ ok: false, reason: "missing_permission" });
    expect(checkFamilyAction("capo", { kind: "kick", target: "underboss" })).toEqual({ ok: false, reason: "rank" });
    expect(checkFamilyAction("underboss", { kind: "set_role", target: "capo", newRole: "underboss" })).toEqual({ ok: false, reason: "rank" });
    expect(checkFamilyAction("don", { kind: "set_role", target: "capo", newRole: "don" })).toEqual({ ok: false, reason: "invalid_role" });
  });
});

describe("territory and treasury permissions", () => {
  it("claiming is for don, underboss and capo; abandoning for don and underboss", () => {
    expect(FAMILY_ROLES.filter((r) => allowed(r, { kind: "claim_territory" }))).toEqual(["don", "underboss", "capo"]);
    expect(FAMILY_ROLES.filter((r) => allowed(r, { kind: "abandon_territory" }))).toEqual(["don", "underboss"]);
  });

  it("treasury history is for don, underboss, consigliere and quartermaster", () => {
    expect(FAMILY_ROLES.filter((r) => allowed(r, { kind: "view_treasury" }))).toEqual(["don", "underboss", "consigliere", "quartermaster"]);
  });
});

describe("pickSuccessor", () => {
  const DAY = 24 * 3600_000;
  const now = 100 * DAY;
  const member = (playerId: string, role: FamilyRole, joinedDay: number, activeDay: number): SuccessionCandidate => ({
    playerId,
    role,
    joinedAtMs: joinedDay * DAY,
    lastActiveAtMs: activeDay * DAY,
  });
  const idleDon = member("don", "don", 1, 93);

  it("keeps a Don who was active within 7 days", () => {
    expect(pickSuccessor(member("don", "don", 1, 93.5), [member("a", "underboss", 2, 99)], now)).toBeNull();
  });

  it("picks the highest-ranked active member, earliest joiner on a tie", () => {
    const others = [member("cap1", "capo", 3, 99), member("cap2", "capo", 2, 99), member("ub", "underboss", 5, 90)];
    // The underboss is inactive too, so the earlier capo wins.
    expect(pickSuccessor(idleDon, others, now)).toBe("cap2");
    expect(pickSuccessor(idleDon, [...others, member("ub2", "underboss", 9, 98)], now)).toBe("ub2");
  });

  it("returns null when nobody else is active", () => {
    expect(pickSuccessor(idleDon, [member("a", "associate", 2, 80)], now)).toBeNull();
    expect(pickSuccessor(idleDon, [], now)).toBeNull();
  });
});
