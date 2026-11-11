import { AppError, ErrorCodes } from '@api/utils/errors';
import type { Actor } from '@cio/db/actor';
import {
  countUnreadNotifications,
  getLessonLinkTargets,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationRow
} from '@cio/db/queries/comms';
import {
  getEnrolmentLinkTargets,
  getEvidenceLinkTargets,
  getOnboardingDocLinkTargets,
  getReviewLinkTargets,
  getTaskLinkTargets
} from '@cio/db/queries/apprenticeship';

// PearlLMS Phase 6 Step 3 — the in-app notification centre service. STRICTLY self-only: every read/mutation
// uses the ACTOR's own id (taken from the resolved session, never from the URL) — there is no way to name
// another user. Each row is enriched with a subject line + a deep link resolved from its type + entity; the
// link is a CONVENIENCE — the target surface's own guards are the access control, not the link.

export interface NotificationItem {
  id: string;
  type: string;
  subject: string;
  link: string;
  createdAt: string;
  read: boolean;
}

export interface NotificationCentre {
  items: NotificationItem[];
  unreadCount: number;
}

function assertAuthed(actor: Actor): asserts actor is Extract<Actor, { authenticated: true }> {
  if (!actor.authenticated) throw new AppError('Unauthorized', ErrorCodes.UNAUTHORIZED, 401);
}

type EvidenceTargets = Awaited<ReturnType<typeof getEvidenceLinkTargets>>;
type TaskTargets = Awaited<ReturnType<typeof getTaskLinkTargets>>;
type ReviewTargets = Awaited<ReturnType<typeof getReviewLinkTargets>>;

type EnrolmentTargets = Awaited<ReturnType<typeof getEnrolmentLinkTargets>>;
type OnboardingDocTargets = Awaited<ReturnType<typeof getOnboardingDocLinkTargets>>;

interface ApprTargets {
  tasks: TaskTargets;
  reviews: ReviewTargets;
  enrolments?: EnrolmentTargets;
  onboardingDocs?: OnboardingDocTargets;
}

/** Gecko Apprenticeships: open the portfolio on a tab (tasks / reviews) — in the reader's own shell. */
function portfolioTabLink(
  enrolmentId: string | undefined,
  tab: 'tasks' | 'reviews' | 'gateway' | 'onboarding',
  isStaff: boolean
): string {
  if (!enrolmentId) return isStaff ? '/caseload/apprenticeships' : '/lms/apprenticeship';
  const base = isStaff ? '/caseload/apprenticeships/learners' : '/lms/apprenticeship';
  return `${base}/${enrolmentId}?tab=${tab}`;
}

/** Gecko Apprenticeships: open the portfolio with that evidence's sheet — in the reader's own shell. */
function evidenceLink(row: NotificationRow, evidence: EvidenceTargets, isStaff: boolean): string {
  const target = row.entityType === 'appr_evidence' && row.entityId ? evidence.get(row.entityId) : undefined;
  if (!target) return isStaff ? '/caseload/apprenticeships' : '/lms/apprenticeship';
  const base = isStaff ? '/caseload/apprenticeships/learners' : '/lms/apprenticeship';
  return `${base}/${target.enrolmentId}?evidence=${row.entityId}`;
}

function enrich(
  row: NotificationRow,
  lessons: Map<string, { courseId: string; title: string | null }>,
  homePath: string,
  evidence: EvidenceTargets = new Map(),
  isStaff = false,
  appr: ApprTargets = { tasks: new Map(), reviews: new Map() }
): NotificationItem {
  const base = { id: row.id, type: row.type, createdAt: row.createdAt, read: row.readAt != null };
  const lesson = row.entityType === 'lesson' && row.entityId ? lessons.get(row.entityId) : undefined;
  const lessonTitle = lesson?.title ?? 'a session';
  const lessonLink = lesson ? `/courses/${lesson.courseId}/lessons/${row.entityId}` : homePath;

  switch (row.type) {
    case 'submission.created':
      // Tutor: goes to the caseload / awaiting-marking queue (the tutor's guarded surface).
      return { ...base, subject: `New coursework submitted — ${lessonTitle}`, link: '/caseload' };
    case 'result.recorded':
      return { ...base, subject: `Your coursework was marked — ${lessonTitle}`, link: lessonLink };
    case 'session.unlocked':
      return { ...base, subject: `New session unlocked — ${lessonTitle}`, link: lessonLink };
    case 'announcement.published':
      // The broadcast banner lives on the recipient's dashboard — a tutor's is /caseload, a learner's /lms.
      return { ...base, subject: 'New announcement', link: homePath };
    case 'message.received':
      // Deep-link straight to the thread (entityId is the message_thread id) — the /messages/:threadId route
      // is role-agnostic (participant/Admin enforced server-side), so it works for the tutor and the learner.
      return { ...base, subject: 'New message', link: row.entityId ? `/messages/${row.entityId}` : homePath };
    case 'appr.evidence.submitted': {
      const ev = row.entityId ? evidence.get(row.entityId) : undefined;
      const who = ev?.learnerName ? `${ev.learnerName}: ` : '';
      return {
        ...base,
        subject: `New evidence to mark — ${who}${ev?.title ?? 'apprenticeship evidence'}`,
        link: evidenceLink(row, evidence, isStaff)
      };
    }
    case 'appr.evidence.accepted':
    case 'appr.evidence.referred': {
      const ev = row.entityId ? evidence.get(row.entityId) : undefined;
      const verb = row.type === 'appr.evidence.accepted' ? 'Evidence accepted' : 'Evidence referred back to you';
      return {
        ...base,
        subject: `${verb} — ${ev?.title ?? 'your apprenticeship evidence'}`,
        link: evidenceLink(row, evidence, isStaff)
      };
    }
    case 'appr.iqa.outcome': {
      // Sent to the assessor (staff) when the IQA decides on their sampled evidence: opens that evidence's sheet.
      const ev = row.entityId ? evidence.get(row.entityId) : undefined;
      return {
        ...base,
        subject: `IQA feedback on your assessment — ${ev?.title ?? 'apprenticeship evidence'}`,
        link: evidenceLink(row, evidence, isStaff)
      };
    }
    case 'appr.task.assigned': {
      const task = row.entityId ? appr.tasks.get(row.entityId) : undefined;
      return {
        ...base,
        subject: 'New apprenticeship tasks have been assigned to you',
        link: portfolioTabLink(task?.enrolmentId, 'tasks', isStaff)
      };
    }
    case 'appr.task.overdue': {
      const task = row.entityId ? appr.tasks.get(row.entityId) : undefined;
      const who = isStaff && task?.learnerName ? `${task.learnerName}: ` : '';
      return {
        ...base,
        subject: `Task overdue — ${who}${task?.title ?? 'apprenticeship task'}`,
        link: portfolioTabLink(task?.enrolmentId, 'tasks', isStaff)
      };
    }
    case 'appr.review.sign': {
      const review = row.entityId ? appr.reviews.get(row.entityId) : undefined;
      return {
        ...base,
        subject: 'Your progress review is ready to sign',
        link: portfolioTabLink(review?.enrolmentId, 'reviews', isStaff)
      };
    }
    case 'appr.review.due': {
      const review = row.entityId ? appr.reviews.get(row.entityId) : undefined;
      const who = review?.learnerName ? `${review.learnerName}: ` : '';
      return {
        ...base,
        subject: `Progress review due — ${who}apprenticeship`,
        link: portfolioTabLink(review?.enrolmentId, 'reviews', isStaff)
      };
    }
    case 'appr.gateway.ready': {
      const who = row.entityId ? appr.enrolments?.get(row.entityId)?.learnerName : null;
      return {
        ...base,
        subject: `Ready for gateway — ${who ?? 'apprentice'}`,
        link: portfolioTabLink(row.entityId ?? undefined, 'gateway', isStaff)
      };
    }
    case 'appr.onboarding.submitted': {
      const who = row.entityId ? appr.enrolments?.get(row.entityId)?.learnerName : null;
      return {
        ...base,
        subject: `Onboarding document uploaded — ${who ?? 'apprentice'}`,
        link: portfolioTabLink(row.entityId ?? undefined, 'onboarding', isStaff)
      };
    }
    case 'appr.onboarding.reviewed': {
      const doc = row.entityId ? appr.onboardingDocs?.get(row.entityId) : undefined;
      const label = doc?.label ?? 'Onboarding document';
      const subject =
        doc?.status === 'REJECTED'
          ? `${label} needs re-uploading${doc.reviewNote ? ` — ${doc.reviewNote}` : ''}`
          : `${label} approved`;
      return { ...base, subject, link: portfolioTabLink(doc?.enrolmentId, 'onboarding', isStaff) };
    }
    case 'appr.onboarding.complete': {
      const who = row.entityId ? appr.enrolments?.get(row.entityId)?.learnerName : null;
      return {
        ...base,
        subject: `Onboarding complete — ${who ?? 'apprentice'}`,
        link: portfolioTabLink(row.entityId ?? undefined, 'onboarding', isStaff)
      };
    }
    default:
      return { ...base, subject: 'Notification', link: homePath };
  }
}

/** The actor's own notifications (newest first) + their unread count. Self-only. */
export async function getNotificationCentre(
  actor: Actor,
  opts: { limit?: number; offset?: number } = {}
): Promise<NotificationCentre> {
  assertAuthed(actor);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
  const offset = Math.max(opts.offset ?? 0, 0);

  const rows = await listNotificationsForUser(actor.userId, { limit, offset });
  const unreadCount = await countUnreadNotifications(actor.userId);

  const lessonIds = [
    ...new Set(rows.filter((r) => r.entityType === 'lesson' && r.entityId).map((r) => r.entityId as string))
  ];
  const lessons = await getLessonLinkTargets(lessonIds);
  const evidenceIds = [
    ...new Set(rows.filter((r) => r.entityType === 'appr_evidence' && r.entityId).map((r) => r.entityId as string))
  ];
  const evidence = await getEvidenceLinkTargets(evidenceIds);
  const idsOf = (entityType: string) => [
    ...new Set(rows.filter((r) => r.entityType === entityType && r.entityId).map((r) => r.entityId as string))
  ];
  const taskIds = idsOf('appr_task');
  const reviewIds = idsOf('appr_review');
  const enrolmentIds = idsOf('appr_enrolment');
  const onboardingDocIds = idsOf('appr_onboarding_doc');
  const appr: ApprTargets = {
    enrolments: enrolmentIds.length ? await getEnrolmentLinkTargets(enrolmentIds) : new Map(),
    tasks: taskIds.length ? await getTaskLinkTargets(taskIds) : new Map(),
    reviews: reviewIds.length ? await getReviewLinkTargets(reviewIds) : new Map(),
    onboardingDocs: onboardingDocIds.length ? await getOnboardingDocLinkTargets(onboardingDocIds) : new Map()
  };

  // The recipient's home dashboard — where their broadcast banner + feed live (tutor → /caseload, else /lms).
  const homePath = actor.role === 'TUTOR' ? '/caseload' : '/lms';

  // Admins and tutors open apprenticeship links in the caseload shell (requireStaff); learners in /lms.
  const isStaff = actor.role === 'TUTOR' || actor.role === 'ADMIN';
  return { items: rows.map((r) => enrich(r, lessons, homePath, evidence, isStaff, appr)), unreadCount };
}

/** Mark ONE of the actor's own notifications read — scoped to actor.userId (a foreign id affects nothing). */
export async function markOwnNotificationRead(actor: Actor, notificationId: string): Promise<{ marked: number }> {
  assertAuthed(actor);
  return { marked: await markNotificationRead(notificationId, actor.userId) };
}

/** Mark ALL of the actor's own notifications read. */
export async function markAllOwnNotificationsRead(actor: Actor): Promise<{ marked: number }> {
  assertAuthed(actor);
  return { marked: await markAllNotificationsRead(actor.userId) };
}
