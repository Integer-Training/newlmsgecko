import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Phase 6: the learner roster carries a derived, read-only "kind" (course / apprentice / both).

const m = vi.hoisted(() => ({
  members: vi.fn(),
  appr: vi.fn()
}));

vi.mock('@cio/db/queries/organization', () => ({
  getSuperAdminMemberId: vi.fn(),
  getSuperAdminProfileId: vi.fn(),
  listOrgAdminMembers: vi.fn(),
  listOrgLearnerMembers: m.members,
  listOrgTutorMembersFull: vi.fn(),
  listApprenticeLearnerIds: m.appr,
  getOrganizationMemberByIdAndOrg: vi.fn()
}));
vi.mock('@cio/db/queries/allocation', () => ({
  listAllocationsByOrg: vi.fn(async () => []),
  getOrgMemberRoleId: vi.fn()
}));
vi.mock('@cio/db/queries/caseload', () => ({
  getEnrolmentsForLearners: vi.fn(async () => [{ learnerId: 'u-both', courseId: 'c1', title: 'Course' }]),
  getUnitTimeForLearners: vi.fn(async () => []),
  getCoursesForLearners: vi.fn()
}));
vi.mock('@cio/db/queries/analytics', () => ({ getLastSeenForUserIds: vi.fn(async () => new Map()) }));
vi.mock('@cio/db/queries/dash', () => ({
  getCourseCounts: vi.fn(),
  getMemberRoleStatusCounts: vi.fn(),
  getOnlineOrgMembers: vi.fn()
}));
vi.mock('@cio/db/queries/onboarding', () => ({ getCourseEnrolmentTarget: vi.fn(), listAllCoursesForOrg: vi.fn() }));
vi.mock('@cio/db/queries/course', () => ({
  addCourseMember: vi.fn(),
  listOrgTutorCourseAssignments: vi.fn(),
  listTutorCourses: vi.fn(),
  setTutorCourseAssignments: vi.fn()
}));
vi.mock('@api/services/course/compliance', () => ({ ensureComplianceEnrollmentRecordsForProfiles: vi.fn() }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@cio/db/queries/auth', () => ({ getProfileById: vi.fn() }));
vi.mock('@cio/db/auth', () => ({ mintLoginLinkToken: vi.fn() }));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(), AUDIT_ACTIONS: {} }));

import { getLearnerManagement, learnerKindOf } from '@api/services/organization/management';

const admin: Actor = { authenticated: true, userId: 'a1', role: 'ADMIN', status: 'ACTIVE', orgId: 'org-1' };
const member = (userId: string) => ({ memberId: 1, userId, name: userId, email: `${userId}@x.test`, status: 'ACTIVE' });

describe('learnerKindOf', () => {
  it('derives course / apprentice / both', () => {
    expect(learnerKindOf(0, false)).toBe('course');
    expect(learnerKindOf(3, false)).toBe('course');
    expect(learnerKindOf(0, true)).toBe('apprentice');
    expect(learnerKindOf(2, true)).toBe('both');
  });
});

describe('getLearnerManagement kind field', () => {
  beforeEach(() => {
    m.members.mockResolvedValue([member('u-course'), member('u-appr'), member('u-both')]);
    m.appr.mockResolvedValue(['u-appr', 'u-both']);
  });

  it('adds kind per row without changing the other fields', async () => {
    const res = await getLearnerManagement(admin);
    const byId = Object.fromEntries(res.rows.map((r) => [r.userId, r]));
    expect(byId['u-course'].kind).toBe('course');
    expect(byId['u-appr'].kind).toBe('apprentice');
    expect(byId['u-both'].kind).toBe('both');
    expect(byId['u-both'].courseCount).toBe(1);
    expect(res.kpis.total).toBe(3);
    expect(m.appr).toHaveBeenCalledWith('org-1');
  });
});
