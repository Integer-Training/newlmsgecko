/**
 * Gecko Apprenticeships — the ONE rules module for progress. Pure functions only (no DB, no clock reads: callers
 * pass `today`), so the API cache recompute, CSV export and UI all compute identical numbers. Change a rule here
 * and every screen follows. Dates are calendar dates ('YYYY-MM-DD'); maths is done in whole UTC days.
 */
import { APPR_DEFAULT_SETTINGS, type ApprProgressStatus, type ApprSettings } from '../constants/apprenticeship';

const DAY_MS = 86_400_000;

/** Parse 'YYYY-MM-DD' (or an ISO timestamp — only the date part is used) to a UTC day number; null if invalid. */
export function toDayNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null; // e.g. 2026-02-30
  return Math.floor(ms / DAY_MS);
}

/** A criterion is met when accepted evidence count reaches its required count (min 1). */
export function criterionMet(acceptedCount: number, requiredCount: number): boolean {
  return Math.max(0, acceptedCount) >= Math.max(1, requiredCount);
}

/**
 * Actual % of a set of criteria, weighted by required count (a criterion needing 3 pieces is worth 3).
 * Partial credit: 1 of 3 accepted counts as 1/3 of that criterion. Floored, so 100 means truly complete.
 * Returns null when there are no criteria (nothing to measure).
 */
export function criteriaActualPct(
  criteria: readonly { acceptedCount: number; requiredCount: number }[]
): number | null {
  let required = 0;
  let done = 0;
  for (const c of criteria) {
    const req = Math.max(1, c.requiredCount);
    required += req;
    done += Math.min(Math.max(0, c.acceptedCount), req);
  }
  if (required === 0) return null;
  return Math.floor((done / required) * 100);
}

/**
 * Where the learner SHOULD be by `today`, as a % of the window [start, target]: 0 before start, 100 on/after the
 * target date, linear between. Null when either date is missing/invalid or target is before start (dates not set).
 */
export function expectedPct(
  start: string | null | undefined,
  target: string | null | undefined,
  today: string
): number | null {
  const s = toDayNumber(start);
  const t = toDayNumber(target);
  const now = toDayNumber(today);
  if (s === null || t === null || now === null || t < s) return null;
  if (now >= t) return 100;
  if (now <= s) return 0;
  return Math.round(((now - s) / (t - s)) * 100);
}

/** RAG status. COMPLETE wins; then NOT_SET without an expected position; then compare actual with expected. */
export function progressStatus(
  actual: number | null,
  expected: number | null,
  settings: Pick<ApprSettings, 'concernGapPct'> = APPR_DEFAULT_SETTINGS
): ApprProgressStatus {
  if (actual !== null && actual >= 100) return 'COMPLETE';
  if (expected === null) return 'NOT_SET';
  const a = actual ?? 0;
  if (a >= expected) return 'ON_TARGET';
  return expected - a <= settings.concernGapPct ? 'BEHIND' : 'CONCERN';
}

/** Qualification actual % = average of its units' actual % (units with no criteria are ignored). */
export function averagePct(values: readonly (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return Math.floor(nums.reduce((sum, v) => sum + v, 0) / nums.length);
}

/**
 * Off-the-job training target in minutes for the whole programme: weeks in [start, end] × min(contracted hours,
 * cap) × factor. An explicit override (set by tutor/admin) always wins. Null when it cannot be calculated.
 */
export function otjTargetMinutes(input: {
  start: string | null | undefined;
  end: string | null | undefined;
  contractedHoursWeek: number | null | undefined;
  overrideMinutes?: number | null;
  settings?: Pick<ApprSettings, 'otjFactor' | 'otjWeeklyCapHours'>;
}): number | null {
  if (input.overrideMinutes !== null && input.overrideMinutes !== undefined)
    return Math.max(0, Math.round(input.overrideMinutes));
  const s = toDayNumber(input.start);
  const e = toDayNumber(input.end);
  const hours = input.contractedHoursWeek;
  if (s === null || e === null || e < s || hours === null || hours === undefined || hours <= 0) return null;
  const settings = input.settings ?? APPR_DEFAULT_SETTINGS;
  const weeks = (e - s) / 7;
  return Math.round(weeks * Math.min(hours, settings.otjWeeklyCapHours) * settings.otjFactor * 60);
}

/** OTJ minutes expected by `today` = target × expected % of the programme window. */
export function otjExpectedMinutes(
  targetMinutes: number | null,
  start: string | null | undefined,
  end: string | null | undefined,
  today: string
): number | null {
  if (targetMinutes === null) return null;
  const pct = expectedPct(start, end, today);
  if (pct === null) return null;
  return Math.round((targetMinutes * pct) / 100);
}

export interface ApprUnitInput {
  unitId: string;
  startDate: string | null;
  targetDate: string | null;
  criteria: readonly { acceptedCount: number; requiredCount: number }[];
}

export interface ApprUnitProgress {
  unitId: string;
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
}

export interface ApprEnrolmentProgress {
  actualPct: number | null;
  expectedPct: number | null;
  status: ApprProgressStatus;
  otjTargetMinutes: number | null;
  otjExpectedMinutes: number | null;
  otjMinutes: number;
  otjStatus: ApprProgressStatus;
  units: ApprUnitProgress[];
}

/**
 * Whole-learner roll-up used by the cache recompute and by any from-scratch check. Qualification actual = average of
 * unit actuals; expected = position in the enrolment window [start, planned end]; OTJ compares accepted OTJ minutes
 * with the expected minutes to date.
 */
export function computeEnrolmentProgress(input: {
  startDate: string | null;
  plannedEndDate: string | null;
  contractedHoursWeek: number | null;
  otjOverrideMinutes: number | null;
  otjMinutes: number;
  units: readonly ApprUnitInput[];
  today: string;
  settings?: ApprSettings;
}): ApprEnrolmentProgress {
  const settings = input.settings ?? APPR_DEFAULT_SETTINGS;
  const units = input.units.map((u) => {
    const actual = criteriaActualPct(u.criteria);
    const expected = expectedPct(u.startDate, u.targetDate, input.today);
    return {
      unitId: u.unitId,
      actualPct: actual,
      expectedPct: expected,
      status: progressStatus(actual, expected, settings)
    };
  });
  const actual = averagePct(units.map((u) => u.actualPct));
  const expected = expectedPct(input.startDate, input.plannedEndDate, input.today);
  const target = otjTargetMinutes({
    start: input.startDate,
    end: input.plannedEndDate,
    contractedHoursWeek: input.contractedHoursWeek,
    overrideMinutes: input.otjOverrideMinutes,
    settings
  });
  const otjExpected = otjExpectedMinutes(target, input.startDate, input.plannedEndDate, input.today);
  const otjActualPct = target ? Math.floor((Math.max(0, input.otjMinutes) / target) * 100) : null;
  const otjExpectedPct = target && otjExpected !== null ? Math.round((otjExpected / target) * 100) : null;
  return {
    actualPct: actual,
    expectedPct: expected,
    status: progressStatus(actual, expected, settings),
    otjTargetMinutes: target,
    otjExpectedMinutes: otjExpected,
    otjMinutes: Math.max(0, input.otjMinutes),
    otjStatus: progressStatus(otjActualPct, otjExpectedPct, settings),
    units
  };
}

/**
 * Spread a programme window across units in order, each unit's share weighted by its criteria count, as consecutive
 * non-overlapping [start, target] date ranges. The last unit ends exactly on the programme end. Returns [] when the
 * window is invalid.
 */
export function spreadUnitDates(
  start: string,
  end: string,
  units: readonly { unitId: string; weight: number }[]
): { unitId: string; startDate: string; targetDate: string }[] {
  const s = toDayNumber(start);
  const e = toDayNumber(end);
  if (s === null || e === null || e < s || units.length === 0) return [];
  const weights = units.map((u) => Math.max(1, u.weight));
  const total = weights.reduce((a, b) => a + b, 0);
  const span = e - s;
  const fmt = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
  let cumulative = 0;
  let cursor = s;
  return units.map((u, i) => {
    cumulative += weights[i]!;
    const unitEnd = i === units.length - 1 ? e : s + Math.round((span * cumulative) / total);
    const range = { unitId: u.unitId, startDate: fmt(cursor), targetDate: fmt(Math.max(cursor, unitEnd)) };
    cursor = Math.min(e, Math.max(cursor, unitEnd) + 1);
    return range;
  });
}

// ── Round 2: tasks and progress reviews ──

const fmtDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * Add whole months to a calendar date, clamping to the last day of the target month (31 Jan + 1 month = 28/29 Feb).
 * Null when the date is invalid. Used for task due dates (learner start + month offset).
 */
export function addMonths(date: string | null | undefined, months: number): string | null {
  const day = toDayNumber(date);
  if (day === null) return null;
  const d = new Date(day * DAY_MS);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + Math.trunc(months);
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return fmtDay(Math.floor(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDay)) / DAY_MS));
}

/** Add whole days to a calendar date. */
export function addDays(date: string | null | undefined, days: number): string | null {
  const day = toDayNumber(date);
  return day === null ? null : fmtDay(day + Math.trunc(days));
}

/** A task's due date: learner start + the plan item's month offset. No start date → no due date. */
export function taskDueDate(startDate: string | null | undefined, monthOffset: number): string | null {
  return addMonths(startDate, Math.max(0, monthOffset));
}

/**
 * A task's status from its linked evidence, newest first. The latest piece decides (a resubmission after a referral
 * makes it SUBMITTED again); any ACCEPTED piece completes the task for good.
 */
export function taskStatusFromEvidence(
  evidenceNewestFirst: readonly { status: string }[]
): 'PLANNED' | 'SUBMITTED' | 'REFERRED' | 'COMPLETE' {
  if (evidenceNewestFirst.some((e) => e.status === 'ACCEPTED')) return 'COMPLETE';
  const latest = evidenceNewestFirst[0];
  if (!latest) return 'PLANNED';
  return latest.status === 'REFERRED' ? 'REFERRED' : 'SUBMITTED';
}

/** Overdue = has a due date, it has passed, and the task is not complete. */
export function isTaskOverdue(task: { dueDate: string | null; status: string }, today: string): boolean {
  const due = toDayNumber(task.dueDate);
  const now = toDayNumber(today);
  return due !== null && now !== null && now > due && task.status !== 'COMPLETE';
}

/** Valid-window check for assigning a task plan (either end may be open). */
export function isWithinWindow(validFrom: string | null, validTo: string | null, today: string): boolean {
  const now = toDayNumber(today);
  if (now === null) return false;
  const from = toDayNumber(validFrom);
  const to = toDayNumber(validTo);
  return (from === null || now >= from) && (to === null || now <= to);
}

/** First / next review date: from a base date (learner start, or the date the last review was held) + interval. */
export function nextReviewDate(base: string | null | undefined, intervalWeeks: number): string | null {
  return addDays(base, Math.max(1, Math.trunc(intervalWeeks)) * 7);
}

/** Review overdue = scheduled date passed and not COMPLETE/CANCELLED. */
export function isReviewOverdue(review: { scheduledDate: string; status: string }, today: string): boolean {
  const due = toDayNumber(review.scheduledDate);
  const now = toDayNumber(today);
  return due !== null && now !== null && now > due && review.status !== 'COMPLETE' && review.status !== 'CANCELLED';
}

/** A review can complete only when every required signature is present. */
export function reviewFullySigned(r: {
  tutorSignedAt: string | null;
  learnerSignedAt: string | null;
  employerSignedAt: string | null;
}): boolean {
  return Boolean(r.tutorSignedAt && r.learnerSignedAt && r.employerSignedAt);
}

/**
 * Date of an enrolment's FIRST review: start + interval, but never in the past — a date already gone (late back-fill,
 * or a start date moved backwards) becomes today + 7 days so the tutor has a week's notice. No start date → null.
 */
export function firstReviewDate(
  startDate: string | null | undefined,
  intervalWeeks: number,
  today: string
): string | null {
  const natural = nextReviewDate(startDate, intervalWeeks);
  if (!natural) return null;
  const n = toDayNumber(natural);
  const t = toDayNumber(today);
  return n !== null && t !== null && n < t ? addDays(today, 7) : natural;
}
