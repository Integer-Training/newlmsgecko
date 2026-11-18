import { classroomio } from '$lib/utils/services/api';
import type { ApprProgrammeType } from '@cio/utils/constants/apprenticeship';
import type { EnrolmentLinked } from './overview.types';

/**
 * Gecko Apprenticeships — the signed-in apprentice's own apprenticeships (the API scopes a LEARNER to themselves).
 * Loaded once by the learner shell: it decides whether "My apprenticeship" appears in the menu at all, so learners on
 * diploma courses only never see it.
 *
 * GET /enrolments folds a linked pair into ONE row (the carrier) with `linked` = the component. So `enrolments` here
 * is the list of distinct apprenticeships, and `id` is always a carrier id. Learner-level pages (evidence, tasks,
 * reviews, OTJ, gateway, onboarding) always use `currentEnrolmentId`.
 */
export interface MyEnrolment {
  /** The carrier enrolment id. */
  id: string;
  programmeTitle: string;
  programmeType: ApprProgrammeType | null;
  linked: EnrolmentLinked | null;
}

/** One qualification of an apprenticeship (the carrier itself, or its linked component). */
export interface MyQualification {
  enrolmentId: string;
  title: string;
  type: ApprProgrammeType | null;
}

const PICKED_KEY = 'gecko.apprentice.enrolment.v1';

function readPicked(): string | null {
  try {
    return localStorage.getItem(PICKED_KEY);
  } catch {
    return null;
  }
}

class MyApprenticeshipApi {
  enrolments = $state<MyEnrolment[]>([]);
  loaded = $state(false);
  error = $state<string | null>(null);
  #inflight: Promise<void> | null = null;
  /** The apprenticeship (carrier id) picked in the sidebar switcher (remembered per viewer; see currentEnrolmentId). */
  #pickedId = $state<string | null>(readPicked());

  get hasAny() {
    return this.enrolments.length > 0;
  }

  /** Switcher shows only with two or more distinct apprenticeships (a diploma + standard pair is ONE). */
  get hasSeveral() {
    return this.enrolments.length > 1;
  }

  /** The CARRIER enrolment the shell shows: their last pick if still valid, else the first one. */
  get currentEnrolmentId(): string | null {
    const picked = this.#pickedId;
    if (picked) {
      const hit = this.carrierOf(picked);
      if (hit) return hit;
    }
    return this.enrolments[0]?.id ?? null;
  }

  get current(): MyEnrolment | null {
    const id = this.currentEnrolmentId;
    return this.enrolments.find((e) => e.id === id) ?? null;
  }

  /** The qualifications of the current apprenticeship: carrier first, then its component. */
  get qualifications(): MyQualification[] {
    return this.qualificationsOf(this.current);
  }

  qualificationsOf(e: MyEnrolment | null): MyQualification[] {
    if (!e) return [];
    const list: MyQualification[] = [{ enrolmentId: e.id, title: e.programmeTitle, type: e.programmeType }];
    if (e.linked) list.push({ enrolmentId: e.linked.id, title: e.linked.programmeTitle, type: e.linked.type });
    return list;
  }

  /** Resolve any of the learner's enrolment ids (carrier or component) to its carrier id; null if not theirs. */
  carrierOf(id: string): string | null {
    const hit = this.enrolments.find((e) => e.id === id || e.linked?.id === id);
    return hit?.id ?? null;
  }

  /** True when the id is the component of a pair (so it has its own qualification page, not a portfolio). */
  isComponent(id: string): boolean {
    return this.enrolments.some((e) => e.linked?.id === id);
  }

  setCurrent(id: string) {
    const carrier = this.carrierOf(id) ?? id;
    this.#pickedId = carrier;
    try {
      localStorage.setItem(PICKED_KEY, carrier);
    } catch {
      // storage blocked — the pick just won't survive a reload
    }
  }

  load(force = false): Promise<void> {
    if (this.#inflight) return this.#inflight;
    if (this.loaded && !force) return Promise.resolve();
    this.#inflight = (async () => {
      try {
        const res = await classroomio.apprenticeship.enrolments.$get({ query: { page: '1', pageSize: '50' } });
        const body = (await res.json()) as {
          success?: boolean;
          data?: {
            items?: {
              id: string;
              programmeTitle: string;
              programmeType?: ApprProgrammeType;
              linked?: EnrolmentLinked | null;
            }[];
          };
          error?: string;
        };
        if (res.ok && body.success) {
          this.enrolments = (body.data?.items ?? []).map((e) => ({
            id: e.id,
            programmeTitle: e.programmeTitle,
            programmeType: e.programmeType ?? null,
            linked: e.linked ?? null
          }));
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
