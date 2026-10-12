import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const REQUEST_ID = Symbol("requestId");
const VALID = /^[A-Za-z0-9._-]{1,64}$/;

/** Reuses a sane incoming X-Request-Id (e.g. from a load balancer) or makes one, and echoes it back. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header("x-request-id");
  const id = incoming && VALID.test(incoming) ? incoming : randomUUID();
  (req as unknown as Record<symbol, string>)[REQUEST_ID] = id;
  res.setHeader("X-Request-Id", id);
  next();
}

export function requestIdOf(req: Request): string {
  return (req as unknown as Record<symbol, string | undefined>)[REQUEST_ID] ?? "none";
}
