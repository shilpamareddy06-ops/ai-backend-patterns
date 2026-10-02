/**
 * The only thing the MCP layer knows about persistence.
 * In production this interface would be implemented on MongoDB or Redis.
 */
export interface Basket {
  id: string;
  items: Array<{ name: string; qty: number }>;
}

export interface BasketStore {
  create(): Promise<Basket>;
  /** Adds qty to the item (creating it if needed). Resolves undefined if the basket does not exist. */
  addItem(basketId: string, name: string, qty: number): Promise<Basket | undefined>;
  get(basketId: string): Promise<Basket | undefined>;
}

export const BASKET_STORE = Symbol('BASKET_STORE');
