import type { Invitation, MeResponse } from "@kots/shared";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/http";
import { useAction } from "../useAction";
import { FamilyView } from "./FamilyView";

/** "My family": either the family view, or create-a-family plus the player's open invitations. */
export function FamilyPanel(props: { me: MeResponse; revision: number; onChanged: () => void; onSelectTerritory: (slug: string) => void; onOpenBattle: (id: string) => void }) {
  const { me, revision, onChanged } = props;
  if (me.family) return <FamilyView {...props} family={me.family} />;
  return (
    <section className="panel side" aria-label="My family">
      <h2>No family yet</h2>
      <CreateFamily onCreated={onChanged} />
      <MyInvitations revision={revision} onJoined={onChanged} />
    </section>
  );
}

function CreateFamily({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await run(() => api.createFamily(name, tag))) onCreated();
  }

  return (
    <form onSubmit={submit}>
      <h3>Start a family</h3>
      <label>
        Name
        <input required minLength={3} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Tag
        <input required minLength={2} maxLength={5} value={tag} onChange={(e) => setTag(e.target.value.toUpperCase())} />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={busy}>
        Create family
      </button>
    </form>
  );
}

function MyInvitations({ revision, onJoined }: { revision: number; onJoined: () => void }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(() => run(async () => setInvitations(await api.myInvitations())), []);

  // `revision` also changes when a live notification arrives, such as a new invitation.
  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <div>
      <h3>
        Invitations{" "}
        <button type="button" className="link" onClick={() => void load()} disabled={busy}>
          refresh
        </button>
      </h3>
      {invitations.length === 0 && <p className="muted">None right now.</p>}
      <ul className="list">
        {invitations.map((inv) => (
          <li key={inv.id}>
            <span>
              <strong>
                {inv.family.name} [{inv.family.tag}]
              </strong>{" "}
              <span className="muted">from {inv.invitedBy.handle}</span>
            </span>
            <span>
              <button type="button" disabled={busy} onClick={async () => (await run(() => api.acceptInvitation(inv.id))) && onJoined()}>
                Accept
              </button>
              <button type="button" disabled={busy} onClick={async () => (await run(() => api.declineInvitation(inv.id))) && void load()}>
                Decline
              </button>
            </span>
          </li>
        ))}
      </ul>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
