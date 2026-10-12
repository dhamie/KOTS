export const naira = (n: number) => `${n < 0 ? "−" : ""}₦${Math.abs(n).toLocaleString("en-NG")}`;

export const when = (iso: string) => new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Time left until `iso`, coarse: "in 5h 59m", "in 42s", or "any moment now" once it has passed (the server decides). */
export function countdown(iso: string, now: number): string {
  const s = Math.floor((new Date(iso).getTime() - now) / 1000);
  if (s <= 0) return "any moment now";
  const [h, m] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60)];
  return h > 0 ? `in ${h}h ${m}m` : m > 0 ? `in ${m}m ${s % 60}s` : `in ${s}s`;
}
