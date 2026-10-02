import 'reflect-metadata';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';

async function bootstrap() {
  const config = loadConfig();
  mkdirSync(dirname(config.dbPath), { recursive: true, mode: 0o700 }); // only applies if the directory is new
  // bodyParser: false, so the MCP SDK reads and validates the raw body itself.
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  await app.listen(config.port, config.host);
  console.log(`MCP server (pid ${process.pid}) listening on http://${config.host}:${config.port}/mcp`);
}
void bootstrap();
