// src/server/cache.ts — Redis with the same call shapes the Devvit apps used
// (get / set with {expiration, nx} / del / incrBy / expire / hSet / hGetAll /
// hDel), so code lifted from them changes only its import. REDIS_URL unset →
// an in-memory store with the same semantics (dev, tests, the replay harness).

import { Redis } from 'ioredis';

export interface SetOptions {
  /** Absolute expiry. */
  expiration?: Date;
  /** Only set when the key does not exist. */
  nx?: boolean;
}

export interface Cache {
  get(key: string): Promise<string | null>;
  /** Resolves 'OK' when written, null when NX blocked the write (ioredis semantics). */
  set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null>;
  del(...keys: string[]): Promise<number>;
  incrBy(key: string, n: number): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  hSet(key: string, fields: Record<string, string>): Promise<void>;
  hGetAll(key: string): Promise<Record<string, string>>;
  hDel(key: string, fields: string[]): Promise<void>;
  /** Health: round-trip ok? */
  ping(): Promise<boolean>;
  kind: 'redis' | 'memory';
}

const ttlMs = (opts?: SetOptions): number | null => {
  if (!opts?.expiration) return null;
  return Math.max(1, opts.expiration.getTime() - Date.now());
};

class RedisCache implements Cache {
  kind = 'redis' as const;
  constructor(private r: Redis) {}
  get(key: string): Promise<string | null> { return this.r.get(key); }
  async set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null> {
    const px = ttlMs(opts);
    // ioredis typings want the literal argument list; build it by case.
    let res: unknown;
    if (px != null && opts?.nx) res = await this.r.set(key, value, 'PX', px, 'NX');
    else if (px != null) res = await this.r.set(key, value, 'PX', px);
    else if (opts?.nx) res = await this.r.set(key, value, 'NX');
    else res = await this.r.set(key, value);
    return res === 'OK' ? 'OK' : null;
  }
  del(...keys: string[]): Promise<number> { return keys.length ? this.r.del(...keys) : Promise.resolve(0); }
  incrBy(key: string, n: number): Promise<number> { return this.r.incrby(key, n); }
  async expire(key: string, seconds: number): Promise<void> { await this.r.expire(key, seconds); }
  async hSet(key: string, fields: Record<string, string>): Promise<void> { if (Object.keys(fields).length) await this.r.hset(key, fields); }
  hGetAll(key: string): Promise<Record<string, string>> { return this.r.hgetall(key); }
  async hDel(key: string, fields: string[]): Promise<void> { if (fields.length) await this.r.hdel(key, ...fields); }
  async ping(): Promise<boolean> { try { return (await this.r.ping()) === 'PONG'; } catch { return false; } }
}

interface MemEntry { v: string; exp: number | null }

export class MemoryCache implements Cache {
  kind = 'memory' as const;
  private m = new Map<string, MemEntry>();
  private h = new Map<string, Map<string, string>>();
  private live(k: string): MemEntry | null {
    const e = this.m.get(k);
    if (!e) return null;
    if (e.exp != null && e.exp <= Date.now()) { this.m.delete(k); return null; }
    return e;
  }
  async get(key: string): Promise<string | null> { return this.live(key)?.v ?? null; }
  async set(key: string, value: string, opts?: SetOptions): Promise<'OK' | null> {
    if (opts?.nx && this.live(key)) return null;
    const px = ttlMs(opts);
    this.m.set(key, { v: value, exp: px == null ? null : Date.now() + px });
    return 'OK';
  }
  async del(...keys: string[]): Promise<number> { let n = 0; for (const k of keys) { if (this.m.delete(k)) n++; if (this.h.delete(k)) n++; } return n; }
  async incrBy(key: string, n: number): Promise<number> {
    const cur = Number(this.live(key)?.v ?? 0) + n;
    const e = this.live(key);
    this.m.set(key, { v: String(cur), exp: e?.exp ?? null });
    return cur;
  }
  async expire(key: string, seconds: number): Promise<void> {
    const e = this.live(key);
    if (e) e.exp = Date.now() + seconds * 1000;
  }
  async hSet(key: string, fields: Record<string, string>): Promise<void> {
    const h = this.h.get(key) ?? new Map<string, string>();
    for (const [k, v] of Object.entries(fields)) h.set(k, v);
    this.h.set(key, h);
  }
  async hGetAll(key: string): Promise<Record<string, string>> { return Object.fromEntries(this.h.get(key) ?? []); }
  async hDel(key: string, fields: string[]): Promise<void> { const h = this.h.get(key); if (h) for (const f of fields) h.delete(f); }
  async ping(): Promise<boolean> { return true; }
}

let instance: Cache | null = null;

export function cache(): Cache {
  if (instance) return instance;
  const url = process.env.REDIS_URL;
  if (url) {
    const r = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: true, lazyConnect: false });
    r.on('error', (e) => console.error('[redis]', e.message));
    instance = new RedisCache(r);
  } else {
    console.warn('[cache] REDIS_URL unset — using in-memory cache');
    instance = new MemoryCache();
  }
  return instance;
}

/** Tests and the replay harness swap the store. */
export function useCache(c: Cache): void { instance = c; }
