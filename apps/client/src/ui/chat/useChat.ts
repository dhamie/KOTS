import type { BlockList, ChatChannel, MeResponse } from "@kots/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/http";
import { onLive } from "../../api/live";

export interface ChatState {
  channels: ChatChannel[];
  blocked: BlockList;
  /** Unread messages across all channels. */
  unread: number;
  /** The channel on screen: its new messages don't count as unread. */
  setOpen: (channelId: string | null) => void;
  /** The player read `channelId`: clear its badge. */
  markSeen: (channelId: string) => void;
  reload: () => void;
  reloadBlocks: () => void;
}

/**
 * Channels, unread counts and the block list, kept while signed in so the toolbar badge stays current with the chat
 * drawer closed. Counts come from the server and are bumped by live messages in between.
 */
export function useChat(me: MeResponse | null): ChatState {
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [blocked, setBlocked] = useState<BlockList>([]);
  const open = useRef<string | null>(null);
  const playerId = me?.player.id;
  const familyId = me?.family?.id;

  const reload = useCallback(() => {
    if (!playerId) return;
    api
      .channels()
      .then((list) => setChannels(list.map((c) => (c.id === open.current ? { ...c, unread: 0 } : c))))
      .catch(() => undefined);
  }, [playerId]);
  const reloadBlocks = useCallback(() => {
    if (playerId) api.blocks().then(setBlocked, () => undefined);
  }, [playerId]);

  // Joining or leaving a family changes the channel list.
  useEffect(() => reload(), [reload, familyId]);
  useEffect(() => reloadBlocks(), [reloadBlocks]);

  const blockedIds = useRef(new Set<string>());
  blockedIds.current = new Set(blocked.map((b) => b.id));
  const known = useRef(new Set<string>());
  known.current = new Set(channels.map((c) => c.id));

  useEffect(
    () =>
      onLive((e) => {
        if (e.type === "resync") reload();
        if (e.type !== "chat.message") return;
        const { channelId, author } = e.message;
        if (author?.id === playerId || (author && blockedIds.current.has(author.id)) || channelId === open.current) return;
        // A direct channel someone else just opened isn't in the list yet.
        if (!known.current.has(channelId)) return reload();
        setChannels((list) => list.map((c) => (c.id === channelId ? { ...c, unread: Math.min(c.unread + 1, 99), lastMessageAt: e.message.createdAt } : c)));
      }),
    [playerId, reload],
  );

  const markSeen = useCallback((channelId: string) => setChannels((list) => list.map((c) => (c.id === channelId ? { ...c, unread: 0 } : c))), []);
  const setOpen = useCallback((channelId: string | null) => {
    open.current = channelId;
  }, []);

  return { channels, blocked, unread: channels.reduce((n, c) => n + c.unread, 0), setOpen, markSeen, reload, reloadBlocks };
}
