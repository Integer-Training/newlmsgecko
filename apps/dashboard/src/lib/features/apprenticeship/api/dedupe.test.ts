import { describe, expect, it, vi } from 'vitest';
import { createDedupedLoader } from './dedupe';

describe('createDedupedLoader', () => {
  it('shares one in-flight request and caches briefly', async () => {
    let t = 0;
    const load = vi.fn(async (k: string) => ({ ok: true, k }));
    const d = createDedupedLoader(load, { ttlMs: 3000, now: () => t, cacheable: (r) => r.ok });
    const [a, b] = await Promise.all([d.get('e1'), d.get('e1')]);
    expect(a).toBe(b);
    t = 2000;
    await d.get('e1');
    expect(load).toHaveBeenCalledTimes(1);
    t = 3500;
    await d.get('e1');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('clear() forces a refetch and failures are not cached', async () => {
    const load = vi.fn(async () => ({ ok: load.mock.calls.length > 2 }));
    const d = createDedupedLoader(load, { cacheable: (r) => r.ok });
    await d.get('x');
    await Promise.resolve();
    await d.get('x');
    expect(load).toHaveBeenCalledTimes(2);
    await d.get('x'); // ok, cached
    d.clear();
    await d.get('x');
    expect(load).toHaveBeenCalledTimes(4);
  });
});
