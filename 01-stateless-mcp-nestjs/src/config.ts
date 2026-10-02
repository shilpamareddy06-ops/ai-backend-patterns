/** Everything configurable comes from environment variables. Defaults are the safe, localhost-only ones. */
const LOCALHOST_NAMES = ['localhost', '127.0.0.1', '[::1]'];

const list = (value: string | undefined, fallback: string[]) =>
  value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;

export interface AppConfig {
  /** Interface to bind. Default 127.0.0.1; use 0.0.0.0 in a container behind a load balancer. */
  host: string;
  port: number;
  dbPath: string;
  /** Accepted Host header hostnames (no port). Replaces the localhost defaults when set. */
  allowedHosts: string[];
  /** Accepted Origin hostnames (no scheme, no port). Requests without an Origin header always pass. */
  allowedOrigins: string[];
}

export const CONFIG = Symbol('CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST ?? '127.0.0.1',
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? './data/baskets.db',
    allowedHosts: list(env.ALLOWED_HOSTS, LOCALHOST_NAMES),
    allowedOrigins: list(env.ALLOWED_ORIGINS, LOCALHOST_NAMES),
  };
}
