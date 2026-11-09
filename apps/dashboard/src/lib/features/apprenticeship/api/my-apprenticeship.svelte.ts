import { classroomio } from '$lib/utils/services/api';

/**
 * Gecko Apprenticeships Phase C — the signed-in apprentice's own enrolments (the API scopes a LEARNER to themselves).
 * Loaded once by the learner shell: it decides whether "My apprenticeship" appears in the menu at all, so learners on
 * diploma courses only never see it.
 */
export interface MyEnrolment {
  id: string;
  programmeTitle: string;
}

class MyApprenticeshipApi {
  enrolments = $state<MyEnrolment[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);
  #inflight: Promise<void> | null = null;

  get hasAny() {
    return this.enrolments.length > 0;
  }

  load(force = false): Promise<void> {
    if (this.#inflight) return this.#inflight;
    if (this.loaded && !force) return Promise.resolve();
    this.#inflight = (async () => {
      try {
        const res = await classroomio.apprenticeship.enrolments.$get({ query: { page: '1', pageSize: '50' } });
        const body = (await res.json()) as { success?: boolean; data?: { items?: MyEnrolment[] }; error?: string };
        if (res.ok && body.success) {
          this.enrolments = (body.data?.items ?? []).map((e) => ({ id: e.id, programmeTitle: e.programmeTitle }));
          this.error = null;
        } else {
          this.error = body.error ?? 'Could not load your apprenticeship.';
        }
      } catch {
        this.error = 'Could not load your apprenticeship.';
      } finally {
        this.loaded = true;
        this.#inflight = null;
      }
    })();
    return this.#inflight;
  }
}

export const myApprenticeshipApi = new MyApprenticeshipApi();
