import { All, Controller, Inject, Req, Res } from '@nestjs/common';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { BASKET_STORE, type BasketStore } from '../basket/basket.store.js';
import { CONFIG, type AppConfig } from '../config.js';
import { buildBasketServer } from './basket-server.js';

@Controller('mcp')
export class McpController {
  private readonly handle: ReturnType<typeof toNodeHandler>;
  private readonly validateHost: ReturnType<typeof hostHeaderValidation>;
  private readonly validateOrigin: ReturnType<typeof originValidation>;

  constructor(@Inject(BASKET_STORE) store: BasketStore, @Inject(CONFIG) config: AppConfig) {
    // DNS-rebinding protection. Defaults are localhost only; behind a load balancer set ALLOWED_HOSTS.
    this.validateHost = hostHeaderValidation(config.allowedHosts);
    this.validateOrigin = originValidation(config.allowedOrigins);
    // 'reject' = 2026-07-28 only. Drop it to also serve 2025-era clients through the SDK's stateless fallback.
    const mcp = createMcpHandler(() => buildBasketServer(store), { legacy: 'reject' });
    this.handle = toNodeHandler(mcp);
  }

  // One route for every method: the SDK decides what is valid (POST only, no GET stream, no DELETE session).
  @All()
  async mcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    // Guards answer 403 themselves and return false.
    if (!this.validateHost(req, res) || !this.validateOrigin(req, res)) return;
    await this.handle(req, res);
  }
}
