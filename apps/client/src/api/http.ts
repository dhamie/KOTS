import {
  AttackQuote,
  Battle,
  BattleList,
  ActivityPage,
  ApiErrorBody,
  BlockList,
  ChatChannel,
  ChatChannelList,
  ChatMessage,
  ChatPage,
  NotificationPage,
  Proposal,
  ReportList,
  RoomState,
  type ProposalTerms,
  type ReportRequest,
  DistrictSummaryList,
  DistrictTerritories,
  FamilyDetail,
  FamilyHoldings,
  HealthResponse,
  Henchman,
  HenchmanList,
  Inventory,
  InvitationList,
  Invitation,
  LedgerPage,
  Market,
  MarketOrder,
  MeResponse,
  RecruitBoard,
  TerritoryDetail,
  Treasury,
  WorldEventList,
  type FamilyMember,
  Trade,
  TradePage,
  type OfferRequest,
  type OrderRequest,
  type TradeBox,
} from "@kots/shared";
import type { Tactic } from "@kots/content";
import type { z } from "zod";

/** An API error in the standard shape; `code` is stable, `message` is shown to the player. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T extends z.ZodType>(method: string, path: string, schema: T | null, body?: unknown, headers: Record<string, string> = {}): Promise<z.infer<T>> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = ApiErrorBody.safeParse(await res.json().catch(() => null));
    throw parsed.success
      ? new ApiError(res.status, parsed.data.code, parsed.data.message)
      : new ApiError(res.status, "INTERNAL", `HTTP ${res.status}`);
  }
  // A null schema means the endpoint answers 204 with no body.
  return (schema ? schema.parse(await res.json()) : undefined) as z.infer<T>;
}

/** The health endpoint answers 503 with a valid body when the database is down, so parse both. */
export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok && res.status !== 503) throw new Error(`HTTP ${res.status}`);
  return HealthResponse.parse(await res.json());
}

export const api = {
  register: (email: string, password: string, handle: string) => request("POST", "/auth/register", null, { email, password, handle }),
  login: (email: string, password: string) => request("POST", "/auth/login", null, { email, password }),
  logout: () => request("POST", "/auth/logout", null, {}),
  me: () => request("GET", "/me", MeResponse),
  myInvitations: () => request("GET", "/me/invitations", InvitationList),
  acceptInvitation: (id: string) => request("POST", `/invitations/${id}/accept`, FamilyDetail, {}),
  declineInvitation: (id: string) => request("POST", `/invitations/${id}/decline`, null, {}),

  createFamily: (name: string, tag: string) => request("POST", "/families", FamilyDetail, { name, tag }),
  family: (id: string) => request("GET", `/families/${id}`, FamilyDetail),
  activity: (id: string) => request("GET", `/families/${id}/activity?limit=20`, ActivityPage),
  familyInvitations: (id: string) => request("GET", `/families/${id}/invitations`, InvitationList),
  invite: (id: string, handle: string) => request("POST", `/families/${id}/invitations`, Invitation, { handle }),
  revokeInvitation: (id: string, invitationId: string) => request("DELETE", `/families/${id}/invitations/${invitationId}`, null),
  setRole: (id: string, playerId: string, role: FamilyMember["role"]) => request("PATCH", `/families/${id}/members/${playerId}`, FamilyDetail, { role }),
  kick: (id: string, playerId: string) => request("DELETE", `/families/${id}/members/${playerId}`, FamilyDetail),
  leave: (id: string) => request("POST", `/families/${id}/leave`, null, {}),
  transferLeadership: (id: string, playerId: string) => request("POST", `/families/${id}/transfer-leadership`, FamilyDetail, { playerId }),
  disband: (id: string) => request("DELETE", `/families/${id}`, null),

  districts: () => request("GET", "/map/districts", DistrictSummaryList),
  districtTerritories: (district: string) => request("GET", `/map/territories?district=${encodeURIComponent(district)}`, DistrictTerritories),

  territory: (slug: string) => request("GET", `/territories/${slug}`, TerritoryDetail),
  claim: (slug: string) => request("POST", `/territories/${slug}/claim`, TerritoryDetail, {}),
  abandon: (slug: string) => request("POST", `/territories/${slug}/abandon`, null, {}),
  holdings: (familyId: string) => request("GET", `/families/${familyId}/territories`, FamilyHoldings),
  treasury: (familyId: string) => request("GET", `/families/${familyId}/treasury`, Treasury),
  treasuryEntries: (familyId: string) => request("GET", `/families/${familyId}/treasury/entries?limit=20`, LedgerPage),

  recruits: (familyId: string) => request("GET", `/families/${familyId}/recruits`, RecruitBoard),
  hire: (familyId: string, slot: number) => request("POST", `/families/${familyId}/recruits`, Henchman, { slot }),
  henchmen: (familyId: string) => request("GET", `/families/${familyId}/henchmen`, HenchmanList),
  assignHenchman: (id: string, territory: string | null) => request("PATCH", `/henchmen/${id}`, Henchman, { territory }),
  dismissHenchman: (id: string) => request("POST", `/henchmen/${id}/dismiss`, null, {}),

  market: (slug: string) => request("GET", `/markets/${slug}`, Market),
  /** `key` identifies this order attempt: reuse it to retry the same order safely, use a new one for a new order. */
  order: (slug: string, order: OrderRequest, key: string) => request("POST", `/markets/${slug}/orders`, MarketOrder, order, { "idempotency-key": key }),
  inventory: (familyId: string) => request("GET", `/families/${familyId}/inventory`, Inventory),

  trades: (familyId: string, box: TradeBox) => request("GET", `/families/${familyId}/trades?box=${box}&limit=${box === "closed" ? 10 : 50}`, TradePage),
  proposeTrade: (familyId: string, offer: OfferRequest, key: string) => request("POST", `/families/${familyId}/trades`, Trade, offer, { "idempotency-key": key }),
  acceptTrade: (id: string) => request("POST", `/trades/${id}/accept`, Trade, {}),
  declineTrade: (id: string) => request("POST", `/trades/${id}/decline`, Trade, {}),
  cancelTrade: (id: string) => request("POST", `/trades/${id}/cancel`, Trade, {}),

  channels: () => request("GET", "/chat/channels", ChatChannelList),
  openDirect: (handle: string) => request("POST", "/chat/direct", ChatChannel, { handle }),
  messages: (channelId: string, before?: string) => request("GET", `/chat/channels/${channelId}/messages${before ? `?before=${before}` : ""}`, ChatPage),
  sendMessage: (channelId: string, body: string) => request("POST", `/chat/channels/${channelId}/messages`, ChatMessage, { body }),
  markRead: (channelId: string, upTo: string) => request("POST", `/chat/channels/${channelId}/read`, null, { upTo }),
  deleteMessage: (id: string) => request("DELETE", `/chat/messages/${id}`, null),
  reportMessage: (id: string, report: ReportRequest) => request("POST", `/chat/messages/${id}/report`, null, report),
  blocks: () => request("GET", "/blocks", BlockList),
  block: (handle: string) => request("POST", "/blocks", BlockList, { handle }),
  unblock: (playerId: string) => request("DELETE", `/blocks/${playerId}`, null),
  reports: () => request("GET", "/moderation/reports", ReportList),
  dismissReport: (id: string) => request("POST", `/moderation/reports/${id}/dismiss`, null, {}),

  openRoom: (tag: string) => request("POST", "/diplomacy/rooms", ChatChannel, { tag }),
  room: (roomId: string) => request("GET", `/diplomacy/rooms/${roomId}`, RoomState),
  propose: (roomId: string, terms: ProposalTerms, key: string) => request("POST", `/diplomacy/rooms/${roomId}/proposals`, Proposal, { terms }, { "idempotency-key": key }),
  signProposal: (id: string) => request("POST", `/proposals/${id}/sign`, Proposal, {}),
  declineProposal: (id: string) => request("POST", `/proposals/${id}/decline`, Proposal, {}),
  withdrawProposal: (id: string) => request("POST", `/proposals/${id}/withdraw`, Proposal, {}),

  attackQuote: (slug: string) => request("GET", `/territories/${slug}/attack`, AttackQuote),
  declareBattle: (slug: string) => request("POST", `/territories/${slug}/battles`, Battle, {}),
  battles: (familyId: string) => request("GET", `/families/${familyId}/battles`, BattleList),
  battle: (id: string) => request("GET", `/battles/${id}`, Battle),
  commitHenchmen: (id: string, henchmen: string[]) => request("POST", `/battles/${id}/commit`, Battle, { henchmen }),
  releaseHenchmen: (id: string, henchmen: string[]) => request("POST", `/battles/${id}/release`, Battle, { henchmen }),
  battleOrder: (id: string, round: number, tactic: Tactic) => request("POST", `/battles/${id}/orders`, Battle, { round, tactic }),
  withdrawBattle: (id: string) => request("POST", `/battles/${id}/withdraw`, Battle, {}),

  events: () => request("GET", "/events", WorldEventList),

  notifications: () => request("GET", "/notifications", NotificationPage),
  readNotification: (id: string) => request("POST", `/notifications/${id}/read`, null, {}),
  readAllNotifications: () => request("POST", "/notifications/read-all", null, {}),
};
