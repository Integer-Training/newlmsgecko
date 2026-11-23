// Gecko Apprenticeships — one tiny wrapper for every RPC call in this feature: runs the request, unwraps the
// { success, data } envelope and turns any failure (API error, zod validation error, network) into a message the
// UI can show as-is. Never throws.

import { RATE_LIMIT_MESSAGE } from '$lib/utils/services/api/rate-limit';

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string };

// Some failures arrive with the whole JSON body as the message ('{"success":false,"error":"…"}'): show only the text.
function unwrapJson(text: string): string {
  const t = text.trim();
  if (!t.startsWith('{')) return text;
  try {
    const inner = JSON.parse(t) as { error?: unknown; message?: unknown };
    if (typeof inner.error === 'string') return inner.error;
    if (typeof inner.message === 'string') return inner.message;
  } catch {
    // not JSON after all
  }
  return text;
}

function errorText(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { error?: unknown; message?: unknown };
  if (typeof b.error === 'string') return unwrapJson(b.error);
  if (typeof b.message === 'string') return b.message;
  // zValidator failure: { success: false, error: { issues: [{ message }] } }
  const issues = (b.error as { issues?: { message?: string }[] } | undefined)?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((i) => i.message)
      .filter(Boolean)
      .join('. ');
  }
  return fallback;
}

export async function call<T>(fn: () => Promise<Response>, fallback = 'Something went wrong'): Promise<CallResult<T>> {
  try {
    const res = await fn();
    const body = (await res.json()) as { success?: boolean; data?: unknown };
    if (body?.success === true) return { ok: true, data: body.data as T };
    return { ok: false, error: errorText(body, fallback) };
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 429) return { ok: false, error: RATE_LIMIT_MESSAGE };
    return { ok: false, error: error instanceof Error && error.message ? unwrapJson(error.message) : fallback };
  }
}
