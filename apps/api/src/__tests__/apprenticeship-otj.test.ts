import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships Deploy 3 — the OTJ service: the merged summary + rows (logs and OTJ evidence), the review
// state machine, and the cache recompute on every write. DB mocked.

const carrier = vi.hoisted(() => ({
  id: 'c1',
  organizationId: 'org-1',
  learnerId: 'l1',
  programmeId: 'p-dip',
  startDate: '2026-01-01',
  plannedEndDate: '2026-12-31',
  contractedHoursWeek: 30 as number | null,
  otjTargetMinutesOverride: 20100 as number | null,
  gatewayPassedAt: null
}));

vi.mock('@cio/db/queries/apprenticeship', () => ({
  getLinkedEnrolment: vi.fn(async () => null),
  getApprEnrolment: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  listOtjLogs: vi.fn(),
  listOtjEvidenceRows: vi.fn(),
  getOtjLog: vi.fn(),
  lockOtjLog: vi.fn(),
  lockApprEnrolment: vi.fn(async () => ({ gatewayPassedAt: null })),
  insertOtjLog: vi.fn(async (_tx: unknown, v: Record<string, unknown>) => ({ id: 'new', ...v })),
  updateOtjLog: vi.fn(),
  deleteOtjLog: vi.fn(),
  listOtjLogQueue: vi.fn(),
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@api/services/apprenticeship/access', async (orig) => ({
  ...(await orig<typeof import('@api/services/apprenticeship/access')>()),
  getEnrolmentForActor: vi.fn(async (_a: unknown, id: string) => ({ id }))
}));
vi.mock('@api/services/apprenticeship/enrolment', () => ({
  resolveApprenticeship: vi.fn(async () => ({
    carrier,
    component: { id: 'c2', programmeId: 'p-std', learnerId: 'l1' }
  }))
}));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-07-01',
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/notifications', () => ({
  notifyGatewayReadyOrRelease: vi.fn(),
  notifyOtjSubmitted: vi.fn(),
  notifyOtjReviewed: vi.fn(),
  notifySafely: async (_l: string, fn: () => Promise<void>) => fn()
}));

import * as q from '@cio/db/queries/apprenticeship';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { notifyOtjReviewed } from '@api/services/apprenticeship/notifications';
import {
  createOtjLog,
  deleteOtjLogEntry,
  getOtj,
  otjReviewTransition,
  reviewOtjLog,
  updateOtjLogEntry
} from '@api/services/apprenticeship/otj';

const admin: Actor = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: 'org-1' };

beforeEach(() => vi.clearAllMocks());

const log = (id: string, over: Record<string, unknown>) => ({
  id,
  title: id,
  minutes: 60,
  isOtj: true,
  logDate: '2026-03-01',
  status: 'VALIDATED',
  byName: 'Amy',
  details: '',
  reviewNote: null,
  ...over
});

describe('getOtj', () => {
  it('merges logs and OTJ evidence of both homes; only validated time counts; pending is reported', async () => {
    vi.mocked(q.listOtjLogs).mockResolvedValue([
      log('a', { minutes: 600 }),
      log('b', { minutes: 120, logDate: '2025-12-01', status: 'SUBMITTED' }),
      log('c', { minutes: 999, isOtj: false })
    ] as never);
    vi.mocked(q.listOtjEvidenceRows).mockResolvedValue([
      {
        id: 'e1',
        title: 'Ev diploma',
        details: '',
        minutes: 300,
        status: 'ACCEPTED',
        programmeId: 'p-dip',
        reviewedAt: '2026-04-01T10:00:00Z',
        createdAt: '2026-03-30T10:00:00Z',
        byName: 'Amy'
      },
      {
        id: 'e2',
        title: 'Ev standard',
        details: '',
        minutes: 60,
        status: 'REFERRED',
        programmeId: 'p-std',
        reviewedAt: null,
        createdAt: '2026-05-01T10:00:00Z',
        byName: 'Amy'
      }
    ] as never);

    const out = await getOtj(admin, 'c2');
    expect(q.listOtjEvidenceRows).toHaveBeenCalledWith(['p-dip', 'p-std'], 'l1');
    expect(out.summary).toMatchObject({
      doneMinutes: 900,
      pendingMinutes: 120,
      targetMinutes: 20100,
      source: 'OVERRIDE',
      completionPct: 4,
      contractedHoursWeek: 30
    });
    const byId = Object.fromEntries(out.rows.map((r) => [r.id, r]));
    expect(byId.e1).toMatchObject({
      kind: 'EVIDENCE',
      status: 'VALIDATED',
      homeEnrolmentId: 'c1',
      date: '2026-04-01',
      isOtj: true
    });
    expect(byId.e2).toMatchObject({ status: 'REJECTED', homeEnrolmentId: 'c2' });
    expect(byId.b.outsideWindow).toBe(true);
    expect(byId.a.outsideWindow).toBe(false);
    expect(out.rows[0].date >= out.rows[out.rows.length - 1].date).toBe(true);
  });

  it('source is CALCULATED without an override and NOT_SET without hours', async () => {
    vi.mocked(q.listOtjLogs).mockResolvedValue([]);
    vi.mocked(q.listOtjEvidenceRows).mockResolvedValue([]);
    carrier.otjTargetMinutesOverride = null;
    expect((await getOtj(admin, 'c1')).summary.source).toBe('CALCULATED');
    carrier.contractedHoursWeek = null;
    const none = await getOtj(admin, 'c1');
    expect(none.summary).toMatchObject({ source: 'NOT_SET', targetMinutes: null, completionPct: null });
    carrier.contractedHoursWeek = 30;
    carrier.otjTargetMinutesOverride = 20100;
  });
});

describe('writes recompute the carrier cache in the same transaction', () => {
  it('create recomputes the carrier (not the component)', async () => {
    await createOtjLog(admin, 'c2', { title: 'x', logDate: '2026-06-01', minutes: 30, isOtj: true });
    expect(recomputeEnrolment).toHaveBeenCalledWith({}, 'c1', { claimGatewayReady: true });
  });

  it('review recomputes too and stamps the reviewer', async () => {
    const row = { id: 'l', enrolmentId: 'c1', learnerId: 'l1', status: 'SUBMITTED' };
    vi.mocked(q.getOtjLog).mockResolvedValue(row as never);
    vi.mocked(q.lockOtjLog).mockResolvedValue(row as never);
    vi.mocked(q.updateOtjLog).mockResolvedValue({ ...row, status: 'VALIDATED' } as never);
    await reviewOtjLog(admin, 'l', { decision: 'VALIDATE', expectedStatus: 'SUBMITTED' });
    expect(vi.mocked(q.updateOtjLog).mock.calls[0][2]).toMatchObject({ status: 'VALIDATED', reviewedBy: 'u-admin' });
    expect(recomputeEnrolment).toHaveBeenCalledWith({}, 'c1', { claimGatewayReady: true });
  });
});

describe('lock order: the pair enrolment rows BEFORE the log row, in every write', () => {
  const row = { id: 'l', enrolmentId: 'c1', learnerId: 'l1', status: 'SUBMITTED', minutes: 30 };
  const callOrder = (fn: unknown) => (fn as { mock: { invocationCallOrder: number[] } }).mock.invocationCallOrder[0];
  beforeEach(() => {
    vi.mocked(q.getOtjLog).mockResolvedValue(row as never);
    vi.mocked(q.lockOtjLog).mockResolvedValue(row as never);
    vi.mocked(q.updateOtjLog).mockResolvedValue({ ...row, status: 'VALIDATED' } as never);
    vi.mocked(q.listOtjLogs).mockResolvedValue([]);
  });

  it('review', async () => {
    await reviewOtjLog(admin, 'l', { decision: 'VALIDATE', expectedStatus: 'SUBMITTED' });
    expect(callOrder(q.lockApprEnrolment)).toBeLessThan(callOrder(q.lockOtjLog));
  });

  it('update', async () => {
    await updateOtjLogEntry(admin, 'l', { minutes: 45 });
    expect(callOrder(q.lockApprEnrolment)).toBeLessThan(callOrder(q.lockOtjLog));
  });

  it('delete', async () => {
    await deleteOtjLogEntry(admin, 'l');
    expect(callOrder(q.lockApprEnrolment)).toBeLessThan(callOrder(q.lockOtjLog));
  });

  it('create locks the pair before inserting', async () => {
    await createOtjLog(admin, 'c1', { title: 'x', logDate: '2026-06-01', minutes: 30, isOtj: true });
    expect(callOrder(q.lockApprEnrolment)).toBeLessThan(callOrder(q.insertOtjLog));
  });
});

describe('review clears the tutors submitted alert only when no log is still waiting', () => {
  const row = { id: 'l', enrolmentId: 'c1', learnerId: 'l1', status: 'SUBMITTED' };
  beforeEach(() => {
    vi.mocked(q.getOtjLog).mockResolvedValue(row as never);
    vi.mocked(q.lockOtjLog).mockResolvedValue(row as never);
    vi.mocked(q.updateOtjLog).mockResolvedValue({ ...row, status: 'VALIDATED' } as never);
  });

  it('passes the number of logs still SUBMITTED on the carrier to the notifier', async () => {
    vi.mocked(q.listOtjLogs).mockResolvedValue([{ id: 'other' }] as never);
    await reviewOtjLog(admin, 'l', { decision: 'VALIDATE', expectedStatus: 'SUBMITTED' });
    expect(q.listOtjLogs).toHaveBeenCalledWith('c1', 'SUBMITTED');
    expect(vi.mocked(notifyOtjReviewed).mock.calls[0][0]).toMatchObject({ remainingSubmitted: 1 });
    vi.mocked(q.listOtjLogs).mockResolvedValue([]);
    await reviewOtjLog(admin, 'l', { decision: 'VALIDATE', expectedStatus: 'SUBMITTED' });
    expect(vi.mocked(notifyOtjReviewed).mock.calls[1][0]).toMatchObject({ remainingSubmitted: 0 });
  });
});

describe('otjReviewTransition', () => {
  it('moves between the three states with the admin-only reversal', () => {
    expect(otjReviewTransition('SUBMITTED', 'VALIDATE', false)).toBe('VALIDATED');
    expect(otjReviewTransition('REJECTED', 'VALIDATE', false)).toBe('VALIDATED');
    expect(otjReviewTransition('SUBMITTED', 'REJECT', false)).toBe('REJECTED');
    expect(otjReviewTransition('REJECTED', 'REOPEN', false)).toBe('SUBMITTED');
    expect(() => otjReviewTransition('VALIDATED', 'REOPEN', false)).toThrow(/admin/);
    expect(() => otjReviewTransition('VALIDATED', 'REJECT', false)).toThrow(/admin/);
    expect(otjReviewTransition('VALIDATED', 'REOPEN', true)).toBe('SUBMITTED');
    expect(() => otjReviewTransition('VALIDATED', 'VALIDATE', true)).toThrow();
    expect(() => otjReviewTransition('SUBMITTED', 'REOPEN', true)).toThrow();
  });
});
