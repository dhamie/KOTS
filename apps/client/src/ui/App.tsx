import { MARKETS } from "@kots/content";
import type { MeResponse, Notification } from "@kots/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/http";
import { connectLive, disconnectLive, onLive } from "../api/live";
import { mapBus } from "../map/bus";
import { MapView } from "../map/MapView";
import { AuthPanel } from "./auth/AuthPanel";
import { BattlePanel } from "./battles/BattlePanel";
import { ChatPanel, type ChatTab } from "./chat/ChatPanel";
import { useChat } from "./chat/useChat";
import { FamilyPanel } from "./family/FamilyPanel";
import { HealthPanel } from "./HealthPanel";
import { HenchmenPanel } from "./henchmen/HenchmenPanel";
import { DistrictNav } from "./map/DistrictNav";
import { TerritoryPanel } from "./map/TerritoryPanel";
import { useMapSync } from "./map/useMapSync";
import { MarketPanel, type MarketTab } from "./market/MarketPanel";
import { NotificationBell } from "./notifications/NotificationBell";

type Session = { kind: "loading" } | { kind: "anonymous" } | { kind: "signed-in"; me: MeResponse } | { kind: "error"; message: string };
type Drawer = "family" | "henchmen" | "market" | "chat" | "districts" | "battle" | null;

const wide = () => window.matchMedia("(min-width: 900px)").matches;

/** App shell: the Phaser map fills the screen; React panels float above it. */
export function App() {
  const [session, setSession] = useState<Session>({ kind: "loading" });
  const [drawer, setDrawer] = useState<Drawer>(wide() ? "family" : null);
  const signedIn = session.kind === "signed-in";
  const { selected, setSelected, states } = useMapSync(signedIn);
  // Bumped when a territory action changes the family's money or land, so the family panel reloads.
  const [revision, setRevision] = useState(0);
  const [marketSlug, setMarketSlug] = useState(MARKETS[0]!.territory);
  const [marketTab, setMarketTab] = useState<MarketTab>("markets");
  const [chatTab, setChatTab] = useState<ChatTab | null>(null);
  const [battleId, setBattleId] = useState<string | null>(null);
  const chat = useChat(signedIn ? session.me : null);

  const loadMe = useCallback(async () => {
    try {
      setSession({ kind: "signed-in", me: await api.me() });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setSession({ kind: "anonymous" });
      else setSession({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  async function logout() {
    await api.logout().catch(() => undefined);
    setSession({ kind: "anonymous" });
  }

  // Live updates while signed in. Events are hints: they trigger the same reloads an action here would.
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!signedIn) return;
    connectLive();
    // Bursts of family activity (a sweep, a busy market) collapse into one reload.
    const refresh = () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => setRevision((r) => r + 1), 300);
    };
    const off = onLive((e) => {
      if (e.type === "me.changed" || e.type === "resync") void loadMe();
      // A city event can move market prices as well as family money and morale.
      if (e.type === "family.changed" || e.type === "notification" || e.type === "events.changed" || e.type === "resync") refresh();
    });
    return () => {
      off();
      clearTimeout(refreshTimer.current);
      disconnectLive();
    };
  }, [signedIn, loadMe]);

  const openTarget = (target: Notification["target"]) => {
    if (!wide()) setSelected(null);
    if (target === "trade") {
      setMarketTab("trades");
      setDrawer("market");
    } else if (target === "diplomacy") {
      setChatTab("diplomacy");
      setDrawer("chat");
    } else setDrawer(target === "henchmen" ? "henchmen" : "family");
  };

  // Battles have no toolbar button: they open from the territory panel, the family panel and the henchmen panel.
  const openBattle = (id: string) => {
    if (!wide()) setSelected(null);
    setBattleId(id);
    setDrawer("battle");
  };
  const selectTerritory = (slug: string) => {
    setSelected(slug);
    mapBus.emit("map:focus", { kind: "territory", slug });
  };

  // On a phone the drawer and the territory sheet share the bottom of the screen, so only one is open.
  useEffect(() => {
    if (selected && !wide()) setDrawer(null);
  }, [selected]);

  const toggle = (d: Exclude<Drawer, null>) => {
    if (!wide()) setSelected(null);
    setDrawer((cur) => (cur === d ? null : d));
  };

  return (
    <div className="app">
      <MapView />
      {signedIn && (
        <>
          <nav className="panel toolbar" aria-label="Panels">
            <button type="button" className={drawer === "family" ? "active" : ""} aria-pressed={drawer === "family"} onClick={() => toggle("family")}>
              Family
            </button>
            <button type="button" className={drawer === "henchmen" ? "active" : ""} aria-pressed={drawer === "henchmen"} onClick={() => toggle("henchmen")}>
              Henchmen
            </button>
            <button type="button" className={drawer === "market" ? "active" : ""} aria-pressed={drawer === "market"} onClick={() => toggle("market")}>
              Market
            </button>
            <button type="button" className={drawer === "chat" ? "active" : ""} aria-pressed={drawer === "chat"} onClick={() => toggle("chat")}>
              Chat{chat.unread > 0 && <span className="badge">{chat.unread > 99 ? "99+" : chat.unread}</span>}
            </button>
          </nav>
          {/* On the map rather than in the toolbar, which keeps four buttons on a phone. */}
          <button
            type="button"
            className={`panel map-control ${drawer === "districts" ? "active" : ""}`}
            aria-pressed={drawer === "districts"}
            onClick={() => toggle("districts")}
          >
            Districts
          </button>
          <header className="panel topbar">
            <span>
              Signed in as <strong data-testid="handle">{session.me.player.handle}</strong>
            </span>
            <NotificationBell onOpen={openTarget} />
            <button type="button" className="link" onClick={() => void logout()}>
              Log out
            </button>
          </header>
          {drawer === "family" && (
            <FamilyPanel
              key={session.me.family?.id ?? "none"}
              me={session.me}
              revision={revision}
              onChanged={() => void loadMe()}
              onSelectTerritory={selectTerritory}
              onOpenBattle={openBattle}
            />
          )}
          {drawer === "henchmen" && (
            <HenchmenPanel
              me={session.me}
              revision={revision}
              onChanged={() => setRevision((r) => r + 1)}
              onSelectTerritory={selectTerritory}
              onOpenBattle={openBattle}
            />
          )}
          {drawer === "market" && (
            <MarketPanel
              me={session.me}
              slug={marketSlug}
              revision={revision}
              tab={marketTab}
              onTab={setMarketTab}
              onSelectMarket={setMarketSlug}
              onChanged={() => setRevision((r) => r + 1)}
            />
          )}
          {drawer === "chat" && <ChatPanel me={session.me} chat={chat} tab={chatTab} onTab={setChatTab} />}
          {drawer === "battle" && battleId && (
            <BattlePanel
              key={battleId}
              me={session.me}
              battleId={battleId}
              revision={revision}
              onChanged={() => setRevision((r) => r + 1)}
              onClose={() => setDrawer(null)}
              onSelectTerritory={(slug) => {
                if (!wide()) setDrawer(null);
                selectTerritory(slug);
              }}
            />
          )}
          {drawer === "districts" && <DistrictNav onNavigate={() => !wide() && setDrawer(null)} />}
          {selected && (
            <TerritoryPanel
              slug={selected}
              state={states.get(selected)}
              me={session.me}
              onChanged={() => setRevision((r) => r + 1)}
              onOpenMarket={(slug) => {
                setMarketSlug(slug);
                setMarketTab("markets");
                if (!wide()) setSelected(null);
                setDrawer("market");
              }}
              onOpenBattle={openBattle}
              onClose={() => setSelected(null)}
            />
          )}
        </>
      )}
      {session.kind === "anonymous" && <AuthPanel onAuthenticated={() => void loadMe()} />}
      {session.kind === "error" && <p className="panel side error">{session.message}</p>}
      <HealthPanel />
    </div>
  );
}
