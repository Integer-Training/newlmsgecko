// Shares one in-flight request per key and caches the result briefly, so several components asking for the
// same thing at once (e.g. the sidebar badge and the onboarding tab) cause a single request.

export function createDedupedLoader<T>(
  load: (key: string) => Promise<T>,
  opts: { ttlMs?: number; now?: () => number; cacheable?: (value: T) => boolean } = {}
) {
  const { ttlMs = 3000, now = Date.now, cacheable = () => true } = opts;
  const entries = new Map<string, { promise: Promise<T>; at: number }>();
  return {
    get(key: string): Promise<T> {
      const hit = entries.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.promise;
      const entry = { promise: load(key), at: now() };
      entries.set(key, entry);
      // Failures are never cached: the next caller retries.
      entry.promise.then(
        (v) => {
          if (!cacheable(v) && entries.get(key) === entry) entries.delete(key);
        },
        () => {
          if (entries.get(key) === entry) entries.delete(key);
        }
      );
      return entry.promise;
    },
    clear() {
      entries.clear();
    }
  };
}
