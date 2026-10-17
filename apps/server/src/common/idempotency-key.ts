import { IdempotencyKey } from "@kots/shared";
import { badRequest } from "./errors";

/** Reads a required Idempotency-Key header. `what` names the request in the error ("order", "offer", "proposal"). */
export function idempotencyKey(value: string | undefined, what: string): string {
  const parsed = IdempotencyKey.safeParse(value);
  if (!parsed.success) throw badRequest(`Send a unique Idempotency-Key header (8–100 letters, digits, '_', ':' or '-') with each ${what}.`);
  return parsed.data;
}

/** JSON with object keys sorted, for comparing a retried request with the stored one (jsonb reorders keys). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
}
