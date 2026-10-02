import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Exchange {
  /** Index of the backend that served this request. */
  backend: number;
  httpMethod: string;
  requestHeaders: IncomingHttpHeaders;
  /** JSON-RPC method from the request body (undefined for non-JSON or GET/DELETE). */
  rpcMethod?: string;
  status: number;
  responseHeaders: IncomingHttpHeaders;
}

/**
 * Plain round-robin reverse proxy: request N goes to backend N mod count. No affinity, no cookies,
 * no header inspection for routing. It records every exchange so tests can assert on the wire.
 */
export async function startRoundRobinProxy(backendPorts: number[]) {
  const exchanges: Exchange[] = [];
  let next = 0;

  const server: Server = createServer((req, res) => {
    const backend = next++ % backendPorts.length;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      let rpcMethod: string | undefined;
      try {
        rpcMethod = JSON.parse(body.toString('utf8')).method;
      } catch {
        /* not JSON */
      }
      const upstream = request(
        { host: '127.0.0.1', port: backendPorts[backend], path: req.url, method: req.method, headers: req.headers },
        (up) => {
          exchanges.push({
            backend,
            httpMethod: req.method ?? '',
            requestHeaders: req.headers,
            rpcMethod,
            status: up.statusCode ?? 0,
            responseHeaders: up.headers,
          });
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', (e) => {
        res.writeHead(502).end(String(e));
      });
      upstream.end(body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    exchanges,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
