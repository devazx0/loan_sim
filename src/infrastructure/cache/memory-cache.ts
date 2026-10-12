import type { Cache } from "../providers/interfaces";

export class MemoryCache implements Cache {
  private store = new Map<string, { value: unknown; expiresAt: number }>();
  async get<T>(key: string): Promise<T | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (Date.now() > e.expiresAt) { this.store.delete(key); return null; }
    return e.value as T;
  }
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
  async del(key: string): Promise<void> {
    this.store.delete(key);
  }
  clear() { this.store.clear(); }
}

export const cache: Cache = new MemoryCache();

// Cache policy (documented): loan products + config reference data only.
// TTL: products 300s, invalidated on admin product write. Never balances/payments/loans.
export const CACHE_TTLS = { loanProducts: 300, loanProduct: 300 } as const;
export const productListKey = () => "products:list";
export const productKey = (id: string) => `products:${id}`;

