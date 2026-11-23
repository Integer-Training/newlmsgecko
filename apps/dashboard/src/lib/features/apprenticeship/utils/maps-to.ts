import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';

export interface MapsToEntry {
  enrolmentId: string;
  type: ApprProgrammeType | string | null;
  title: string;
  /** Criteria mapped on this programme (null when unknown). */
  count: number | null;
}

interface MappedLike {
  enrolmentId: string;
  type: ApprProgrammeType | string;
  title: string;
  criterionCodes: string[];
}

interface HomeLike {
  enrolmentId: string;
  type?: ApprProgrammeType | string | null;
  title?: string | null;
}

/**
 * One "Maps to" entry per programme the evidence counts towards (home programme first). When the API sends no mapped
 * list (a diploma-only learner), falls back to the home portfolio's programme with `fallbackCount` criteria.
 */
export function mapsToEntries(
  mapped: MappedLike[] | null | undefined,
  home: HomeLike | null | undefined,
  fallbackCount: number | null = null
): MapsToEntry[] {
  const withCodes = (mapped ?? []).filter((m) => m.criterionCodes.length > 0);
  if (withCodes.length > 0) {
    return withCodes
      .map((m) => ({ enrolmentId: m.enrolmentId, type: m.type, title: m.title, count: m.criterionCodes.length }))
      .sort((a, b) => Number(b.enrolmentId === home?.enrolmentId) - Number(a.enrolmentId === home?.enrolmentId));
  }
  if (home?.title) {
    return [{ enrolmentId: home.enrolmentId, type: home.type ?? null, title: home.title, count: fallbackCount }];
  }
  return [];
}
