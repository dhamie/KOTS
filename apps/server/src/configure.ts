import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { originCheck } from "./common/origin.middleware";
import { requestIdMiddleware } from "./common/request-id.middleware";
import { requestLog } from "./common/request-log.middleware";
import type { ServerConfig } from "./config";

/** Shared by main.api.ts and the tests. All HTTP routes live under /api so the client can proxy one path. */
export function configureApp(app: INestApplication, config: ServerConfig): void {
  const express = app as NestExpressApplication;
  express.useBodyParser("json", { limit: "16kb" });
  express.use(requestIdMiddleware);
  if (config.logRequests) express.use(requestLog);
  express.use(originCheck(config.allowedOrigins));
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
}
