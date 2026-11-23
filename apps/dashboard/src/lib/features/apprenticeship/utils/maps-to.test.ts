import { describe, expect, it } from 'vitest';
import { mapsToEntries } from './maps-to';

const dip = {
  enrolmentId: 'e1',
  programmeId: 'p1',
  type: 'DIPLOMA',
  title: 'L5 Diploma',
  criterionCodes: ['1.1', '1.2']
};
const std = { enrolmentId: 'e2', programmeId: 'p2', type: 'STANDARD', title: 'L5 Standard', criterionCodes: ['K1'] };

describe('mapsToEntries', () => {
  it('lists each programme with its criteria count, home first', () => {
    const out = mapsToEntries([std, dip], { enrolmentId: 'e1' });
    expect(out.map((o) => [o.title, o.count])).toEqual([
      ['L5 Diploma', 2],
      ['L5 Standard', 1]
    ]);
  });
  it('ignores entries with no criteria', () => {
    expect(mapsToEntries([{ ...std, criterionCodes: [] }, dip], null)).toHaveLength(1);
  });
  it('falls back to the home programme when nothing is mapped (diploma-only)', () => {
    const out = mapsToEntries([], { enrolmentId: 'e1', type: 'DIPLOMA', title: 'L5 Diploma' }, 3);
    expect(out).toEqual([{ enrolmentId: 'e1', type: 'DIPLOMA', title: 'L5 Diploma', count: 3 }]);
  });
  it('returns [] with no data at all', () => {
    expect(mapsToEntries(undefined, null)).toEqual([]);
    expect(mapsToEntries(null, { enrolmentId: 'e1' })).toEqual([]);
  });
});
