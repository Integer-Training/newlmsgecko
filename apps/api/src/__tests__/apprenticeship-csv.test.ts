import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCsv, parseCsvWithHeader } from '@cio/utils/functions/csv';
import { planStructureImport, splitUnitCode } from '@api/services/apprenticeship/programme-import';
import type { Actor } from '@cio/db/actor';

vi.mock('@cio/db/queries/apprenticeship', () => ({
  isProgrammeTutor: vi.fn(async () => false),
  isProgrammeTutorOfLinked: vi.fn(async () => false),
  getApprEnrolment: vi.fn(),
  getApprSettings: vi.fn(async () => ({ concernGapPct: 15, otjFactor: 0.2, otjWeeklyCapHours: 30 })),
  getEnrolmentOverview: vi.fn(),
  getApprProgrammeStructure: vi.fn(),
  countEvidenceByCriterion: vi.fn(async () => new Map()),
  listCriterionAcceptedDates: vi.fn(async () => new Map()),
  getEvidenceTotals: vi.fn(async () => ({ submitted: 0, accepted: 0, referred: 0, otjMinutes: 0 })),
  listEnrolmentUnitRows: vi.fn(async () => []),
  sumGlhLogMinutes: vi.fn(async () => 0),
  listAcceptedEvidenceTitles: vi.fn(async () => new Map())
}));
vi.mock('@cio/db/queries/allocation', () => ({
  isTutorAllocatedToLearner: vi.fn(async () => false),
  isCourseTutorForLearner: vi.fn(async () => false),
  isCourseTutor: vi.fn(async () => false)
}));
vi.mock('@cio/db/audit', () => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('@cio/db/drizzle', () => ({
  runInTransaction: (fn: (t: unknown) => unknown) => fn({}),
  sql: (strings: TemplateStringsArray) => strings.join('?')
}));
vi.mock('@api/services/apprenticeship/onboarding', () => ({ ensureOnboardingTypes: vi.fn(async () => undefined) }));
vi.mock('@api/services/organization/users', () => ({ createOrgUser: vi.fn() }));
vi.mock('@api/services/organization/allocation', () => ({ createTutorAllocation: vi.fn() }));
vi.mock('@api/services/apprenticeship/notifications', () => ({ notifyGatewayReadyOrRelease: vi.fn() }));
vi.mock('@api/middlewares/guards/ownership', () => ({ isAllocatedTutor: vi.fn(async () => false) }));

import * as q from '@cio/db/queries/apprenticeship';
import { exportPortfolioCsv } from '@api/services/apprenticeship/enrolment';

// Gecko Apprenticeships — the pure CSV parser and the structure-import planner (preview and apply share this plan).

describe('parseCsv', () => {
  it('parses simple rows with LF, CRLF and CR endings', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
    expect(parseCsv('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
  });
  it('handles quoted fields with commas, escaped quotes and embedded newlines', () => {
    expect(parseCsv('a,"b,c","say ""hi""","line1\nline2"')).toEqual([['a', 'b,c', 'say "hi"', 'line1\nline2']]);
  });
  it('keeps empty cells and a trailing empty cell', () => {
    expect(parseCsv('a,,c,')).toEqual([['a', '', 'c', '']]);
    expect(parseCsv('"",x')).toEqual([['', 'x']]);
  });
  it('skips blank lines, strips a BOM, and handles no trailing newline', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n\n')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ]);
    expect(parseCsv('')).toEqual([]);
  });
  it('treats a quote in the middle of an unquoted cell literally', () => {
    expect(parseCsv('5" pipe,x')).toEqual([['5" pipe', 'x']]);
  });
});

describe('parseCsvWithHeader', () => {
  it('lower-cases and trims headers, trims values, numbers rows from the file line', () => {
    const { headers, records } = parseCsvWithHeader(' Unit_Code , Unit_Title \n U1 , First \nU2,Second');
    expect(headers).toEqual(['unit_code', 'unit_title']);
    expect(records).toEqual([
      { row: 2, values: { unit_code: 'U1', unit_title: 'First' } },
      { row: 3, values: { unit_code: 'U2', unit_title: 'Second' } }
    ]);
  });
  it('treats missing trailing cells as empty', () => {
    expect(parseCsvWithHeader('a,b,c\n1').records[0].values).toEqual({ a: '1', b: '', c: '' });
  });
});

const Q1 = { id: 'q1', title: 'Diploma', reference: 'QD1' };
const empty = { qualifications: [Q1], units: [], criteria: [] };

describe('planStructureImport', () => {
  const csv = [
    'unit_code,unit_title,criterion_code,criterion_text,group,required',
    'U1,Communication,1.1,Explain things,Performance,2',
    'U1,Communication,1.2,"Listen, then reply",Performance,',
    'U2,Safety,2.1,Spot hazards,,'
  ].join('\n');

  it('plans new units and criteria into the first qualification, in order', () => {
    const plan = planStructureImport(empty, csv);
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toEqual({ unitsNew: 2, unitsUpdated: 0, criteriaNew: 3, criteriaUpdated: 0 });
    expect(plan.newUnits.map((u) => [u.code, u.sort, u.qualificationId])).toEqual([
      ['U1', 0, 'q1'],
      ['U2', 1, 'q1']
    ]);
    const u1 = plan.newUnits[0].id;
    expect(plan.newCriteria.filter((c) => c.unitId === u1).map((c) => [c.code, c.requiredCount, c.sort])).toEqual([
      ['1.1', 2, 0],
      ['1.2', 1, 1]
    ]);
  });

  it('is idempotent: re-importing the same file against its own result changes nothing', () => {
    const first = planStructureImport(empty, csv);
    const existing = {
      qualifications: [Q1],
      units: first.newUnits.map((u) => ({ ...u, externalRef: u.externalRef })),
      criteria: first.newCriteria.map((c) => ({ ...c }))
    };
    const again = planStructureImport(existing, csv);
    expect(again.summary).toEqual({ unitsNew: 0, unitsUpdated: 0, criteriaNew: 0, criteriaUpdated: 0 });
  });

  it('updates by unit code / criterion code and counts each once', () => {
    const existing = {
      qualifications: [Q1],
      units: [{ id: 'u1', qualificationId: 'q1', code: 'U1', title: 'Old title', externalRef: null, sort: 0 }],
      criteria: [
        {
          id: 'c1',
          unitId: 'u1',
          code: '1.1',
          text: 'Old',
          groupLabel: null,
          requiredCount: 1,
          externalRef: null,
          sort: 0
        }
      ]
    };
    const plan = planStructureImport(existing, csv);
    expect(plan.summary).toEqual({ unitsNew: 1, unitsUpdated: 1, criteriaNew: 2, criteriaUpdated: 1 });
    expect(plan.unitUpdates[0]).toMatchObject({ id: 'u1', patch: { title: 'Communication' } });
    expect(plan.criterionUpdates[0]).toMatchObject({
      id: 'c1',
      patch: { text: 'Explain things', requiredCount: 2, groupLabel: 'Performance' }
    });
    // New criterion appended after the existing sort, new unit after the existing one.
    expect(plan.newCriteria.find((c) => c.code === '1.2')?.sort).toBe(1);
    expect(plan.newUnits[0].sort).toBe(1);
  });

  it('matches by external ref before code', () => {
    const existing = {
      qualifications: [Q1],
      units: [{ id: 'u1', qualificationId: 'q1', code: 'OLD', title: 'T', externalRef: 'ext-9', sort: 0 }],
      criteria: []
    };
    const plan = planStructureImport(existing, 'unit_ref,unit_code,unit_title\next-9,NEW,T');
    expect(plan.summary.unitsNew).toBe(0);
    expect(plan.unitUpdates[0]).toMatchObject({ id: 'u1', patch: { code: 'NEW' } });
  });

  it('reports row errors without planning them, and keeps good rows', () => {
    const plan = planStructureImport(
      empty,
      [
        'unit_code,unit_title,criterion_code,criterion_text,required',
        'U1,One,1.1,Text,0',
        'U2,Two,2.1,,',
        'U3,Three,3.1,Fine,3'
      ].join('\n')
    );
    expect(plan.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(plan.summary).toEqual({ unitsNew: 1, unitsUpdated: 0, criteriaNew: 1, criteriaUpdated: 0 });
  });

  it('errors on an unknown qualification and on a missing unit column', () => {
    expect(planStructureImport(empty, 'qualification,unit_code\nNope,U1').errors[0].message).toMatch(/not found/);
    expect(planStructureImport(empty, 'criterion_code,criterion_text\n1,x').errors[0].row).toBe(1);
  });

  it('rejects more than 5,000 rows', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => `U${i},T${i}`).join('\n');
    const plan = planStructureImport(empty, `unit_code,unit_title\n${rows}`);
    expect(plan.errors[0].message).toMatch(/Too many rows/);
    expect(plan.newUnits).toHaveLength(0);
  });

  it('a unit-only row (no criterion) creates just the unit', () => {
    const plan = planStructureImport(empty, 'unit_code,unit_title\nU1,One');
    expect(plan.summary).toEqual({ unitsNew: 1, unitsUpdated: 0, criteriaNew: 0, criteriaUpdated: 0 });
  });
});

describe('Skills Portfolio export format', () => {
  const header = 'code,unitTitle,name,description,completedItems,requiredItems';
  const csv = [
    header,
    '"X/100/0001/01","U1 Talking","1.1","Say why people talk",1,1',
    '"X/100/0001/02","U1 Talking","1.2","Describe listening, briefly",0,2',
    '"X/100/0002/01","U2 Safety","1.1","Name a hazard",3,1'
  ].join('\r\n');
  const empty = {
    qualifications: [{ id: 'q1', title: 'Q', sort: 0, externalRef: null }],
    units: [],
    criteria: []
  } as never;

  it('maps the All Units export onto units and criteria (ignoring learner progress)', () => {
    const plan = planStructureImport(empty, csv);
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ unitsNew: 2, criteriaNew: 3 });
  });

  it('a single-unit export (no unitTitle) cannot create a unit on its own', () => {
    const single = ['code,name,description,completedItems,requiredItems', '"X/100/0001/01","1.1","Say why",1,1'].join(
      '\n'
    );
    const plan = planStructureImport(empty, single);
    expect(plan.errors.length).toBe(1);
  });
});

describe('Skills Portfolio unit codes', () => {
  it.each([
    ['U1 Talking', 'U1', 'Talking'],
    [
      'AC M6B Support the health and wellbeing of individuals',
      'AC M6B',
      'Support the health and wellbeing of individuals'
    ],
    ['AC M1 Promote communication in care settings', 'AC M1', 'Promote communication in care settings'],
    ['Communication skills', '', 'Communication skills'],
    ['NHS 111 Calls', '', 'NHS 111 Calls'],
    ['2.1 Something', '', '2.1 Something'],
    ['U1', '', 'U1']
  ])('%s → code "%s"', (raw, code, title) => {
    expect(splitUnitCode(raw)).toEqual({ code, title });
  });

  it('new units get the code from the title; the title keeps the rest', () => {
    const csv = [
      'code,unitTitle,name,description,completedItems,requiredItems',
      '"X/100/0001/01","U1 Talking","1.1","Say why",1,1'
    ].join('\n');
    const plan = planStructureImport(
      { qualifications: [{ id: 'q1', title: 'Q', sort: 0, externalRef: null }], units: [], criteria: [] } as never,
      csv
    );
    expect(plan.newUnits[0]).toMatchObject({ code: 'U1', title: 'Talking', externalRef: 'X/100/0001' });
  });

  it('re-import fills an EMPTY code but never overwrites one an admin set', () => {
    const csv = [
      'code,unitTitle,name,description,completedItems,requiredItems',
      '"X/100/0001/01","U1 Talking","1.1","Say why",1,1'
    ].join('\n');
    const existing = (code: string | null) =>
      ({
        qualifications: [{ id: 'q1', title: 'Q', sort: 0, externalRef: null }],
        units: [{ id: 'u1', qualificationId: 'q1', code, title: 'U1 Talking', sort: 0, externalRef: 'X/100/0001' }],
        criteria: []
      }) as never;
    expect(planStructureImport(existing(null), csv).unitUpdates[0]).toMatchObject({
      id: 'u1',
      patch: { code: 'U1', title: 'Talking' }
    });
    const kept = planStructureImport(existing('MY-CODE'), csv).unitUpdates[0];
    expect(kept).toMatchObject({ id: 'u1', patch: { code: 'MY-CODE', title: 'Talking' } });
  });
});

describe('optional glh column (guided learning hours per unit)', () => {
  const Q1 = { id: 'q1', title: 'Q', reference: null };
  const empty = { qualifications: [Q1], units: [], criteria: [] } as never;
  const csv = (glh: string) => ['unit_code,unit_title,glh', `U1,Talking,${glh}`].join('\n');

  it('sets GLH on new units; blank leaves it null', () => {
    expect(planStructureImport(empty, csv('45')).newUnits[0]).toMatchObject({ glh: 45 });
    expect(planStructureImport(empty, csv('')).newUnits[0]).toMatchObject({ glh: null });
    expect(planStructureImport(empty, csv('0')).newUnits[0]).toMatchObject({ glh: 0 });
  });

  it('updates an existing unit only when the value changes; blank never clears it; no glh column = untouched', () => {
    const existing = {
      qualifications: [Q1],
      units: [{ id: 'u1', qualificationId: 'q1', code: 'U1', title: 'Talking', externalRef: null, glh: 30, sort: 0 }],
      criteria: []
    } as never;
    expect(planStructureImport(existing, csv('30')).summary.unitsUpdated).toBe(0);
    const changed = planStructureImport(existing, csv('60'));
    expect(changed.unitUpdates[0]).toMatchObject({ id: 'u1', patch: { glh: 60 } });
    expect(planStructureImport(existing, csv('')).summary.unitsUpdated).toBe(0);
    expect(planStructureImport(existing, 'unit_code,unit_title\nU1,Talking').summary.unitsUpdated).toBe(0);
  });

  it('rejects a non-whole, negative or over-2000 value on that row only', () => {
    for (const bad of ['1.5', '-1', '2001', 'abc']) {
      const plan = planStructureImport(empty, csv(bad));
      expect(plan.errors[0]?.message, bad).toMatch(/glh must be a whole number/);
      expect(plan.newUnits).toHaveLength(0);
    }
  });

  it('the Skills Portfolio format has no glh, so units stay null', () => {
    const sp = [
      'code,unitTitle,name,description,completedItems,requiredItems',
      '"X/1","U1 Talking","1.1","Say",0,1'
    ].join('\n');
    expect(planStructureImport(empty, sp).newUnits[0]).toMatchObject({ glh: null });
  });
});

describe('exportPortfolioCsv achieved columns', () => {
  const ORG = 'org-1';
  const PROG = '11111111-1111-4111-8111-111111111111';
  const LRN = '22222222-2222-4222-8222-222222222222';
  const ENR = '33333333-3333-4333-8333-333333333333';
  const admin = { authenticated: true, userId: 'u-admin', role: 'ADMIN', status: 'ACTIVE', orgId: ORG } as Actor;
  const structure = {
    qualifications: [{ id: 'q1', title: 'Diploma', reference: '603/1', awardingBody: 'NCFE', level: '2' }],
    units: [{ id: 'u1', qualificationId: 'q1', code: 'U1', title: 'Communication', glh: null }],
    criteria: [
      { id: 'c1', unitId: 'u1', code: '1.1', text: 'Explain', groupLabel: null, requiredCount: 1 },
      { id: 'c2', unitId: 'u1', code: '1.2', text: 'Listen', groupLabel: null, requiredCount: 1 }
    ]
  };
  const run = async () => {
    const { csv } = await exportPortfolioCsv(admin, ENR);
    return csv
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.split(','));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(q.getApprEnrolment).mockResolvedValue({
      id: ENR,
      organizationId: ORG,
      programmeId: PROG,
      learnerId: LRN
    } as never);
    vi.mocked(q.getEnrolmentOverview).mockResolvedValue({
      enrolment: {
        id: ENR,
        organizationId: ORG,
        programmeId: PROG,
        learnerId: LRN,
        startDate: '2026-01-01',
        plannedEndDate: '2027-01-01',
        contractedHoursWeek: 30,
        otjTargetMinutesOverride: 1000,
        achievedAt: null,
        recomputedAt: null,
        gatewayItems: {}
      },
      learnerName: 'Amy',
      learnerEmail: 'amy@example.com',
      programmeTitle: 'Adult Care',
      programmeReference: null,
      programmeLevel: '2',
      tutors: [],
      overdueTaskCount: 0,
      nextReview: null,
      gatewayChecklist: null
    } as never);
    vi.mocked(q.getApprProgrammeStructure).mockResolvedValue(structure as never);
    vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(
      new Map([
        ['c1', { accepted: 1, submitted: 0 }],
        ['c2', { accepted: 1, submitted: 0 }]
      ]) as never
    );
  });

  it('keeps the existing columns first and appends the two date columns at the end', async () => {
    vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(
      new Map([
        ['c1', ['2026-03-04T10:00:00.000Z']],
        ['c2', ['2026-03-09T10:00:00.000Z']]
      ]) as never
    );
    const rows = await run();
    expect(rows[0]).toEqual([
      'Qualification',
      'Unit code',
      'Unit title',
      'Criterion code',
      'Criterion',
      'Required',
      'Accepted',
      'Met',
      'Evidence',
      'GLH target (h)',
      'GLH done (h)',
      'GLH expected (h)',
      'Criterion met on',
      'Unit achieved on'
    ]);
    expect(rows[1]!.slice(0, 9)).toEqual(['Diploma', 'U1', 'Communication', '1.1', 'Explain', '1', '1', 'Yes', '']);
    expect(rows[1]!.slice(12)).toEqual(['2026-03-04', '2026-03-09']);
    expect(rows[2]!.slice(12)).toEqual(['2026-03-09', '2026-03-09']);
  });

  it('formats the day in Europe/London, across midnight in summer and not in winter', async () => {
    vi.mocked(q.listCriterionAcceptedDates).mockResolvedValue(
      new Map([
        ['c1', ['2026-06-30T23:30:00.000Z']], // BST: already 1 July in London
        ['c2', ['2026-01-15T23:30:00.000Z']] // GMT: still 15 January
      ]) as never
    );
    const rows = await run();
    expect(rows[1]![12]).toBe('2026-07-01');
    expect(rows[2]![12]).toBe('2026-01-15');
    expect(rows[1]![13]).toBe('2026-07-01'); // unit = latest criterion
  });

  it('leaves both cells blank when nothing is met', async () => {
    vi.mocked(q.countEvidenceByCriterion).mockResolvedValue(new Map());
    const rows = await run();
    expect(rows[1]!.slice(7, 8)).toEqual(['No']);
    expect(rows[1]!.slice(12)).toEqual(['', '']);
  });
});
