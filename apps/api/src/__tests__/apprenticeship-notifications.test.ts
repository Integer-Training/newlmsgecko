import { beforeEach, describe, expect, it, vi } from 'vitest';

// Gecko Apprenticeships — evidence notifications. Proves: a submission goes to the learner's ALLOCATED tutors only
// (none allocated → nothing); a review goes to the apprentice and clears every tutor's "to mark" alert for that
// evidence; everything is in-app only (no email template); notifySafely never throws. DB + pipeline mocked.

vi.mock('@cio/db/queries/allocation', () => ({
  listTutorsForLearner: vi.fn(async () => []),
  listTutorsForLearnerInOrg: vi.fn(async () => [])
}));
vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprEnrolment: vi.fn(async (id: string) => ({ id, programmeId: `prog-${id}` })),
  listTutorsForProgramme: vi.fn(async () => []),
  listOrgAdminIds: vi.fn(async () => []),
  releaseGatewayReady: vi.fn(async () => undefined)
}));
vi.mock('@cio/db/queries/comms', () => ({ markNotificationsReadForEntity: vi.fn(async () => 0) }));
vi.mock('@api/services/comms/notify', () => ({ emitNotification: vi.fn(async () => undefined) }));

import { listTutorsForLearner, listTutorsForLearnerInOrg } from '@cio/db/queries/allocation';
import { listOrgAdminIds, listTutorsForProgramme, releaseGatewayReady } from '@cio/db/queries/apprenticeship';
import { markNotificationsReadForEntity } from '@cio/db/queries/comms';
import { emitNotification } from '@api/services/comms/notify';
import {
  notifyGatewayReady,
  notifyGatewayReadyOrRelease,
  notifyEvidenceReviewed,
  notifyEvidenceSubmitted,
  notifyOtjReviewed,
  notifyOtjSubmitted,
  notifySafely
} from '@api/services/apprenticeship/notifications';

beforeEach(() => vi.clearAllMocks());

describe('notifyEvidenceSubmitted', () => {
  it('sends one in-app notification per allocated tutor, about the evidence, with no email', async () => {
    vi.mocked(listTutorsForLearner).mockResolvedValue([
      { tutorId: 't1', email: 't1@x.test' },
      { tutorId: 't2', email: null }
    ] as never);
    await notifyEvidenceSubmitted({ evidenceId: 'ev-1', learnerId: 'l-1' });
    expect(listTutorsForLearner).toHaveBeenCalledWith('l-1');
    expect(emitNotification).toHaveBeenCalledWith({
      type: 'appr.evidence.submitted',
      recipients: [{ userId: 't1' }, { userId: 't2' }],
      entityType: 'appr_evidence',
      entityId: 'ev-1'
    });
    expect(vi.mocked(emitNotification).mock.calls[0][0]).not.toHaveProperty('emailTemplateId');
  });

  it('no allocated tutor → nothing is sent', async () => {
    vi.mocked(listTutorsForLearner).mockResolvedValue([]);
    await notifyEvidenceSubmitted({ evidenceId: 'ev-1', learnerId: 'l-1' });
    expect(emitNotification).not.toHaveBeenCalled();
  });
});

describe('notifyEvidenceSubmitted across a linked pair', () => {
  it('adds the programme tutors of BOTH enrolments, deduped with the named tutors', async () => {
    vi.mocked(listTutorsForLearner).mockResolvedValue([{ tutorId: 't1', email: null }] as never);
    vi.mocked(listTutorsForProgramme).mockImplementation((async (programmeId: string) =>
      programmeId === 'prog-e1' ? [{ id: 't1', name: 'a' }] : [{ id: 't2', name: 'b' }]) as never);
    await notifyEvidenceSubmitted({ evidenceId: 'ev-1', learnerId: 'l-1', enrolmentId: 'e1', pairEnrolmentId: 'e2' });
    expect(vi.mocked(emitNotification).mock.calls[0][0].recipients).toEqual([{ userId: 't1' }, { userId: 't2' }]);
  });
});

describe('off-the-job notifications', () => {
  it('submitted → named + programme tutors of both enrolments, deduped, never the author; entity = carrier', async () => {
    vi.mocked(listTutorsForLearner).mockResolvedValue([
      { tutorId: 't1', email: null },
      { tutorId: 'me', email: null }
    ] as never);
    vi.mocked(listTutorsForProgramme).mockResolvedValue([
      { id: 't1', name: 'a' },
      { id: 't3', name: 'c' }
    ] as never);
    await notifyOtjSubmitted({
      carrierEnrolmentId: 'c1',
      componentEnrolmentId: 'c2',
      learnerId: 'l-1',
      exceptUserId: 'me'
    });
    expect(emitNotification).toHaveBeenCalledWith({
      type: 'appr.otj.submitted',
      recipients: [{ userId: 't1' }, { userId: 't3' }],
      entityType: 'appr_enrolment',
      entityId: 'c1'
    });
  });

  it('reviewed with no log left waiting marks the tutors submitted alert read; with logs left it keeps it', async () => {
    vi.mocked(markNotificationsReadForEntity).mockClear();
    await notifyOtjReviewed({
      carrierEnrolmentId: 'c1',
      learnerId: 'l-1',
      outcome: 'VALIDATED',
      remainingSubmitted: 2
    });
    expect(markNotificationsReadForEntity).not.toHaveBeenCalled();
    await notifyOtjReviewed({ carrierEnrolmentId: 'c1', learnerId: 'l-1', outcome: 'REJECTED', remainingSubmitted: 0 });
    expect(markNotificationsReadForEntity).toHaveBeenCalledWith('appr_enrolment', 'c1', ['appr.otj.submitted']);
  });

  it('reviewed → the apprentice only', async () => {
    await notifyOtjReviewed({ carrierEnrolmentId: 'c1', learnerId: 'l-1', outcome: 'VALIDATED' });
    expect(emitNotification).toHaveBeenCalledWith({
      type: 'appr.otj.reviewed',
      recipients: [{ userId: 'l-1' }],
      entityType: 'appr_enrolment',
      entityId: 'c1'
    });
  });
});

describe('notifyEvidenceReviewed', () => {
  it.each([
    ['ACCEPTED', 'appr.evidence.accepted'],
    ['REFERRED', 'appr.evidence.referred']
  ] as const)('%s → tells the apprentice and clears the tutors’ to-mark alerts', async (outcome, type) => {
    await notifyEvidenceReviewed({ evidenceId: 'ev-1', learnerId: 'l-1', outcome });
    expect(markNotificationsReadForEntity).toHaveBeenCalledWith('appr_evidence', 'ev-1', ['appr.evidence.submitted']);
    expect(emitNotification).toHaveBeenCalledWith({
      type,
      recipients: [{ userId: 'l-1' }],
      entityType: 'appr_evidence',
      entityId: 'ev-1'
    });
  });
});

describe('notifySafely', () => {
  it('swallows a failure so the evidence change is never undone', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      notifySafely('x', async () => {
        throw new Error('db down');
      })
    ).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe('notifyGatewayReady', () => {
  it('goes to the allocated tutors of the learner (THIS org only) and the org admins, once each, in-app only', async () => {
    vi.mocked(listTutorsForLearnerInOrg).mockResolvedValue([
      { tutorId: 't1', email: null },
      { tutorId: 'a1', email: null }
    ] as never);
    vi.mocked(listOrgAdminIds).mockResolvedValue(['a1', 'a2']);
    await notifyGatewayReady({ enrolmentId: 'enr-1', learnerId: 'l-1', organizationId: 'org-1' });
    expect(listTutorsForLearnerInOrg).toHaveBeenCalledWith('l-1', 'org-1');
    expect(listOrgAdminIds).toHaveBeenCalledWith('org-1');
    expect(emitNotification).toHaveBeenCalledTimes(1);
    expect(emitNotification).toHaveBeenCalledWith({
      type: 'appr.gateway.ready',
      recipients: [{ userId: 't1' }, { userId: 'a1' }, { userId: 'a2' }],
      entityType: 'appr_enrolment',
      entityId: 'enr-1'
    });
  });

  it('nobody to tell -> nothing is sent', async () => {
    vi.mocked(listTutorsForLearnerInOrg).mockResolvedValue([]);
    vi.mocked(listOrgAdminIds).mockResolvedValue([]);
    await notifyGatewayReady({ enrolmentId: 'enr-1', learnerId: 'l-1', organizationId: 'org-1' });
    expect(emitNotification).not.toHaveBeenCalled();
  });
});

describe('notifyGatewayReadyOrRelease', () => {
  const ctx = { enrolmentId: 'enr-1', learnerId: 'l-1', organizationId: 'org-1' };
  beforeEach(() => {
    vi.mocked(listTutorsForLearnerInOrg).mockResolvedValue([{ tutorId: 't1', email: null }] as never);
    vi.mocked(listOrgAdminIds).mockResolvedValue([]);
  });

  it('sends normally and does NOT release the claim', async () => {
    await notifyGatewayReadyOrRelease(ctx);
    expect(emitNotification).toHaveBeenCalledTimes(1);
    expect(releaseGatewayReady).not.toHaveBeenCalled();
  });

  it('a failed send releases the claim (best-effort) so the daily scan retries - and never throws', async () => {
    vi.mocked(listOrgAdminIds).mockRejectedValueOnce(new Error('db blip'));
    await expect(notifyGatewayReadyOrRelease(ctx)).resolves.toBeUndefined();
    expect(releaseGatewayReady).toHaveBeenCalledWith('enr-1');
    expect(emitNotification).not.toHaveBeenCalled();
  });

  it('even if the release itself fails nothing is thrown', async () => {
    vi.mocked(listOrgAdminIds).mockRejectedValueOnce(new Error('db blip'));
    vi.mocked(releaseGatewayReady).mockRejectedValueOnce(new Error('still down'));
    await expect(notifyGatewayReadyOrRelease(ctx)).resolves.toBeUndefined();
  });
});
