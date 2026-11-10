import type { ApprEpaResult, ApprStage } from '@cio/utils/constants/apprenticeship';
import { classroomio } from '$lib/utils/services/api';
import { call } from './call';

// Gecko Apprenticeships — client for GLH logs, the gateway checklist and the end-point assessment. Shapes mirror
// apps/api/src/services/apprenticeship/{glh,gateway,gateway-core}.ts. Everything (ready, stage, auto items) is the
// API's; the UI only displays it.

export interface GlhSummary {
  targetMinutes: number | null;
  doneMinutes: number;
  expectedMinutes: number | null;
}

export interface GlhLog {
  id: string;
  minutes: number;
  logDate: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
  createdByName: string | null;
}

export interface GatewayItem {
  key: string;
  label: string;
  kind: 'AUTO_UNITS' | 'AUTO_OTJ' | 'MANUAL';
  done: boolean;
  note: string | null;
  by: string | null;
  /** Display name of `by`. */
  byName?: string | null;
  at: string | null;
}

export interface GatewayView {
  items: GatewayItem[];
  ready: boolean;
  stage: ApprStage;
  stageLabel: string;
  /** The checklist can no longer be changed (gateway confirmed). */
  locked: boolean;
  gatewayPassedAt: string | null;
  gatewayPassedBy: string | null;
  /** Display name of `gatewayPassedBy`. */
  gatewayPassedByName?: string | null;
  epaBookedDate: string | null;
  epaResult: ApprEpaResult | null;
  epaResultDate: string | null;
  achievedAt: string | null;
}

class GatewayApi {
  glhLogs(enrolmentId: string) {
    return call<{ items: GlhLog[]; totalMinutes: number }>(() =>
      classroomio.apprenticeship.enrolments[':id']['glh-logs'].$get({ param: { id: enrolmentId } })
    );
  }

  addGlh(enrolmentId: string, body: { minutes: number; logDate: string; note?: string | null }) {
    return call<{ log: GlhLog }>(() =>
      classroomio.apprenticeship.enrolments[':id']['glh-logs'].$post({ param: { id: enrolmentId }, json: body })
    );
  }

  removeGlh(enrolmentId: string, logId: string) {
    return call<unknown>(() =>
      classroomio.apprenticeship.enrolments[':id']['glh-logs'][':logId'].$delete({ param: { id: enrolmentId, logId } })
    );
  }

  setItem(enrolmentId: string, key: string, body: { done: boolean; note?: string | null }) {
    return call<GatewayView>(() =>
      classroomio.apprenticeship.enrolments[':id'].gateway.items[':key'].$put({
        param: { id: enrolmentId, key },
        json: body
      })
    );
  }

  confirm(enrolmentId: string) {
    return call<GatewayView>(() =>
      classroomio.apprenticeship.enrolments[':id'].gateway.confirm.$post({ param: { id: enrolmentId } })
    );
  }

  reopen(enrolmentId: string) {
    return call<GatewayView>(() =>
      classroomio.apprenticeship.enrolments[':id'].gateway.reopen.$post({ param: { id: enrolmentId } })
    );
  }

  updateEpa(
    enrolmentId: string,
    body: { epaBookedDate?: string | null; epaResult?: ApprEpaResult | null; epaResultDate?: string | null }
  ) {
    return call<GatewayView>(() =>
      classroomio.apprenticeship.enrolments[':id'].epa.$patch({ param: { id: enrolmentId }, json: body })
    );
  }
}

export const gatewayApi = new GatewayApi();
