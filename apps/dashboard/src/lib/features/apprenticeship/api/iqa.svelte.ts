import { classroomio } from '$lib/utils/services/api';
import { call } from './call';

// Gecko Apprenticeships — client for IQA sampling. Shapes mirror apps/api/src/services/apprenticeship/iqa.ts.
// Coverage, suggest, decide, delete and the target are admin-only; a tutor reads and acknowledges their own feedback.

export type IqaOutcome = 'PENDING' | 'AGREE' | 'DISAGREE';

export interface IqaSample {
  /** Null for a "Suggest sample" preview pick that is not saved yet. */
  id: string | null;
  outcome: IqaOutcome;
  feedback: string | null;
  createdAt: string;
  decidedAt: string | null;
  acknowledgedAt: string | null;
  evidenceId: string;
  evidenceTitle: string;
  evidenceStatus: string;
  evidenceTypeKey: string | null;
  enrolmentId: string;
  programmeId: string;
  programmeTitle: string;
  learnerId: string;
  learnerName: string | null;
  assessorId: string;
  assessorName: string | null;
  sampledByName: string | null;
  decidedByName: string | null;
}

export interface IqaAssessorCoverage {
  assessorId: string;
  name: string | null;
  accepted: number;
  sampled: number;
  pct: number;
  pending: number;
  agree: number;
  disagree: number;
  awaitingAck: number;
}

export interface IqaUnitCoverage {
  unitId: string;
  unitTitle: string;
  unitRef: string | null;
  programmeId: string;
  programmeTitle: string;
  accepted: number;
  sampled: number;
  pct: number;
}

export interface IqaCoverage {
  targetPct: number;
  assessors: IqaAssessorCoverage[];
  units: IqaUnitCoverage[];
}

export interface IqaFilters {
  programmeId?: string;
  assessorId?: string;
  outcome?: IqaOutcome;
}

const clean = (f: IqaFilters) => ({
  ...(f.programmeId ? { programmeId: f.programmeId } : {}),
  ...(f.assessorId ? { assessorId: f.assessorId } : {}),
  ...(f.outcome ? { outcome: f.outcome } : {})
});

class ApprIqaApi {
  coverage(programmeId?: string) {
    return call<IqaCoverage>(() => classroomio.apprenticeship.iqa.coverage.$get({ query: clean({ programmeId }) }));
  }

  samples(filters: IqaFilters = {}) {
    return call<IqaSample[]>(() => classroomio.apprenticeship.iqa.samples.$get({ query: clean(filters) }));
  }

  suggest(input: {
    programmeId?: string;
    assessorId?: string;
    max?: number;
    preview: boolean;
    evidenceIds?: string[];
  }) {
    return call<IqaSample[]>(() =>
      classroomio.apprenticeship.iqa.suggest.$post({
        json: {
          ...clean(input),
          ...(input.max ? { max: input.max } : {}),
          ...(input.evidenceIds?.length ? { evidenceIds: input.evidenceIds } : {}),
          preview: input.preview
        }
      })
    );
  }

  decide(
    sampleId: string,
    input: {
      outcome: 'AGREE' | 'DISAGREE';
      feedback: string;
      expectedOutcome: IqaOutcome;
      expectedDecidedAt?: string | null;
    }
  ) {
    return call<IqaSample>(() =>
      classroomio.apprenticeship.iqa.samples[':sampleId'].decide.$post({ param: { sampleId }, json: input })
    );
  }

  /** `decidedAt` = the decision the assessor is acknowledging (409 if it has changed since). */
  acknowledge(sampleId: string, decidedAt: string) {
    return call<IqaSample>(() =>
      classroomio.apprenticeship.iqa.samples[':sampleId'].acknowledge.$post({
        param: { sampleId },
        json: { decidedAt }
      })
    );
  }

  remove(sampleId: string) {
    return call<{ id: string }>(() =>
      classroomio.apprenticeship.iqa.samples[':sampleId'].$delete({ param: { sampleId } })
    );
  }

  setTarget(iqaTargetPct: number) {
    return call<{ iqaTargetPct: number }>(() => classroomio.apprenticeship.iqa.target.$put({ json: { iqaTargetPct } }));
  }
}

export const apprIqaApi = new ApprIqaApi();
