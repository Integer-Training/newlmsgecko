import type { ApprProgrammeType } from '../constants/apprenticeship';

/** First digit 1-8 in a free-text level ("3", "L3", "Level 3"); otherwise null. */
export function apprLevelNumber(level: string | null | undefined): number | null {
  if (!level) return null;
  const match = /[1-8]/.exec(level);

  return match ? Number(match[0]) : null;
}

export interface ApprPairingProgramme {
  type: ApprProgrammeType | string;
  level: string | null | undefined;
  status: string;
  organizationId: string;
}

/** Validates pairing a diploma to a Standard. Returns an error message or null when valid. */
export function pairingError(
  diploma: ApprPairingProgramme,
  standard: ApprPairingProgramme | null | undefined
): string | null {
  if (!standard || standard.type !== 'STANDARD' || standard.organizationId !== diploma.organizationId) {
    return 'Pick a Standard programme';
  }
  if (diploma.type !== 'DIPLOMA') return 'Pick a Standard programme';

  const diplomaLevel = apprLevelNumber(diploma.level);
  const standardLevel = apprLevelNumber(standard.level);
  if (diplomaLevel === null || standardLevel === null) return 'Set a level on both programmes first';
  if (diplomaLevel !== standardLevel) {
    return `Level ${diplomaLevel} diploma can only be paired with a Level ${diplomaLevel} standard`;
  }
  if (standard.status !== 'ACTIVE') return 'That standard is archived';

  return null;
}

export interface ApprEnrolmentSetProgramme {
  id: string;
  type: ApprProgrammeType | string;
  level: string | null | undefined;
  pairedProgrammeId: string | null | undefined;
}

/** A learner's apprenticeship is one programme, or one diploma plus the Standard it is paired to. */
export function enrolmentSetError(programmes: ApprEnrolmentSetProgramme[]): string | null {
  if (programmes.length < 1 || programmes.length > 2) return 'Choose one or two programmes';
  if (programmes.length === 1) return null;

  const diploma = programmes.find((p) => p.type === 'DIPLOMA');
  const standard = programmes.find((p) => p.type === 'STANDARD');
  if (!diploma || !standard) return 'A pair must be one diploma and one standard';
  if (diploma.pairedProgrammeId !== standard.id) return 'That diploma is not paired with that standard';

  return null;
}
