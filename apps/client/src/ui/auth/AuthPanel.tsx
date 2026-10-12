import { useState, type FormEvent } from "react";
import { api } from "../../api/http";
import { useAction } from "../useAction";

export function AuthPanel({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [handle, setHandle] = useState("");
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => (mode === "login" ? api.login(email, password) : api.register(email, password, handle)));
    if (ok) onAuthenticated();
  }

  return (
    <section className="panel side" aria-label="Account">
      <div className="tabs">
        <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
          Log in
        </button>
        <button type="button" className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
          Register
        </button>
      </div>
      <form onSubmit={submit}>
        <label>
          Email
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode === "register" && (
          <label>
            Handle
            <input required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" value={handle} onChange={(e) => setHandle(e.target.value)} />
          </label>
        )}
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            required
            minLength={mode === "register" ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>
          {mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>
    </section>
  );
}
