import { BATTLES, CITY, MARKETS } from "@kots/content";
import { checkFamilyAction } from "@kots/rules";
import type { AttackQuote, AttackRefusal, Battle, ClaimRefusal, MeResponse, TerritoryDetail, TerritoryState } from "@kots/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/http";
import { KIND_STYLE } from "../../map/palette";
import { mapData } from "../../map/mapData";
import { eventsAt, useCityNews } from "../events/useCityNews";
import { countdown, naira, when } from "../format";
import { useAction } from "../useAction";

const REFUSAL: Record<Exclude<ClaimRefusal, "owned">, string> = {
  not_in_family: "Join or start a family to claim territory.",
  missing_permission: "Your role can't claim territory.",
  not_adjacent: "You can only claim territory next to land your family holds, or across a bridge from it.",
  insufficient_funds: "The treasury can't cover this.",
};

const ATTACK_REFUSAL: Record<Exclude<AttackRefusal, "not_held">, string> = {
  not_in_family: "Join a family to fight for territory.",
  missing_permission: "Only the Don or an Underboss can declare a battle.",
  contested: "Another battle is already being fought over it.",
  already_fighting: "Your family is already attacking somewhere. Finish that battle first.",
  not_adjacent: "You can only attack territory that borders land your family holds.",
  last_territory: "It's that family's last territory; a family's last territory can't be attacked.",
  attacker_protected: `Your family can't start battles until it is ${BATTLES.protectionDays} days old.`,
  defender_protected: `That family is new: it can't be attacked until it is ${BATTLES.protectionDays} days old.`,
  ceasefire: "Your families have a ceasefire in force.",
  cooldown: `Your families fought within the last ${BATTLES.pairCooldownHours} hours.`,
  insufficient_funds: "The treasury can't cover the fee.",
};

/** The location view for a territory. Static facts come from content; ownership, upkeep and costs from the server. */
export function TerritoryPanel(props: {
  slug: string;
  state: TerritoryState | undefined;
  me: MeResponse;
  onChanged: () => void;
  onOpenMarket: (slug: string) => void;
  onOpenBattle: (id: string) => void;
  onClose: () => void;
}) {
  const { slug, state, me, onChanged, onOpenMarket, onOpenBattle, onClose } = props;
  const t = CITY.territories.get(slug);
  const [detail, setDetail] = useState<TerritoryDetail | null>(null);
  const [attack, setAttack] = useState<AttackQuote | null>(null);
  // The battle over it, when the viewer's family is one of the sides (others can't see it).
  const [battle, setBattle] = useState<Battle | null>(null);
  const { busy, error, run } = useAction();
  const news = useCityNews();
  const ownerId = state?.owner?.id ?? null;
  const mapBattleId = state?.battleId ?? null;
  const myFamilyId = me.family?.id ?? null;

  const load = useCallback(
    () =>
      run(async () => {
        const d = await api.territory(slug);
        setDetail(d);
        const theirs = d.owner !== null && d.owner.id !== myFamilyId;
        const [a, b] = await Promise.all([
          theirs && !d.battleId ? api.attackQuote(slug) : Promise.resolve(null),
          d.battleId && myFamilyId ? api.battle(d.battleId).catch(() => null) : Promise.resolve(null),
        ]);
        setAttack(a);
        setBattle(b);
      }),
    [slug, myFamilyId],
  );
  // Reload when the selection changes, or the map learns the owner or the battle changed.
  useEffect(() => {
    setDetail(null);
    setAttack(null);
    setBattle(null);
    void load();
  }, [load, ownerId, mapBattleId]);

  if (!t) return null;
  const district = CITY.districts.get(t.district)!;
  const owner = detail ? detail.owner : state?.owner;
  const canAbandon = detail?.holding && me.family && checkFamilyAction(me.family.role, { kind: "abandon_territory" }).ok;

  const act = async (action: () => Promise<unknown>) => {
    if (!(await run(action))) return;
    await mapData.refresh(t.district).catch(() => undefined);
    onChanged();
    void load();
  };

  const declare = async () => {
    let id = "";
    if (!(await run(async () => (id = (await api.declareBattle(slug)).id)))) return;
    await mapData.refresh(t.district).catch(() => undefined);
    onChanged();
    onOpenBattle(id);
    void load();
  };

  return (
    <section className="panel territory" aria-label="Territory" data-testid="territory-panel">
      <button type="button" className="close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <p className="muted small">{district.name}</p>
      <h2>{t.name}</h2>
      <p className="kind">{KIND_STYLE[t.kind].label}</p>
      <p>{t.description}</p>
      <dl>
        <dt>Controlled by</dt>
        <dd data-testid="territory-owner">{owner === undefined ? "…" : owner ? `${owner.name} [${owner.tag}]` : "Neutral"}</dd>
        {detail?.battleId && (
          <>
            <dt>Status</dt>
            <dd className="contested" data-testid="contested">
              Battle in progress
            </dd>
          </>
        )}
        {detail?.state === "neglected" && (
          <>
            <dt>Status</dt>
            <dd className="warn">Upkeep overdue</dd>
          </>
        )}
        {detail?.holding ? (
          <>
            <dt>Income</dt>
            <dd>{naira(detail.holding.income)} / day</dd>
            <dt>Upkeep</dt>
            <dd>{naira(detail.holding.upkeep)} / day</dd>
            <dt>Paid until</dt>
            <dd data-testid="paid-until">{when(detail.holding.paidUntil)}</dd>
          </>
        ) : (
          <>
            <dt>Income potential</dt>
            <dd>{naira(t.baseIncome)} / day</dd>
            <dt>Upkeep</dt>
            <dd>{naira(t.baseUpkeep)} / day</dd>
          </>
        )}
      </dl>

      {eventsAt(news, slug, t.district).map((e) => (
        <p key={e.id} className="event small" data-testid="territory-event">
          <strong>{e.headline}.</strong> {e.body}
        </p>
      ))}
      {MARKETS.some((m) => m.territory === slug) && (
        <button type="button" onClick={() => onOpenMarket(slug)}>
          Open the market
        </button>
      )}
      {detail?.claim && detail.claim.refusal !== "owned" && (
        <div className="claim">
          <button type="button" disabled={busy || detail.claim.refusal !== null} onClick={() => void act(() => api.claim(slug))}>
            Claim for {naira(detail.claim.total)}
          </button>
          <p className="muted small">
            {detail.claim.fee > 0 ? `${naira(detail.claim.fee)} fee + ` : "No fee for your first territory. "}
            {naira(detail.claim.firstUpkeep)} first day's upkeep
          </p>
          {detail.claim.refusal && <p className="muted small" data-testid="claim-refusal">{REFUSAL[detail.claim.refusal]}</p>}
        </div>
      )}
      {battle && (
        <div className="claim">
          <button type="button" onClick={() => onOpenBattle(battle.id)}>
            View the battle
          </button>
          <p className="muted small">
            [{battle.attacker.tag}] attacking [{battle.defender.tag}] ·{" "}
            {battle.status === "preparing" ? "round 1" : `round ${battle.currentRound + 1}`} {battle.nextRoundAt ? countdown(battle.nextRoundAt, Date.now()) : ""}
          </p>
        </div>
      )}
      {attack && attack.refusal !== "not_held" && (
        <div className="claim" data-testid="attack">
          <button
            type="button"
            disabled={busy || attack.refusal !== null}
            onClick={() => confirm(`Declare battle for ${t.name}? The ${naira(attack.fee)} fee isn't refunded.`) && void declare()}
          >
            Declare battle for {naira(attack.fee)}
          </button>
          <p className="muted small">
            Round 1 is fought {BATTLES.preparationHours} hours after declaring, then a round every {BATTLES.roundHours} hours, best of {BATTLES.rounds}.
          </p>
          {attack.refusal && (
            <p className="muted small" data-testid="attack-refusal">
              {ATTACK_REFUSAL[attack.refusal]}
            </p>
          )}
        </div>
      )}
      {canAbandon && !detail?.battleId && (
        <button type="button" className="link" disabled={busy} onClick={() => confirm(`Abandon ${t.name}? It becomes neutral; nothing is refunded.`) && void act(() => api.abandon(slug))}>
          Abandon territory
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
