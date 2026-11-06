import { APPR_PROGRESS_STATUS_LABELS, type ApprProgressStatus } from '@cio/utils/constants/apprenticeship';

// Display helpers shared by the apprenticeship screens. No maths about progress lives here — the API's numbers
// are shown as given; these only format them.

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function fmtPct(pct: number | null | undefined): string {
  return pct === null || pct === undefined ? '—' : `${pct}%`;
}

export const STATUS_LABEL = (s: ApprProgressStatus) => APPR_PROGRESS_STATUS_LABELS[s] ?? s;

/** Tailwind classes for the RAG status chip. */
export const STATUS_CLASS: Record<ApprProgressStatus, string> = {
  ON_TARGET: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  BEHIND: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  CONCERN: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300',
  NOT_SET: 'bg-muted text-muted-foreground',
  COMPLETE: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300'
};

export const EVIDENCE_STATUS_CLASS: Record<string, string> = {
  SUBMITTED: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  ACCEPTED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  REFERRED: 'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300'
};

export function fmtBytes(n: number | undefined): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
