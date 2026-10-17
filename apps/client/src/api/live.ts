import { SOCKET_PATH, type ServerEvent } from "@kots/shared";
import { io, type Socket } from "socket.io-client";

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: Socket | null = null;

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
  });
  socket.on("event", emit);
  // The server ended the session (logged out elsewhere, or banned): listeners reload, find it gone and sign out.
  socket.on("disconnect", (reason) => {
    if (reason === "io server disconnect") emit({ type: "resync" });
  });
}

export function disconnectLive(): void {
  socket?.disconnect();
  socket = null;
}

/** Subscribes to live events; returns the unsubscribe function (fits a useEffect cleanup). */
export function onLive(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
