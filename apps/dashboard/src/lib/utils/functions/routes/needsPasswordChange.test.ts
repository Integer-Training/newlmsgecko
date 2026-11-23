import { describe, expect, it } from 'vitest';
import { changePasswordUrl, needsPasswordChange, safeRedirect } from './needsPasswordChange';

describe('needsPasswordChange', () => {
  const flagged = { settings: { mustChangePassword: true } };
  it('true when flagged and elsewhere', () => expect(needsPasswordChange(flagged, '/lms')).toBe(true));
  it('false on change-password page', () => {
    expect(needsPasswordChange(flagged, '/change-password')).toBe(false);
    expect(needsPasswordChange(flagged, '/change-password/')).toBe(false);
  });
  it('false when not flagged or missing', () => {
    expect(needsPasswordChange({ settings: { mustChangePassword: false } }, '/lms')).toBe(false);
    expect(needsPasswordChange({ settings: null }, '/lms')).toBe(false);
    expect(needsPasswordChange(null, '/lms')).toBe(false);
  });
});

describe('safeRedirect', () => {
  it('accepts relative', () => expect(safeRedirect('/lms/courses?a=1')).toBe('/lms/courses?a=1'));
  it('rejects absolute and protocol-relative', () => {
    expect(safeRedirect('https://evil.com')).toBeNull();
    expect(safeRedirect('//evil.com')).toBeNull();
    expect(safeRedirect('/\\evil.com')).toBeNull();
    expect(safeRedirect('javascript:alert(1)')).toBeNull();
    expect(safeRedirect('')).toBeNull();
    expect(safeRedirect(null)).toBeNull();
  });
  it('rejects loops to change-password', () => expect(safeRedirect('/change-password')).toBeNull());
});

describe('changePasswordUrl', () => {
  it('encodes redirect', () => expect(changePasswordUrl('/lms?x=1')).toBe('/change-password?redirect=%2Flms%3Fx%3D1'));
  it('drops unsafe', () => expect(changePasswordUrl('//evil')).toBe('/change-password'));
});
