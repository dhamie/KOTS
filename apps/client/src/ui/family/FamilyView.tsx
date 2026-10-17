import { CITY, FAMILY_ROLES, ROLE_RANK, type FamilyRole, type GoodKey } from "@kots/content";
import { checkFamilyAction, goodDef } from "@kots/rules";
import type { ActivityEntry, BattleSummary, FamilyDetail, FamilyHoldings, Invitation, Inventory, LedgerEntry, MeResponse } from "@kots/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/http";
import { naira, when } from "../format";
import { useAction } from "../useAction";

type MyFamily = NonNullable<MeResponse["family"]>;

const ROLE_LABEL: Record<FamilyRole, string> = {
  don: "Don",
  underboss: "Underboss",
  consigliere: "Consigliere",
  capo: "Capo",
  enforcer: "Enforcer",
  fixer: "Fixer",
  quartermaster: "Quartermaster",
  associate: "Associate",
};

/** The member's view of their family. Controls are hidden when the shared rules say no; the server re-checks everything. */
export function FamilyView(props: {
  me: MeResponse;
  family: MyFamily;
  revision: number;
  onChanged: () => void;
  onSelectTerritory: (slug: string) => void;
  onOpenBattle: (id: string) => void;
}) {
  const { me, family, revision, onChanged, onSelectTerritory, onOpenBattle } = props;
  const [detail, setDetail] = useState<FamilyDetail | null>(null);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [balance, setBalance] = useState<number | null>(null);
  const [holdings, setHoldings] = useState<FamilyHoldings | null>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [battles, setBattles] = useState<BattleSummary[]>([]);
  const { busy, error, run } = useAction();
  const myRole = family.role;
  const canInvite = checkFamilyAction(myRole, { kind: "invite" }).ok;
  const canViewTreasury = checkFamilyAction(myRole, { kind: "view_treasury" }).ok;

  const load = useCallback(
    () =>
      run(async () => {
        const [d, a, i, t, h, e, inv, bs] = await Promise.all([
          api.family(family.id),
          api.activity(family.id),
          canInvite ? api.familyInvitations(family.id) : Promise.resolve([]),
          api.treasury(family.id),
          api.holdings(family.id),
          canViewTreasury ? api.treasuryEntries(family.id) : Promise.resolve(null),
          api.inventory(family.id),
          api.battles(family.id),
        ]);
        setDetail(d);
        setActivity(a.items);
        setInvitations(i);
        setBalance(t.balance);
        setHoldings(h);
        setEntries(e?.items ?? []);
        setInventory(inv);
        setBattles(bs);
      }),
    [family.id, canInvite, canViewTreasury],
  );

  // `revision` changes when something elsewhere (a claim on the map) touched the family's money or land.
  useEffect(() => {
    void load();
  }, [load, revision]);

  /** Runs a change, then reloads; reloads `me` too when the change can affect my own role or membership. */
  const act = async (action: () => Promise<unknown>, affectsMe = false) => {
    if (!(await run(action))) return;
    if (affectsMe) onChanged();
    else void load();
  };

  return (
    <section className="panel side" aria-label="My family">
      <h2>
        {family.name} <span className="tag">[{family.tag}]</span>
      </h2>
      <p className="muted">
        You are {ROLE_LABEL[myRole]} · {detail?.members.length ?? "…"} members{" "}
        <button type="button" className="link" onClick={() => void load()} disabled={busy}>
          refresh
        </button>
      </p>
      {error && <p className="error">{error}</p>}

      <h3>Treasury</h3>
      <p>
        <strong data-testid="treasury-balance">{balance === null ? "…" : naira(balance)}</strong>
        {holdings && holdings.territories.length > 0 && (
          <span className="muted">
            {" "}
            · {naira(holdings.income)} in, {naira(holdings.upkeep)} upkeep a day
          </span>
        )}
      </p>
      {holdings && holdings.territories.length === 0 && <p className="muted small">No territory yet. Pick a neutral territory on the map to claim it.</p>}
      <ul className="list" data-testid="holdings">
        {holdings?.territories.map((h) => (
          <li key={h.slug}>
            <button type="button" className="link" onClick={() => onSelectTerritory(h.slug)}>
              {CITY.territories.get(h.slug)?.name ?? h.slug}
            </button>
            <span className={h.state === "neglected" ? "warn small" : "muted small"}>{h.state === "neglected" ? "upkeep overdue" : `paid to ${when(h.paidUntil)}`}</span>
          </li>
        ))}
      </ul>
      {canViewTreasury && entries.length > 0 && (
        <details>
          <summary className="small">Recent transactions</summary>
          <ul className="list activity" data-testid="ledger">
            {entries.map((e) => (
              <li key={e.id}>
                <span>{describeEntry(e)}</span>
                <span className={e.amount < 0 ? "warn" : ""}>{naira(e.amount)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {battles.length > 0 && (
        <>
          <h3>Battles</h3>
          <ul className="list" data-testid="battles">
            {battles.slice(0, 5).map((b) => {
              const enemy = b.mySide === "attacker" ? b.defender : b.attacker;
              const live = b.status === "preparing" || b.status === "active";
              return (
                <li key={b.id}>
                  <span>
                    {b.territory.name} <span className="muted small">{b.mySide === "attacker" ? "against" : "defending against"} [{enemy.tag}]</span>
                  </span>
                  <span>
                    <span className={live ? "contested small" : "muted small"}>
                      {live ? (b.status === "preparing" ? "preparing" : `round ${b.currentRound + 1}`) : b.status === "cancelled" ? "called off" : b.winner === b.mySide ? "won" : "lost"}
                    </span>
                    <button type="button" onClick={() => onOpenBattle(b.id)}>
                      Open
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <h3>Goods</h3>
      {inventory && (
        <p className="muted small" data-testid="storage">
          Storage {inventory.used}/{inventory.capacity} units{inventory.used > inventory.capacity && " · over capacity: sell before buying more"}
        </p>
      )}
      {inventory && inventory.items.length === 0 && <p className="muted small">Nothing in storage. Buy goods at a market.</p>}
      <ul className="list" data-testid="inventory">
        {inventory?.items.map((i) => (
          <li key={i.good}>
            <span>{goodDef(i.good).label}</span>
            <span>{i.quantity}</span>
          </li>
        ))}
      </ul>

      <h3>Members</h3>
      <ul className="list" data-testid="members">
        {detail?.members.map((m) => {
          const isMe = m.playerId === me.player.id;
          const roleOptions = FAMILY_ROLES.filter((r) => r === m.role || checkFamilyAction(myRole, { kind: "set_role", target: m.role, newRole: r }).ok);
          const canKick = !isMe && checkFamilyAction(myRole, { kind: "kick", target: m.role }).ok;
          const canMakeDon = !isMe && checkFamilyAction(myRole, { kind: "transfer_leadership" }).ok;
          return (
            <li key={m.playerId}>
              <span>
                <strong>{m.handle}</strong>
                {isMe && <span className="muted"> (you)</span>}
              </span>
              <span>
                {roleOptions.length > 1 && !isMe ? (
                  <select
                    aria-label={`Role of ${m.handle}`}
                    value={m.role}
                    disabled={busy}
                    onChange={(e) => void act(() => api.setRole(family.id, m.playerId, e.target.value as FamilyRole))}
                  >
                    {roleOptions
                      .sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])
                      .map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                  </select>
                ) : (
                  <span className="role">{ROLE_LABEL[m.role]}</span>
                )}
                {canKick && (
                  <button type="button" disabled={busy} onClick={() => confirm(`Kick ${m.handle}?`) && void act(() => api.kick(family.id, m.playerId))}>
                    Kick
                  </button>
                )}
                {canMakeDon && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => confirm(`Make ${m.handle} the Don? You become Underboss.`) && void act(() => api.transferLeadership(family.id, m.playerId), true)}
                  >
                    Make Don
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      {canInvite && <InviteForm familyId={family.id} invitations={invitations} busy={busy} act={act} />}

      <h3>Activity</h3>
      <ul className="list activity" data-testid="activity">
        {activity.map((a) => (
          <li key={a.id}>
            <span>{describe(a)}</span>
            <span className="muted">{new Date(a.createdAt).toLocaleString()}</span>
          </li>
        ))}
      </ul>

      <div className="danger">
        {myRole === "don" ? (
          <button type="button" disabled={busy} onClick={() => confirm("Disband the family? This can't be undone.") && void act(() => api.disband(family.id), true)}>
            Disband family
          </button>
        ) : (
          <button type="button" disabled={busy} onClick={() => confirm("Leave the family?") && void act(() => api.leave(family.id), true)}>
            Leave family
          </button>
        )}
      </div>
    </section>
  );
}

function InviteForm(props: { familyId: string; invitations: Invitation[]; busy: boolean; act: (a: () => Promise<unknown>) => Promise<void> }) {
  const [handle, setHandle] = useState("");
  const { familyId, invitations, busy, act } = props;

  async function submit(e: FormEvent) {
    e.preventDefault();
    await act(() => api.invite(familyId, handle));
    setHandle("");
  }

  return (
    <>
      <h3>Invite</h3>
      <form className="inline" onSubmit={submit}>
        <input aria-label="Handle to invite" placeholder="handle" required value={handle} onChange={(e) => setHandle(e.target.value)} />
        <button type="submit" disabled={busy}>
          Invite
        </button>
      </form>
      <ul className="list">
        {invitations.map((inv) => (
          <li key={inv.id}>
            <span>
              {inv.player.handle} <span className="muted">pending</span>
            </span>
            <button type="button" disabled={busy} onClick={() => void act(() => api.revokeInvitation(familyId, inv.id))}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

const placeName = (slug: string | undefined) => (slug && CITY.territories.get(slug)?.name) ?? slug ?? "a territory";

function describeEntry(e: LedgerEntry): string {
  const place = e.ref?.type === "territory" ? placeName(e.ref.id) : "";
  switch (e.reason) {
    case "starting_grant":
      return "Starting grant";
    case "territory_claim":
      return `Claimed ${place}`;
    case "territory_income":
      return `Income: ${place}`;
    case "territory_upkeep":
      return `Upkeep: ${place}`;
    case "recruitment":
      return "Hired a henchman";
    case "wage":
      return "Henchman wage";
    case "market_purchase":
      return "Market purchase";
    case "market_sale":
      return "Market sale";
    case "trade":
      return "Trade with another family";
    case "territory_transfer":
      return `Transfer: ${place}`;
    case "battle_fee":
      return `Declared battle: ${place}`;
    case "battle_refund":
      return `Battle called off, fee refunded: ${place}`;
    case "event_windfall":
      return "Street festival";
    case "admin_adjustment":
      return "Adjusted by an administrator";
    default:
      return e.reason.replace(/_/g, " ");
  }
}

const items = (list: string[] | undefined) => (list && list.length > 0 ? list.join(", ") : "nothing");

function describe(a: ActivityEntry): string {
  const who = a.actor?.handle ?? "Someone";
  const p = a.payload as {
    handle?: string;
    name?: string;
    from?: FamilyRole;
    to?: FamilyRole;
    formerDon?: string;
    cost?: number;
    slug?: string;
    market?: string;
    good?: GoodKey;
    quantity?: number;
    total?: number;
    with?: string;
    gives?: string[];
    wants?: string[];
    summary?: string;
    direction?: "in" | "out";
    price?: number;
    hours?: number;
    fee?: number;
    round?: number;
    outcome?: "won" | "lost" | "draw";
    side?: "attacker" | "defender";
    reason?: string | null;
    refunded?: number;
    district?: string;
    amount?: number;
    territories?: number;
    henchmen?: number;
    morale?: number;
  };
  switch (a.type) {
    case "family.created":
      return `${who} founded ${p.name}`;
    case "member.invited":
      return `${who} invited ${p.handle}`;
    case "member.joined":
      return `${who} joined`;
    case "member.left":
      return `${who} left`;
    case "member.kicked":
      return `${who} kicked ${p.handle}`;
    case "member.role_changed":
      return `${who} made ${p.handle} ${p.to ? ROLE_LABEL[p.to] : "?"}`;
    case "leadership.transferred":
      return `${who} handed leadership to ${p.handle}`;
    case "invitation.revoked":
      return `${who} revoked an invitation`;
    case "invitation.declined":
      return `${who} declined an invitation`;
    case "leadership.succeeded":
      return `${p.handle} took over as Don from ${p.formerDon}, who had been inactive`;
    case "territory.claimed":
      return `${who} claimed ${p.name} for ${naira(p.cost ?? 0)}`;
    case "territory.abandoned":
      return `${who} abandoned ${p.name}`;
    case "territory.neglected":
      return `Upkeep on ${p.name} is overdue`;
    case "territory.lost":
      return `${p.name} was lost: upkeep went unpaid`;
    case "henchman.hired":
      return `${who} hired ${p.name} for ${naira(p.cost ?? 0)}`;
    case "henchman.assigned":
      return `${who} posted ${p.name} to ${placeName(p.slug)}`;
    case "henchman.unassigned":
      return `${who} stood ${p.name} down`;
    case "henchman.dismissed":
      return `${who} dismissed ${p.name}`;
    case "henchman.unpaid":
      return `${p.name}'s wages are overdue`;
    case "henchman.deserted":
      return `${p.name} walked out: wages went unpaid`;
    case "market.bought":
      return `${who} bought ${p.quantity} ${p.good ? goodDef(p.good).label.toLowerCase() : "goods"} at ${placeName(p.market)} for ${naira(p.total ?? 0)}`;
    case "market.sold":
      return `${who} sold ${p.quantity} ${p.good ? goodDef(p.good).label.toLowerCase() : "goods"} at ${placeName(p.market)} for ${naira(p.total ?? 0)}`;
    case "trade.offered":
      return `${who} offered [${p.with}] ${items(p.gives)} for ${items(p.wants)}`;
    case "trade.received":
      return `${who} of [${p.with}] offered ${items(p.gives)} for ${items(p.wants)}`;
    case "trade.executed":
      return `Traded ${items(p.gives)} for ${items(p.wants)} with [${p.with}] (accepted by ${who})`;
    case "trade.declined":
      return `${who} declined a trade with [${p.with}]`;
    case "trade.cancelled":
      return `${who} cancelled a trade with [${p.with}]`;
    case "trade.expired":
      return `A trade offer with [${p.with}] expired`;
    case "proposal.made":
      return `${who} proposed to [${p.with}]: ${p.summary}`;
    case "proposal.received":
      return `${who} of [${p.with}] proposed ${p.summary}`;
    case "proposal.signed":
      return `${who} signed: ${p.summary}`;
    case "proposal.executed":
      return `Agreed with [${p.with}]: ${p.summary} (final signature by ${who})`;
    case "proposal.declined":
      return `${who} declined: ${p.summary}`;
    case "proposal.withdrawn":
      return `${who} withdrew: ${p.summary}`;
    case "proposal.expired":
      return `A proposal with [${p.with}] expired: ${p.summary}`;
    case "territory.transferred":
      return p.direction === "in"
        ? `Received ${p.name} from [${p.with}]${p.price ? ` for ${naira(p.price)}` : ""}`
        : `Handed ${p.name} to [${p.with}]${p.price ? ` for ${naira(p.price)}` : ""}`;
    case "ceasefire.agreed":
      return `Ceasefire with [${p.with}] for ${(p.hours ?? 0) / 24} days`;
    case "battle.declared":
      return `${who} declared battle on [${p.with}] for ${p.name} (${naira(p.fee ?? 0)})`;
    case "battle.attacked":
      return `${who} of [${p.with}] declared battle for ${p.name}`;
    case "battle.round":
      return `Round ${p.round} at ${p.name} against [${p.with}]: ${p.outcome === "draw" ? "drawn" : p.outcome}`;
    case "battle.won":
      return `${p.side === "attacker" ? `Took ${p.name} from` : `Held ${p.name} against`} [${p.with}]${p.reason === "withdrawn" ? " (they withdrew)" : ""}`;
    case "battle.lost":
      return `${p.side === "attacker" ? `Failed to take ${p.name} from` : `Lost ${p.name} to`} [${p.with}]${p.reason === "withdrawn" ? ` (${who} withdrew)` : ""}`;
    case "battle.cancelled":
      return `The battle with [${p.with}] for ${p.name} was called off${p.refunded ? `; ${naira(p.refunded)} refunded` : ""}`;
    case "event.festival":
      return `A street festival in ${p.district} paid ${naira(p.amount ?? 0)} (${p.territories === 1 ? "one territory" : `${p.territories} territories`})`;
    case "admin.adjusted":
      return `An administrator ${(p.amount ?? 0) > 0 ? "credited" : "debited"} ${naira(Math.abs(p.amount ?? 0))}: ${p.reason}`;
    case "event.police_sweep":
      return `A police sweep in ${p.district} cost ${p.henchmen === 1 ? "one guard" : `${p.henchmen} guards`} ${p.morale} morale`;
    default:
      return `${who}: ${a.type}`;
  }
}
