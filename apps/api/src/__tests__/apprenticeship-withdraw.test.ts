import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@cio/db/actor';

// Gecko Apprenticeships — Deploy 5: withdraw + reinstate. DB access is mocked with a tiny in-memory enrolment store so
// the guard and the pairing re-check see the state the withdraw / reinstate just wrote. access.ts, pair-lock.ts, the
// enrolment service and the glh service are real.

type Row = Record<string, unknown> & { id: string };
const store = new Map<string, Row>();

vi.mock('@cio/db/queries/apprenticeship', () => ({
  lockApprEnrolment: vi.fn(async (_tx: unknown, id: string) => store.get(id) ?? null),
  moveOtjLogs: vi.fn(async () => 0),
  listLinkedUnitCounts: vi.fn(async () => new Map()),
  sumValidatedOtjLogMinutes: vi.fn(async () => 0),
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprProgramme: vi.fn(),
  getApprEnrolment: vi.fn(async (id: string) => store.get(id) ?? null),
  getApprEnrolmentByProgrammeLearner: vi.fn(async () => null),
  getApprProgrammeStructure: vi.fn(async () => ({ qualifications: [], units: [], criteria: [] })),
  insertApprEnrolment: vi.fn(),
  insertEnrolmentUnits: vi.fn(async () => undefined),
  insertApprReview: vi.fn(async () => ({ id: 'rev' })),
  listLearnerEnrolments: vi.fn(async () => []),
  lockLearnerEnrolments: vi.fn(async () => undefined),
  getLinkedEnrolment: vi.fn(async (id: string) => {
    const self = store.get(id);
    if (!self) return null;
    for (const row of store.values()) {
      if (row.primaryEnrolmentId === id || row.id === self.primaryEnrolmentId) return row;
    }
    return null;
  }),
  setApprEnrolmentWithdrawn: vi.fn(async (_tx: unknown, id: string, by: { reason: string; at: string }) => {
    Object.assign(store.get(id)!, { withdrawnAt: by.at, withdrawalReason: by.reason });
  }),
  clearApprEnrolmentWithdrawn: vi.fn(async (_tx: unknown, id: string) => {
    Object.assign(store.get(id)!, { withdrawnAt: null, withdrawalReason: null });
    return true;
  }),
  linkApprEnrolments: vi.fn(async () => true),
  unlinkApprEnrolment: vi.fn(async () => undefined),
  countCrossMappedEvidence: vi.fn(async () => 0),
  listEnrolmentRows: vi.fn(async () => []),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getEnrolmentOverview: vi.fn(),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  listCriterionAcceptedDates: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  sumGlhLogMinutes: vi.fn(async () => 0),
  upsertEnrolmentUnitDates: vi.fn(async () => undefined),
  updateApprEnrolment: vi.fn(async () => undefined),
  insertGlhLog: vi.fn(async () => ({ id: 'glh-1' })),
  deleteGlhLog: vi.fn(async () => true),
  listGlhLogs: vi.fn(async () => [])
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  getOrgMemberRoleId: vi.fn(async (_org: string, id: string) => (id === '88888888-8888-4888-8888-888888888888' ? 2 : 3))
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', async () => ({
  runInTransaction: (fn: (tx: unknown) => unknown) => fn({ tx: true }),
  // the real tag, so the closed-rule SQL text can be rendered below
  sql: (await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm')).sql
}));
vi.mock('@api/services/apprenticeship/progress', () => ({
  todayIso: () => '2026-06-01',
  recomputeEnrolment: vi.fn(async () => null)
}));
vi.mock('@api/services/apprenticeship/onboarding', () => ({ ensureOnboardingTypes: vi.fn(async () => undefined) }));
vi.mock('@api/services/apprenticeship/notifications', () => ({ notifyGatewayReadyOrRelease: vi.fn() }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn(async () => undefined) }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));

import * as q from '@cio/db/queries/apprenticeship';
import { recomputeEnrolment } from '@api/services/apprenticeship/progress';
import { recordAudit } from '@cio/db/audit';
import { assertCarrierWritable, assertEnrolmentWritable } from '@api/services/apprenticeship/access';
import {
  createApprenticeship,
  listEnrolments,
  reinstateEnrolment,
  setUnitDates,
  spreadEnrolmentUnitDates,
  updateEnrolment,
  withdrawEnrolment
} from '@api/services/apprenticeship/enrolment';
import { addGlhLog, removeGlhLog } from '@api/services/apprenticeship/glh';
import { AppError } from '@api/utils/errors';
import { ZEnrolmentListQuery, ZEnrolmentReinstate, ZEnrolmentWithdraw } from '@cio/utils/validation/apprenticeship';

const ORG = 'org-1';
const DIP = '11111111-1111-4111-8111-111111111111';
const STD = '11111111-1111-4111-8111-222222222222';
const DIP2 = '11111111-1111-4111-8111-333333333333';
const LRN = '22222222-2222-4222-8222-222222222222';
const TUTOR = '88888888-8888-4888-8888-888888888888';
const CARRIER = '33333333-3333-4333-8333-333333333333';
const COMP = '33333333-3333-4333-8333-444444444444';
const SOLO = '33333333-3333-4333-8333-555555555555';
const NOW = new Date('2026-06-01T10:00:00Z');
const WITHDRAWN_AT = '2026-05-01T09:00:00.000Z';

const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
const tutor = { authenticated: true, userId: 'u-tutor', role: 'TUTOR', status: 'ACTIVE', orgId: ORG } as Actor;
const learner = { authenticated: true, userId: LRN, role: 'LEARNER', status: 'ACTIVE', orgId: ORG } as Actor;
const otherOrgAdmin = { ...admin, orgId: 'org-2' } as Actor;

const programmes: Record<string, Record<string, unknown>> = {
  [DIP]: { id: DIP, title: 'L3 Diploma', type: 'DIPLOMA', level: '3', pairedProgrammeId: STD },
  [STD]: { id: STD, title: 'L3 Standard', type: 'STANDARD', level: '3', pairedProgrammeId: null },
  [DIP2]: { id: DIP2, title: 'L3 Other Diploma', type: 'DIPLOMA', level: '3', pairedProgrammeId: null }
};

const enrolmentRow = (id: string, programmeId: string, over: Record<string, unknown> = {}): Row => ({
  id,
  organizationId: ORG,
  learnerId: LRN,
  programmeId,
  primaryEnrolmentId: null,
  startDate: '2026-01-01',
  plannedEndDate: '2027-01-01',
  withdrawnAt: null,
  withdrawalReason: null,
  achievedAt: null,
  ...over
});

/** A linked pair (carrier + component) in the store. */
function seedPair(over: { carrier?: Record<string, unknown>; component?: Record<string, unknown> } = {}) {
  store.clear();
  store.set(CARRIER, enrolmentRow(CARRIER, DIP, over.carrier));
  store.set(COMP, enrolmentRow(COMP, STD, { primaryEnrolmentId: CARRIER, ...over.component }));
}
function seedSolo(over: Record<string, unknown> = {}) {
  store.clear();
  store.set(SOLO, enrolmentRow(SOLO, DIP, over));
}

async function status(p: Promise<unknown>) {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof AppError ? e.statusCode : 500;
  }
}

const ref = (o: Record<string, unknown>) => ({
  id: 'e-open',
  programmeId: DIP,
  programmeTitle: 'L3 Diploma',
  type: 'DIPLOMA',
  level: '3',
  pairedProgrammeId: STD,
  pairedProgrammeTitle: 'L3 Standard',
  primaryEnrolmentId: null,
  componentId: null,
  achievedAt: null,
  withdrawnAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...o
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(q.getApprProgramme).mockImplementation((async (id: string) => {
    const p = programmes[id];
    return p ? { organizationId: ORG, status: 'ACTIVE', reviewIntervalWeeks: 12, ...p } : null;
  }) as never);
  vi.mocked(q.listLearnerEnrolments).mockResolvedValue([]);
});

describe('validation', () => {
  it('withdraw needs a trimmed reason (1..2000) and defaults scope to THIS', () => {
    expect(ZEnrolmentWithdraw.safeParse({ reason: '   ' }).success).toBe(false);
    expect(ZEnrolmentWithdraw.safeParse({ reason: 'x'.repeat(2001) }).success).toBe(false);
    expect(ZEnrolmentWithdraw.parse({ reason: '  Left the employer  ' })).toEqual({
      reason: 'Left the employer',
      scope: 'THIS'
    });
    expect(ZEnrolmentWithdraw.safeParse({ reason: 'ok', scope: 'EVERYTHING' }).success).toBe(false);
    expect(ZEnrolmentWithdraw.parse({ reason: 'ok', scope: 'BOTH' }).scope).toBe('BOTH');
  });

  it('the list state filter defaults to active', () => {
    expect(ZEnrolmentListQuery.parse({}).state).toBe('active');
    expect(ZEnrolmentListQuery.parse({ state: 'withdrawn' }).state).toBe('withdrawn');
    expect(ZEnrolmentListQuery.parse({ state: 'all' }).state).toBe('all');
    expect(ZEnrolmentListQuery.safeParse({ state: 'nope' }).success).toBe(false);
  });

  it('reinstate scope defaults to THIS', () => {
    expect(ZEnrolmentReinstate.parse({})).toEqual({ scope: 'THIS' });
    expect(ZEnrolmentReinstate.parse({ scope: 'BOTH' })).toEqual({ scope: 'BOTH' });
  });
});

describe('withdrawEnrolment', () => {
  it('THIS on a component withdraws only the component; the carrier stays active and the pair is recomputed', async () => {
    seedPair();
    const res = await withdrawEnrolment(admin, COMP, { reason: 'Left the standard', scope: 'THIS' });
    expect(res).toMatchObject({ enrolmentId: COMP, withdrawnIds: [COMP], closed: false });
    expect(res.withdrawnAt).toEqual(expect.any(String));
    expect(q.setApprEnrolmentWithdrawn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(q.setApprEnrolmentWithdrawn).mock.calls[0][1]).toBe(COMP);
    expect(vi.mocked(q.setApprEnrolmentWithdrawn).mock.calls[0][2]).toMatchObject({
      userId: 'u-admin',
      reason: 'Left the standard'
    });
    // survivors re-derived in the same transaction (the carrier id recomputes both halves)
    expect(recomputeEnrolment).toHaveBeenCalledWith(expect.anything(), CARRIER, { claimGatewayReady: true });
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({
      action: 'appr.enrolment.withdrawn',
      entityId: COMP,
      metadata: { scope: 'THIS', enrolmentIds: [COMP], closed: false, reason: 'Left the standard' }
    });
  });

  it('THIS on the CARRIER while the component is active keeps the pair open (the carrier row stays the record)', async () => {
    seedPair();
    const res = await withdrawEnrolment(admin, CARRIER, { reason: 'Diploma dropped', scope: 'THIS' });
    expect(res).toMatchObject({ withdrawnIds: [CARRIER], closed: false });
    expect(store.get(CARRIER)!.withdrawnAt).toBeTruthy();
    expect(store.get(COMP)!.withdrawnAt).toBeNull();
    // the carrier is still writable: it holds the reviews, OTJ, onboarding and gateway
    await expect(assertEnrolmentWritable(store.get(CARRIER) as never)).resolves.toBeUndefined();
    await expect(assertCarrierWritable(store.get(COMP) as never)).resolves.toBeUndefined();
  });

  it('BOTH withdraws every half and closes the apprenticeship (either id works)', async () => {
    seedPair();
    const res = await withdrawEnrolment(admin, COMP, { reason: 'Left the programme', scope: 'BOTH' });
    expect(res.closed).toBe(true);
    expect([...res.withdrawnIds].sort()).toEqual([CARRIER, COMP].sort());
    expect(store.get(CARRIER)!.withdrawnAt).toBeTruthy();
    expect(store.get(COMP)!.withdrawnAt).toBeTruthy();
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ metadata: { scope: 'BOTH', closed: true } });
  });

  it('a lone enrolment is closed by any scope', async () => {
    seedSolo();
    expect(await withdrawEnrolment(admin, SOLO, { reason: 'Left', scope: 'THIS' })).toMatchObject({ closed: true });
  });

  it('withdrawing the second half of a pair closes it', async () => {
    seedPair({ component: { withdrawnAt: WITHDRAWN_AT } });
    expect(await withdrawEnrolment(admin, CARRIER, { reason: 'Left', scope: 'THIS' })).toMatchObject({ closed: true });
  });

  it('already withdrawn is a 409; BOTH only touches the half that is still active', async () => {
    seedPair({ component: { withdrawnAt: WITHDRAWN_AT } });
    expect(await status(withdrawEnrolment(admin, COMP, { reason: 'Again', scope: 'THIS' }))).toBe(409);
    expect(q.setApprEnrolmentWithdrawn).not.toHaveBeenCalled();
    const res = await withdrawEnrolment(admin, COMP, { reason: 'All of it', scope: 'BOTH' });
    expect(res.withdrawnIds).toEqual([CARRIER]);
    expect(q.setApprEnrolmentWithdrawn).toHaveBeenCalledTimes(1);
  });

  it('is admin only (tutor / learner 403) and another org gets 404', async () => {
    seedPair();
    expect(await status(withdrawEnrolment(tutor, COMP, { reason: 'x', scope: 'THIS' }))).toBe(403);
    expect(await status(withdrawEnrolment(learner, COMP, { reason: 'x', scope: 'THIS' }))).toBe(403);
    expect(await status(withdrawEnrolment(otherOrgAdmin, COMP, { reason: 'x', scope: 'THIS' }))).toBe(404);
    expect(q.setApprEnrolmentWithdrawn).not.toHaveBeenCalled();
  });
});

describe('reinstateEnrolment', () => {
  it('clears the withdrawn columns, recomputes the pair and audits', async () => {
    seedPair({ component: { withdrawnAt: WITHDRAWN_AT, withdrawalReason: 'x' } });
    const res = await reinstateEnrolment(admin, COMP, { scope: 'THIS' });
    expect(res).toEqual({ enrolmentId: COMP, reinstatedIds: [COMP] });
    expect(q.clearApprEnrolmentWithdrawn).toHaveBeenCalledTimes(1);
    expect(store.get(COMP)!.withdrawnAt).toBeNull();
    expect(recomputeEnrolment).toHaveBeenCalledWith(expect.anything(), CARRIER, { claimGatewayReady: true });
    expect(vi.mocked(recordAudit).mock.calls[0][0]).toMatchObject({ action: 'appr.enrolment.reinstated' });
  });

  it('scope BOTH reinstates every withdrawn half', async () => {
    seedPair({ carrier: { withdrawnAt: WITHDRAWN_AT }, component: { withdrawnAt: WITHDRAWN_AT } });
    const res = await reinstateEnrolment(admin, CARRIER, { scope: 'BOTH' });
    expect([...res.reinstatedIds].sort()).toEqual([CARRIER, COMP].sort());
    expect(store.get(CARRIER)!.withdrawnAt).toBeNull();
    expect(store.get(COMP)!.withdrawnAt).toBeNull();
  });

  it('is a 409 when the enrolment is not withdrawn', async () => {
    seedPair();
    expect(await status(reinstateEnrolment(admin, COMP, { scope: 'THIS' }))).toBe(409);
    expect(q.clearApprEnrolmentWithdrawn).not.toHaveBeenCalled();
  });

  it('re-checks the one-diploma rule: a 409 when the learner has since taken another open diploma', async () => {
    seedSolo({ withdrawnAt: WITHDRAWN_AT });
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
      ref({ id: SOLO, programmeId: DIP, withdrawnAt: WITHDRAWN_AT }),
      ref({ id: 'other', programmeId: DIP2, programmeTitle: 'L3 Other Diploma', pairedProgrammeId: null })
    ] as never);
    const failure = await reinstateEnrolment(admin, SOLO, { scope: 'THIS' }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).statusCode).toBe(409);
    expect((failure as AppError).message).toContain('already has an open diploma');
    expect(q.clearApprEnrolmentWithdrawn).not.toHaveBeenCalled();
    expect(store.get(SOLO)!.withdrawnAt).toBe(WITHDRAWN_AT);
  });

  it('a withdrawn enrolment of the same type does not block reinstating (it is the one being reinstated)', async () => {
    seedSolo({ withdrawnAt: WITHDRAWN_AT });
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
      ref({ id: SOLO, programmeId: DIP, withdrawnAt: WITHDRAWN_AT })
    ] as never);
    expect(await status(reinstateEnrolment(admin, SOLO, { scope: 'THIS' }))).toBe(200);
  });

  it('is admin only and another org gets 404', async () => {
    seedSolo({ withdrawnAt: WITHDRAWN_AT });
    expect(await status(reinstateEnrolment(tutor, SOLO, { scope: 'THIS' }))).toBe(403);
    expect(await status(reinstateEnrolment(otherOrgAdmin, SOLO, { scope: 'THIS' }))).toBe(404);
  });
});

describe('a withdrawn enrolment is not "open" for the one-diploma + one-standard rule', () => {
  it('enrolling on a new diploma succeeds when the only other diploma is withdrawn', async () => {
    seedSolo({ withdrawnAt: WITHDRAWN_AT });
    vi.mocked(q.listLearnerEnrolments).mockResolvedValue([
      ref({ id: SOLO, programmeId: DIP, withdrawnAt: WITHDRAWN_AT })
    ] as never);
    vi.mocked(q.insertApprEnrolment).mockImplementation((async (_tx: unknown, v: object) => ({
      id: 'enr-new',
      ...v
    })) as never);
    const res = await createApprenticeship(admin, {
      learner: { learnerId: LRN },
      tutorId: TUTOR,
      enrolments: [{ programmeId: DIP2, startDate: '2026-06-01', plannedEndDate: '2027-06-01' }]
    } as never);
    expect(res.enrolments).toEqual([{ id: 'enr-new', programmeId: DIP2, role: 'STANDALONE' }]);
  });
});

describe('write guard: assertEnrolmentWritable', () => {
  it('lets an active enrolment (or one with no withdrawn flag) through without a query', async () => {
    seedPair();
    await expect(assertEnrolmentWritable(store.get(CARRIER) as never)).resolves.toBeUndefined();
    await expect(assertEnrolmentWritable({ id: 'x' })).resolves.toBeUndefined();
    expect(q.getLinkedEnrolment).not.toHaveBeenCalled();
  });

  it('blocks a withdrawn component, a withdrawn lone enrolment and a closed pair with a 409', async () => {
    seedPair({ component: { withdrawnAt: WITHDRAWN_AT } });
    const failure = await assertEnrolmentWritable(store.get(COMP) as never).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).statusCode).toBe(409);
    expect((failure as AppError).message).toBe('This apprenticeship has been withdrawn');

    seedSolo({ withdrawnAt: WITHDRAWN_AT });
    expect(await status(assertEnrolmentWritable(SOLO))).toBe(409);

    seedPair({ carrier: { withdrawnAt: WITHDRAWN_AT }, component: { withdrawnAt: WITHDRAWN_AT } });
    expect(await status(assertEnrolmentWritable(store.get(CARRIER) as never))).toBe(409);
    expect(await status(assertCarrierWritable(store.get(COMP) as never))).toBe(409);
  });

  it('a withdrawn carrier stays writable only while its component is active', async () => {
    seedPair({ carrier: { withdrawnAt: WITHDRAWN_AT } });
    expect(await status(assertEnrolmentWritable(CARRIER))).toBe(200);
    // an active component of a withdrawn carrier is itself writable
    expect(await status(assertEnrolmentWritable(store.get(COMP) as never))).toBe(200);
  });

  it('blocks the enrolment dates, unit dates and GLH writes on a closed apprenticeship (409), reads untouched', async () => {
    seedSolo({ withdrawnAt: WITHDRAWN_AT });
    expect(await status(updateEnrolment(admin, SOLO, { contractedHoursWeek: 20 }))).toBe(409);
    expect(await status(setUnitDates(admin, SOLO, { units: [] as never }))).toBe(409);
    expect(await status(spreadEnrolmentUnitDates(admin, SOLO, { onlyEmpty: false }))).toBe(409);
    expect(await status(addGlhLog(admin, SOLO, { minutes: 60, logDate: '2026-05-01' } as never))).toBe(409);
    expect(await status(removeGlhLog(admin, SOLO, 'log-1'))).toBe(409);
    expect(q.updateApprEnrolment).not.toHaveBeenCalled();
    expect(q.upsertEnrolmentUnitDates).not.toHaveBeenCalled();
    expect(q.insertGlhLog).not.toHaveBeenCalled();
    expect(q.deleteGlhLog).not.toHaveBeenCalled();
  });

  it('the same writes work on an active enrolment', async () => {
    seedSolo();
    expect(await status(addGlhLog(admin, SOLO, { minutes: 60, logDate: '2026-05-01' } as never))).toBe(200);
    expect(q.insertGlhLog).toHaveBeenCalledTimes(1);
  });
});

describe('every write service calls the guard', () => {
  const dir = resolve(__dirname, '../services/apprenticeship');
  const writes: Record<string, string[]> = {
    'evidence.ts': ['presignEvidenceUploads', 'createEvidence', 'updateEvidence', 'reviewEvidence', 'addEvidenceNote'],
    'tasks.ts': ['presignTaskUploads', 'createTask', 'updateTask', 'deleteTask'],
    'reviews.ts': ['createReview', 'updateReview', 'cancelReview', 'signReview'],
    'otj.ts': ['createOtjLog', 'updateOtjLogEntry', 'reviewOtjLog', 'deleteOtjLogEntry'],
    'onboarding.ts': [
      'presignOnboardingUploads',
      'saveOnboardingDoc',
      'withdrawOnboardingDoc',
      'reviewOnboardingDocument'
    ],
    'gateway.ts': ['setGatewayItem', 'confirmGateway', 'reopenGateway', 'updateEpa'],
    'glh.ts': ['addGlhLog', 'removeGlhLog'],
    'enrolment.ts': ['updateEnrolment', 'setUnitDates', 'spreadEnrolmentUnitDates', 'linkEnrolment', 'unlinkEnrolment'],
    'task-plans.ts': ['createTasksFromPlan']
  };
  for (const [file, fns] of Object.entries(writes)) {
    for (const fn of fns) {
      it(`${file} ${fn}`, () => {
        const source = readFileSync(resolve(dir, file), 'utf8').replace(/\r\n/g, '\n');
        const start = source.indexOf(`export async function ${fn}(`);
        expect(start, `${fn} not found`).toBeGreaterThan(-1);
        const next = source.indexOf('\nexport ', start + 10);
        const body = source.slice(start, next === -1 ? undefined : next);
        expect(/assert(Enrolment|Carrier)Writable\(/.test(body)).toBe(true);
      });
    }
  }
});

describe('the daily scans and the lists skip a CLOSED apprenticeship', () => {
  const queries = resolve(__dirname, '../../../../packages/db/src/queries/apprenticeship');
  const bodyOf = (file: string, fn: string) => {
    const source = readFileSync(resolve(queries, file), 'utf8').replace(/\r\n/g, '\n');
    const start = source.indexOf(`export async function ${fn}(`);
    expect(start, `${fn} not found`).toBeGreaterThan(-1);
    const next = source.indexOf('\nexport ', start + 10);
    return source.slice(start, next === -1 ? undefined : next);
  };

  it.each([
    ['tasks.ts', 'claimOverdueTasks'],
    ['tasks.ts', 'listOverdueTasks'],
    ['reviews.ts', 'claimDueReviews'],
    ['gateway.ts', 'listGatewayReadyCandidates'],
    ['enrolment.ts', 'listCarrierEnrolmentsNeedingFirstReview'],
    ['enrolment.ts', 'listEnrolmentRows'],
    ['summary.ts', 'countEvidenceByStatus'],
    ['summary.ts', 'countTasksByStatus'],
    ['summary.ts', 'countIqaOpen'],
    ['summary.ts', 'listOverdueTasksByType'],
    ['evidence.ts', 'listToMark']
  ])('%s %s applies the closed rule', (file, fn) => {
    expect(/apprenticeshipClosed(ByLearner)?Sql\(/.test(bodyOf(file, fn))).toBe(true);
  });

  it('the closed rule is: carrier withdrawn and no active component', async () => {
    const real = await vi.importActual<typeof import('@cio/db/queries/apprenticeship/withdrawn')>(
      '@cio/db/queries/apprenticeship/withdrawn'
    );
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { sql: text } = new PgDialect().sqlToQuery(real.apprenticeshipClosedSql('"appr_task"."enrolment_id"'));
    expect(text).toContain('ck.withdrawn_at is not null');
    expect(text).toContain(
      'not exists (select 1 from appr_enrolment cc where cc.primary_enrolment_id = ck.id and cc.withdrawn_at is null)'
    );
    expect(text).toContain('"appr_task"."enrolment_id"');
  });
});

describe('the learners list', () => {
  const listRow = (o: Record<string, unknown> = {}) => ({
    id: CARRIER,
    programmeId: DIP,
    programmeTitle: 'L3 Diploma',
    programmeType: 'DIPLOMA',
    linked: null,
    learnerId: LRN,
    learnerName: 'Amy Apprentice',
    learnerEmail: 'amy@example.com',
    startDate: '2026-01-01',
    plannedEndDate: '2027-01-01',
    contractedHoursWeek: 30,
    otjTargetMinutesOverride: 1000,
    achievedAt: null,
    withdrawnAt: null,
    withdrawalReason: null,
    actualPct: 60,
    otjMinutes: 100,
    tutors: [],
    onboarding: null,
    nextReview: null,
    glhMinutes: 0,
    glhTargetMinutes: null,
    unitsTotal: 2,
    unitsComplete: 2,
    gatewayItems: {},
    gatewayPassedAt: null,
    epaBookedDate: null,
    epaResult: null,
    epaResultDate: null,
    gatewayChecklist: null,
    ...o
  });
  const component = (o: Record<string, unknown> = {}) => ({
    id: COMP,
    programmeId: STD,
    programmeTitle: 'L3 Standard',
    programmeType: 'STANDARD',
    startDate: '2026-01-01',
    plannedEndDate: '2027-01-01',
    actualPct: 5,
    achievedAt: null,
    withdrawnAt: null,
    ...o
  });
  const query = { page: 1, pageSize: 25, state: 'active' };

  it('passes the state filter to the query (default active) and returns the withdrawn fields on each row', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ withdrawnAt: WITHDRAWN_AT, withdrawalReason: 'Left' })
    ] as never);
    const res = await listEnrolments(admin, { ...query, state: 'withdrawn' } as never, NOW);
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[0][0]).toMatchObject({ state: 'withdrawn' });
    expect(res.items[0]).toMatchObject({ withdrawnAt: WITHDRAWN_AT, withdrawalReason: 'Left' });
    await listEnrolments(admin, { ...query, state: 'all' } as never, NOW);
    expect(vi.mocked(q.listEnrolmentRows).mock.calls[1][0]).toMatchObject({ state: 'all' });
  });

  it('a withdrawn component drops out of `overall` and the status counts; `linked.withdrawnAt` is returned', async () => {
    // The component's 5% is far behind plan (CONCERN) but withdrawn, so the apprenticeship reads as the carrier alone.
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ linked: component({ withdrawnAt: WITHDRAWN_AT }) })
    ] as never);
    const res = await listEnrolments(admin, query as never, NOW);
    const [item] = res.items;
    expect(item.linked).toMatchObject({ id: COMP, withdrawnAt: WITHDRAWN_AT, actualPct: 5 });
    expect(item.overall.actualPct).toBe(60);
    expect(item.overall.status).toBe(item.status);
    expect(res.statusCounts[item.overall.status]).toBe(1);
    expect(res.statusCounts.CONCERN).toBe(0);
    // the status filter agrees with the chip
    const filtered = await listEnrolments(admin, { ...query, status: item.overall.status } as never, NOW);
    expect(filtered.items).toHaveLength(1);
  });

  it('a withdrawn CARRIER with an active component rolls up as the component alone', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ withdrawnAt: WITHDRAWN_AT, actualPct: 90, linked: component({ actualPct: 20 }) })
    ] as never);
    const [item] = (await listEnrolments(admin, query as never, NOW)).items;
    expect(item.overall.actualPct).toBe(20);
    expect(item.overall.status).toBe(item.linked!.status);
  });

  it('when every half is withdrawn the frozen numbers still roll up (average of both)', async () => {
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({
        withdrawnAt: WITHDRAWN_AT,
        actualPct: 60,
        linked: component({ withdrawnAt: WITHDRAWN_AT, actualPct: 20 })
      })
    ] as never);
    const [item] = (await listEnrolments(admin, { ...query, state: 'withdrawn' } as never, NOW)).items;
    expect(item.overall.actualPct).toBe(40);
  });

  it('the gateway unit count excludes a withdrawn half: ready on the active half alone', async () => {
    const unitsOnly = [{ key: 'units', label: 'All units complete', kind: 'AUTO_UNITS' }];
    // carrier complete (2/2); component has 3 units, none complete
    vi.mocked(q.listLinkedUnitCounts).mockResolvedValue(new Map([[CARRIER, { total: 3, complete: 0 }]]));
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ gatewayChecklist: unitsOnly, linked: component() })
    ] as never);
    expect((await listEnrolments(admin, query as never, NOW)).items[0].gatewayReady).toBe(false);
    vi.mocked(q.listEnrolmentRows).mockResolvedValue([
      listRow({ gatewayChecklist: unitsOnly, linked: component({ withdrawnAt: WITHDRAWN_AT }) })
    ] as never);
    expect((await listEnrolments(admin, query as never, NOW)).items[0].gatewayReady).toBe(true);
  });
});
