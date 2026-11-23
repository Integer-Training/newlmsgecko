import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMIT_MAX_WAIT_MS, retryAfterMs, sendWith429Retry } from './rate-limit';

const res = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

describe('sendWith429Retry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('retries a GET on 429 after Retry-After and returns the success', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(res(429, { 'Retry-After': '2' }))
      .mockResolvedValueOnce(res(200));
    const p = sendWith429Retry(send, 'GET', sleep);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).status).toBe(200);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('gives up after 2 retries and returns the 429', async () => {
    const send = vi.fn().mockImplementation(async () => res(429, { 'Retry-After': '1' }));
    const p = sendWith429Retry(send, 'GET', sleep);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await p).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('never retries a POST', async () => {
    const send = vi.fn().mockResolvedValue(res(429, { 'Retry-After': '1' }));
    expect((await sendWith429Retry(send, 'POST', sleep)).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('caps the wait at 15s and defaults to 3s', () => {
    expect(retryAfterMs(res(429, { 'Retry-After': '120' }), () => 0)).toBe(RATE_LIMIT_MAX_WAIT_MS);
    expect(retryAfterMs(res(429), () => 0)).toBe(3000);
  });
});
