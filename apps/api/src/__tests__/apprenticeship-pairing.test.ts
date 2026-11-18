import { describe, expect, it } from 'vitest';
import { apprLevelNumber, enrolmentSetError, pairingError } from '@cio/utils/functions/apprenticeship-pairing';

const base = { type: 'DIPLOMA', level: '3', status: 'ACTIVE', organizationId: 'org-1' };
const standard = { type: 'STANDARD', level: 'Level 3', status: 'ACTIVE', organizationId: 'org-1' };

describe('apprLevelNumber', () => {
  it('reads the first digit 1-8', () => {
    expect(apprLevelNumber('3')).toBe(3);
    expect(apprLevelNumber('L3')).toBe(3);
    expect(apprLevelNumber('Level 3')).toBe(3);
    expect(apprLevelNumber('Level 5 Diploma')).toBe(5);
  });
  it('returns null when there is no level', () => {
    expect(apprLevelNumber(null)).toBeNull();
    expect(apprLevelNumber(undefined)).toBeNull();
    expect(apprLevelNumber('')).toBeNull();
    expect(apprLevelNumber('Entry')).toBeNull();
    expect(apprLevelNumber('0')).toBeNull();
    expect(apprLevelNumber('9')).toBeNull();
  });
});

describe('pairingError', () => {
  it('accepts a matching diploma and standard', () => {
    expect(pairingError(base, standard)).toBeNull();
    expect(pairingError({ ...base, level: 'L3' }, { ...standard, level: '3' })).toBeNull();
  });
  it('rejects missing or wrong-type targets', () => {
    expect(pairingError(base, null)).toBe('Pick a Standard programme');
    expect(pairingError(base, { ...standard, type: 'DIPLOMA' })).toBe('Pick a Standard programme');
    expect(pairingError({ ...base, type: 'STANDARD' }, standard)).toBe('Pick a Standard programme');
  });
  it('rejects another organisation', () => {
    expect(pairingError(base, { ...standard, organizationId: 'org-2' })).toBe('Pick a Standard programme');
  });
  it('requires a level on both sides', () => {
    expect(pairingError({ ...base, level: null }, standard)).toBe('Set a level on both programmes first');
    expect(pairingError(base, { ...standard, level: 'n/a' })).toBe('Set a level on both programmes first');
  });
  it('rejects level mismatch', () => {
    expect(pairingError(base, { ...standard, level: '4' })).toBe(
      'Level 3 diploma can only be paired with a Level 3 standard'
    );
  });
  it('rejects an archived standard', () => {
    expect(pairingError(base, { ...standard, status: 'ARCHIVED' })).toBe('That standard is archived');
  });
  it('allows two diplomas to pair with the same standard', () => {
    expect(pairingError(base, standard)).toBeNull();
    expect(pairingError({ ...base, level: 'Level 3' }, standard)).toBeNull();
  });
});

describe('enrolmentSetError', () => {
  const diploma = { id: 'd1', type: 'DIPLOMA', level: '3', pairedProgrammeId: 's1' };
  const std = { id: 's1', type: 'STANDARD', level: '3', pairedProgrammeId: null };

  it('accepts one programme of either type', () => {
    expect(enrolmentSetError([diploma])).toBeNull();
    expect(enrolmentSetError([std])).toBeNull();
  });
  it('rejects zero or more than two', () => {
    expect(enrolmentSetError([])).not.toBeNull();
    expect(enrolmentSetError([diploma, std, { ...diploma, id: 'd2' }])).not.toBeNull();
  });
  it('accepts a paired diploma and standard in any order', () => {
    expect(enrolmentSetError([diploma, std])).toBeNull();
    expect(enrolmentSetError([std, diploma])).toBeNull();
  });
  it('rejects two diplomas, two standards, or an unpaired set', () => {
    expect(enrolmentSetError([diploma, { ...diploma, id: 'd2' }])).not.toBeNull();
    expect(enrolmentSetError([std, { ...std, id: 's2' }])).not.toBeNull();
    expect(enrolmentSetError([{ ...diploma, pairedProgrammeId: 'other' }, std])).not.toBeNull();
    expect(enrolmentSetError([{ ...diploma, pairedProgrammeId: null }, std])).not.toBeNull();
  });
});
