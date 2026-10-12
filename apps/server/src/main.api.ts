import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ApiModule } from "./api.module";
import { loadConfig } from "./config";
import { configureApp } from "./configure";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(ApiModule.forConfig(config));
  configureApp(app, config);
  await app.listen(config.apiPort);
  Logger.log(`KOTS API on http://localhost:${config.apiPort}/api`, "Bootstrap");
}

void bootstrap();
