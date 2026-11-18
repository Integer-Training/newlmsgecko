import { page } from '$app/state';
import { enrolmentsApi } from '../../api/enrolments.svelte';

// Gecko Apprenticeships — breadcrumb data for the workspace layout (admin + tutor). The layout builds the trail from
// the URL; the names it cannot know (learner, qualification, unit) come from here. Pages/routes either call
// `setWorkspaceCrumbs([...])` to override the whole trail, or `loadCrumbNames(...)` to fill the names in.

export interface Crumb {
  label: string;
  /** Omit on the last crumb (the current page). */
  href?: string;
}

interface CrumbNames {
  learner?: string;
  qualification?: string;
  unit?: string;
}

class WorkspaceCrumbs {
  /** Full override of the trail, valid only for the pathname it was set on. */
  override = $state<{ pathname: string; items: Crumb[] } | null>(null);
  names = $state<CrumbNames>({});
  #cache = new Map<string, { learner: string; qualification: string; units: Record<string, string> }>();
  #req = 0;

  set(items: Crumb[] | null, pathname: string = page.url.pathname) {
    this.override = items ? { pathname, items } : null;
  }

  reset() {
    this.override = null;
    this.names = {};
    this.#req++;
  }

  /** Resolve names for the learner / qualification / unit in the URL (one portfolio GET, cached per id). */
  async load(ids: { learnerEnrolmentId?: string; qualEnrolmentId?: string; unitId?: string }) {
    const id = ids.qualEnrolmentId || ids.learnerEnrolmentId;
    if (!id) return;
    const req = ++this.#req;
    let hit = this.#cache.get(id);
    if (!hit) {
      const res = await enrolmentsApi.getPortfolio(id);
      if (req !== this.#req || !res.ok) return;
      const p = res.data;
      const units: Record<string, string> = {};
      for (const q of p.qualifications ?? []) for (const u of q.units) units[u.id] = u.title;
      hit = { learner: p.learner.name, qualification: p.programme.title, units };
      this.#cache.set(id, hit);
    }
    this.names = {
      learner: hit.learner,
      qualification: ids.qualEnrolmentId ? hit.qualification : undefined,
      unit: ids.unitId ? hit.units[ids.unitId] : undefined
    };
  }
}

export const workspaceCrumbs = new WorkspaceCrumbs();

/** Override the trail for the current page (the lead / other pages can call this once they know better names). */
export function setWorkspaceCrumbs(items: Crumb[] | null, pathname?: string) {
  workspaceCrumbs.set(items, pathname);
}

/** Fill in the learner / qualification / unit names for the layout's URL-derived trail. */
export function loadCrumbNames(ids: { learnerEnrolmentId?: string; qualEnrolmentId?: string; unitId?: string }) {
  return workspaceCrumbs.load(ids);
}
