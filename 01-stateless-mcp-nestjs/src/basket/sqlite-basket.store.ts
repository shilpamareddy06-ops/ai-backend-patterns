import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Basket, BasketStore } from './basket.store.js';

/**
 * Demo store: one SQLite file shared by every server process that points at the same path.
 * Uses node:sqlite (experimental in Node 22) so the repo needs no external service and no native build.
 * NOT a production design: use MongoDB or Redis there.
 */
export class SqliteBasketStore implements BasketStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // Several processes write the same file: wait for locks instead of failing, and use WAL.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS baskets (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS basket_items (
        basket_id TEXT NOT NULL REFERENCES baskets(id),
        name TEXT NOT NULL,
        qty INTEGER NOT NULL,
        PRIMARY KEY (basket_id, name)
      );
    `);
  }

  async create(): Promise<Basket> {
    const id = randomUUID();
    this.db.prepare('INSERT INTO baskets (id) VALUES (?)').run(id);
    return { id, items: [] };
  }

  async addItem(basketId: string, name: string, qty: number): Promise<Basket | undefined> {
    if (!this.exists(basketId)) return undefined;
    // Single atomic statement, so two instances adding the same item cannot lose an update.
    this.db
      .prepare(
        `INSERT INTO basket_items (basket_id, name, qty) VALUES (?, ?, ?)
         ON CONFLICT (basket_id, name) DO UPDATE SET qty = qty + excluded.qty`,
      )
      .run(basketId, name, qty);
    return this.get(basketId);
  }

  async get(basketId: string): Promise<Basket | undefined> {
    if (!this.exists(basketId)) return undefined;
    const rows = this.db
      .prepare('SELECT name, qty FROM basket_items WHERE basket_id = ? ORDER BY name')
      .all(basketId) as Array<{ name: string; qty: number }>;
    return { id: basketId, items: rows.map((r) => ({ name: r.name, qty: r.qty })) };
  }

  private exists(basketId: string): boolean {
    return this.db.prepare('SELECT 1 FROM baskets WHERE id = ?').get(basketId) !== undefined;
  }
}
