import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — programme tutors (assignment like a course's tutors) + named tutors. The access rule: a tutor
// reaches an enrolment when NAMED (allocation) OR assigned to THAT enrolment's programme; writes are admin only.

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprProgramme: vi.fn(),
  getEnrolmentOverview: vi.fn(async () => ({ tutors: [{ id: 'u-tutor', name: 'Tina' }] })),
  listTutorsForProgramme: vi.fn(async () => [{ id: 'u-cover', name: 'Cora' }]),
  listProgrammeIdsForTutor: vi.fn(async () => []),
  listProgrammeOptions: vi.fn(async () => []),
  filterProgrammeIdsInOrg: vi.fn(async (_org: string, ids: string[]) => ids),
  setProgrammesForTutor: vi.fn(async () => undefined),
  getAllocationIdForPair: vi.fn(async () => null)
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async () => 2)
}));
vi.mock('@api/services/organization/allocation', () => ({
  createTutorAllocation: vi.fn(async () => ({ id: 'alloc-1' })),
  removeTutorAllocation: vi.fn(async () => ({ id: 'alloc-1' }))
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({ runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }) }));

import * as q from '@cio/db/queries/apprenticeship';
import { getOrgMemberRoleId, isTutorAllocatedToLearner } from '@cio/db/queries/allocation';
import { createTutorAllocation, removeTutorAllocation } from '@api/services/organization/allocation';
import { canAccessLearner, getEnrolmentForActor } from '@api/services/apprenticeship/access';
import {
  addNamedTutor,
  getEnrolmentTutors,
  getTutorProgrammes,
  removeNamedTutor,
  setTutorProgrammes
} from '@api/services/apprenticeship/tutors';
import { AppError } from '@api/utils/errors';
import { ZTutorProgrammesPut } from '@cio/utils/validation/apprenticeship';

const ORG = 'org-1';
const PROG_A = '11111111-1111-4111-8111-111111111111';
const PROG_B = '11111111-1111-4111-8111-222222222222';
const LRN = '22222222-2222-4222-8222-222222222222';
const ENR = '33333333-3333-4333-8333-333333333333';
const TUT = '55555555-5555-4555-8555-555555555555';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const self = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const enrolment = { id: ENR, organizationId: ORG, programmeId: PROG_A, learnerId: LRN };

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof AppError ? e.statusCode : 500;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprEnrolment).mockResolvedValue(enrolment as never);
  vi.mocked(q.isProgrammeTutor).mockResolvedValue(false);
  vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(false);
  vi.mocked(getOrgMemberRoleId).mockResolvedValue(2);
});

describe('access rule — named OR programme tutor', () => {
  it('a tutor with neither link cannot reach the portfolio (404)', async () => {
    expect(await status(getEnrolmentForActor(tutor, ENR))).toBe(404);
  });

  it('a named (allocated) tutor reaches it without a programme lookup', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    expect(await status(getEnrolmentForActor(tutor, ENR))).toBe(200);
    expect(q.isProgrammeTutor).not.toHaveBeenCalled();
  });

  it('a programme tutor reaches it, checked against THAT enrolment programme', async () => {
    vi.mocked(q.isProgrammeTutor).mockImplementation(async (programmeId) => programmeId === PROG_A);
    expect(await status(getEnrolmentForActor(tutor, ENR))).toBe(200);
    expect(q.isProgrammeTutor).toHaveBeenCalledWith(PROG_A, 'u-tutor');
    // the same learner on another programme stays closed
    expect(await canAccessLearner(tutor, ORG, LRN, PROG_B)).toBe(false);
  });

  it('programme assignment never crosses orgs, and learners/admins are unaffected', async () => {
    vi.mocked(q.isProgrammeTutor).mockResolvedValue(true);
    expect(await canAccessLearner({ ...tutor, orgId: 'org-2' } as Actor, ORG, LRN, PROG_A)).toBe(false);
    expect(await canAccessLearner(self, ORG, LRN, PROG_A)).toBe(true);
    expect(await canAccessLearner({ ...self, userId: 'someone-else' } as Actor, ORG, LRN, PROG_A)).toBe(false);
    expect(await canAccessLearner(admin, ORG, LRN, PROG_A)).toBe(true);
  });
});

describe('programme tutors (Tutor Management)', () => {
  it('admin only; tutors and learners get 403', async () => {
    expect(await status(getTutorProgrammes(tutor, TUT))).toBe(403);
    expect(await status(setTutorProgrammes(self, TUT, []))).toBe(403);
    expect(await status(getTutorProgrammes(admin, TUT))).toBe(200);
  });

  it('the target must be a tutor of the admin org (404 otherwise)', async () => {
    vi.mocked(getOrgMemberRoleId).mockResolvedValue(3);
    expect(await status(setTutorProgrammes(admin, TUT, [PROG_A]))).toBe(404);
    vi.mocked(getOrgMemberRoleId).mockResolvedValue(null);
    expect(await status(getTutorProgrammes(otherOrgAdmin, TUT))).toBe(404);
    expect(q.setProgrammesForTutor).not.toHaveBeenCalled();
  });

  it('a programme of another org is refused (400) and nothing is written', async () => {
    vi.mocked(q.filterProgrammeIdsInOrg).mockResolvedValueOnce([PROG_A]);
    expect(await status(setTutorProgrammes(admin, TUT, [PROG_A, PROG_B]))).toBe(400);
    expect(q.setProgrammesForTutor).not.toHaveBeenCalled();
  });

  it('saves the exact set (empty clears) in a transaction', async () => {
    await setTutorProgrammes(admin, TUT, [PROG_A]);
    expect(q.setProgrammesForTutor).toHaveBeenCalledWith(ORG, TUT, [PROG_A], 'u-admin', { tx: true });
    await setTutorProgrammes(admin, TUT, []);
    expect(q.setProgrammesForTutor).toHaveBeenLastCalledWith(ORG, TUT, [], 'u-admin', { tx: true });
  });

  it('validation de-duplicates ids and rejects non-uuids', () => {
    expect(ZTutorProgrammesPut.parse({ programmeIds: [PROG_A, PROG_A] }).programmeIds).toEqual([PROG_A]);
    expect(ZTutorProgrammesPut.safeParse({ programmeIds: ['x'] }).success).toBe(false);
  });
});

describe('named tutors (portfolio)', () => {
  it('anyone who can see the portfolio reads both lists; others get 404', async () => {
    const res = await getEnrolmentTutors(self, ENR);
    expect(res).toEqual({ named: [{ id: 'u-tutor', name: 'Tina' }], programme: [{ id: 'u-cover', name: 'Cora' }] });
    expect(await status(getEnrolmentTutors(tutor, ENR))).toBe(404);
  });

  it('only an admin adds or removes a named tutor', async () => {
    vi.mocked(isTutorAllocatedToLearner).mockResolvedValue(true);
    expect(await status(addNamedTutor(tutor, ENR, TUT))).toBe(403);
    expect(await status(removeNamedTutor(self, ENR, TUT))).toBe(403);
    expect(createTutorAllocation).not.toHaveBeenCalled();
  });

  it('add allocates tutor ↔ learner; already named is fine', async () => {
    await addNamedTutor(admin, ENR, TUT);
    expect(createTutorAllocation).toHaveBeenCalledWith(ORG, admin, { tutorId: TUT, learnerId: LRN });
    vi.mocked(createTutorAllocation).mockRejectedValueOnce(new AppError('dup', 'CONFLICT' as never, 409));
    expect(await status(addNamedTutor(admin, ENR, TUT))).toBe(200);
  });

  it('add refuses a non-tutor; another org admin gets 404', async () => {
    vi.mocked(getOrgMemberRoleId).mockResolvedValue(3);
    expect(await status(addNamedTutor(admin, ENR, TUT))).toBe(404);
    expect(await status(addNamedTutor(otherOrgAdmin, ENR, TUT))).toBe(404);
    expect(createTutorAllocation).not.toHaveBeenCalled();
  });

  it('remove deletes that pair; a tutor who is not named gets 404', async () => {
    expect(await status(removeNamedTutor(admin, ENR, TUT))).toBe(404);
    vi.mocked(q.getAllocationIdForPair).mockResolvedValueOnce('alloc-9');
    await removeNamedTutor(admin, ENR, TUT);
    expect(q.getAllocationIdForPair).toHaveBeenLastCalledWith(ORG, TUT, LRN);
    expect(removeTutorAllocation).toHaveBeenCalledWith(ORG, admin, 'alloc-9');
  });
});
