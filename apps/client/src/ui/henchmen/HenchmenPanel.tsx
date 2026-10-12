import { ARCHETYPES, CITY, HENCHMAN_ATTRIBUTES, type HenchmanAttribute } from "@kots/content";
import { checkFamilyAction } from "@kots/rules";
import type { FamilyHoldings, Henchman, MeResponse, RecruitBoard, RecruitCandidate } from "@kots/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/http";
import { naira, when } from "../format";
import { useAction } from "../useAction";

const ATTRIBUTE_LABEL: Record<HenchmanAttribute, string> = {
  combat: "Combat",
  leadership: "Leadership",
  discipline: "Discipline",
  negotiation: "Negotiation",
  logistics: "Logistics",
  reliability: "Reliability",
  loyalty: "Loyalty",
};
const archetype = (key: string) => ARCHETYPES.find((a) => a.key === key);

/** The family's crew and today's recruitment board. Controls follow the shared rules; the server re-checks. */
export function HenchmenPanel(props: { me: MeResponse; revision: number; onChanged: () => void; onSelectTerritory: (slug: string) => void; onOpenBattle: (id: string) => void }) {
  const { me, revision, onChanged, onSelectTerritory, onOpenBattle } = props;
  const family = me.family;
  const [board, setBoard] = useState<RecruitBoard | null>(null);
  const [crew, setCrew] = useState<Henchman[]>([]);
  const [holdings, setHoldings] = useState<FamilyHoldings | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(
    () =>
      run(async () => {
        if (!family) return;
        const [b, c, h, t] = await Promise.all([api.recruits(family.id), api.henchmen(family.id), api.holdings(family.id), api.treasury(family.id)]);
        setBoard(b);
        setCrew(c);
        setHoldings(h);
        setBalance(t.balance);
      }),
    [family?.id],
  );

  useEffect(() => {
    void load();
  }, [load, revision]);

  if (!family) {
    return (
      <section className="panel side" aria-label="Henchmen">
        <h2>Henchmen</h2>
        <p className="muted">Join or start a family to recruit henchmen.</p>
      </section>
    );
  }

  const can = (kind: "recruit_henchman" | "assign_henchman" | "dismiss_henchman") => checkFamilyAction(family.role, { kind }).ok;
  const act = async (action: () => Promise<unknown>) => {
    if (!(await run(action))) return;
    onChanged();
    void load();
  };
  const wages = crew.reduce((s, h) => s + h.wage, 0);

  return (
    <section className="panel side" aria-label="Henchmen">
      <h2>Henchmen</h2>
      <p className="muted small">
        Treasury {balance === null ? "…" : naira(balance)}
        {crew.length > 0 && ` · wages ${naira(wages)} a day`}
      </p>
      {error && <p className="error">{error}</p>}

      <h3>Crew</h3>
      {crew.length === 0 && <p className="muted small">Nobody yet. Hire from today's candidates below.</p>}
      <ul className="list crew" data-testid="crew">
        {crew.map((h) => (
          <li key={h.id}>
            <div className="who">
              <strong>{h.name}</strong>
              <span className="muted small">
                {" "}
                {archetype(h.archetype)?.label ?? h.archetype} · morale {h.morale} · {naira(h.wage)}/day
              </span>
              {h.wageOverdue && <span className="warn small"> · wages unpaid</span>}
              {h.injuredUntil && new Date(h.injuredUntil).getTime() > Date.now() && <span className="warn small"> · injured until {when(h.injuredUntil)}</span>}
              {h.battleId && (
                <>
                  {" · "}
                  <button type="button" className="link small contested" onClick={() => onOpenBattle(h.battleId!)}>
                    in battle
                  </button>
                </>
              )}
            </div>
            <div className="controls">
              {can("assign_henchman") ? (
                <select
                  aria-label={`Post for ${h.name}`}
                  value={h.assignedTo ?? ""}
                  disabled={busy || !!h.battleId}
                  onChange={(e) => void act(() => api.assignHenchman(h.id, e.target.value || null))}
                >
                  <option value="">Idle</option>
                  {holdings?.territories.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      Guarding {CITY.territories.get(t.slug)?.name ?? t.slug}
                    </option>
                  ))}
                </select>
              ) : h.assignedTo ? (
                <button type="button" className="link small" onClick={() => onSelectTerritory(h.assignedTo!)}>
                  Guarding {CITY.territories.get(h.assignedTo)?.name}
                </button>
              ) : (
                <span className="muted small">Idle</span>
              )}
              {can("dismiss_henchman") && (
                <button
                  type="button"
                  disabled={busy || !!h.battleId}
                  onClick={() => confirm(`Dismiss ${h.name}? Nothing is refunded.`) && void act(() => api.dismissHenchman(h.id))}
                >
                  Dismiss
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h3>Today's candidates</h3>
      {board && <p className="muted small">New faces {when(board.resetsAt)}.</p>}
      <ul className="list candidates" data-testid="candidates">
        {board?.candidates.map((c) => (
          <CandidateCard key={c.slot} c={c} canHire={can("recruit_henchman")} balance={balance} busy={busy} onHire={() => void act(() => api.hire(family.id, c.slot))} />
        ))}
      </ul>
    </section>
  );
}

function CandidateCard(props: { c: RecruitCandidate; canHire: boolean; balance: number | null; busy: boolean; onHire: () => void }) {
  const { c, canHire, balance, busy, onHire } = props;
  const a = archetype(c.archetype);
  const cost = c.hireCost + c.wage;
  const short = balance !== null && balance < cost;
  return (
    <li className="candidate">
      <div>
        <strong>{c.name}</strong> <span className="kind">{a?.label ?? c.archetype}</span>
      </div>
      {a && <p className="muted small">{a.blurb}</p>}
      <dl className="attributes">
        {HENCHMAN_ATTRIBUTES.map((attr) => (
          <div key={attr}>
            <dt>{ATTRIBUTE_LABEL[attr]}</dt>
            <dd>
              <span className="bar" style={{ width: `${c.attributes[attr]}%` }} />
              <span className="value">{c.attributes[attr]}</span>
            </dd>
          </div>
        ))}
      </dl>
      <p className="small">
        <span className="muted">{c.traits.join(", ")}</span>
      </p>
      {c.hired ? (
        <p className="muted small">Hired</p>
      ) : (
        <>
          <button type="button" disabled={busy || !canHire || short} onClick={onHire}>
            Hire for {naira(cost)}
          </button>
          <span className="muted small">
            {" "}
            then {naira(c.wage)}/day{!canHire ? " · your role can't hire" : short ? " · not enough in the treasury" : ""}
          </span>
        </>
      )}
    </li>
  );
}
