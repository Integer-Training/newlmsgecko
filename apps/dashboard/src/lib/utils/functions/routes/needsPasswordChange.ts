export const CHANGE_PASSWORD_PATH = '/change-password';

/** True while an admin-provisioned account still has its temporary password and isn't already on the change page. */
export function needsPasswordChange(profile: { settings?: unknown } | null | undefined, path: string): boolean {
  const flag = !!(profile?.settings as Record<string, unknown> | null | undefined)?.mustChangePassword;
  if (!flag) return false;
  const p = path.replace(/\/+$/, '') || '/';
  return p !== CHANGE_PASSWORD_PATH;
}

/** Only same-origin relative paths: must start with a single '/', no '//' or backslash tricks. Else null. */
export function safeRedirect(value: string | null | undefined): string | null {
  if (!value || typeof value !== 'string') return null;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  if (/[\u0000-\u001f]/.test(value)) return null;
  if (value.startsWith(CHANGE_PASSWORD_PATH)) return null;
  return value;
}

export function changePasswordUrl(pathPlusSearch: string): string {
  const safe = safeRedirect(pathPlusSearch);
  return safe ? `${CHANGE_PASSWORD_PATH}?redirect=${encodeURIComponent(safe)}` : CHANGE_PASSWORD_PATH;
}
