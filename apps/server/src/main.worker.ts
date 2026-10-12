import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { systemClock } from "./common/clock";
import { loadConfig } from "./config";
import { WorkerModule } from "./worker.module";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.createApplicationContext(WorkerModule.forDatabase(config.databaseUrl, systemClock, config.workerQueues));
  app.enableShutdownHooks();
  Logger.log(`KOTS worker running${config.workerQueues ? ` (queues: ${config.workerQueues.join(", ")})` : ""}`, "Bootstrap");
}

void bootstrap();
