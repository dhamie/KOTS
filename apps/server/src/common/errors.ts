import type { ErrorCode } from "@kots/shared";

/** A deliberate API error. The exception filter turns it into the standard error body. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "VALIDATION_FAILED", message, details);
export const unauthenticated = () => new AppError(401, "UNAUTHENTICATED", "Log in first.");
export const forbidden = (message = "You are not allowed to do that.") => new AppError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (code: ErrorCode, message: string) => new AppError(409, code, message);

/** Finds the Postgres error under Drizzle's wrapper (DrizzleQueryError keeps it in `cause`). */
export function pgError(err: unknown): { code?: string; constraint?: string } | undefined {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ("code" in e && typeof (e as { code: unknown }).code === "string" && /^[0-9A-Z]{5}$/.test((e as { code: string }).code)) {
      return e as { code?: string; constraint?: string };
    }
  }
  return undefined;
}

/** The name of the unique constraint a statement violated, if that's why it failed. */
export function uniqueViolation(err: unknown): string | undefined {
  const pg = pgError(err);
  return pg?.code === "23505" ? (pg.constraint ?? "") : undefined;
}
