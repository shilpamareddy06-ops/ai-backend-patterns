import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { BasketStore } from '../basket/basket.store.js';

// Ids are lowercase UUIDs (that is what randomUUID() returns), so the store's exact-match lookup is safe.
const basketId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'basket_id must be a lowercase UUID')
  .describe('Handle returned by create_basket');
// Trimmed, 1-100 characters, no control characters.
const itemName = z.string().trim().min(1).max(100).regex(/^[^\u0000-\u001f\u007f]+$/, 'name must not contain control characters');

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const unknownBasket = (id: string) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `Unknown basket_id ${id}. Call create_basket first.` }],
});

/**
 * Builds a fresh McpServer. createMcpHandler calls this once per HTTP request,
 * so nothing here may hold state: everything lives in the injected store,
 * and the client carries the basket_id from call to call.
 */
export function buildBasketServer(store: BasketStore): McpServer {
  const server = new McpServer({ name: 'stateless-basket', version: '1.0.0' });

  server.registerTool(
    'create_basket',
    { description: 'Create an empty basket. Returns a basket_id to pass to the other tools.' },
    async () => {
      const basket = await store.create();
      return text(JSON.stringify({ basket_id: basket.id }));
    },
  );

  server.registerTool(
    'add_item',
    {
      description: 'Add qty of an item to a basket.',
      inputSchema: z.object({
        basket_id: basketId,
        name: itemName,
        qty: z.number().int().min(1).max(1000),
      }),
    },
    async ({ basket_id, name, qty }) => {
      const basket = await store.addItem(basket_id, name, qty);
      return basket ? text(JSON.stringify(basket)) : unknownBasket(basket_id);
    },
  );

  server.registerTool(
    'get_basket',
    { description: 'Read a basket.', inputSchema: z.object({ basket_id: basketId }) },
    async ({ basket_id }) => {
      const basket = await store.get(basket_id);
      return basket ? text(JSON.stringify(basket)) : unknownBasket(basket_id);
    },
  );

  return server;
}
