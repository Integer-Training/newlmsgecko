import axios from 'axios';
import { classroomio } from '$lib/utils/services/api';
import { snackbar } from '$features/ui/snackbar/store';
import { call, type CallResult } from './call';

// Gecko Apprenticeships — client for onboarding documents (photo ID, NI proof…). Shapes mirror
// apps/api/src/services/apprenticeship/onboarding.ts. Files go presign → PUT straight to storage → save on the slot.

export type OnboardingStatus = 'SUBMITTED' | 'APPROVED' | 'REJECTED';

export interface OnboardingDocType {
  id: string;
  label: string;
  description: string | null;
  required: boolean;
  allowNotHeld: boolean;
  /** False = switched off or no longer applies: shown only because it already has an upload; never counts. */
  active: boolean;
}

export interface OnboardingFile {
  key: string;
  name: string;
  size?: number;
  type?: string;
}

export interface OnboardingDoc {
  id: string;
  status: OnboardingStatus;
  notHeld: boolean;
  learnerNote: string | null;
  reviewNote: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  submittedByName: string | null;
  submittedAt: string | null;
  /** Empty for a tutor (status only). */
  files: OnboardingFile[];
  fileCount: number;
}

export interface OnboardingItem {
  type: OnboardingDocType;
  doc: OnboardingDoc | null;
}

export interface OnboardingView {
  enrolmentId: string;
  complete: boolean;
  counts: { required: number; approved: number; submitted: number; rejected: number };
  canSeeFiles: boolean;
  items: OnboardingItem[];
}

/** Admin settings row: a document type plus where it applies and whether anyone has uploaded against it. */
export interface OnboardingTypeRow {
  id: string;
  label: string;
  description: string | null;
  required: boolean;
  allowNotHeld: boolean;
  programmeId: string | null;
  sequence: number;
  active: boolean;
  inUse: boolean;
}

export interface OnboardingTypeInput {
  label: string;
  description?: string | null;
  required?: boolean;
  allowNotHeld?: boolean;
  programmeId?: string | null;
  active?: boolean;
}

/** Bumped after any save / withdraw / review so other parts of the page (e.g. the sidebar badge) can refetch. */
class OnboardingChanged {
  count = $state(0);
  bump() {
    this.count += 1;
  }
}
export const onboardingChanged = new OnboardingChanged();

class ApprOnboardingApi {
  get(enrolmentId: string) {
    return call<OnboardingView>(() =>
      classroomio.apprenticeship.enrolments[':id'].onboarding.$get({ param: { id: enrolmentId } })
    );
  }

  /** Presign → PUT each file → returns the file metadata to pass to save(). */
  async presign(enrolmentId: string, docTypeId: string, files: File[]): Promise<CallResult<OnboardingFile[]>> {
    const presign = await call<{ files: { name: string; key: string; uploadUrl: string }[] }>(() =>
      classroomio.apprenticeship.enrolments[':id'].onboarding.presign.$post({
        param: { id: enrolmentId },
        json: {
          docTypeId,
          files: files.map((f) => ({ name: f.name, size: f.size, type: f.type || 'application/octet-stream' }))
        }
      })
    );
    if (!presign.ok) return presign;
    try {
      const uploaded: OnboardingFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const target = presign.data.files[i];
        const type = files[i].type || 'application/octet-stream';
        await axios.put(target.uploadUrl, files[i], { headers: { 'Content-Type': type } });
        uploaded.push({ key: target.key, name: files[i].name, size: files[i].size, type });
      }
      return { ok: true, data: uploaded };
    } catch {
      return { ok: false, error: 'The upload failed. Please try again.' };
    }
  }

  async save(
    enrolmentId: string,
    docTypeId: string,
    input: { files: OnboardingFile[]; notHeld: boolean; learnerNote?: string | null }
  ) {
    const res = await call<{ id: string; status: OnboardingStatus }>(() =>
      classroomio.apprenticeship.enrolments[':id'].onboarding[':docTypeId'].$put({
        param: { id: enrolmentId, docTypeId },
        json: input
      })
    );
    if (res.ok) onboardingChanged.bump();
    return res;
  }

  async withdraw(enrolmentId: string, docTypeId: string) {
    const res = await call<{ id: string }>(() =>
      classroomio.apprenticeship.enrolments[':id'].onboarding[':docTypeId'].$delete({
        param: { id: enrolmentId, docTypeId }
      })
    );
    if (res.ok) onboardingChanged.bump();
    return res;
  }

  async review(
    enrolmentId: string,
    docTypeId: string,
    input: { decision: 'APPROVE' | 'REJECT'; note?: string | null; expectedStatus: OnboardingStatus }
  ) {
    const res = await call<{ id: string; status: OnboardingStatus; becameComplete: boolean }>(() =>
      classroomio.apprenticeship.enrolments[':id'].onboarding[':docTypeId'].review.$post({
        param: { id: enrolmentId, docTypeId },
        json: input
      })
    );
    if (res.ok) onboardingChanged.bump();
    return res;
  }

  download(enrolmentId: string, docTypeId: string, keys: string[]) {
    return call<Record<string, string>>(() =>
      classroomio.apprenticeship.enrolments[':id'].onboarding[':docTypeId'].download.$post({
        param: { id: enrolmentId, docTypeId },
        json: { keys }
      })
    );
  }

  /**
   * Open one file via a short-lived signed URL. The tab is opened BEFORE the await (still inside the click) so popup
   * blockers allow it; it is then pointed at the signed URL (or closed).
   */
  async openFile(enrolmentId: string, docTypeId: string, key: string): Promise<void> {
    const tab = window.open('', '_blank');
    const res = await this.download(enrolmentId, docTypeId, [key]);
    const url = res.ok ? res.data[key] : undefined;
    if (!url) {
      tab?.close();
      snackbar.error(res.ok ? 'Could not open the file.' : res.error);
      return;
    }
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  }

  // ── Document types (admin settings) ──

  listTypes() {
    return call<OnboardingTypeRow[]>(() => classroomio.apprenticeship['onboarding-types'].$get());
  }

  createType(json: OnboardingTypeInput) {
    return call<OnboardingTypeRow>(() => classroomio.apprenticeship['onboarding-types'].$post({ json }));
  }

  updateType(typeId: string, json: Partial<OnboardingTypeInput>) {
    return call<OnboardingTypeRow>(() =>
      classroomio.apprenticeship['onboarding-types'][':typeId'].$patch({ param: { typeId }, json })
    );
  }

  reorderTypes(typeIds: string[]) {
    return call<OnboardingTypeRow[]>(() =>
      classroomio.apprenticeship['onboarding-types'].order.$put({ json: { typeIds } })
    );
  }

  deleteType(typeId: string) {
    return call<{ id: string }>(() =>
      classroomio.apprenticeship['onboarding-types'][':typeId'].$delete({ param: { typeId } })
    );
  }
}

export const apprOnboardingApi = new ApprOnboardingApi();
