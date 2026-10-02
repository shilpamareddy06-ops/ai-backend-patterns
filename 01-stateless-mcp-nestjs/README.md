# Stateless MCP server on NestJS (spec 2026-07-28)

Code for the article "Why an in-memory MCP session breaks behind a load balancer, and what the 2026-07-28 spec changes (NestJS demo)".

A small NestJS app that serves an MCP server over Streamable HTTP with **no session**: no `initialize` handshake, no `Mcp-Session-Id`. Any instance can answer any request. State that has to survive between calls is an explicit handle (`basket_id`) that the model passes back as an ordinary tool argument, and the state itself lives in a store shared by all instances.

The test starts **two separate server processes** behind a **plain round-robin proxy** (no sticky routing) and shows that a basket created through one instance is read and modified through the other.

## Tools

| Tool | Input | Result |
|---|---|---|
| `create_basket` | none | `{"basket_id": "<uuid>"}` |
| `add_item` | `basket_id` (lowercase uuid), `name` (trimmed, 1-100 characters, no ASCII control characters; see the note below), `qty` (integer 1-1000, per call) | the updated basket |
| `get_basket` | `basket_id` (lowercase uuid) | the basket |

Name validation is a C0/DEL check only: the name is trimmed, must be 1-100 characters (counted as code points) and must not contain ASCII control characters (U+0000-U+001F, U+007F). Some invisible, bidirectional-control and C1 control characters (for example U+200B, U+202E, U+0085, U+2028) are still accepted, and a lone UTF-16 surrogate is accepted but stored as U+FFFD. Do not rely on this as sanitisation for display or logs.

Unknown ids return a tool result with `isError: true` and the text `Unknown basket_id ... Call create_basket first.` Invalid input is rejected by the SDK's zod validation with an `isError` result (`Input validation error: ...`).

## Requirements

Node >= 22.13 (developed and tested on Node v22.22.2, npm 10.9.7). No external services, no native build steps.

## Run from a clean clone

```bash
npm ci
npm test          # builds with tsc, then runs node:test (11 tests, about 5 seconds on the test machine, measured, not a promise)
npm start         # builds, then serves http://127.0.0.1:3000/mcp
```

Run two instances against one shared store (two terminals):

```bash
PORT=3001 DB_PATH=./data/baskets.db npm start
PORT=3002 DB_PATH=./data/baskets.db npm start
```

### Configuration (environment variables)

The app does not read `.env` itself: use `PORT=... npm start`, or after `npm run build` run `node --env-file=.env dist/src/main.js`. See `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | TCP port |
| `HOST` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` in a container behind a load balancer |
| `DB_PATH` | `./data/baskets.db` | SQLite file shared by all instances |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` | Comma-separated `Host` header hostnames (no port) the server accepts; anything else gets HTTP 403. Setting it **replaces** the defaults; an empty or whitespace-only value falls back to the localhost defaults |
| `ALLOWED_ORIGINS` | `localhost,127.0.0.1,[::1]` | Same for the `Origin` header (hostname only, no scheme or port), including the empty-value fallback. Requests without an `Origin` header are always accepted |

The defaults are the safe ones (loopback bind, localhost-only Host/Origin: DNS-rebinding protection). Behind a load balancer, bind `0.0.0.0` and list the public hostname, for example `HOST=0.0.0.0 ALLOWED_HOSTS=mcp.example.com`. If you bind a public interface and keep the defaults, requests with any other `Host` header are refused with 403. Host/Origin checks are not authentication; this demo has none.

## Layout

```
src/config.ts                     env-var config (HOST, PORT, DB_PATH, ALLOWED_HOSTS, ALLOWED_ORIGINS)
src/main.ts                       Nest bootstrap (bodyParser off: the MCP SDK reads the body)
src/app.module.ts                 wires the store into the controller
src/mcp/mcp.controller.ts         one @All('mcp') route -> createMcpHandler + toNodeHandler
src/mcp/basket-server.ts          builds a fresh McpServer per request; the three tools
src/baseline/sessionful-main.ts   BEFORE: same tools with an in-memory MCP session (intentionally NOT scalable)
src/basket/basket.store.ts        the BasketStore interface (the only persistence contract)
src/basket/sqlite-basket.store.ts demo implementation on node:sqlite
test/round-robin-proxy.ts         65-line reverse proxy that records every exchange
test/instances.ts                 spawns real server processes on free ports
test/stateless.test.ts            the tests (AFTER: stateless)
test/config.test.ts               Host/Origin allow-list tests (defaults and configured)
test/baseline.test.ts             the tests (BEFORE: sessionful baseline fails behind the same proxy)
```

## What the tests assert

1. A basket created via one instance is readable and modifiable via the other; four consecutive calls hit alternating instances.
2. Both instances receive traffic.
3. On the wire: no request or response has an `Mcp-Session-Id` header, no `initialize` or `notifications/initialized` is ever sent, every request carries `MCP-Protocol-Version: 2026-07-28`, the first request is `server/discover`, and `Mcp-Method` / `Mcp-Name` headers are present on `tools/call`.
4. A 2025-style `initialize` is rejected with `-32022` (supported: `["2026-07-28"]`).
5. Unknown basket id gives a clean tool error (`get_basket` and `add_item`).
6. Invalid input (bad or uppercase uuid, qty 0 / -1 / 1001 / 1.5 / missing, empty, whitespace-only, over-long or control-character name) is rejected (control characters here means ASCII only) and does not change the basket; the limits themselves are accepted and names are trimmed.
7. 20 concurrent `add_item` calls spread over both instances sum to exactly 20 (no lost updates).

(The 7 stateless tests are in `stateless.test.ts`, `baseline.test.ts` adds 2 and `config.test.ts` adds 2, for 11 in total. Every test starts its own client and can be run alone, for example `node --test --test-name-pattern="never uses a session" "dist/test/**/*.test.js"`; filtered-out files start no server processes.)

Sanity check performed while building: pointing the two instances at different database files makes tests 1 and 7 fail, so the tests do detect non-shared state.

## Before / after: what a session costs you

`src/baseline/sessionful-main.ts` is a deliberately non-scalable baseline. It serves the same three tools through `NodeStreamableHTTPServerTransport` with `sessionIdGenerator: () => randomUUID()`, the SDK's sessionful path (2025-11-25 handshake). The basket data is in the same shared SQLite store, so the only thing pinning a client to one instance is the MCP session held in that process's memory. It keeps a single transport per process, so it supports one session per instance; that is enough to show the failure and is not a design to copy. `test/baseline.test.ts` runs two baseline instances behind the same round-robin proxy with the default v2 client (`initialize`, then `notifications/initialized`, then calls).

Captured output of that test (real run):

```
 0 POST initialize -> 200 req=- res=0fddeeb6-e410-4729-b61c-dd701a31548d
 1 POST notifications/initialized -> 400 req=0fddeeb6-e410-4729-b61c-dd701a31548d res=-
CLIENT ERROR: SdkHttpError: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Server not initialized"},"id":null}
```

Columns: backend index, HTTP method, JSON-RPC method, status, `Mcp-Session-Id` sent, `Mcp-Session-Id` returned. Instance 0 minted the session at `initialize`; the very next request went to instance 1 with that session id and got HTTP 400 `-32000 Bad Request: Server not initialized` from the SDK transport. (The session id differs on each run.) A control test shows the same baseline works when the client talks to one instance directly, so the proxy routing is what breaks it. The stateless server passes the same proxy setup because there is nothing to be sticky to.

Scope of the claim: this shows the failure for this SDK's sessionful path with one in-memory session per process. A sessionful server that keeps a session map behind sticky routing, or a shared session store, is a different design and was not tested.

## Versions (exact, pinned in package.json and package-lock.json)

| Package | Version |
|---|---|
| @modelcontextprotocol/server | 2.2.0 |
| @modelcontextprotocol/client | 2.2.0 |
| @modelcontextprotocol/node | 2.1.0 |
| @nestjs/core, @nestjs/common, @nestjs/platform-express | 12.1.1 |
| zod | 4.6.5 |
| rxjs / reflect-metadata | 7.8.2 / 0.2.2 |
| typescript | 7.0.2 |

Spec targeted: MCP 2026-07-28.

## A real exchange (captured with curl; instance A on :3111, instance B on :3112, same DB file)

Request to A (`create_basket`), headers sent: `Content-Type`, `Accept`, `MCP-Protocol-Version: 2026-07-28`, `Mcp-Method: tools/call`, `Mcp-Name: create_basket`. Body:

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_basket","arguments":{},
 "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
          "io.modelcontextprotocol/clientInfo":{"name":"curl","version":"0"},
          "io.modelcontextprotocol/clientCapabilities":{}}}}
```

Response headers (complete list; no `Mcp-Session-Id`):

```
HTTP/1.1 200 OK
X-Powered-By: Express
content-type: application/json
Date: Tue, 29 Sep 2026 05:35:47 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked
```

```json
{"result":{"content":[{"type":"text","text":"{\"basket_id\":\"10334452-0765-4e51-871c-f8d5378d3c36\"}"}],"resultType":"complete","_meta":{"io.modelcontextprotocol/serverInfo":{"name":"stateless-basket","version":"1.0.0"}}},"jsonrpc":"2.0","id":1}
```

The same `basket_id` was then added to via B (`add_item apple x2`) and read back via A (`{"id":"1033...","items":[{"name":"apple","qty":2}]}`).

## Limitations (read before copying)

- **The store is a demo.** `SqliteBasketStore` uses `node:sqlite`, which is experimental in Node 22 (it prints an `ExperimentalWarning` at startup) and a single SQLite file only works for processes on the same machine. A real multi-host deployment would implement `BasketStore` on MongoDB or Redis. Also: the store methods are `async` but do synchronous SQLite work (blocking the event loop); `addItem` is a check followed by one atomic upsert, not a transaction (safe here because nothing is ever deleted); the database file is created with the default umask (only a newly created data directory gets mode 0700), so other local users may be able to read it. There is no expiry/TTL, no auth, and no per-user ownership of baskets: anyone holding a `basket_id` can use it. Nothing bounds growth: `create_basket` is unauthenticated and there is no cap on baskets, on items per basket, or on total quantity (the 1000 limit is per call), and `get_basket` returns the whole basket.
- **Only the 2026-07-28 era is served** (`legacy: 'reject'`). The SDK also offers a stateless fallback for 2025-era clients (the default when the option is omitted); it was not exercised here.
- **The v2 client defaults to the 2025 `initialize` handshake.** The tests opt in with `versionNegotiation: { mode: { pin: '2026-07-28' } }`.
- Not covered: multi round-trip requests (`input_required`), `subscriptions/listen`, authentication/authorization, streaming (SSE) responses, tasks, and resources/prompts.
- The tools are advertised with `tools.listChanged: true` by default (observed in `server/discover`), although this server never emits list-changed events.
- **Baseline error handling:** `src/baseline/sessionful-main.ts` calls `transport.handleRequest(req, res)` with `void` and no `.catch`, so a rejected promise would be unhandled. It is a test-only file.
- **Hard kills leave servers behind:** the tests clean up spawned servers on normal exit, failures and SIGINT, but a `kill -9` of the test runner cannot run any handler and can leave the spawned server processes running (a killed runner was observed to leave two alive in review). Kill them by hand.
- **No caps** on the number of baskets, items per basket or total quantity are implemented.
- Only tested on Linux with Node v22.22.2.
