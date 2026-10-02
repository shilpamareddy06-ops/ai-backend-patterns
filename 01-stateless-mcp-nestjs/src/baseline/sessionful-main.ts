/**
 * BASELINE, INTENTIONALLY NOT HORIZONTALLY SCALABLE.
 *
 * The same three basket tools, served the pre-2026-07-28 way: one NodeStreamableHTTPServerTransport
 * with a sessionIdGenerator. The transport mints an Mcp-Session-Id at `initialize` and remembers it
 * in THIS process's memory. The basket data still lives in the shared store, so the only thing that
 * ties a client to one instance is the MCP session itself.
 * (One transport = one session per process, no path check, no Host/Origin validation.
 * Enough to show the failure; not a design to copy.)
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { SqliteBasketStore } from '../basket/sqlite-basket.store.js';
import { buildBasketServer } from '../mcp/basket-server.js';

const dbPath = process.env.DB_PATH ?? './data/baskets.db';
mkdirSync(dirname(dbPath), { recursive: true });
const server = buildBasketServer(new SqliteBasketStore(dbPath));
const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await server.connect(transport);

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  void transport.handleRequest(req, res);
}).listen(port, '127.0.0.1', () => {
  console.log(`BASELINE sessionful MCP server (pid ${process.pid}) listening on http://127.0.0.1:${port}/mcp`);
});
