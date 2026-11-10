import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// PearlLMS Phase 6 Step 3 — the notification-centre SERVICE. Proves: reads/mutations use the ACTOR's own id
// (never a URL value); rows are enriched into subject + deep link by type; anon is refused. DB mocked.

vi.mock('@cio/db/queries/comms', () => ({
  listNotificationsForUser: vi.fn(async () => []),
  countUnreadNotifications: vi.fn(async () => 0),
  markNotificationRead: vi.fn(async () => 1),
  markAllNotificationsRead: vi.fn(async () => 3),
  getLessonLinkTargets: vi.fn(async () => new Map())
}));
vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getEvidenceLinkTargets: vi.fn(async () => new Map()),
  getTaskLinkTargets: vi.fn(async () => new Map()),
  getReviewLinkTargets: vi.fn(async () => new Map()),
  getEnrolmentLinkTargets: vi.fn(async () => new Map()),
  getOnboardingDocLinkTargets: vi.fn(async () => new Map())
}));

import {
  listNotificationsForUser,
  countUnreadNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getLessonLinkTargets
} from '@cio/db/queries/comms';
import {
  getEnrolmentLinkTargets,
  getEvidenceLinkTargets,
  getReviewLinkTargets,
  getTaskLinkTargets
} from '@cio/db/queries/apprenticeship';
import {
  getNotificationCentre,
  markOwnNotificationRead,
  markAllOwnNotificationsRead
} from '@api/services/comms/notification-centre';

const mList = vi.mocked(listNotificationsForUser);
const mCount = vi.mocked(countUnreadNotifications);
const mMark = vi.mocked(markNotificationRead);
const mMarkAll = vi.mocked(markAllNotificationsRead);
const mLessons = vi.mocked(getLessonLinkTargets);

const learner: Actor = { authenticated: true, userId: 'learner-A', role: 'LEARNER', status: 'ACTIVE', orgId: 'o1' };
const anon: Actor = { authenticated: false } as Actor;

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'n1',
  userId: 'learner-A',
  type: 'result.recorded',
  entityType: 'lesson',
  entityId: 'lesson-1',
  createdAt: '2026-08-18T10:00:00Z',
  readAt: null,
  ...over
});

async function code(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 0;
  } catch (e) {
    return (e as { statusCode?: number })?.statusCode ?? -1;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mList.mockResolvedValue([] as never);
  mCount.mockResolvedValue(0);
  mMark.mockResolvedValue(1);
  mMarkAll.mockResolvedValue(3);
  mLessons.mockResolvedValue(new Map());
});

describe('getNotificationCentre — self-scoped + enriched', () => {
  it('lists using the ACTOR own id and returns the unread count', async () => {
    mCount.mockResolvedValue(2);
    const res = await getNotificationCentre(learner);
    expect(mList).toHaveBeenCalledWith('learner-A', { limit: 30, offset: 0 });
    expect(mCount).toHaveBeenCalledWith('learner-A');
    expect(res.unreadCount).toBe(2);
  });

  it('enriches result.recorded → lesson deep link + subject', async () => {
    mList.mockResolvedValue([row()] as never);
    mLessons.mockResolvedValue(new Map([['lesson-1', { courseId: 'course-9', title: 'Session 3' }]]));
    const res = await getNotificationCentre(learner);
    expect(res.items[0]).toMatchObject({
      type: 'result.recorded',
      subject: 'Your coursework was marked — Session 3',
      link: '/courses/course-9/lessons/lesson-1',
      read: false
    });
  });

  it('submission.created → the caseload (tutor surface)', async () => {
    mList.mockResolvedValue([row({ type: 'submission.created' })] as never);
    mLessons.mockResolvedValue(new Map([['lesson-1', { courseId: 'course-9', title: 'Session 3' }]]));
    const res = await getNotificationCentre(learner);
    expect(res.items[0].link).toBe('/caseload');
  });

  it('session.unlocked → the newly-open lesson', async () => {
    mList.mockResolvedValue([row({ type: 'session.unlocked' })] as never);
    mLessons.mockResolvedValue(new Map([['lesson-1', { courseId: 'course-9', title: 'Portfolio' }]]));
    const res = await getNotificationCentre(learner);
    expect(res.items[0].link).toBe('/courses/course-9/lessons/lesson-1');
  });

  it('a read row reports read:true; a dangling lesson falls back to /lms', async () => {
    mList.mockResolvedValue([row({ readAt: '2026-08-18T11:00:00Z' })] as never);
    mLessons.mockResolvedValue(new Map()); // lesson not found
    const res = await getNotificationCentre(learner);
    expect(res.items[0].read).toBe(true);
    expect(res.items[0].link).toBe('/lms');
  });

  it('anon is refused (401)', async () => {
    expect(await code(getNotificationCentre(anon))).toBe(401);
  });

  describe('Gecko Apprenticeships evidence alerts → the portfolio, in the reader’s own shell', () => {
    const tutor: Actor = { authenticated: true, userId: 't-1', role: 'TUTOR', status: 'ACTIVE', orgId: 'o1' };
    const evRow = (type: string) => row({ type, entityType: 'appr_evidence', entityId: 'ev-1' });
    beforeEach(() => {
      vi.mocked(getEvidenceLinkTargets).mockResolvedValue(
        new Map([['ev-1', { enrolmentId: 'enr-1', title: 'Case study', learnerName: 'Amy Apprentice' }]])
      );
    });

    it('tutor: "New evidence to mark" → caseload portfolio with the evidence open', async () => {
      mList.mockResolvedValue([evRow('appr.evidence.submitted')] as never);
      const res = await getNotificationCentre(tutor);
      expect(getEvidenceLinkTargets).toHaveBeenCalledWith(['ev-1']);
      expect(res.items[0]).toMatchObject({
        subject: 'New evidence to mark — Amy Apprentice: Case study',
        link: '/caseload/apprenticeships/learners/enr-1?evidence=ev-1'
      });
    });

    it('apprentice: accepted / referred → their own portfolio in /lms', async () => {
      mList.mockResolvedValue([evRow('appr.evidence.accepted'), evRow('appr.evidence.referred')] as never);
      const res = await getNotificationCentre(learner);
      expect(res.items[0]).toMatchObject({
        subject: 'Evidence accepted — Case study',
        link: '/lms/apprenticeship/enr-1?evidence=ev-1'
      });
      expect(res.items[1].subject).toBe('Evidence referred back to you — Case study');
    });

    it('evidence that no longer exists falls back to the apprenticeship home of that shell', async () => {
      vi.mocked(getEvidenceLinkTargets).mockResolvedValue(new Map());
      mList.mockResolvedValue([evRow('appr.evidence.referred')] as never);
      expect((await getNotificationCentre(learner)).items[0].link).toBe('/lms/apprenticeship');
    });
  });
});

describe('Gecko Apprenticeships tasks + reviews alerts → the right tab, in the reader’s own shell', () => {
  const tutor: Actor = { authenticated: true, userId: 't-1', role: 'TUTOR', status: 'ACTIVE', orgId: 'o1' };
  const admin: Actor = { authenticated: true, userId: 'a-1', role: 'ADMIN', status: 'ACTIVE', orgId: 'o1' };
  const taskRow = (type: string) => row({ type, entityType: 'appr_task', entityId: 'task-1' });
  const reviewRow = (type: string) => row({ type, entityType: 'appr_review', entityId: 'rev-1' });
  beforeEach(() => {
    vi.mocked(getTaskLinkTargets).mockResolvedValue(
      new Map([['task-1', { enrolmentId: 'enr-1', title: 'Reflective log', learnerName: 'Amy Apprentice' }]])
    );
    vi.mocked(getReviewLinkTargets).mockResolvedValue(
      new Map([['rev-1', { enrolmentId: 'enr-1', learnerName: 'Amy Apprentice' }]])
    );
  });

  it('apprentice: assigned → their tasks tab; overdue names the task; review to sign → their reviews tab', async () => {
    mList.mockResolvedValue([
      taskRow('appr.task.assigned'),
      taskRow('appr.task.overdue'),
      reviewRow('appr.review.sign')
    ] as never);
    const res = await getNotificationCentre(learner);
    expect(getTaskLinkTargets).toHaveBeenCalledWith(['task-1']);
    expect(getReviewLinkTargets).toHaveBeenCalledWith(['rev-1']);
    expect(res.items[0].link).toBe('/lms/apprenticeship/enr-1?tab=tasks');
    expect(res.items[1]).toMatchObject({
      subject: 'Task overdue — Reflective log',
      link: '/lms/apprenticeship/enr-1?tab=tasks'
    });
    expect(res.items[2]).toMatchObject({
      subject: 'Your progress review is ready to sign',
      link: '/lms/apprenticeship/enr-1?tab=reviews'
    });
  });

  it('tutor and admin: overdue / review due → the caseload portfolio tab (admins use the same staff path)', async () => {
    mList.mockResolvedValue([taskRow('appr.task.overdue'), reviewRow('appr.review.due')] as never);
    for (const who of [tutor, admin]) {
      const res = await getNotificationCentre(who);
      expect(res.items[0]).toMatchObject({
        subject: 'Task overdue — Amy Apprentice: Reflective log',
        link: '/caseload/apprenticeships/learners/enr-1?tab=tasks'
      });
      expect(res.items[1]).toMatchObject({
        subject: 'Progress review due — Amy Apprentice: apprenticeship',
        link: '/caseload/apprenticeships/learners/enr-1?tab=reviews'
      });
    }
  });

  it('a task or review that no longer exists falls back to the apprenticeship home; no lookups when there are none', async () => {
    vi.mocked(getTaskLinkTargets).mockResolvedValue(new Map());
    mList.mockResolvedValue([taskRow('appr.task.assigned')] as never);
    expect((await getNotificationCentre(learner)).items[0].link).toBe('/lms/apprenticeship');
    vi.mocked(getTaskLinkTargets).mockClear();
    vi.mocked(getReviewLinkTargets).mockClear();
    mList.mockResolvedValue([row()] as never);
    await getNotificationCentre(learner);
    expect(getTaskLinkTargets).not.toHaveBeenCalled();
    expect(getReviewLinkTargets).not.toHaveBeenCalled();
  });
});

describe('Gecko Apprenticeships gateway-ready alert', () => {
  it('tutor and admin: opens the learner portfolio on the Gateway tab, naming the learner', async () => {
    vi.mocked(getEnrolmentLinkTargets).mockResolvedValue(new Map([['enr-1', { learnerName: 'Amy Apprentice' }]]));
    mList.mockResolvedValue([
      row({ type: 'appr.gateway.ready', entityType: 'appr_enrolment', entityId: 'enr-1' })
    ] as never);
    for (const role of ['TUTOR', 'ADMIN'] as const) {
      const who: Actor = { authenticated: true, userId: 'x', role, status: 'ACTIVE', orgId: 'o1' };
      const res = await getNotificationCentre(who);
      expect(getEnrolmentLinkTargets).toHaveBeenCalledWith(['enr-1']);
      expect(res.items[0]).toMatchObject({
        subject: 'Ready for gateway — Amy Apprentice',
        link: '/caseload/apprenticeships/learners/enr-1?tab=gateway'
      });
    }
  });
});

describe('mark read — scoped to the actor', () => {
  it('markOwnNotificationRead passes the actor own id (a foreign notification id marks nothing at the query)', async () => {
    await markOwnNotificationRead(learner, 'someones-notification-id');
    expect(mMark).toHaveBeenCalledWith('someones-notification-id', 'learner-A');
  });
  it('markAllOwnNotificationsRead scopes to the actor', async () => {
    const res = await markAllOwnNotificationsRead(learner);
    expect(mMarkAll).toHaveBeenCalledWith('learner-A');
    expect(res.marked).toBe(3);
  });
  it('anon refused on both', async () => {
    expect(await code(markOwnNotificationRead(anon, 'n1'))).toBe(401);
    expect(await code(markAllOwnNotificationsRead(anon))).toBe(401);
  });
});
