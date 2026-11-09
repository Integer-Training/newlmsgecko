import { describe, expect, it } from 'vitest';

import {
  averagePct,
  computeEnrolmentProgress,
  criteriaActualPct,
  criterionMet,
  expectedPct,
  otjExpectedMinutes,
  otjTargetMinutes,
  progressStatus,
  spreadUnitDates,
  toDayNumber,
  addMonths,
  addDays,
  taskDueDate,
  taskStatusFromEvidence,
  isTaskOverdue,
  isWithinWindow,
  nextReviewDate,
  isReviewOverdue,
  reviewFullySigned
} from '@cio/utils/functions/apprenticeship-progress';

// Gecko Apprenticeships rules module. Every screen, the cache recompute and the CSV export read these functions,
// so these tests pin the rules the owner agreed (2026-11-06): only accepted evidence counts, expected % is the
// position in the date window, On target / Behind (gap ≤ 15) / Concern (gap > 15) / Dates not set / Complete.

describe('toDayNumber', () => {
  it('parses dates and ignores the time part', () => {
    expect(toDayNumber('2026-01-02')).toBe(toDayNumber('2026-01-02T23:59:59Z'));
    expect(toDayNumber('2026-01-02')! - toDayNumber('2026-01-01')!).toBe(1);
  });
  it('rejects missing and impossible dates', () => {
    expect(toDayNumber(null)).toBeNull();
    expect(toDayNumber('')).toBeNull();
    expect(toDayNumber('31/07/2026')).toBeNull();
    expect(toDayNumber('2026-02-30')).toBeNull();
  });
});

describe('criteria', () => {
  it('a criterion is met when accepted count reaches required (min 1)', () => {
    expect(criterionMet(0, 1)).toBe(false);
    expect(criterionMet(1, 1)).toBe(true);
    expect(criterionMet(2, 3)).toBe(false);
    expect(criterionMet(3, 3)).toBe(true);
    expect(criterionMet(1, 0)).toBe(true); // required 0 is treated as 1
  });
  it('actual % is weighted by required count with partial credit, floored', () => {
    expect(criteriaActualPct([])).toBeNull();
    expect(
      criteriaActualPct([
        { acceptedCount: 1, requiredCount: 1 },
        { acceptedCount: 0, requiredCount: 1 }
      ])
    ).toBe(50);
    // 1 of 3 on a required-3 criterion + 1 complete required-1 → (1+1)/4
    expect(
      criteriaActualPct([
        { acceptedCount: 1, requiredCount: 3 },
        { acceptedCount: 1, requiredCount: 1 }
      ])
    ).toBe(50);
    // extra evidence never pushes a criterion past 100
    expect(
      criteriaActualPct([
        { acceptedCount: 5, requiredCount: 1 },
        { acceptedCount: 0, requiredCount: 1 }
      ])
    ).toBe(50);
    // 2 of 3 = 66.6 → floored to 66 (100 only when truly complete)
    expect(criteriaActualPct([{ acceptedCount: 2, requiredCount: 3 }])).toBe(66);
  });
});

describe('expectedPct', () => {
  it('is null without valid dates', () => {
    expect(expectedPct(null, '2026-12-31', '2026-06-01')).toBeNull();
    expect(expectedPct('2026-01-01', null, '2026-06-01')).toBeNull();
    expect(expectedPct('2026-12-31', '2026-01-01', '2026-06-01')).toBeNull(); // target before start
  });
  it('is 0 before start, 100 on/after target, linear between', () => {
    expect(expectedPct('2026-01-01', '2026-01-11', '2025-12-25')).toBe(0);
    expect(expectedPct('2026-01-01', '2026-01-11', '2026-01-01')).toBe(0);
    expect(expectedPct('2026-01-01', '2026-01-11', '2026-01-06')).toBe(50);
    expect(expectedPct('2026-01-01', '2026-01-11', '2026-01-11')).toBe(100);
    expect(expectedPct('2026-01-01', '2026-01-11', '2027-01-01')).toBe(100);
  });
  it('a single-day window is 100 on that day', () => {
    expect(expectedPct('2026-01-01', '2026-01-01', '2026-01-01')).toBe(100);
  });
});

describe('progressStatus', () => {
  it('complete wins, then dates-not-set', () => {
    expect(progressStatus(100, null)).toBe('COMPLETE');
    expect(progressStatus(100, 100)).toBe('COMPLETE');
    expect(progressStatus(40, null)).toBe('NOT_SET');
  });
  it('on target / behind / concern around the 15-point default', () => {
    expect(progressStatus(50, 50)).toBe('ON_TARGET');
    expect(progressStatus(60, 50)).toBe('ON_TARGET');
    expect(progressStatus(35, 50)).toBe('BEHIND'); // gap 15
    expect(progressStatus(34, 50)).toBe('CONCERN'); // gap 16
    expect(progressStatus(null, 20)).toBe('CONCERN'); // nothing done, 20 expected
  });
  it('honours an org threshold', () => {
    expect(progressStatus(30, 50, { concernGapPct: 25 })).toBe('BEHIND');
    expect(progressStatus(30, 50, { concernGapPct: 10 })).toBe('CONCERN');
  });
});

describe('averagePct', () => {
  it('ignores units with nothing to measure', () => {
    expect(averagePct([])).toBeNull();
    expect(averagePct([null, null])).toBeNull();
    expect(averagePct([100, null, 50])).toBe(75);
    expect(averagePct([100, 99])).toBe(99);
  });
});

describe('OTJ', () => {
  it('target = weeks × min(hours, cap) × factor, in minutes', () => {
    // 52 weeks (364 days) × 30h × 0.2 = 312 h
    expect(otjTargetMinutes({ start: '2026-01-01', end: '2026-12-31', contractedHoursWeek: 30 })).toBe(312 * 60);
    // 40 h/week is capped at 30
    expect(otjTargetMinutes({ start: '2026-01-01', end: '2026-12-31', contractedHoursWeek: 40 })).toBe(312 * 60);
    // part-time 15 h/week → half
    expect(otjTargetMinutes({ start: '2026-01-01', end: '2026-12-31', contractedHoursWeek: 15 })).toBe(156 * 60);
  });
  it('override wins; missing inputs give null', () => {
    expect(otjTargetMinutes({ start: null, end: null, contractedHoursWeek: null, overrideMinutes: 600 })).toBe(600);
    expect(
      otjTargetMinutes({ start: '2026-01-01', end: '2026-12-31', contractedHoursWeek: 30, overrideMinutes: 0 })
    ).toBe(0);
    expect(otjTargetMinutes({ start: '2026-01-01', end: '2026-12-31', contractedHoursWeek: null })).toBeNull();
    expect(otjTargetMinutes({ start: '2026-01-01', end: '2026-12-31', contractedHoursWeek: 0 })).toBeNull();
  });
  it('expected minutes follow the programme window', () => {
    expect(otjExpectedMinutes(1000, '2026-01-01', '2026-01-11', '2026-01-06')).toBe(500);
    expect(otjExpectedMinutes(null, '2026-01-01', '2026-01-11', '2026-01-06')).toBeNull();
    expect(otjExpectedMinutes(1000, null, '2026-01-11', '2026-01-06')).toBeNull();
  });
});

describe('computeEnrolmentProgress', () => {
  const base = {
    startDate: '2026-01-01',
    plannedEndDate: '2026-01-11',
    contractedHoursWeek: 30,
    otjOverrideMinutes: 1000,
    today: '2026-01-06'
  };

  it('rolls units up into the qualification and compares OTJ', () => {
    const r = computeEnrolmentProgress({
      ...base,
      otjMinutes: 500,
      units: [
        {
          unitId: 'u1',
          startDate: '2026-01-01',
          targetDate: '2026-01-05',
          criteria: [{ acceptedCount: 1, requiredCount: 1 }]
        },
        { unitId: 'u2', startDate: null, targetDate: null, criteria: [{ acceptedCount: 0, requiredCount: 2 }] }
      ]
    });
    expect(r.units).toEqual([
      { unitId: 'u1', actualPct: 100, expectedPct: 100, status: 'COMPLETE' },
      { unitId: 'u2', actualPct: 0, expectedPct: null, status: 'NOT_SET' }
    ]);
    expect(r.actualPct).toBe(50);
    expect(r.expectedPct).toBe(50);
    expect(r.status).toBe('ON_TARGET');
    expect(r.otjTargetMinutes).toBe(1000);
    expect(r.otjExpectedMinutes).toBe(500);
    expect(r.otjStatus).toBe('ON_TARGET');
  });

  it('no units and no dates is "dates not set", never a crash', () => {
    const r = computeEnrolmentProgress({
      startDate: null,
      plannedEndDate: null,
      contractedHoursWeek: null,
      otjOverrideMinutes: null,
      otjMinutes: 0,
      units: [],
      today: '2026-01-06'
    });
    expect(r.actualPct).toBeNull();
    expect(r.status).toBe('NOT_SET');
    expect(r.otjTargetMinutes).toBeNull();
    expect(r.otjStatus).toBe('NOT_SET');
  });
});

describe('spreadUnitDates', () => {
  it('covers the window with consecutive, non-overlapping ranges weighted by criteria', () => {
    const r = spreadUnitDates('2026-01-01', '2026-01-31', [
      { unitId: 'a', weight: 1 },
      { unitId: 'b', weight: 2 }
    ]);
    expect(r[0]).toEqual({ unitId: 'a', startDate: '2026-01-01', targetDate: '2026-01-11' });
    expect(r[1]).toEqual({ unitId: 'b', startDate: '2026-01-12', targetDate: '2026-01-31' });
  });
  it('ends exactly on the programme end and never goes backwards', () => {
    const units = Array.from({ length: 20 }, (_, i) => ({ unitId: `u${i}`, weight: (i % 4) + 1 }));
    const r = spreadUnitDates('2026-01-01', '2026-01-10', units); // more units than days
    expect(r).toHaveLength(20);
    expect(r[19]!.targetDate).toBe('2026-01-10');
    for (const range of r) expect(range.targetDate >= range.startDate).toBe(true);
    for (let i = 1; i < r.length; i++) expect(r[i]!.startDate >= r[i - 1]!.startDate).toBe(true);
  });
  it('invalid window gives no dates', () => {
    expect(spreadUnitDates('2026-02-01', '2026-01-01', [{ unitId: 'a', weight: 1 }])).toEqual([]);
    expect(spreadUnitDates('2026-01-01', '2026-02-01', [])).toEqual([]);
  });
});

describe('round 2: dates', () => {
  it('addMonths clamps to the end of shorter months and handles year roll-over', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15');
    expect(addMonths('2026-03-31', 0)).toBe('2026-03-31');
    expect(addMonths(null, 2)).toBeNull();
  });
  it('addDays and nextReviewDate', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(nextReviewDate('2026-01-01', 12)).toBe('2026-03-26');
    expect(nextReviewDate('2026-01-01', 0)).toBe('2026-01-08'); // interval floor is one week
    expect(nextReviewDate(null, 12)).toBeNull();
  });
  it('taskDueDate = start + month offset; no start → no due date; negative offset treated as 0', () => {
    expect(taskDueDate('2026-08-01', 2)).toBe('2026-10-01');
    expect(taskDueDate(null, 2)).toBeNull();
    expect(taskDueDate('2026-08-01', -3)).toBe('2026-08-01');
  });
});

describe('round 2: task status', () => {
  it('latest evidence decides; any accepted completes', () => {
    expect(taskStatusFromEvidence([])).toBe('PLANNED');
    expect(taskStatusFromEvidence([{ status: 'SUBMITTED' }])).toBe('SUBMITTED');
    expect(taskStatusFromEvidence([{ status: 'REFERRED' }])).toBe('REFERRED');
    expect(taskStatusFromEvidence([{ status: 'SUBMITTED' }, { status: 'REFERRED' }])).toBe('SUBMITTED');
    expect(taskStatusFromEvidence([{ status: 'REFERRED' }, { status: 'ACCEPTED' }])).toBe('COMPLETE');
  });
  it('overdue only when due date passed and not complete', () => {
    expect(isTaskOverdue({ dueDate: '2026-11-01', status: 'PLANNED' }, '2026-11-02')).toBe(true);
    expect(isTaskOverdue({ dueDate: '2026-11-01', status: 'PLANNED' }, '2026-11-01')).toBe(false);
    expect(isTaskOverdue({ dueDate: '2026-11-01', status: 'COMPLETE' }, '2026-12-01')).toBe(false);
    expect(isTaskOverdue({ dueDate: null, status: 'PLANNED' }, '2026-12-01')).toBe(false);
  });
  it('plan valid window, open ends allowed', () => {
    expect(isWithinWindow(null, null, '2026-11-09')).toBe(true);
    expect(isWithinWindow('2026-11-10', null, '2026-11-09')).toBe(false);
    expect(isWithinWindow(null, '2026-11-08', '2026-11-09')).toBe(false);
    expect(isWithinWindow('2026-11-09', '2026-11-09', '2026-11-09')).toBe(true);
  });
});

describe('round 2: reviews', () => {
  it('overdue unless complete or cancelled', () => {
    expect(isReviewOverdue({ scheduledDate: '2026-11-01', status: 'SCHEDULED' }, '2026-11-02')).toBe(true);
    expect(isReviewOverdue({ scheduledDate: '2026-11-01', status: 'AWAITING_SIGNATURES' }, '2026-11-02')).toBe(true);
    expect(isReviewOverdue({ scheduledDate: '2026-11-01', status: 'COMPLETE' }, '2026-11-02')).toBe(false);
    expect(isReviewOverdue({ scheduledDate: '2026-11-01', status: 'CANCELLED' }, '2026-11-02')).toBe(false);
  });
  it('fully signed needs tutor, learner and employer', () => {
    const t = '2026-11-09T10:00:00Z';
    expect(reviewFullySigned({ tutorSignedAt: t, learnerSignedAt: t, employerSignedAt: t })).toBe(true);
    expect(reviewFullySigned({ tutorSignedAt: t, learnerSignedAt: null, employerSignedAt: t })).toBe(false);
  });
});
