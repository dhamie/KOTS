import { SOCKET_PATH, type ServerEvent } from "@kots/shared";
import { io, type Socket } from "socket.io-client";
import type { Client } from "./helpers";

/** A live connection as a browser tab would open it, recording every event it receives. */
export interface LiveSocket {
  socket: Socket;
  events: ServerEvent[];
  /** Resolves with the first event (already received or still to come) that matches. */
  next<T extends ServerEvent["type"]>(type: T, match?: (e: Extract<ServerEvent, { type: T }>) => boolean, timeoutMs?: number): Promise<Extract<ServerEvent, { type: T }>>;
  close(): void;
}

const open: Socket[] = [];

export async function connect(base: string, client?: Client, headers: Record<string, string> = {}): Promise<LiveSocket> {
  const cookie = client?.sessionCookie;
  const socket = io(base, {
    path: SOCKET_PATH,
    transports: ["websocket"],
    reconnection: false,
    extraHeaders: { ...headers, ...(cookie ? { cookie } : {}) },
  });
  open.push(socket);
  const events: ServerEvent[] = [];
  const waiters = new Set<() => void>();
  socket.on("event", (e: ServerEvent) => {
    events.push(e);
    for (const w of waiters) w();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return {
    socket,
    events,
    next(type, match = () => true, timeoutMs = 5_000) {
      type E = Extract<ServerEvent, { type: typeof type }>;
      const find = () => events.find((e): e is E => e.type === type && match(e as E));
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = find();
          if (!hit) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(hit);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no ${type} event within ${timeoutMs} ms; got ${JSON.stringify(events.map((e) => e.type))}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      });
    },
    close: () => socket.close(),
  };
}

/** Lets in-flight NOTIFYs arrive, so a test can assert that something did NOT happen. */
export const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

export function closeAllSockets(): void {
  for (const s of open.splice(0)) s.close();
}
