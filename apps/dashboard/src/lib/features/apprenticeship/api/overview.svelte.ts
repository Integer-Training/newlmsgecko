import { classroomio } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';
import type { OverviewPayload } from './overview.types';

// Gecko Apprenticeships — the learner overview payload (GET /apprenticeship/enrolments/:id/overview). `:id` may be
// either enrolment of a pair; the API resolves it to the carrier. Every number is the API's: nothing is recomputed here.
class OverviewApi {
  get(enrolmentId: string): Promise<CallResult<OverviewPayload>> {
    return call<OverviewPayload>(() =>
      classroomio.apprenticeship.enrolments[':id'].overview.$get({ param: { id: enrolmentId } })
    );
  }

  /** Download the portfolio CSV for one enrolment, optionally for one unit (the API builds it). */
  async exportCsv(enrolmentId: string, unitId?: string): Promise<boolean> {
    try {
      const res = await classroomio.apprenticeship.enrolments[':id']['export.csv'].$get({
        param: { id: enrolmentId },
        query: unitId ? { unitId } : {}
      });
      if (!res.ok) {
        snackbar.error('Could not export the data.');
        return false;
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'portfolio.csv';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return true;
    } catch {
      snackbar.error('Could not export the data.');
      return false;
    }
  }
}

export const overviewApi = new OverviewApi();
