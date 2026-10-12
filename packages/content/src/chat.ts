/** Chat limits. The server enforces them; the client uses them to guide input. */
export const CHAT = {
  maxMessageLength: 500,
  /** Per player, across all channels. */
  rateLimit: { messages: 5, seconds: 10 },
  publicChannelName: "Lagos",
  pageSize: 50,
} as const;

export const REPORT_REASONS = ["spam", "abuse", "cheating", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
