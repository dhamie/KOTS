import { BATTLES, BEATS, CITY, DEFAULT_TACTIC, TACTICS, type Tactic } from "@kots/content";
import { checkFamilyAction } from "@kots/rules";
import type { Battle, BattleRound, Henchman, MeResponse } from "@kots/shared";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/http";
import { mapData } from "../../map/mapData";
import { countdown, naira } from "../format";
import { useAction } from "../useAction";

type Side = Battle["mySide"];

export const TACTIC_LABEL: Record<Tactic, string> = { press: "Press", hold: "Hold", flank: "Flank" };
const TACTIC_VERB: Record<Tactic, string> = { press: "pressed the attack", hold: "held the line", flank: "went round the flank" };
const beatenBy = (t: Tactic) => TACTICS.find((o) => BEATS[o] === t)!;

const END_REASON: Record<string, string> = {
  withdrawn: "one side withdrew",
  territory_lost: "the defenders lost the territory another way",
  disbanded: "a family disbanded",
};

/** Ticks once a second, for countdowns. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * One battle as the viewer's family sees it: both sides, its own committed henchmen, orders for the next round,
 * and the report with a step-by-step replay. Rounds are resolved by the server on schedule; this only reloads.
 */
export function BattlePanel(props: { me: MeResponse; battleId: string; revision: number; onChanged: () => void; onClose: () => void; onSelectTerritory: (slug: string) => void }) {
  const { me, battleId, revision, onChanged, onClose, onSelectTerritory } = props;
  const [battle, setBattle] = useState<Battle | null>(null);
  const [crew, setCrew] = useState<Henchman[]>([]);
  const { busy, error, run } = useAction();
  const now = useNow();
  const family = me.family;
  const canCommand = !!family && checkFamilyAction(family.role, { kind: "command_battle" }).ok;
  const canWithdraw = !!family && checkFamilyAction(family.role, { kind: "declare_battle" }).ok;

  const show = useCallback(async (b: Battle) => {
    setBattle(b);
    // Keep the map's contested ring (and, once it's over, the owner) in step with what this battle says.
    const live = b.status === "preparing" || b.status === "active";
    const district = CITY.territories.get(b.territory.slug)?.district;
    if (district && (mapData.get(b.territory.slug)?.battleId ?? null) !== (live ? b.id : null)) await mapData.refresh(district).catch(() => undefined);
  }, []);

  const load = useCallback(
    () =>
      run(async () => {
        const [b, c] = await Promise.all([api.battle(battleId), family && canCommand ? api.henchmen(family.id) : Promise.resolve([])]);
        setCrew(c);
        await show(b);
      }),
    [battleId, family?.id, canCommand, show],
  );

  // `revision` changes on live family events, which include every round resolved and the end of the battle.
  useEffect(() => {
    void load();
  }, [load, revision]);

  // A change bumps `revision`, which reloads this panel (and the crew) through the effect above.
  const act = async (action: () => Promise<Battle>) => {
    if (await run(action)) onChanged();
  };

  if (!battle) {
    return (
      <section className="panel side battle" aria-label="Battle">
        <button type="button" className="close" aria-label="Close" onClick={onClose}>
          ×
        </button>
        <h2>Battle</h2>
        {error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  const b = battle;
  const live = b.status === "preparing" || b.status === "active";
  const enemy: Side = b.mySide === "attacker" ? "defender" : "attacker";
  const tag = (s: Side) => `[${b[s].tag}]`;
  const nextRound = b.currentRound + 1;
  const free = crew.filter((h) => !h.battleId && !(h.injuredUntil && new Date(h.injuredUntil).getTime() > now));
  const room = BATTLES.maxCommittedPerSide - b.committed.length;

  let status: string;
  if (b.status === "preparing") status = `Preparing · round 1 ${b.nextRoundAt ? countdown(b.nextRoundAt, now) : ""}`;
  else if (b.status === "active") status = `Round ${nextRound} of ${b.rounds} ${b.nextRoundAt ? countdown(b.nextRoundAt, now) : ""}`;
  else if (b.status === "resolved") status = `${b.winner === b.mySide ? "Victory" : "Defeat"}: ${tag(b.winner!)} won${b.endReason ? ` (${END_REASON[b.endReason] ?? b.endReason})` : ""}`;
  else status = `Called off: ${END_REASON[b.endReason ?? ""] ?? b.endReason}`;

  return (
    <section className="panel side battle" aria-label="Battle" data-testid="battle-panel">
      <button type="button" className="close" aria-label="Close" onClick={onClose}>
        ×
      </button>
      <h2>
        Battle for{" "}
        <button type="button" className="link" onClick={() => onSelectTerritory(b.territory.slug)}>
          {b.territory.name}
        </button>
      </h2>
      <p className="sides">
        {(["attacker", "defender"] as const).map((s) => (
          <span key={s} className={s === b.mySide ? "mine" : ""}>
            {b[s].name} <span className="tag">[{b[s].tag}]</span> <span className="muted small">{s === b.mySide ? `${s}, you` : s}</span>
          </span>
        ))}
      </p>
      <p data-testid="battle-status" className={live ? "" : b.winner === b.mySide ? "win" : "warn"}>
        {status}
      </p>
      <p className="muted small" data-testid="battle-score">
        Rounds won: {tag("attacker")} {b.points.attacker} – {b.points.defender} {tag("defender")} · best of {b.rounds}
      </p>
      {error && <p className="error">{error}</p>}

      {live && canCommand && (
        <>
          <h3>Orders for round {nextRound}</h3>
          <div className="tactics" role="group" aria-label="Tactic">
            {TACTICS.map((t) => (
              <button
                key={t}
                type="button"
                className={b.nextOrder === t ? "active" : ""}
                aria-pressed={b.nextOrder === t}
                disabled={busy}
                onClick={() => void act(() => api.battleOrder(b.id, nextRound, t))}
              >
                {TACTIC_LABEL[t]}
              </button>
            ))}
          </div>
          <p className="muted small">
            {b.nextOrder
              ? `${TACTIC_LABEL[b.nextOrder]} beats ${TACTIC_LABEL[BEATS[b.nextOrder]]} and loses to ${TACTIC_LABEL[beatenBy(b.nextOrder)]}. You can change it until the round is fought.`
              : `No order sent: your side will ${TACTIC_LABEL[DEFAULT_TACTIC[b.mySide]].toLowerCase()}. Press beats Flank, Flank beats Hold, Hold beats Press.`}
          </p>
        </>
      )}

      <h3>{live ? "Your side" : "Your fighters"}</h3>
      {b.committed.length === 0 && <p className="muted small">{live ? "Nobody committed yet. A side with nobody loses every round." : "Nobody fought for your side."}</p>}
      <ul className="list" data-testid="committed">
        {b.committed.map((h) => (
          <li key={h.id}>
            <span>
              {h.name} <span className="muted small">combat {h.combat} · morale {h.morale}</span>
              {h.injured && <span className="warn small"> · injured</span>}
            </span>
            {b.status === "preparing" && canCommand && (
              <button type="button" disabled={busy} onClick={() => void act(() => api.releaseHenchmen(b.id, [h.id]))}>
                Release
              </button>
            )}
          </li>
        ))}
      </ul>
      {b.status === "preparing" && canCommand && free.length > 0 && (
        <details open={b.committed.length === 0}>
          <summary className="small">
            Commit henchmen ({room > 0 ? `room for ${room} more` : "full"})
          </summary>
          <ul className="list" data-testid="available">
            {free.map((h) => (
              <li key={h.id}>
                <span>
                  {h.name} <span className="muted small">combat {h.attributes.combat} · morale {h.morale}</span>
                </span>
                <button type="button" disabled={busy || room <= 0} onClick={() => void act(() => api.commitHenchmen(b.id, [h.id]))}>
                  Commit
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="muted small" data-testid="enemy-committed">
        {tag(enemy)}: {b.enemyCommitted} {b.enemyCommitted === 1 ? "henchman" : "henchmen"} {live ? "committed" : "fought"}
      </p>

      {b.report.length > 0 && <Report battle={b} />}

      <p className="muted small">
        {b.mySide === "attacker" ? `Declared for ${naira(b.fee)}, not refunded if the battle is fought.` : "The attacker paid to declare; defending costs nothing."}
      </p>
      {live && canWithdraw && (
        <div className="danger">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              confirm(b.mySide === "attacker" ? "Withdraw? The defenders win and the fee is lost." : `Withdraw? ${b.territory.name} goes to ${tag("attacker")}.`) &&
              void act(() => api.withdrawBattle(b.id))
            }
          >
            Withdraw
          </button>
        </div>
      )}
    </section>
  );
}

const outcomeWord = (r: BattleRound, side: Side) => (r.winner === "draw" ? "drawn" : r.winner === side ? "won" : "lost");
const fought = (n: number) => (n === 0 ? "nobody" : n === 1 ? "one henchman" : `${n} henchmen`);
const luck = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n / 10).toFixed(1)}%`;

/** The rounds so far: a step-through replay of one round at a time, and the full list. */
function Report(props: { battle: Battle }) {
  const b = props.battle;
  const rounds = b.report;
  const [step, setStep] = useState(rounds.length - 1);
  const [playing, setPlaying] = useState(false);
  // A new round arriving shows it.
  useEffect(() => setStep(rounds.length - 1), [rounds.length]);
  useEffect(() => {
    if (!playing) return;
    const id = setTimeout(() => (step < rounds.length - 1 ? setStep(step + 1) : setPlaying(false)), 1800);
    return () => clearTimeout(id);
  }, [playing, step, rounds.length]);

  const r = rounds[Math.min(step, rounds.length - 1)]!;
  const tag = (s: Side) => `[${b[s].tag}]`;
  const top = Math.max(r.strength.attacker, r.strength.defender, 1);
  const edge = BEATS[r.tactics.attacker] === r.tactics.defender ? "attacker" : BEATS[r.tactics.defender] === r.tactics.attacker ? "defender" : null;
  const score = rounds.slice(0, step + 1).reduce((p, x) => ({ attacker: p.attacker + (x.winner === "attacker" ? 1 : 0), defender: p.defender + (x.winner === "defender" ? 1 : 0) }), { attacker: 0, defender: 0 });

  return (
    <>
      <h3>Report</h3>
      <div className="replay" data-testid="replay">
        <p className="small">
          <strong>Round {r.round}</strong>{" "}
          <span className="muted">
            · {tag("attacker")} {score.attacker} – {score.defender} {tag("defender")}
          </span>
        </p>
        {(["attacker", "defender"] as const).map((s) => (
          <div key={s} className={`strength ${s}`}>
            <span className="who small">
              {tag(s)} {TACTIC_LABEL[r.tactics[s]]}
            </span>
            <span className="track">
              {/* Keyed by round, so each step replays the bar growing. */}
              <span key={`${r.round}-${step}`} className="fill" style={{ width: `${(r.strength[s] / top) * 100}%` }} />
            </span>
            <span className="value small">{r.strength[s]}</span>
          </div>
        ))}
        <p className="small narration" data-testid="narration">
          {tag("attacker")} {TACTIC_VERB[r.tactics.attacker]} with {fought(r.fighters.attacker)}; {tag("defender")} {TACTIC_VERB[r.tactics.defender]} with {fought(r.fighters.defender)}.{" "}
          {edge && `${TACTIC_LABEL[r.tactics[edge]]} beats ${TACTIC_LABEL[r.tactics[edge === "attacker" ? "defender" : "attacker"]].toLowerCase()}. `}
          {r.winner === "draw" ? "Neither side gave ground." : `${tag(r.winner)} won the round.`}
          {(r.injured.attacker > 0 || r.injured.defender > 0) && ` Injured: ${r.injured.attacker} ${tag("attacker")}, ${r.injured.defender} ${tag("defender")}.`}
        </p>
        <p className="muted small">
          Luck {tag("attacker")} {luck(r.roll.attacker)}, {tag("defender")} {luck(r.roll.defender)}
          {` · defenders fight ${Math.round(BATTLES.defenderBonus * 100)}% harder`}
        </p>
        {rounds.length > 1 && (
          <div className="steps">
            <button type="button" disabled={step === 0} onClick={() => setStep(step - 1)}>
              ‹ Previous
            </button>
            <button
              type="button"
              onClick={() => {
                setStep(0);
                setPlaying(true);
              }}
              disabled={playing}
            >
              Replay
            </button>
            <button type="button" disabled={step >= rounds.length - 1} onClick={() => setStep(step + 1)}>
              Next ›
            </button>
          </div>
        )}
      </div>
      <ul className="list activity" data-testid="report">
        {rounds.map((x) => (
          <li key={x.round}>
            <span>
              Round {x.round}: {TACTIC_LABEL[x.tactics.attacker]} vs {TACTIC_LABEL[x.tactics.defender]}, {x.strength.attacker}–{x.strength.defender}
            </span>
            <span className={outcomeWord(x, b.mySide) === "lost" ? "warn" : ""}>{outcomeWord(x, b.mySide)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
