import { classroomio } from '$lib/utils/services/api';
import { call } from './call';

// Gecko Apprenticeships — off-the-job progress: the summary plus merged rows (logs and OTJ evidence) and the log
// mutations. Shapes mirror apps/api/src/services/apprenticeship/otj.ts. No maths here: the API's numbers are shown as given.

export type OtjLogStatus = 'SUBMITTED' | 'VALIDATED' | 'REJECTED';

export interface OtjSummary {
  doneMinutes: number;
  expectedMinutes: number | null;
  targetMinutes: number | null;
  completionPct: number | null;
  status: 'ON_TARGET' | 'BEHIND' | 'CONCERN' | 'NOT_SET' | 'COMPLETE';
  source: 'OVERRIDE' | 'CALCULATED' | 'NOT_SET';
  contractedHoursWeek: number | null;
  pendingMinutes: number;
}

export interface OtjRow {
  kind: 'LOG' | 'EVIDENCE';
  id: string;
  title: string;
  minutes: number;
  isOtj: boolean;
  date: string | null;
  status: OtjLogStatus;
  byName: string | null;
  homeEnrolmentId?: string;
  details?: string | null;
  reviewNote?: string | null;
  outsideWindow?: boolean;
}

export interface OtjView {
  summary: OtjSummary;
  rows: OtjRow[];
}

export interface OtjLogBody {
  title: string;
  details?: string | null;
  logDate: string;
  minutes: number;
  isOtj: boolean;
  status?: 'SUBMITTED' | 'VALIDATED';
}

export interface OtjReviewBody {
  decision: 'VALIDATE' | 'REJECT' | 'REOPEN';
  note?: string;
  expectedStatus: OtjLogStatus;
}

const routes = () => classroomio.apprenticeship;

export interface OtjQueueRow {
  id: string;
  enrolmentId: string;
  learnerId: string;
  learnerName: string | null;
  programmeTitle: string;
  title: string;
  minutes: number;
  isOtj: boolean;
  logDate: string;
  status: OtjLogStatus;
  createdAt: string;
  byName: string | null;
}

export const otjApi = {
  queue: (status: OtjLogStatus = 'SUBMITTED') =>
    call<OtjQueueRow[]>(() => routes()['otj-logs'].$get({ query: { status } }), 'Could not load the logs'),

  get: (enrolmentId: string) =>
    call<OtjView>(() => routes().enrolments[':id'].otj.$get({ param: { id: enrolmentId } }), 'Could not load the log'),

  add: (enrolmentId: string, body: OtjLogBody) =>
    call<unknown>(
      () => routes().enrolments[':id']['otj-logs'].$post({ param: { id: enrolmentId }, json: body }),
      'Could not add the log'
    ),

  update: (logId: string, body: Partial<OtjLogBody>) =>
    call<unknown>(
      () => routes()['otj-logs'][':logId'].$patch({ param: { logId }, json: body }),
      'Could not save the log'
    ),

  review: (logId: string, body: OtjReviewBody) =>
    call<unknown>(
      () => routes()['otj-logs'][':logId'].review.$post({ param: { logId }, json: body }),
      'Could not save the decision'
    ),

  remove: (logId: string) =>
    call<unknown>(() => routes()['otj-logs'][':logId'].$delete({ param: { logId } }), 'Could not delete the log')
};
