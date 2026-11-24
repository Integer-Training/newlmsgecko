import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
import { classroomio } from '$lib/utils/services/api';
import { RATE_LIMIT_MESSAGE } from '$lib/utils/services/api/rate-limit';
import { call, type CallResult } from './call';

// Gecko Apprenticeships — learner-side client for programme resources (learning resources = view only, workbooks =
// view + download + "upload completed workbook"). Shapes mirror the API contract (routes/apprenticeship/resources.ts).
// This file serves learners AND staff viewing a learner (the unit page is shared); the API decides what each may do.

export type ResourceKind = 'LEARNING' | 'WORKBOOK';
export type ResourceStatus = 'NOT_STARTED' | 'VIEWED' | 'DOWNLOADED' | 'SUBMITTED' | 'REFERRED' | 'ACCEPTED';

export interface LearnerResourceItem {
  id: string;
  programmeId: string;
  unitId: string | null;
  unitTitle: string | null;
  unitCode: string | null;
  kind: ResourceKind;
  title: string;
  description: string | null;
  file: { name: string; size: number; type: string };
  version: number;
  sort: number;
  evidenceTypeKey: string | null;
  criterionIds: string[];
  createdAt: string;
  updatedAt: string;
  /** The enrolment (half of the pair) this resource belongs to. */
  enrolmentId: string;
  programmeTitle: string;
  programmeType: ApprProgrammeType | null;
  downloadable: boolean;
  activity: {
    firstViewedAt: string | null;
    lastDownloadedAt: string | null;
    downloadCount: number;
    lastVersion: number | null;
  } | null;
  updatedSinceDownload: boolean;
  /** This learner's progress (overrides the resource's own ACTIVE/ARCHIVED status; learners only see ACTIVE). */
  status: ResourceStatus;
  latestEvidenceId: string | null;
}

export interface ResourceProgramme {
  enrolmentId: string;
  programmeId: string;
  title: string;
  type: ApprProgrammeType | null;
  withdrawn: boolean;
}

export interface LearnerResourceList {
  programmes: ResourceProgramme[];
  resources: LearnerResourceItem[];
}

export type ContentResult = { ok: true; data: ArrayBuffer } | { ok: false; error: string; status?: number };

const CONTENT_ERRORS: Record<number, string> = {
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have access to this resource.',
  404: 'This resource is no longer available.',
  429: RATE_LIMIT_MESSAGE
};

class ResourcesLearnerApi {
  /** One request: every resource the enrolment (and its paired half) can see, with this learner's progress. */
  forEnrolment(enrolmentId: string): Promise<CallResult<LearnerResourceList>> {
    return call<LearnerResourceList>(
      () => classroomio.apprenticeship.resources.enrolment[':enrolmentId'].$get({ param: { enrolmentId } }),
      'Could not load the resources.'
    );
  }

  /** The file bytes, streamed inline by the API (no storage URL ever reaches the browser). Fetch once per open. */
  async content(id: string, enrolmentId: string): Promise<ContentResult> {
    try {
      const res = await classroomio.apprenticeship.resources[':id'].content.$get({
        param: { id },
        // Staff previewing from programme setup have no enrolment: omit the param rather than send ''.
        query: enrolmentId ? { enrolmentId } : {}
      });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: CONTENT_ERRORS[res.status] ?? 'Could not open this resource. Please try again.'
        };
      }
      return { ok: true, data: await res.arrayBuffer() };
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      return {
        ok: false,
        status,
        error: (status && CONTENT_ERRORS[status]) || 'Could not open this resource. Please try again.'
      };
    }
  }

  /** A short-lived attachment URL (workbooks only; the API answers 403 "This resource is view only" otherwise). */
  download(id: string, enrolmentId: string) {
    return call<{ url: string; fileName: string }>(
      () =>
        classroomio.apprenticeship.resources[':id'].download.$post({
          param: { id },
          // Staff previewing from programme setup have no enrolment: omit it rather than send ''.
          json: enrolmentId ? { enrolmentId } : {}
        }),
      'Could not download the file.'
    );
  }
}

export const resourcesLearnerApi = new ResourcesLearnerApi();
