import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startCluster, type Instance } from './instances.js';
import { startRoundRobinProxy } from './round-robin-proxy.js';

type Proxy = Awaited<ReturnType<typeof startRoundRobinProxy>>;

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe('stateless MCP over two instances behind a round-robin proxy', () => {
  let dir: string;
  let instances: Instance[];
  let proxy: Proxy;

  // Hooks live inside describe: if every test here is filtered out, no server process is started.
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-baskets-'));
    instances = await startCluster(join(dir, 'shared.db'), 2); // one DB file, shared by both processes
    assert.notEqual(instances[0].pid, instances[1].pid);
    proxy = await startRoundRobinProxy(instances.map((i) => i.port));
  });

  after(async () => {
    await proxy?.close();
    await Promise.all((instances ?? []).map((i) => i.stop()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A fresh client per test, so no test depends on another one having run. */
  async function connect(): Promise<Client> {
    const client = new Client(
      { name: 'stateless-test', version: '0.0.0' },
      // The v2 client defaults to the 2025 handshake; this pins the 2026-07-28 stateless protocol.
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(proxy.url)));
    return client;
  }

  async function createBasket(client: Client): Promise<string> {
    return JSON.parse(textOf(await client.callTool({ name: 'create_basket', arguments: {} }))).basket_id;
  }

  it('a basket created via one instance is readable and modifiable via the other', async () => {
    const client = await connect();
    const mark = proxy.exchanges.length;

    const basket_id = await createBasket(client);
    assert.match(basket_id, /^[0-9a-f-]{36}$/);
    await client.callTool({ name: 'add_item', arguments: { basket_id, name: 'apple', qty: 2 } });
    await client.callTool({ name: 'add_item', arguments: { basket_id, name: 'apple', qty: 3 } });
    const read = await client.callTool({ name: 'get_basket', arguments: { basket_id } });
    assert.deepEqual(JSON.parse(textOf(read)), { id: basket_id, items: [{ name: 'apple', qty: 5 }] });

    // These four calls were consecutive, so round-robin put them on alternating instances.
    const calls = proxy.exchanges.slice(mark);
    assert.deepEqual(calls.map((c) => c.rpcMethod), ['tools/call', 'tools/call', 'tools/call', 'tools/call']);
    for (let i = 1; i < calls.length; i++) assert.notEqual(calls[i].backend, calls[i - 1].backend);
    await client.close();
  });

  it('spreads requests over both instances', async () => {
    const client = await connect();
    const mark = proxy.exchanges.length;
    await createBasket(client);
    await createBasket(client);
    const served = new Set(proxy.exchanges.slice(mark).map((e) => e.backend));
    assert.deepEqual([...served].sort(), [0, 1]);
    await client.close();
  });

  it('never uses a session: no initialize, no Mcp-Session-Id in either direction', async () => {
    const mark = proxy.exchanges.length;
    const client = await connect(); // includes the connect-time exchange(s)
    await createBasket(client);
    await client.close();

    const exchanges = proxy.exchanges.slice(mark);
    assert.ok(exchanges.length >= 2);
    for (const e of exchanges) {
      assert.ok(!('mcp-session-id' in e.requestHeaders), 'request carried a session id');
      assert.ok(!('mcp-session-id' in e.responseHeaders), 'response carried a session id');
      assert.notEqual(e.rpcMethod, 'initialize');
      assert.notEqual(e.rpcMethod, 'notifications/initialized');
      assert.equal(e.httpMethod, 'POST');
      assert.equal(e.requestHeaders['mcp-protocol-version'], '2026-07-28');
    }
    // The first request is server/discover, the rest are self-describing calls.
    assert.equal(exchanges[0].rpcMethod, 'server/discover');
    // Routing headers are present on tool calls (Mcp-Method / Mcp-Name).
    const call = exchanges.find((e) => e.rpcMethod === 'tools/call');
    assert.ok(call, 'expected a tools/call exchange');
    assert.equal(call.requestHeaders['mcp-method'], 'tools/call');
    assert.equal(call.requestHeaders['mcp-name'], 'create_basket');
  });

  it('rejects a 2025-style initialize handshake (this endpoint is 2026-07-28 only)', async () => {
    const res = await fetch(`http://127.0.0.1:${instances[0].port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } },
      }),
    });
    assert.equal(res.status, 400);
    assert.equal(res.headers.get('mcp-session-id'), null);
    const body = (await res.json()) as { error: { code: number; data: { supported: string[] } } };
    assert.equal(body.error.code, -32022);
    assert.deepEqual(body.error.data.supported, ['2026-07-28']);
  });

  it('returns a clean tool error for an unknown basket id, from either instance', async () => {
    const client = await connect();
    const ghost = '00000000-0000-4000-8000-000000000000';
    for (const name of ['get_basket', 'add_item']) {
      const args = name === 'get_basket' ? { basket_id: ghost } : { basket_id: ghost, name: 'x', qty: 1 };
      const r = await client.callTool({ name, arguments: args });
      assert.ok(isError(r), `${name} should be an error result`);
      assert.match(textOf(r), /Unknown basket_id 0000/);
    }
    await client.close();
  });

  it('rejects invalid input (zod) and leaves the basket unchanged', async () => {
    const client = await connect();
    const basket_id = await createBasket(client);
    const bad = [
      { basket_id: 'not-a-uuid', name: 'x', qty: 1 },
      { basket_id: basket_id.toUpperCase(), name: 'x', qty: 1 }, // ids are lowercase UUIDs
      { basket_id: `${basket_id}0`, name: 'x', qty: 1 },
      { basket_id, name: 'x', qty: 0 },
      { basket_id, name: 'x', qty: -1 },
      { basket_id, name: 'x', qty: 1001 },
      { basket_id, name: 'x', qty: 1.5 },
      { basket_id, name: '', qty: 1 },
      { basket_id, name: '   ', qty: 1 },
      { basket_id, name: 'a'.repeat(101), qty: 1 },
      { basket_id, name: 'bell\u0007', qty: 1 },
      { basket_id, name: 'x' },
    ];
    for (const args of bad) {
      const r = await client.callTool({ name: 'add_item', arguments: args });
      assert.ok(isError(r), `input should be rejected: ${JSON.stringify(args)}`);
      assert.match(textOf(r), /Input validation error/);
    }
    const after = await client.callTool({ name: 'get_basket', arguments: { basket_id } });
    assert.deepEqual(JSON.parse(textOf(after)).items, [], 'rejected calls must not have changed the basket');

    // The limits themselves are accepted, and names are trimmed.
    const ok = await client.callTool({ name: 'add_item', arguments: { basket_id, name: `  ${'a'.repeat(100)}  `, qty: 1000 } });
    assert.ok(!isError(ok));
    assert.deepEqual(JSON.parse(textOf(ok)).items, [{ name: 'a'.repeat(100), qty: 1000 }]);
    await client.close();
  });

  it('concurrent add_item calls spread over both instances do not lose updates', async () => {
    const client = await connect();
    const basket_id = await createBasket(client);
    await Promise.all(
      Array.from({ length: 20 }, () => client.callTool({ name: 'add_item', arguments: { basket_id, name: 'pear', qty: 1 } })),
    );
    const read = await client.callTool({ name: 'get_basket', arguments: { basket_id } });
    assert.deepEqual(JSON.parse(textOf(read)).items, [{ name: 'pear', qty: 20 }]);
    await client.close();
  });
});
