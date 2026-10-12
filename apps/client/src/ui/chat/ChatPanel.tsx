import { CHAT, REPORT_REASONS, type ReportReason } from "@kots/content";
import { checkFamilyAction } from "@kots/rules";
import type { ChatChannel, ChatMessage, MeResponse, Report } from "@kots/shared";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../../api/http";
import { onLive } from "../../api/live";
import { when } from "../format";
import { useAction } from "../useAction";
import { DiplomacyRooms, RoomProposals } from "./Diplomacy";
import type { ChatState } from "./useChat";

export type ChatTab = "family" | "public" | "direct" | "diplomacy" | "reports";

/** Chat drawer: the family channel, the city channel, direct messages, diplomacy rooms and, for moderators, open reports. */
export function ChatPanel(props: { me: MeResponse; chat: ChatState; tab: ChatTab | null; onTab: (tab: ChatTab) => void }) {
  const { me, chat, onTab: setTab } = props;
  const tab = props.tab ?? (me.family ? "family" : "public");
  const [directId, setDirectId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState<string | null>(null);
  const family = chat.channels.find((c) => c.kind === "family");
  const city = chat.channels.find((c) => c.kind === "public");
  const directs = chat.channels.filter((c) => c.kind === "direct");
  const rooms = chat.channels.filter((c) => c.kind === "diplomacy");
  const canTalk = me.family !== null && checkFamilyAction(me.family.role, { kind: "diplomacy_talk" }).ok;
  const open =
    tab === "family"
      ? family
      : tab === "public"
        ? city
        : tab === "direct"
          ? directs.find((c) => c.id === directId)
          : tab === "diplomacy"
            ? rooms.find((c) => c.id === roomId)
            : undefined;

  const { setOpen } = chat;
  useEffect(() => {
    setOpen(open?.id ?? null);
    return () => setOpen(null);
  }, [open?.id, setOpen]);

  const tabs: [ChatTab, string, number][] = [
    ...(family ? [["family", "Family", family.unread] as [ChatTab, string, number]] : []),
    ["public", CHAT.publicChannelName, city?.unread ?? 0],
    ["direct", "Direct", directs.reduce((n, c) => n + c.unread, 0)],
    ...(canTalk ? [["diplomacy", "Diplomacy", rooms.reduce((n, c) => n + c.unread, 0)] as [ChatTab, string, number]] : []),
    ...(me.moderator ? [["reports", "Reports", 0] as [ChatTab, string, number]] : []),
  ];

  return (
    <section className="panel side chat" aria-label="Chat">
      <h2>Chat</h2>
      <div className="tabs primary" role="group" aria-label="Chat channels">
        {tabs.map(([t, label, unread]) => (
          <button key={t} type="button" className={tab === t ? "active" : ""} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {label}
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
        ))}
      </div>
      {tab === "reports" && <Reports />}
      {tab === "direct" && !open && <Directs channels={directs} chat={chat} onOpen={setDirectId} />}
      {tab === "direct" && open && (
        <button type="button" className="link small" onClick={() => setDirectId(null)}>
          ← All direct messages
        </button>
      )}
      {tab === "diplomacy" && !open && <DiplomacyRooms rooms={rooms} chat={chat} onOpen={setRoomId} />}
      {tab === "diplomacy" && open && (
        <>
          <button type="button" className="link small" onClick={() => setRoomId(null)}>
            ← All rooms
          </button>
          <RoomProposals key={open.id} room={open} family={me.family!} />
        </>
      )}
      {open && <Conversation key={open.id} channel={open} me={me} chat={chat} />}
    </section>
  );
}

function Directs(props: { channels: ChatChannel[]; chat: ChatState; onOpen: (id: string) => void }) {
  const { channels, chat, onOpen } = props;
  const [handle, setHandle] = useState("");
  const { busy, error, run } = useAction();

  const start = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const channel = await api.openDirect(handle.trim());
      chat.reload();
      setHandle("");
      onOpen(channel.id);
    });
  };

  return (
    <div>
      <form className="inline" onSubmit={(e) => void start(e)}>
        <input aria-label="Player handle" value={handle} maxLength={20} onChange={(e) => setHandle(e.target.value)} placeholder="Message a player by handle" />
        <button type="submit" disabled={busy || handle.trim().length < 3}>
          Open
        </button>
      </form>
      {error && <p className="error">{error}</p>}
      {channels.length === 0 && <p className="muted small">No conversations yet.</p>}
      <ul className="list">
        {channels.map((c) => (
          <li key={c.id}>
            <button type="button" className="link" onClick={() => onOpen(c.id)}>
              {c.name}
            </button>
            <span className="muted small">
              {c.unread > 0 && <span className="badge">{c.unread}</span>}
              {c.lastMessageAt ? when(c.lastMessageAt) : ""}
            </span>
          </li>
        ))}
      </ul>
      {chat.blocked.length > 0 && (
        <details>
          <summary className="small">Blocked players ({chat.blocked.length})</summary>
          <ul className="list">
            {chat.blocked.map((b) => (
              <li key={b.id}>
                <span>{b.handle}</span>
                <button type="button" className="link" onClick={() => void api.unblock(b.id).then(chat.reloadBlocks)}>
                  Unblock
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** One channel's messages, oldest at the top, with live updates and a composer. */
function Conversation(props: { channel: ChatChannel; me: MeResponse; chat: ChatState }) {
  const { channel, me, chat } = props;
  // Newest first, as the server pages them; reversed for display.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const blocked = new Set(chat.blocked.map((b) => b.id));

  const load = useCallback(
    () =>
      run(async () => {
        const page = await api.messages(channel.id);
        setMessages(page.items);
        setOlder(page.nextCursor);
      }),
    [channel.id],
  );
  useEffect(() => {
    void load();
  }, [load, chat.blocked]);

  useEffect(
    () =>
      onLive((e) => {
        if (e.type === "resync") void load();
        if (e.type === "chat.message" && e.message.channelId === channel.id) {
          setMessages((list) => (list.some((m) => m.id === e.message.id) ? list : [e.message, ...list]));
        }
        if (e.type === "chat.deleted" && e.channelId === channel.id) setMessages((list) => list.filter((m) => m.id !== e.messageId));
      }),
    [channel.id, load],
  );

  // Whatever is on screen has been read; the newest message stays in view.
  const newest = messages[0]?.id;
  const { markSeen } = chat;
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    markSeen(channel.id);
    if (newest) api.markRead(channel.id, newest).catch(() => undefined);
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [channel.id, newest, markSeen]);

  const loadOlder = () =>
    run(async () => {
      const page = await api.messages(channel.id, older!);
      setMessages((list) => [...list, ...page.items]);
      setOlder(page.nextCursor);
    });

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    await run(async () => {
      const sent = await api.sendMessage(channel.id, body);
      setMessages((list) => (list.some((m) => m.id === sent.id) ? list : [sent, ...list]));
      setDraft("");
    });
  };

  const shown = messages.filter((m) => !m.author || !blocked.has(m.author.id)).reverse();

  return (
    <div className="conversation">
      <h3>{channel.kind === "direct" ? `With ${channel.name}` : channel.name}</h3>
      {older && (
        <button type="button" className="link small" disabled={busy} onClick={() => void loadOlder()}>
          Load older messages
        </button>
      )}
      <ol ref={list} className="messages" data-testid="messages" aria-live="polite">
        {shown.length === 0 && <li className="muted small">No messages yet.</li>}
        {shown.map((m) => (
          <li key={m.id} className={m.author?.id === me.player.id ? "mine" : ""}>
            <div className="meta">
              <strong>{m.author?.handle ?? "unknown"}</strong> <span className="muted">{when(m.createdAt)}</span>
              <button type="button" className="link more" aria-label={`Actions for message from ${m.author?.handle ?? "unknown"}`} onClick={() => setMenu(menu === m.id ? null : m.id)}>
                ⋯
              </button>
            </div>
            <div className="body">{m.body}</div>
            {menu === m.id && <MessageActions message={m} me={me} chat={chat} onDone={() => setMenu(null)} onDeleted={() => setMessages((list) => list.filter((x) => x.id !== m.id))} />}
          </li>
        ))}
      </ol>
      {error && <p className="error">{error}</p>}
      <form className="composer" onSubmit={(e) => void send(e)}>
        <input aria-label="Message" value={draft} maxLength={CHAT.maxMessageLength} onChange={(e) => setDraft(e.target.value)} placeholder="Write a message" />
        <button type="submit" disabled={busy || draft.trim().length === 0}>
          Send
        </button>
      </form>
    </div>
  );
}

function MessageActions(props: { message: ChatMessage; me: MeResponse; chat: ChatState; onDone: () => void; onDeleted: () => void }) {
  const { message, me, chat, onDone, onDeleted } = props;
  const own = message.author?.id === me.player.id;
  const [reason, setReason] = useState<ReportReason>("abuse");
  const [reported, setReported] = useState(false);
  const { busy, error, run } = useAction();

  return (
    <div className="actions small">
      {(own || me.moderator) && (
        <button type="button" disabled={busy} onClick={() => void run(() => api.deleteMessage(message.id)).then((ok) => ok && onDeleted())}>
          Delete
        </button>
      )}
      {!own && message.author && (
        <>
          {reported ? (
            <span className="muted">Reported. Thank you.</span>
          ) : (
            <span className="report">
              <select aria-label="Report reason" value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
                {REPORT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <button type="button" disabled={busy} onClick={() => void run(() => api.reportMessage(message.id, { reason })).then((ok) => ok && setReported(true))}>
                Report
              </button>
            </span>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() => api.block(message.author!.handle)).then((ok) => {
                if (!ok) return;
                chat.reloadBlocks();
                onDone();
              })
            }
          >
            Block {message.author.handle}
          </button>
        </>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** Open reports, for moderators. Deleting the message closes its reports; both actions are audited on the server. */
function Reports() {
  const [reports, setReports] = useState<Report[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(() => run(async () => setReports(await api.reports())), []);
  useEffect(() => {
    void load();
  }, [load]);
  const act = async (action: () => Promise<unknown>) => {
    await run(action);
    void load();
  };

  return (
    <div data-testid="reports">
      {error && <p className="error">{error}</p>}
      {reports.length === 0 && <p className="muted small">No open reports.</p>}
      <ul className="list offers">
        {reports.map((r) => (
          <li key={r.id}>
            <div>
              <div className="small">
                <strong>{r.message.author?.handle ?? "unknown"}</strong> in {r.channelKind} chat, {when(r.message.createdAt)}
              </div>
              <div className="body">{r.message.body}</div>
              <div className="muted small">
                {r.reason} by {r.reporter?.handle ?? "unknown"}
                {r.note ? `: ${r.note}` : ""}
              </div>
            </div>
            <div className="controls">
              <button type="button" disabled={busy} onClick={() => void act(() => api.deleteMessage(r.message.id))}>
                Delete message
              </button>
              <button type="button" disabled={busy} onClick={() => void act(() => api.dismissReport(r.id))}>
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
