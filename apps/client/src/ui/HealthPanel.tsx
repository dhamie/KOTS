import { useEffect, useState } from "react";
import { fetchHealth } from "../api/http";

type State = { kind: "loading" } | { kind: "ok"; db: string } | { kind: "error"; message: string };

export function HealthPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((h) => !cancelled && setState({ kind: "ok", db: h.db }))
      .catch((e: unknown) => !cancelled && setState({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <aside className="panel" data-testid="health-panel">
      <h2>Server</h2>
      {state.kind === "loading" && <p>Checking…</p>}
      {state.kind === "ok" && <p>API ok · database {state.db}</p>}
      {state.kind === "error" && <p className="error">Unreachable: {state.message}</p>}
    </aside>
  );
}
