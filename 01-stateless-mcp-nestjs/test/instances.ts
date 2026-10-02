import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../src/main.js', import.meta.url)); // compiled: dist/src/main.js
const BASELINE_MAIN = fileURLToPath(new URL('../src/baseline/sessionful-main.js', import.meta.url));

// Every child we spawn, so a crashed or interrupted test run cannot leave servers behind.
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

export interface Instance {
  port: number;
  pid: number;
  stop(): Promise<void>;
}

export interface InstanceOptions {
  entry?: 'stateless' | 'baseline';
  /** Extra environment variables, for example ALLOWED_HOSTS. */
  env?: Record<string, string>;
}

/** Starts a real, separate OS process running the compiled app. */
export async function startInstance(dbPath: string, options: InstanceOptions = {}): Promise<Instance> {
  const port = await freePort();
  const entry = options.entry === 'baseline' ? BASELINE_MAIN : MAIN;
  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running.add(child);
  child.once('exit', () => running.delete(child));

  let log = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`instance did not start:\n${log}`)), 15_000);
      const onData = (d: Buffer) => {
        log += d.toString();
        if (log.includes('listening on')) { clearTimeout(timer); resolve(); }
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', (d: Buffer) => { log += d.toString(); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`instance exited early (${code}):\n${log}`)); });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  return {
    port,
    pid: child.pid!,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill('SIGTERM');
      }),
  };
}

/** Starts `count` instances that share one database file. */
export async function startCluster(dbPath: string, count: number, options: InstanceOptions = {}): Promise<Instance[]> {
  const started: Instance[] = [];
  try {
    for (let i = 0; i < count; i++) started.push(await startInstance(dbPath, options));
  } catch (error) {
    await Promise.all(started.map((i) => i.stop()));
    throw error;
  }
  return started;
}
