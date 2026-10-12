import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import { SOCKET_PATH, type ServerEvent } from "@kots/shared";
import { Client } from "pg";
import { Server, type Socket } from "socket.io";
import { CONFIG } from "../../common/tokens";
import type { ServerConfig } from "../../config";
import { readCookie, SESSION_COOKIE } from "../auth/cookies";
import { SessionsService } from "../auth/sessions.service";
import { MembershipsService } from "../families/memberships.service";
import { EVENTS_CHANNEL, rooms, type Envelope } from "./realtime.service";

interface SocketData {
  playerId: string;
  sessionId: string;
  /** Bumped by each room sync, so a slow, older sync can't overwrite a newer one. */
  syncs: number;
}

const RECONNECT_MS = 2_000;

/**
 * Socket.IO on the api's HTTP server. It only pushes: commands go over HTTP. Events arrive through Postgres
 * LISTEN on one dedicated connection, from this process or the worker, and go to this process's own sockets.
 * With more api instances each one listens and serves its own sockets, so no shared adapter is needed.
 */
@Injectable()
export class RealtimeGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(RealtimeGateway.name);
  private io?: Server;
  private listener?: Client;
  private closing = false;

  constructor(
    @Inject(CONFIG) private readonly config: ServerConfig,
    private readonly adapterHost: HttpAdapterHost,
    private readonly sessions: SessionsService,
    private readonly memberships: MembershipsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // WebSocket only: no long-polling fallback, so a second api instance needs no sticky sessions.
    this.io = new Server(this.adapterHost.httpAdapter.getHttpServer(), { path: SOCKET_PATH, transports: ["websocket"], serveClient: false });
    this.io.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (err: Error) => next(err),
      );
    });
    this.io.on("connection", (socket) => void this.onConnection(socket));
    await this.listen(false);
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    await this.listener?.end().catch(() => undefined);
    this.io?.disconnectSockets(true);
    // Not io.close(): that also closes the HTTP server, which Nest closes itself.
    this.io?.engine.close();
  }

  // ── Connections ──────────────────────────────────────────────────────────

  /** The same checks as an HTTP request: an allowed Origin (browsers always send one) and a live session cookie. */
  private async authenticate(socket: Socket): Promise<void> {
    const origin = socket.handshake.headers.origin;
    if (origin && !this.config.allowedOrigins.includes(origin)) throw new Error("ORIGIN_REJECTED");
    const token = readCookie(socket.handshake.headers.cookie, SESSION_COOKIE);
    const auth = token ? await this.sessions.resolve(token) : undefined;
    if (!auth) throw new Error("UNAUTHENTICATED");
    socket.data = { playerId: auth.playerId, sessionId: auth.sessionId, syncs: 0 } satisfies SocketData;
  }

  private async onConnection(socket: Socket): Promise<void> {
    const data = socket.data as SocketData;
    // The player's room first, so a membership change from here on reaches this socket and re-syncs it.
    await socket.join([rooms.player(data.playerId), rooms.public]);
    await this.syncRooms(socket);
  }

  /** Puts the socket in its player's current family room, and in no other. */
  private async syncRooms(socket: Socket): Promise<void> {
    const data = socket.data as SocketData;
    const sync = ++data.syncs;
    const member = await this.memberships.memberOf(data.playerId);
    if (sync !== data.syncs || socket.disconnected) return;
    const want = member ? rooms.family(member.familyId) : null;
    for (const room of socket.rooms) if (room.startsWith("family:") && room !== want) await socket.leave(room);
    if (want) await socket.join(want);
  }

  /** This process's sockets in a room. */
  private socketsIn(room: string): Socket[] {
    const ids = this.io?.sockets.adapter.rooms.get(room) ?? new Set<string>();
    return [...ids].map((id) => this.io!.sockets.sockets.get(id)).filter((s): s is Socket => s !== undefined);
  }

  // ── Events from Postgres ─────────────────────────────────────────────────

  private async listen(reconnecting: boolean): Promise<void> {
    if (this.closing) return;
    const client = new Client({ connectionString: this.config.databaseUrl });
    const retry = () => {
      if (this.closing || this.listener !== client) return;
      this.listener = undefined;
      client.end().catch(() => undefined);
      setTimeout(() => void this.listen(true), RECONNECT_MS).unref();
    };
    client.on("error", (err) => {
      this.logger.warn(`event listener lost: ${err.message}`);
      retry();
    });
    client.on("end", retry);
    client.on("notification", (msg) => {
      if (msg.channel === EVENTS_CHANNEL && msg.payload) this.dispatch(msg.payload);
    });
    try {
      this.listener = client;
      await client.connect();
      await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    } catch (err) {
      // Keep serving HTTP (health reports the database) and keep trying in the background.
      this.logger.warn(`event listener can't connect: ${(err as Error).message}`);
      retry();
      return;
    }
    // Events published while the listener was down are lost; clients reload over HTTP.
    if (reconnecting) this.emit([rooms.public], { type: "resync" });
  }

  private dispatch(payload: string): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(payload) as Envelope;
    } catch {
      this.logger.warn("unreadable event dropped");
      return;
    }
    if ("rooms" in envelope) return this.emit(envelope.rooms, envelope.event);
    if (envelope.control === "player") {
      for (const socket of this.socketsIn(rooms.player(envelope.playerId))) {
        // Out of every family room at once, so a kicked player hears nothing more; syncRooms re-joins the current one.
        for (const room of socket.rooms) if (room.startsWith("family:")) void socket.leave(room);
        void this.syncRooms(socket);
      }
      return this.emit([rooms.player(envelope.playerId)], { type: "me.changed" });
    }
    for (const socket of this.io?.sockets.sockets.values() ?? []) {
      if ((socket.data as SocketData).sessionId === envelope.sessionId) socket.disconnect(true);
    }
  }

  private emit(to: string[], event: ServerEvent): void {
    if (to.length > 0) this.io?.to(to).emit("event", event);
  }
}
