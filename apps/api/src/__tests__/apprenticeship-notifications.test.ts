import { beforeEach, describe, expect, it, vi } from 'vitest';

// Gecko Apprenticeships — evidence notifications. Proves: a submission goes to the learner's ALLOCATED tutors only
// (none allocated → nothing); a review goes to the apprentice and clears every tutor's "to mark" alert for that
// evidence; everything is in-app only (no email template); notifySafely never throws. DB + pipeline mocked.

vi.mock('@cio/db/queries/allocation', () => ({ listTutorsForLearner: vi.fn(async () => []) }));
vi.mock('@cio/db/queries/comms', () => ({ markNotificationsReadForEntity: vi.fn(async () => 0) }));
vi.mock('@api/services/comms/notify', () => ({ emitNotification: vi.fn(async () => undefined) }));

import { listTutorsForLearner } from '@cio/db/queries/allocation';
import { markNotificationsReadForEntity } from '@cio/db/queries/comms';
import { emitNotification } from '@api/services/comms/notify';
import {
  notifyEvidenceReviewed,
  notifyEvidenceSubmitted,
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
