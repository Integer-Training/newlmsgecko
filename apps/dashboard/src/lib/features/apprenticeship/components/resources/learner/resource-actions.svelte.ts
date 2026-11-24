import { snackbar } from '$features/ui/snackbar/store';
import type { PortfolioStore } from '../../../stores/portfolio.svelte';
import { resourcesLearnerApi, type LearnerResourceItem } from '../../../api/resources-learner.svelte';
import { pickableCriteria } from './resource-utils';

/**
 * What the learner can do with one resource row: open the viewer, download a workbook, upload the completed workbook
 * as evidence. One instance per screen (page / unit card); `onChange` lets the owner patch its list after a download.
 */
export class ResourceActions {
  viewing = $state<LearnerResourceItem | null>(null);
  viewerOpen = $state(false);
  downloadingId = $state<string | null>(null);

  constructor(
    private readonly store: PortfolioStore | null,
    private readonly onChange: (id: string, patch: Partial<LearnerResourceItem>) => void
  ) {}

  view(r: LearnerResourceItem) {
    this.viewing = r;
    this.viewerOpen = true;
    // The API records the first view; reflect it locally without another request.
    if (r.status === 'NOT_STARTED') this.onChange(r.id, { status: 'VIEWED' });
  }

  async download(r: LearnerResourceItem) {
    if (this.downloadingId) return;
    this.downloadingId = r.id;
    try {
      const res = await resourcesLearnerApi.download(r.id, r.enrolmentId);
      if (!res.ok) {
        snackbar.error(res.error);
        return;
      }
      const a = document.createElement('a');
      a.href = res.data.url;
      a.download = res.data.fileName || r.file.name;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a timestamp string, not reactive state
      const now = new Date().toISOString();
      this.onChange(r.id, {
        updatedSinceDownload: false,
        activity: {
          firstViewedAt: r.activity?.firstViewedAt ?? now,
          lastDownloadedAt: now,
          downloadCount: (r.activity?.downloadCount ?? 0) + 1,
          lastVersion: r.version
        },
        ...(r.status === 'NOT_STARTED' || r.status === 'VIEWED' ? { status: 'DOWNLOADED' as const } : {})
      });
    } finally {
      this.downloadingId = null;
    }
  }

  /** Open the evidence form pre-filled from the workbook (title, type, suggested criteria, resourceId). */
  upload(r: LearnerResourceItem) {
    const store = this.store;
    if (!store) return;
    this.viewerOpen = false;
    const qualEnrolmentId = store.portfolioFor(r.enrolmentId) ? r.enrolmentId : null;
    store.openNewEvidence(pickableCriteria(r.criterionIds, store.pickerTree), null, qualEnrolmentId, {
      id: r.id,
      title: r.title,
      typeKey: r.evidenceTypeKey
    });
  }
}
