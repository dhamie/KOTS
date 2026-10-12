import { CITY, DIPLOMACY } from "@kots/content";
import { checkFamilyAction, checkProposalTerms } from "@kots/rules";
import type { ChatChannel, MeResponse, Proposal, ProposalTerms, RoomState } from "@kots/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/http";
import { onLive } from "../../api/live";
import { naira, when } from "../format";
import { useAction } from "../useAction";
import type { ChatState } from "./useChat";

type MyFamily = NonNullable<MeResponse["family"]>;

const placeName = (slug: string) => CITY.territories.get(slug)?.name ?? slug;
const allTerritories = [...CITY.territories.values()].sort((a, b) => a.name.localeCompare(b.name));

function describeTerms(p: Proposal): string {
  if (p.terms.kind === "ceasefire") return `A ${p.terms.hours / 24}-day ceasefire`;
  const [giver, receiver] = p.terms.giver === "proposer" ? [p.from, p.to] : [p.to, p.from];
  return `[${giver.tag}] hands ${placeName(p.terms.territory)} to [${receiver.tag}]${p.terms.price > 0 ? ` for ${naira(p.terms.price)}` : ""}`;
}

/** The family's diplomacy rooms, and opening one with another family by tag. */
export function DiplomacyRooms(props: { rooms: ChatChannel[]; chat: ChatState; onOpen: (id: string) => void }) {
  const { rooms, chat, onOpen } = props;
  const [tag, setTag] = useState("");
  const { busy, error, run } = useAction();

  const open = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const room = await api.openRoom(tag.trim().toUpperCase());
      chat.reload();
      setTag("");
      onOpen(room.id);
    });
  };

  return (
    <div>
      <p className="muted small">Talk terms with another family here. Only signed proposals change anything.</p>
      <form className="inline" onSubmit={(e) => void open(e)}>
        <input aria-label="Family tag to talk to" value={tag} maxLength={5} onChange={(e) => setTag(e.target.value)} placeholder="Family tag, e.g. APA" />
        <button type="submit" disabled={busy || tag.trim().length < 2}>
          Open room
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {rooms.length === 0 && <p className="muted small">No rooms yet.</p>}
      <ul className="list">
        {rooms.map((r) => (
          <li key={r.id}>
            <button type="button" className="link" onClick={() => onOpen(r.id)}>
              {r.name}
            </button>
            <span className="muted small">
              {r.unread > 0 && <span className="badge">{r.unread}</span>}
              {r.lastMessageAt ? when(r.lastMessageAt) : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A room's proposals and ceasefire. The server re-checks every term when the second family signs. */
export function RoomProposals(props: { room: ChatChannel; family: MyFamily }) {
  const { room, family } = props;
  const [state, setState] = useState<RoomState | null>(null);
  const { busy, error, run } = useAction();
  const canSign = checkFamilyAction(family.role, { kind: "diplomacy_sign" }).ok;
  const canPropose = checkFamilyAction(family.role, { kind: "diplomacy_propose" }).ok;

  const load = useCallback(() => run(async () => setState(await api.room(room.id))), [room.id]);
  useEffect(() => {
    void load();
  }, [load]);
  // Proposals change through family activity (signing, expiry), which every member's browser hears about.
  useEffect(() => onLive((e) => (e.type === "family.changed" || e.type === "resync") && void load()), [load]);

  const act = async (action: () => Promise<unknown>) => {
    await run(action);
    void load();
  };

  const open = state?.proposals.filter((p) => p.status === "open") ?? [];
  const closed = state?.proposals.filter((p) => p.status !== "open") ?? [];

  return (
    <div className="proposals" data-testid="proposals">
      {state?.ceasefireUntil && <p className="ceasefire small">Ceasefire in force until {when(state.ceasefireUntil)}. (Battles arrive in a later update.)</p>}
      {error && <p className="error">{error}</p>}
      <h3>Proposals</h3>
      {open.length === 0 && <p className="muted small">None open.</p>}
      <ul className="list offers" data-testid="open-proposals">
        {open.map((p) => {
          const mine = p.from.id === family.id;
          const signedByUs = p.signatures.some((s) => s.familyId === family.id);
          return (
            <li key={p.id}>
              <div>
                <strong>{describeTerms(p)}</strong>
                <div className="muted small">
                  {mine ? "Your proposal" : `From [${p.from.tag}]`}
                  {p.createdBy ? ` (${p.createdBy})` : ""} · expires {when(p.expiresAt)}
                </div>
                <div className="small">
                  {p.signatures.length === 0 ? "No signatures yet" : p.signatures.map((s) => `[${s.familyId === p.from.id ? p.from.tag : p.to.tag}] signed${s.by ? ` (${s.by})` : ""}`).join(" · ")}
                </div>
              </div>
              <div className="controls">
                {canSign && !signedByUs && (
                  <button type="button" disabled={busy} onClick={() => void act(() => api.signProposal(p.id))}>
                    Sign
                  </button>
                )}
                {canSign && !mine && (
                  <button type="button" disabled={busy} onClick={() => void act(() => api.declineProposal(p.id))}>
                    Decline
                  </button>
                )}
                {canPropose && mine && (
                  <button type="button" disabled={busy} onClick={() => void act(() => api.withdrawProposal(p.id))}>
                    Withdraw
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {canPropose && <NewProposal room={room} family={family} busy={busy} onSubmit={(terms) => act(() => api.propose(room.id, terms))} />}
      {closed.length > 0 && (
        <details>
          <summary className="small">Recent proposals</summary>
          <ul className="list activity" data-testid="closed-proposals">
            {closed.map((p) => (
              <li key={p.id}>
                <span>{describeTerms(p)}</span>
                <span className="muted">{p.status === "executed" ? "agreed" : p.status}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {!canSign && canPropose && <p className="muted small">Your Don or Underboss signs for the family.</p>}
    </div>
  );
}

function NewProposal(props: { room: ChatChannel; family: MyFamily; busy: boolean; onSubmit: (terms: ProposalTerms) => Promise<void> }) {
  const { room, family, busy, onSubmit } = props;
  const [kind, setKind] = useState<ProposalTerms["kind"]>("territory_transfer");
  const [hours, setHours] = useState<number>(DIPLOMACY.ceasefireHours[0]);
  const [giver, setGiver] = useState<"proposer" | "recipient">("proposer");
  const [territory, setTerritory] = useState("");
  const [price, setPrice] = useState("");
  const [held, setHeld] = useState<string[]>([]);

  useEffect(() => {
    api
      .holdings(family.id)
      .then((h) => setHeld(h.territories.map((t) => t.slug)))
      .catch(() => undefined);
  }, [family.id]);

  // Handing over: one of ours. Asking: any territory; the server checks the other family holds it.
  const choices = giver === "proposer" ? allTerritories.filter((t) => held.includes(t.slug)) : allTerritories;
  const terms: ProposalTerms = kind === "ceasefire" ? { kind, hours } : { kind, territory, giver, price: Number(price || 0) };
  const ready = (kind === "ceasefire" || territory !== "") && checkProposalTerms(terms).ok;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    await onSubmit(terms);
    setTerritory("");
    setPrice("");
  };

  return (
    <form className="new-proposal" onSubmit={(e) => void submit(e)}>
      <h3>New proposal to [{room.family?.tag}]</h3>
      <label>
        Proposal type
        <select value={kind} onChange={(e) => setKind(e.target.value as ProposalTerms["kind"])}>
          <option value="territory_transfer">Territory transfer</option>
          <option value="ceasefire">Ceasefire</option>
        </select>
      </label>
      {kind === "ceasefire" ? (
        <label>
          Ceasefire length
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {DIPLOMACY.ceasefireHours.map((h) => (
              <option key={h} value={h}>
                {h / 24} {h === 24 ? "day" : "days"}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label>
            Direction
            <select
              value={giver}
              onChange={(e) => {
                setGiver(e.target.value as typeof giver);
                setTerritory("");
              }}
            >
              <option value="proposer">We hand over (they pay)</option>
              <option value="recipient">They hand over (we pay)</option>
            </select>
          </label>
          <label>
            Territory
            <select value={territory} onChange={(e) => setTerritory(e.target.value)}>
              <option value="">Choose…</option>
              {choices.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Price (₦)
            <input type="number" min={0} step={1} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ""))} placeholder="0" />
          </label>
        </>
      )}
      <button type="submit" disabled={busy || !ready}>
        Propose
      </button>
    </form>
  );
}
