import { classroomio } from '$lib/utils/services/api';
import { call } from './call';

// Gecko Apprenticeships — client for the IQA panel on the evidence sheet. Shapes mirror ApprIqaSampleView in
// packages/db/src/queries/apprenticeship/iqa.ts. Staff only: the API answers 404 for a learner, so never call it for one.

export type EvidenceIqaOutcome = 'PENDING' | 'AGREE' | 'DISAGREE';

export interface EvidenceIqaSample {
  id: string;
  outcome: EvidenceIqaOutcome | string;
  feedback: string | null;
  createdAt: string;
  decidedAt: string | null;
  acknowledgedAt: string | null;
  evidenceId: string;
  evidenceTitle: string;
  evidenceStatus: string;
  enrolmentId: string;
  learnerName: string | null;
  assessorId: string | null;
  assessorName: string | null;
  sampledByName: string | null;
  decidedByName: string | null;
}

class EvidenceIqaApi {
  get(evidenceId: string) {
    return call<EvidenceIqaSample | null>(
      () => classroomio.apprenticeship.evidence[':evidenceId'].iqa.$get({ param: { evidenceId } }),
      'Could not load IQA'
    );
  }

  sample(evidenceId: string) {
    return call<EvidenceIqaSample>(
      () => classroomio.apprenticeship.iqa.samples.$post({ json: { evidenceId } }),
      'Could not sample this evidence'
    );
  }

  decide(
    sampleId: string,
    input: {
      outcome: 'AGREE' | 'DISAGREE';
      feedback?: string;
      expectedOutcome: EvidenceIqaOutcome;
      expectedDecidedAt?: string | null;
    }
  ) {
    return call<EvidenceIqaSample>(
      () => classroomio.apprenticeship.iqa.samples[':sampleId'].decide.$post({ param: { sampleId }, json: input }),
      'Could not save the IQA decision'
    );
  }

  /** `decidedAt` = the decision being acknowledged (409 if it has changed since). */
  acknowledge(sampleId: string, decidedAt: string) {
    return call<EvidenceIqaSample>(
      () =>
        classroomio.apprenticeship.iqa.samples[':sampleId'].acknowledge.$post({
          param: { sampleId },
          json: { decidedAt }
        }),
      'Could not acknowledge'
    );
  }
}

export const evidenceIqaApi = new EvidenceIqaApi();
