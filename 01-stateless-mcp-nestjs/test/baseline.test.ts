/**
 * BEFORE: the same tools served with an in-memory MCP session (src/baseline, intentionally not scalable),
 * behind the same round-robin proxy. Shows the failure the stateless design removes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startCluster, type Instance } from './instances.js';
import { startRoundRobinProxy } from './round-robin-proxy.js';

// The baseline holds exactly one session per process, so each test starts its own fresh instances.
describe('BASELINE: sessionful server behind a round-robin proxy', () => {
  let dir: string;
  const cleanups: Array<() => Promise<unknown>> = [];

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-baseline-'));
  });

  after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a client that initialized on instance A fails when its next request lands on instance B', async () => {
    // Default v2 client = the 2025 handshake: initialize, then notifications/initialized, then calls.
    const instances = await startCluster(join(dir, 'shared.db'), 2, { entry: 'baseline' });
    cleanups.push(() => Promise.all(instances.map((i) => i.stop())));
    const proxy = await startRoundRobinProxy(instances.map((i) => i.port));
    cleanups.push(() => proxy.close());

    const client = new Client({ name: 'baseline-test', version: '0.0.0' });
    let failure: unknown;
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(proxy.url)));
      await client.callTool({ name: 'create_basket', arguments: {} });
    } catch (e) {
      failure = e;
    }

    const ex = proxy.exchanges;
    console.log('EXCHANGES (backend, http, rpc, status, session header in/out):');
    for (const e of ex) {
      console.log(` ${e.backend} ${e.httpMethod} ${e.rpcMethod ?? '-'} -> ${e.status} req=${e.requestHeaders['mcp-session-id'] ?? '-'} res=${e.responseHeaders['mcp-session-id'] ?? '-'}`);
    }
    console.log('CLIENT ERROR:', String(failure));

    // Instance A (backend 0) served initialize and issued a session id.
    assert.equal(ex[0].backend, 0);
    assert.equal(ex[0].rpcMethod, 'initialize');
    assert.equal(ex[0].status, 200);
    const sessionId = ex[0].responseHeaders['mcp-session-id'];
    assert.ok(sessionId, 'baseline must issue an Mcp-Session-Id');

    // The follow-up request went to instance B carrying A's session id, and B refused it.
    const rejected = ex.find((e) => e.backend === 1 && e.requestHeaders['mcp-session-id'] === sessionId);
    assert.ok(rejected, 'a request with A\'s session id must have reached B');
    assert.equal(rejected.status, 400);
    assert.ok(failure, 'the client must have failed');
    assert.match(String(failure), /Bad Request: Server not initialized/);

    await client.close().catch(() => {});
  });

  it('control: the same baseline works when the client talks to one instance directly (so the proxy is what breaks it)', async () => {
    const [solo] = await startCluster(join(dir, 'solo.db'), 1, { entry: 'baseline' });
    cleanups.push(() => solo.stop());
    const client = new Client({ name: 'baseline-control', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${solo.port}/mcp`)));
    const r = (await client.callTool({ name: 'create_basket', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> };
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /basket_id/);
    await client.close();
  });
});
