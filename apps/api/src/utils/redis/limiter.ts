import {
  DEFAULT_MAX_REQUESTS,
  DEFAULT_WINDOW_MS,
  ERROR_MESSAGES,
  RATE_LIMIT_KEY_PREFIX
} from '@api/constants/rate-limiter';

import { redis, type RedisClient } from '@cio/core/utils/redis/redis';

/**
 * Sliding-window log, atomic: trim expired, count, and add the request ONLY when allowed.
 * Blocked requests are never recorded (so hammering a blocked key doesn't extend the lockout).
 * Returns { allowed(1/0), count after decision, oldest score in window (or 0) }.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local maxRequests = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < maxRequests then
  redis.call('ZADD', key, now, member)
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', key, windowMs)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local oldestScore = now
if oldest[2] then oldestScore = tonumber(oldest[2]) end
return { allowed, count, oldestScore }
`;

export class RedisRateLimiter {
  private redis: RedisClient;
  private windowMs: number;
  private maxRequests: number;

  constructor(redis: RedisClient, windowMs: number = DEFAULT_WINDOW_MS, maxRequests: number = DEFAULT_MAX_REQUESTS) {
    this.redis = redis;
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  async isAllowed(key: string): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const now = Date.now();
    const keyWithPrefix = `${RATE_LIMIT_KEY_PREFIX}${key}`;

    const result = (await this.redis.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [keyWithPrefix],
      arguments: [String(now), String(this.windowMs), String(this.maxRequests), `${now}-${Math.random()}`]
    })) as [number, number, number] | null;

    if (!Array.isArray(result) || result.length < 3) {
      throw new Error(ERROR_MESSAGES.REDIS_PIPELINE_FAILED);
    }

    const [allowedFlag, count, oldest] = result.map(Number);

    return {
      allowed: allowedFlag === 1,
      remaining: Math.max(0, this.maxRequests - count),
      // Capacity frees when the oldest entry leaves the window.
      resetTime: oldest + this.windowMs
    };
  }

  async reset(key: string): Promise<void> {
    const keyWithPrefix = `${RATE_LIMIT_KEY_PREFIX}${key}`;
    await this.redis.del(keyWithPrefix);
  }
}

export const rateLimiter = new RedisRateLimiter(redis);
