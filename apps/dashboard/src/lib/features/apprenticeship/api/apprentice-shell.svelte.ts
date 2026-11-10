import { coursesApi } from '$features/course/api';
import { apprOnboardingApi } from './onboarding.svelte';

/**
 * Gecko Apprenticeships — small shared state for the apprentice shell (sidebar badge + "My courses" visibility).
 * Kept next to myApprenticeshipApi so the sidebar, the onboarding page and the dashboard all read the same numbers.
 */
class ApprenticeShell {
  /** Onboarding documents approved / required for the current enrolment; null until known (badge stays hidden). */
  onboarding = $state<{
    enrolmentId: string;
    approved: number;
    required: number;
    rejected: number;
    complete: boolean;
  } | null>(null);
  /** Whether the learner also has course enrolments (decides if "My courses" appears); null until known. */
  hasCourses = $state<boolean | null>(null);

  async refreshOnboardingBadge(enrolmentId: string | null) {
    if (!enrolmentId) {
      this.onboarding = null;
      return;
    }
    try {
      const res = await apprOnboardingApi.get(enrolmentId);
      if (res.ok) {
        this.onboarding = {
          enrolmentId,
          approved: res.data.counts.approved,
          required: res.data.counts.required,
          rejected: res.data.counts.rejected,
          complete: res.data.complete
        };
      }
      // on failure keep the previous value (or none) — the badge simply stays hidden
    } catch {
      // ignore: a badge is never worth an error
    }
  }

  /** The cheapest existing source: the same enrolled-courses list the course dashboard uses. */
  async loadCourses() {
    try {
      await coursesApi.getEnrolledCourses();
      this.hasCourses = coursesApi.enrolledCourses.length > 0;
    } catch {
      this.hasCourses = null;
    }
  }
}

export const apprenticeShell = new ApprenticeShell();

/** Re-read the sidebar's onboarding badge (call after the onboarding page saves). */
export function refreshOnboardingBadge(enrolmentId: string | null) {
  return apprenticeShell.refreshOnboardingBadge(enrolmentId);
}
