import { DIPLOMACY } from "@kots/content";
import { z } from "zod";
import { FamilyTag } from "./families";

const Timestamp = z.iso.datetime({ offset: true });
const FamilyRef = z.object({ id: z.uuid(), name: z.string(), tag: z.string() });

/** `POST /api/diplomacy/rooms`: opens (or finds) the room with the family that has this tag. */
export const OpenRoomRequest = z.strictObject({ tag: FamilyTag });
export type OpenRoomRequest = z.infer<typeof OpenRoomRequest>;

/** Checked further by rules `checkProposalTerms`, and against the game state when the proposal runs. */
export const ProposalTerms = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("territory_transfer"),
    territory: z.string().min(1).max(64),
    /** Which side hands the territory over. The other side pays `price`. */
    giver: z.enum(["proposer", "recipient"]),
    price: z.number().int().min(0).max(DIPLOMACY.maxPrice),
  }),
  z.strictObject({ kind: z.literal("ceasefire"), hours: z.number().int() }),
]);
export type ProposalTerms = z.infer<typeof ProposalTerms>;

export const ProposeRequest = z.strictObject({ terms: ProposalTerms });
export type ProposeRequest = z.infer<typeof ProposeRequest>;

export const PROPOSAL_STATUSES = ["open", "executed", "declined", "withdrawn", "expired"] as const;

export const Proposal = z.object({
  id: z.uuid(),
  roomId: z.uuid(),
  /** The proposing family. */
  from: FamilyRef,
  to: FamilyRef,
  terms: ProposalTerms,
  status: z.enum(PROPOSAL_STATUSES),
  /** Families that have signed, and who signed for them. It runs when both have. */
  signatures: z.array(z.object({ familyId: z.uuid(), by: z.string().nullable(), at: Timestamp })),
  createdBy: z.string().nullable(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
  closedAt: Timestamp.nullable(),
});
export type Proposal = z.infer<typeof Proposal>;

/** `GET /api/diplomacy/rooms/:id`: the room's proposals (open first, then the latest closed) and any ceasefire in force. */
export const RoomState = z.object({
  proposals: z.array(Proposal),
  ceasefireUntil: Timestamp.nullable(),
});
export type RoomState = z.infer<typeof RoomState>;
