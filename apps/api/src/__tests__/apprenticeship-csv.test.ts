import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvWithHeader } from '@cio/utils/functions/csv';
import { planStructureImport } from '@api/services/apprenticeship/programme-import';

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
