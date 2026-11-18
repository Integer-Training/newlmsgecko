import { describe, expect, it } from 'vitest';
import { planStructureImport, type ImportPlan } from '@api/services/apprenticeship/programme-import';

// Gecko Apprenticeship Standard — structure import: Standard-shaped files (no unit codes, repeated criterion codes),
// preview/warning shape, and the Skills Portfolio ref-collision fix.

const Q = { id: 'q1', title: 'Standard', reference: null };
const empty = { qualifications: [Q], units: [], criteria: [] };

const standardCsv = [
  'unit_code,unit_title,criterion_code,criterion_text,group,required',
  ',Duty 1 Communication,1.1,Communicate clearly,Knowledge,',
  ',Duty 1 Communication,1.2,"Listen, then ""reply""",Skills,',
  ',Duty 2 Safeguarding,1.1,Recognise abuse,Knowledge,2',
  ',Duty 2 Safeguarding,1.2,Report concerns,Behaviours,'
].join('\n');

function existingFrom(plan: ImportPlan, extra: Record<string, unknown> = {}) {
  return {
    qualifications: [Q],
    units: plan.newUnits.map((u) => ({ ...u })),
    criteria: plan.newCriteria.map((c) => ({ ...c })),
    ...extra
  };
}

describe('Standard-shaped import (no unit codes, repeated 1.1)', () => {
  it('creates distinct criteria per unit even though criterion codes repeat', () => {
    const plan = planStructureImport(empty, standardCsv);
    expect(plan.errors).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.summary).toEqual({ unitsNew: 2, unitsUpdated: 0, criteriaNew: 4, criteriaUpdated: 0 });
    expect(plan.newUnits.map((u) => [u.code, u.title])).toEqual([
      [null, 'Duty 1 Communication'],
      [null, 'Duty 2 Safeguarding']
    ]);
    const [u1, u2] = plan.newUnits.map((u) => u.id);
    expect(plan.newCriteria.filter((c) => c.unitId === u1).map((c) => c.code)).toEqual(['1.1', '1.2']);
    expect(plan.newCriteria.filter((c) => c.unitId === u2).map((c) => c.code)).toEqual(['1.1', '1.2']);
    expect(new Set(plan.newCriteria.map((c) => c.id)).size).toBe(4);
    expect(plan.newCriteria.find((c) => c.text === 'Listen, then "reply"')?.groupLabel).toBe('Skills');
  });

  it('re-importing the same file gives 0 new and 0 updated, all units UNCHANGED', () => {
    const first = planStructureImport(empty, standardCsv);
    const again = planStructureImport(existingFrom(first), standardCsv);
    expect(again.summary).toEqual({ unitsNew: 0, unitsUpdated: 0, criteriaNew: 0, criteriaUpdated: 0 });
    expect(again.errors).toEqual([]);
    expect(again.warnings).toEqual([]);
    expect(again.unitPreview.map((u) => u.state)).toEqual(['UNCHANGED', 'UNCHANGED']);
  });
});

describe('unitPreview', () => {
  it('lists NEW units with their criteria counts, in file order', () => {
    const plan = planStructureImport(empty, standardCsv);
    expect(plan.unitPreview).toEqual([
      { title: 'Duty 1 Communication', code: null, state: 'NEW', criteriaNew: 2, criteriaUpdated: 0 },
      { title: 'Duty 2 Safeguarding', code: null, state: 'NEW', criteriaNew: 2, criteriaUpdated: 0 }
    ]);
  });

  it('marks a unit UPDATED when only a criterion changes, and reports it per unit', () => {
    const first = planStructureImport(empty, standardCsv);
    const changed = standardCsv.replace('Recognise abuse', 'Recognise signs of abuse');
    const plan = planStructureImport(existingFrom(first), changed);
    expect(plan.summary).toEqual({ unitsNew: 0, unitsUpdated: 0, criteriaNew: 0, criteriaUpdated: 1 });
    expect(plan.unitPreview.map((u) => [u.state, u.criteriaNew, u.criteriaUpdated])).toEqual([
      ['UNCHANGED', 0, 0],
      ['UPDATED', 0, 1]
    ]);
  });
});

describe('warnings', () => {
  it('warns when the same unit + criterion code appears twice; the later row wins', () => {
    const csv = [
      'unit_title,criterion_code,criterion_text',
      'Duty 1,1.1,First wording',
      'Duty 1,1.1,Second wording'
    ].join('\n');
    const plan = planStructureImport(empty, csv);
    expect(plan.summary.criteriaNew).toBe(1);
    expect(plan.newCriteria[0].text).toBe('Second wording');
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0].row).toBe(3);
    expect(plan.warnings[0].message).toContain('row 2');
  });

  it('warns about programme units missing from the file and never deletes them', () => {
    const first = planStructureImport(empty, standardCsv);
    const onlyOne = ['unit_title,criterion_code,criterion_text', 'Duty 1 Communication,1.1,Communicate clearly'].join(
      '\n'
    );
    const plan = planStructureImport(existingFrom(first), onlyOne);
    expect(plan.unitUpdates).toEqual([]);
    const absent = plan.warnings.filter((w) => w.row === 0);
    expect(absent).toHaveLength(1);
    expect(absent[0].message).toContain('Duty 2 Safeguarding');
    expect(absent[0].message).toContain('import never deletes');
  });

  it('warns on a required change only when the programme has learners', () => {
    const first = planStructureImport(empty, standardCsv);
    const changed = standardCsv.replace('Recognise abuse,Knowledge,2', 'Recognise abuse,Knowledge,3');
    const without = planStructureImport(existingFrom(first), changed);
    expect(without.summary.criteriaUpdated).toBe(1);
    expect(without.warnings).toEqual([]);
    const withLearners = planStructureImport(existingFrom(first, { hasEnrolments: true }), changed);
    expect(withLearners.warnings).toHaveLength(1);
    expect(withLearners.warnings[0].message).toContain('from 2 to 3');
    expect(withLearners.warnings[0].message).toContain('progress will be recalculated');
  });
});

describe('Skills Portfolio ref collision', () => {
  const header = 'code,unitTitle,name,description,completedItems,requiredItems';

  it('a bare code like "1.1" is not used as a ref, so two units keep their own criterion 1.1', () => {
    const csv = [header, '"1.1","Duty 1","1.1","One",0,1', '"1.1","Duty 2","1.1","Two",0,1'].join('\n');
    const plan = planStructureImport(empty, csv);
    expect(plan.errors).toEqual([]);
    expect(plan.summary).toMatchObject({ unitsNew: 2, criteriaNew: 2 });
    expect(plan.newCriteria.map((c) => c.externalRef)).toEqual([null, null]);
    expect(plan.newUnits.map((u) => u.externalRef)).toEqual([null, null]);
  });

  it('an Ofqual-shaped code (with "/") still becomes the ref', () => {
    const csv = [header, '"X/100/0001/01","U1 Talking","1.1","Say why",0,1'].join('\n');
    const plan = planStructureImport(empty, csv);
    expect(plan.newCriteria[0].externalRef).toBe('X/100/0001/01');
    expect(plan.newUnits[0].externalRef).toBe('X/100/0001');
  });

  it('a criterion_ref that matches a criterion in a different unit is a row error, not a silent update', () => {
    const existing = {
      qualifications: [Q],
      units: [
        { id: 'u1', qualificationId: 'q1', code: 'A', title: 'Unit A', externalRef: null, sort: 0 },
        { id: 'u2', qualificationId: 'q1', code: 'B', title: 'Unit B', externalRef: null, sort: 1 }
      ],
      criteria: [
        {
          id: 'c1',
          unitId: 'u1',
          code: '1.1',
          text: 'Old',
          groupLabel: null,
          requiredCount: 1,
          externalRef: 'R1',
          sort: 0
        }
      ]
    };
    const csv = ['unit_code,criterion_code,criterion_text,criterion_ref', 'B,1.1,Hijack,R1'].join('\n');
    const plan = planStructureImport(existing, csv);
    expect(plan.errors).toHaveLength(1);
    expect(plan.errors[0].row).toBe(2);
    expect(plan.criterionUpdates).toEqual([]);
    expect(plan.newCriteria).toEqual([]);
  });
});
