import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { originCheck } from "./common/origin.middleware";
import { requestIdMiddleware } from "./common/request-id.middleware";
import { requestLog } from "./common/request-log.middleware";
import type { ServerConfig } from "./config";

/**
 * Options for NestFactory.create, shared by main.api.ts and the tests. On shutdown, connections still open once
 * in-flight requests are done are closed rather than waited for: a client or proxy that leaves one half-open would
 * otherwise keep the process alive for ever (found in the Phase 10b load tests).
 */
export const API_APP_OPTIONS = { forceCloseConnections: true } as const;

/** Shared by main.api.ts and the tests. All HTTP routes live under /api so the client can proxy one path. */
export function configureApp(app: INestApplication, config: ServerConfig): void {
  const express = app as NestExpressApplication;
  // Behind Caddy, req.ip (the per-IP rate limits' key) must be the player's address, not the proxy's.
  if (config.trustProxy > 0) express.set("trust proxy", config.trustProxy);
  express.useBodyParser("json", { limit: "16kb" });
  express.use(requestIdMiddleware);
  if (config.logRequests) express.use(requestLog);
  express.use(originCheck(config.allowedOrigins));
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
}
