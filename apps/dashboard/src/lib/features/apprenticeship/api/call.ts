// Gecko Apprenticeships — one tiny wrapper for every RPC call in this feature: runs the request, unwraps the
// { success, data } envelope and turns any failure (API error, zod validation error, network) into a message the
// UI can show as-is. Never throws.

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string };

function errorText(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const b = body as { error?: unknown; message?: unknown };
  if (typeof b.error === 'string') return b.error;
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
    return { ok: false, error: error instanceof Error && error.message ? error.message : fallback };
  }
}
