import {
  DEFAULT_RATE_LIMITER_OPTIONS,
  RATE_LIMIT_AUTH_PER_MIN,
  RATE_LIMIT_READ_PER_MIN,
  RATE_LIMIT_WRITE_PER_MIN,
  ERROR_MESSAGES,
  HTTP_STATUS,
  RATE_LIMIT_HEADERS
} from '@api/constants/rate-limiter';

import type { Context, MiddlewareHandler } from 'hono';
import { RedisRateLimiter } from '@api/utils/redis/limiter';
import { ipKeyGenerator, userKeyGenerator } from '../utils/redis/key-generators';
import { env } from '@cio/core/config/env';
import { logRedisUnavailableOnce, redis } from '@cio/core/utils/redis/redis';
import { withTimeout } from '@api/utils/with-timeout';

/** A rate-limit check must never hold up a request — if Redis stalls this long, fail open (allow). */
const RATE_LIMIT_CHECK_TIMEOUT_MS = 2_000;

/** Dashboard SSR and other internal callers authenticate with PRIVATE_SERVER_KEY. */
export function isTrustedServerApiKeyRequest(c: Context): boolean {
  const expectedKey = env.PRIVATE_SERVER_KEY;
  if (!expectedKey) return false;

  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return false;

  return authHeader.slice('Bearer '.length).trim() === expectedKey;
}

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number | ((c: any) => number);
  keyGenerator?: (c: any) => string;
  skip?: (c: any) => boolean;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  message?: string;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
}

const defaultOptions: Required<RateLimiterOptions> = {
  ...DEFAULT_RATE_LIMITER_OPTIONS,
  keyGenerator: userKeyGenerator,
  skip: () => false
};

export const createRateLimiter = (options: RateLimiterOptions = {}): MiddlewareHandler => {
  const opts = { ...defaultOptions, ...options };

  return async (c, next) => {
    // Skip rate limiting if not in production
    if (env.NODE_ENV !== 'production' || opts.skip(c)) {
      return await next();
    }

    try {
      const maxRequests = typeof opts.maxRequests === 'function' ? opts.maxRequests(c) : opts.maxRequests;
      const limiter = new RedisRateLimiter(redis, opts.windowMs, maxRequests);

      // Generate rate limit key
      const key = opts.keyGenerator(c);

      // Check rate limit (bounded — a stalled Redis command must not hang the request; the catch fails open).
      const result = await withTimeout(limiter.isAllowed(key), RATE_LIMIT_CHECK_TIMEOUT_MS, 'rate-limit check');

      // Set rate limit headers
      if (opts.standardHeaders) {
        c.header(RATE_LIMIT_HEADERS.LIMIT, maxRequests.toString());
        c.header(RATE_LIMIT_HEADERS.REMAINING, result.remaining.toString());
        c.header(RATE_LIMIT_HEADERS.RESET, new Date(result.resetTime).toISOString());
      }

      if (opts.legacyHeaders) {
        c.header(RATE_LIMIT_HEADERS.LIMIT, maxRequests.toString());
        c.header(RATE_LIMIT_HEADERS.REMAINING, result.remaining.toString());
        c.header(RATE_LIMIT_HEADERS.RESET, Math.ceil(result.resetTime / 1000).toString());
      }

      if (!result.allowed) {
        const retryAfter = Math.max(1, Math.ceil((result.resetTime - Date.now()) / 1000));

        if (opts.standardHeaders) {
          c.header(RATE_LIMIT_HEADERS.RETRY_AFTER, retryAfter.toString());
        }

        return c.json(
          {
            error: ERROR_MESSAGES.RATE_LIMIT_EXCEEDED,
            message: opts.message,
            retryAfter
          },
          HTTP_STATUS.TOO_MANY_REQUESTS
        );
      }

      await next();
    } catch (error) {
      logRedisUnavailableOnce('Redis rate limiter unavailable, allowing requests without rate limiting', error);
      await next();
    }
  };
};

const AUTH_ABUSE_PATH_PREFIXES = [
  '/api/auth/sign-in',
  '/api/auth/sign-up',
  '/api/auth/forget-password',
  '/api/auth/reset-password'
];

function isAuthAbuseRequest(c: Context): boolean {
  if (c.req.method !== 'POST') return false;

  return AUTH_ABUSE_PATH_PREFIXES.some((prefix) => c.req.path.startsWith(prefix));
}

/** Picks the bucket (key + per-minute budget) for a request. */
export function resolveRateLimitBucket(c: Context): { key: string; max: number } {
  if (isAuthAbuseRequest(c)) {
    return { key: `ip:auth:${ipKeyGenerator(c).slice(3)}`, max: RATE_LIMIT_AUTH_PER_MIN };
  }

  const user = c.get('user');

  if (user?.id) {
    const isRead = c.req.method === 'GET' || c.req.method === 'HEAD';

    return isRead
      ? { key: `user:${user.id}:read`, max: RATE_LIMIT_READ_PER_MIN }
      : { key: `user:${user.id}:write`, max: RATE_LIMIT_WRITE_PER_MIN };
  }

  // Org lookup runs on every SSR layout load; keep it out of the tight anonymous bucket.
  const max = c.req.method === 'GET' && c.req.path === '/organization' ? 500 : DEFAULT_RATE_LIMITER_OPTIONS.maxRequests;

  return { key: userKeyGenerator(c), max };
}

function shouldSkipRateLimit(c: Context): boolean {
  if (isTrustedServerApiKeyRequest(c)) return true;

  return c.req.path === '/api/auth/get-session';
}

// Default rate limiter middleware with standard configuration
export default createRateLimiter({
  maxRequests: (c) => resolveRateLimitBucket(c).max,
  keyGenerator: (c) => resolveRateLimitBucket(c).key,
  skip: shouldSkipRateLimit
});
