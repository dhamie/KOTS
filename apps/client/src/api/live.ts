import { SOCKET_PATH, type ServerEvent } from "@kots/shared";
import { io, type Socket } from "socket.io-client";

type Listener = (event: ServerEvent) => void;
/** "reconnecting" while the live connection is down and socket.io is retrying (Phase 9c). */
export type LiveStatus = "live" | "reconnecting";

const listeners = new Set<Listener>();
const statusListeners = new Set<(status: LiveStatus) => void>();
let socket: Socket | null = null;
const setStatus = (status: LiveStatus) => {
  for (const l of statusListeners) l(status);
};

const emit = (event: ServerEvent) => {
  for (const l of listeners) l(event);
};

/**
 * Opens the live connection for the signed-in player (the session cookie authenticates it). Events are hints:
 * after a reconnect listeners get `resync`, and reload over HTTP whatever they show.
 */
export function connectLive(): void {
  if (socket) return;
  let connectedBefore = false;
  socket = io({ path: SOCKET_PATH, transports: ["websocket"] });
  socket.on("connect", () => {
    if (connectedBefore) emit({ type: "resync" });
    connectedBefore = true;
    setStatus("live");
  });
  socket.on("event", emit);
  // The server ended the session (logged out elsewhere, or banned): listeners reload, find it gone and sign out.
  socket.on("disconnect", (reason) => {
    if (reason === "io server disconnect") emit({ type: "resync" });
    // Anything else but our own disconnect (an api restart, a lost network): socket.io retries on its own.
    else if (reason !== "io client disconnect") setStatus("reconnecting");
  });
}

export function disconnectLive(): void {
  socket?.disconnect();
  socket = null;
  setStatus("live");
}

/** Subscribes to the connection status; returns the unsubscribe function. */
export function onLiveStatus(listener: (status: LiveStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

/** Subscribes to live events; returns the unsubscribe function (fits a useEffect cleanup). */
export function onLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
