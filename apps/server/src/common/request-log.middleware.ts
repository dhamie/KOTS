import type { NextFunction, Request, Response } from "express";
import { requestIdOf } from "./request-id.middleware";

/**
 * One line when a request arrives and one when it ends ("done" with status, or "aborted" if the client went away),
 * with the time taken. A request that stalls shows up as an arrival with no end, or not at all.
 */
export function requestLog(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const tag = `${requestIdOf(req).slice(0, 8)} ${req.method} ${req.originalUrl}`;
  console.log(`${new Date(start).toISOString()} req  ${tag}`);
  let ended = false;
  res.on("finish", () => {
    ended = true;
    console.log(`${new Date().toISOString()} done ${tag} ${res.statusCode} ${Date.now() - start}ms`);
  });
  res.on("close", () => {
    if (!ended) console.log(`${new Date().toISOString()} aborted ${tag} ${Date.now() - start}ms`);
  });
  next();
}
