/** Host / Origin allow-lists: safe localhost defaults, explicit opt-in for a load balancer. */
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startInstance, type Instance } from './instances.js';

const discover = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'server/discover',
  params: { _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientInfo': { name: 'config-test', version: '0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } },
});

/** fetch() cannot override Host, so use node:http. Returns the HTTP status. */
function post(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
                   'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover', ...headers } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
    );
    req.on('error', reject);
    req.end(discover);
  });
}

describe('Host and Origin allow-lists', () => {
  let dir: string;
  let defaults: Instance;
  let configured: Instance;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-config-'));
    defaults = await startInstance(join(dir, 'a.db'));
    // What a container behind a load balancer would use: bind all interfaces, allow the public hostname.
    configured = await startInstance(join(dir, 'b.db'), {
      env: { HOST: '0.0.0.0', ALLOWED_HOSTS: 'mcp.example.test', ALLOWED_ORIGINS: 'app.example.test' },
    });
  });

  after(async () => {
    await Promise.all([defaults?.stop(), configured?.stop()]);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('defaults: localhost Host is accepted, any other Host or Origin gets 403', async () => {
    assert.equal(await post(defaults.port, { host: `localhost:${defaults.port}` }), 200);
    assert.equal(await post(defaults.port, { host: 'mcp.example.test' }), 403);
    assert.equal(await post(defaults.port, { host: 'localhost', origin: 'http://evil.example' }), 403);
  });

  it('configured: the listed Host and Origin are accepted, unlisted ones are still 403', async () => {
    assert.equal(await post(configured.port, { host: 'mcp.example.test' }), 200);
    assert.equal(await post(configured.port, { host: 'mcp.example.test:8443' }), 200); // port-agnostic
    assert.equal(await post(configured.port, { host: 'mcp.example.test', origin: 'https://app.example.test' }), 200);
    assert.equal(await post(configured.port, { host: 'evil.example' }), 403);
    assert.equal(await post(configured.port, { host: 'mcp.example.test', origin: 'https://evil.example' }), 403);
    // Setting ALLOWED_HOSTS replaces the localhost defaults instead of adding to them.
    assert.equal(await post(configured.port, { host: 'localhost' }), 403);
  });
});
