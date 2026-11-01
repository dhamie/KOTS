import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { loadConfig } from "./config";
import { API_APP_OPTIONS, configureApp } from "./configure";

/** If a graceful shutdown hasn't finished by then, exit anyway, so a restart or deploy never waits on this process. */
const SHUTDOWN_DEADLINE_MS = 10_000;

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        Logger.error(`Shutdown didn't finish within ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting.`, "Bootstrap");
        process.exit(1);
      }, SHUTDOWN_DEADLINE_MS).unref();
    });
  }
  const app = await NestFactory.create(ApiModule.forConfig(config), API_APP_OPTIONS);
  configureApp(app, config);
  await app.listen(config.apiPort);
  Logger.log(`KOTS API on http://localhost:${config.apiPort}/api`, "Bootstrap");
}

void bootstrap();
