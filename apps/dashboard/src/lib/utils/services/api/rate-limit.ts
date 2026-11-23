// 429 handling for the dashboard fetch wrapper. Kept free of SvelteKit imports so it can be unit tested.

export const RATE_LIMIT_MESSAGE = "We're loading a lot at once — please try again in a moment.";
export const RATE_LIMIT_MAX_RETRIES = 2;
export const RATE_LIMIT_DEFAULT_WAIT_MS = 3000;
export const RATE_LIMIT_MAX_WAIT_MS = 15000;
const JITTER_MS = 500;

/** Only idempotent reads are ever retried automatically. */
export function isRetryableMethod(method?: string | null): boolean {
  const m = (method || 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/** Retry-After (seconds) -> ms, capped at 15s, plus a little jitter. Default 3s when missing or invalid. */
export function retryAfterMs(res: Pick<Response, 'headers'>, random: () => number = Math.random): number {
  const raw = res.headers?.get?.('Retry-After');
  const secs = raw == null || raw === '' ? NaN : Number(raw);
  const base = Number.isFinite(secs) && secs >= 0 ? secs * 1000 : RATE_LIMIT_DEFAULT_WAIT_MS;
  return Math.min(base, RATE_LIMIT_MAX_WAIT_MS) + Math.floor(random() * JITTER_MS);
}

/** Sends the request; on 429 for GET/HEAD waits Retry-After and retries (max 2). Returns the last response. */
export async function sendWith429Retry(
  send: () => Promise<Response>,
  method: string | null | undefined,
  sleep: (ms: number) => Promise<unknown> = (ms) => new Promise((r) => setTimeout(r, ms))
): Promise<Response> {
  let res = await send();
  if (!isRetryableMethod(method)) return res;
  for (let i = 0; i < RATE_LIMIT_MAX_RETRIES && res.status === 429; i++) {
    await sleep(retryAfterMs(res));
    res = await send();
  }
  return res;
}
