import { JOB_NAMES, QUEUE_NAMES } from '../queues/names';
import { QUEUE_DEFAULTS } from '../queues/defaults';
import { getQueue } from '../queues/factories';
import type {
  TApprDailyScanPayload,
  TApprUploadCleanupPayload,
  TAssetStorageCleanupPayload
} from '../payloads/maintenance';

/**
 * Enqueue a background sweep of a deleted asset's object-storage files. The
 * payload carries the concrete buckets/keys/prefixes because the asset row is
 * already deleted by the time this runs.
 */
export async function enqueueAssetStorageCleanup(payload: TAssetStorageCleanupPayload): Promise<string> {
  const job = await getQueue(QUEUE_NAMES.maintenance).add(
    JOB_NAMES.maintenance.assetStorageCleanup,
    payload,
    QUEUE_DEFAULTS[QUEUE_NAMES.maintenance]
  );

  return job.id ?? '';
}

type ApprMaintenanceJob = 'apprUploadCleanup' | 'apprTaskOverdueScan' | 'apprReviewDueScan';

/** Run one of the Gecko Apprenticeships daily maintenance jobs now (the scheduler runs them daily on its own). */
export async function enqueueApprMaintenanceJob(
  job: ApprMaintenanceJob,
  payload: TApprUploadCleanupPayload | TApprDailyScanPayload = {}
): Promise<string> {
  const queued = await getQueue(QUEUE_NAMES.maintenance).add(
    JOB_NAMES.maintenance[job],
    payload,
    QUEUE_DEFAULTS[QUEUE_NAMES.maintenance]
  );

  return queued.id ?? '';
}
