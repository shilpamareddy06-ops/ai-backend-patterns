import { Module } from '@nestjs/common';
import { BASKET_STORE } from './basket/basket.store.js';
import { SqliteBasketStore } from './basket/sqlite-basket.store.js';
import { CONFIG, loadConfig, type AppConfig } from './config.js';
import { McpController } from './mcp/mcp.controller.js';

@Module({
  controllers: [McpController],
  providers: [
    { provide: CONFIG, useFactory: () => loadConfig() },
    { provide: BASKET_STORE, inject: [CONFIG], useFactory: (config: AppConfig) => new SqliteBasketStore(config.dbPath) },
  ],
})
export class AppModule {}
