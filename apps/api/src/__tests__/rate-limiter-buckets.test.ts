import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const state = vi.hoisted(() => ({ zsets: new Map<string, number[]>(), evalCalls: 0, fail: false }));

// In-memory emulation of the Lua script's semantics (trim, count, add only when allowed).
const fakeRedis = vi.hoisted(() => ({
  eval: async (_s: string, o: { keys: string[]; arguments: string[] }) => {
    state.evalCalls++;
    if (state.fail) throw new Error('redis down');
    const [now, windowMs, max] = o.arguments.map(Number);
    const z = (state.zsets.get(o.keys[0]) ?? []).filter((t) => t > now - windowMs);
    let allowed = 0;
    if (z.length < max) {
      z.push(now);
      allowed = 1;
    }
    state.zsets.set(o.keys[0], z);
    return [allowed, z.length, z.length ? Math.min(...z) : now];
  },
  del: async () => 0
}));

vi.mock('@cio/core/utils/redis/redis', () => ({
  redis: fakeRedis,
  logRedisUnavailableOnce: vi.fn()
}));
vi.mock('@cio/core/config/env', () => ({ env: { NODE_ENV: 'production', PRIVATE_SERVER_KEY: 'srv-key' } }));
vi.mock('@hono/node-server/conninfo', () => ({ getConnInfo: () => ({ remote: { address: '9.9.9.9' } }) }));

import { RedisRateLimiter } from '@api/utils/redis/limiter';
import rateLimiter, { resolveRateLimitBucket } from '@api/middlewares/rate-limiter';

function makeApp(user?: { id: string }) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('user' as never, user as never);
    await next();
  });
  app.use('*', rateLimiter);
  app.all('*', (c) => c.text('ok'));
  return app;
}

beforeEach(() => {
  state.zsets.clear();
  state.evalCalls = 0;
  state.fail = false;
});

describe('RedisRateLimiter (count first, add only when allowed)', () => {
  it('does not record blocked requests and reports reset = oldest + window', async () => {
    const limiter = new RedisRateLimiter(fakeRedis as never, 60_000, 2);
    const t0 = Date.now();
    expect((await limiter.isAllowed('k')).allowed).toBe(true);
    expect((await limiter.isAllowed('k')).allowed).toBe(true);
    const blocked = await limiter.isAllowed('k');
    await limiter.isAllowed('k');
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(state.zsets.get('rate_limit:k')).toHaveLength(2);
    expect(blocked.resetTime).toBeGreaterThanOrEqual(t0 + 60_000);
    expect(blocked.resetTime).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe('bucket selection', () => {
  const ctx = (method: string, path: string, user?: { id: string }) =>
    ({
      req: { method, path, header: () => undefined },
      get: () => user
    }) as never;

  it('authenticated GET/HEAD -> read 600', () => {
    expect(resolveRateLimitBucket(ctx('GET', '/x', { id: 'u1' }))).toEqual({ key: 'user:u1:read', max: 600 });
    expect(resolveRateLimitBucket(ctx('HEAD', '/x', { id: 'u1' }))).toEqual({ key: 'user:u1:read', max: 600 });
  });

  it('authenticated writes -> write 120', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE'])
      expect(resolveRateLimitBucket(ctx(m, '/x', { id: 'u1' }))).toEqual({ key: 'user:u1:write', max: 120 });
  });

  it('anonymous -> ip 100, /organization GET 500', () => {
    expect(resolveRateLimitBucket(ctx('GET', '/x'))).toEqual({ key: 'ip:9.9.9.9', max: 100 });
    expect(resolveRateLimitBucket(ctx('GET', '/organization')).max).toBe(500);
  });

  it('auth POST paths -> ip:auth 30, even for signed-in users', () => {
    for (const p of [
      '/api/auth/sign-in/email',
      '/api/auth/sign-up/email',
      '/api/auth/forget-password',
      '/api/auth/reset-password'
    ])
      expect(resolveRateLimitBucket(ctx('POST', p))).toEqual({ key: 'ip:auth:9.9.9.9', max: 30 });
    expect(resolveRateLimitBucket(ctx('GET', '/api/auth/sign-in/email')).key).toBe('ip:9.9.9.9');
  });
});

describe('middleware', () => {
  it('writes get 120/min with Retry-After and 429, reads are a separate bucket', async () => {
    const app = makeApp({ id: 'u1' });
    for (let i = 0; i < 120; i++) expect((await app.request('/a', { method: 'POST' })).status).toBe(200);
    const res = await app.request('/a', { method: 'POST' });
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get('Retry-After'));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('120');
    expect((await app.request('/a', { method: 'GET' })).status).toBe(200);
    expect(state.zsets.get('rate_limit:user:u1:write')).toHaveLength(120);
  });

  it('skips get-session and trusted server key', async () => {
    const app = makeApp();
    await app.request('/api/auth/get-session');
    await app.request('/x', { headers: { Authorization: 'Bearer srv-key' } });
    expect(state.evalCalls).toBe(0);
  });

  it('fails open when redis errors', async () => {
    state.fail = true;
    expect((await makeApp({ id: 'u1' }).request('/a')).status).toBe(200);
  });
});
