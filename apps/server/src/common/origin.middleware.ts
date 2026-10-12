import type { NextFunction, Request, Response } from "express";
import { requestIdOf } from "./request-id.middleware";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defence alongside SameSite=Lax cookies: a browser always sends Origin on cross-site writes,
 * so a state-changing request with a foreign Origin is refused. Requests without Origin (curl, tests) pass.
 */
export function originCheck(allowedOrigins: readonly string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.header("origin");
    if (SAFE_METHODS.has(req.method) || !origin || allowedOrigins.includes(origin)) return next();
    res.status(403).json({ code: "ORIGIN_REJECTED", message: "Request origin not allowed.", correlationId: requestIdOf(req) });
  };
}
