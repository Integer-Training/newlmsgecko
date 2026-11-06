# Gecko Apprenticeships

A second learning flow beside diploma courses: apprenticeship **programmes** (qualification → units → criteria) with
learner **evidence** mapped to criteria, tutor marking, unit dates, actual-vs-expected progress, off-the-job (OTJ)
hours and a RAG status. Functionally modelled on an existing e-portfolio product, deliberately simpler: one portfolio
page, things open in place, no page-hopping. Owner decisions: 2026-11-06.

Build order: **A — admin view (done)**, B — tutor view, C — learner view.

## Separation from the diploma flow

A programme is its own record (`appr_programme`), **not** a `course` row, so none of the diploma lists, counts,
reports, progress or certificates can see it. The diploma code is touched in exactly three places:

1. `apps/dashboard/src/lib/features/course/components/new-course-modal.svelte` — 5th card "Apprenticeship" creates a
   programme instead of a course (the 4 course types run the same code as before).
2. `apps/dashboard/src/lib/features/ui/navigation/org-navigation.ts` — the "Apprenticeships" sidebar item (admin only).
3. `apps/api/src/app.ts` — `.route('/apprenticeship', apprenticeshipRouter)`.

Plus one security line in `apps/api/src/middlewares/guards/ownership.ts`: `apprenticeship/` file keys are refused by
the course-materials download (they are served only by the apprenticeship evidence download).

Learners are ordinary org learners; tutor ↔ learner allocation (`tutor_allocation`) is reused unchanged.

## Rules (one module)

`packages/utils/src/functions/apprenticeship-progress.ts` + constants `packages/utils/src/constants/apprenticeship.ts`.
Used by the API, the cache recompute and the CSV export, so every screen shows the same numbers.

- Only **Accepted** evidence counts. A criterion is met when accepted mappings ≥ its required count; partial credit
  for required > 1. One piece of evidence can map to criteria in several units.
- Unit actual % = criteria met (weighted by required count), floored. Qualification actual % = average of its units.
- **Expected %** = position of today in the window (unit: start → target date; programme: start → planned end).
- **Status**: Complete (100%) · Dates not set · On target (actual ≥ expected) · Behind (gap ≤ concern gap, default 15)
  · Concern (gap > 15).
- **OTJ target** = weeks × min(contracted hours, cap 30) × 20%, or a per-learner override. OTJ done = accepted evidence
  marked "include in off-the-job".
- Org-tunable (Apprenticeships › Settings): concern gap, OTJ %, weekly cap, evidence types (23 defaults).

Expected % and status depend on the date, so they are **computed on read**, never stored. Only action-driven values
are cached (`appr_enrolment.actual_pct / otj_minutes / *_count`, `appr_enrolment_unit.actual_pct`), recomputed in the
same transaction as every change (`apps/api/src/services/apprenticeship/progress.ts → recomputeEnrolment`).

## Evidence lifecycle

Submitted → **Accepted** or **Referred** (staff review confirms/edits the criteria mapping). Referred → Submitted when
the learner edits it (Phase C). Reopening Accepted is admin-only. Concurrent reviews get a 409. Every change writes an
AUDIT note (who, what, status at the time); GENERAL notes are comments. Files: private `documents` bucket under
`apprenticeship/{programmeId}/{learnerId}/{evidenceId}/…`, presigned upload/download, keys checked on save.

## Access (one helper)

`apps/api/src/services/apprenticeship/access.ts`: ADMIN = whole org · TUTOR = only learners allocated to them ·
LEARNER = self. Anything not visible is a 404. Phase A routes are admin-only; B/C only open routes.

## Data

Tables (migration `0027_apprenticeships.sql`): `appr_programme`, `appr_qualification`, `appr_unit`, `appr_criterion`,
`appr_enrolment`, `appr_enrolment_unit`, `appr_evidence`, `appr_evidence_criterion`, `appr_evidence_note`,
`appr_evidence_type`, `appr_settings`. Statuses are varchar validated against the constants (no Postgres enums).

## Import

Programme › Import accepts our CSV (`unit_code, unit_title, criterion_code, criterion_text, group, required,
unit_ref, criterion_ref`) **or a Skills Portfolio "Export All Unit Data" file as-is** (`code, unitTitle, name,
description, completedItems, requiredItems`; `completedItems` is learner progress and is ignored). Preview first;
apply saves valid rows and lists bad ones. Re-imports update by reference, never duplicate. A single-unit export has
no unit title, so import "All Units" first.

## Admin screens (Phase A)

Apprenticeships › **Learners** (table with qualification + OTJ bars, status, tutor, to-mark; filters; Add learner) ·
learner **portfolio** (summary strip; tabs Units with inline criteria, Criteria map, Evidence, Off-the-job, Achieved;
Edit dates & hours; Spread unit dates; Export CSV; evidence side panel for add/edit/review/notes/files) · **To mark**
queue · **Programmes** (list + setup editor + import) · **Settings**.

## Verified

API tests 793 pass / 15 known baseline failures. Local end-to-end (local Postgres + MinIO, 2026-11-06): create from
the course pop-up → import the 18-unit / 388-criterion export → add learner → spread dates → evidence across 2 units
with a file → To mark → accept with edited mapping → refer with a note → header, units, criteria map, pop-up, OTJ,
CSV and learners list all agree; diploma "Self Paced" creation unchanged.

## Known gaps / next

- "Add learner" tutor/learner pickers use the existing diploma lists (show short handles, as the diploma screens do).
- To mark has no Type column; adding files from To mark is disabled (review works).
- Unit codes from Skills Portfolio files are empty (the title starts with the code).
- Phase B (tutor) and C (learner); later: tasks, GLH, employer access, progress reviews, gateway/EPA, IQA sampling,
  PDF portfolio, multiple qualifications UI, notifications (when email is on).
