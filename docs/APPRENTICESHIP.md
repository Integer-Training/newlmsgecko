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

`apps/api/src/services/apprenticeship/access.ts`: ADMIN = whole org · TUTOR = learners allocated to them (NAMED tutor)
OR every enrolment of a programme they are assigned to (PROGRAMME tutor, per enrolment — never the same learner on
another programme) · LEARNER = self. Anything not visible is a 404. Phase A routes are admin-only; B/C only open routes.

## Data

Tables (migration `0027_apprenticeships.sql`): `appr_programme`, `appr_qualification`, `appr_unit`, `appr_criterion`,
`appr_enrolment`, `appr_enrolment_unit`, `appr_evidence`, `appr_evidence_criterion`, `appr_evidence_note`,
`appr_evidence_type`, `appr_settings`. Statuses are varchar validated against the constants (no Postgres enums).

**One programme = one course** (owner, 2026-11-09). Each course (e.g. NCFE L3 Adult Care, NCFE L5 Adult Care) is its
own programme with exactly one qualification; the UI no longer adds a second one. Editing the programme's title /
reference / level / awarding body mirrors them onto that single qualification. The schema still allows several (older
programmes that have more keep a per-qualification header with edit / move / delete). `appr_programme.awarding_body`
(migration `0028`) drives the Programmes list column + filter.

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
queue · **Programmes** (list with status / level / awarding body filters + search; setup page = details, then units
collapsed with their criteria inside, + import) · **Settings**.

## Tutor screens (Phase B)

The /org area is admin-only server-side, so tutors get the same screens inside their caseload shell:
**/caseload/apprenticeships** (learners — only those allocated to them), **…/learners/[enrolmentId]** (portfolio) and
**…/to-mark**, plus "Apprenticeships" + "To mark" in the tutor sidebar. Links follow the shell
(`features/apprenticeship/utils/paths.ts`). API: learners table, portfolio, unit dates / spread, CSV export, every
evidence route, and READ of the programme list + settings bundle are `requireStaff`; the services 404 any learner not
allocated to the tutor. Admin-only: enrolling a learner, programme dates / hours / OTJ override (route + service),
programme setup, settings writes, reopening accepted evidence. Hidden for tutors in the UI: Add learner, the tutor
filter, Edit dates & hours.

## Learner screens (Phase C)

In the learner shell: **/lms/apprenticeship** (one apprenticeship opens straight into its portfolio; several show a
pick list) and **/lms/apprenticeship/[enrolmentId]**. "My apprenticeship" shows in the learner menu only when the
learner has an enrolment (`features/apprenticeship/api/my-apprenticeship.svelte.ts`, loaded by the /lms layout). API
routes open to LEARNER (`requireRole('ADMIN','TUTOR','LEARNER')`): own learners list, portfolio, CSV export, evidence
list / create / presign / download / detail / edit / notes, criterion evidence, settings read. Staff-only still: unit
dates + spread, To mark, review. The services force a learner's evidence to SUBMITTED, allow edits only while
SUBMITTED / REFERRED (editing REFERRED resubmits it) and make their notes GENERAL. Hidden for learners in the UI: the
status picker, unit-date edit, Spread unit dates (and Edit dates & hours).

## Verified

API tests 793 pass / 15 known baseline failures. Local end-to-end (local Postgres + MinIO, 2026-11-06): create from
the course pop-up → import the 18-unit / 388-criterion export → add learner → spread dates → evidence across 2 units
with a file → To mark → accept with edited mapping → refer with a note → header, units, criteria map, pop-up, OTJ,
CSV and learners list all agree; diploma "Self Paced" creation unchanged.

## Notifications (in-app)

The existing bell (all three shells) carries three types, in-app only (no email template; email is off on Gecko):
`appr.evidence.submitted` → the learner's allocated tutors when the apprentice adds evidence or resubmits referred
evidence; `appr.evidence.accepted` / `appr.evidence.referred` → the apprentice when it is marked (and when staff add
evidence straight as Accepted). Marking clears every tutor's "to mark" alert for that evidence
(`markNotificationsReadForEntity`). Links are built at read time (`services/comms/notification-centre.ts`): staff →
`/caseload/apprenticeships/learners/{enrolmentId}?evidence={id}`, apprentice → `/lms/apprenticeship/{enrolmentId}?evidence={id}`;
the portfolio opens that evidence's sheet. Sending lives in `services/apprenticeship/notifications.ts`, called after the
transaction and never fatal.

## Round 2 — Deploy 1 (2026-11-09): task plans, tasks, progress reviews, upload clean-up

Migration `0029_appr_tasks_reviews.sql` (additive): `appr_upload`, `appr_task_plan`, `appr_task_plan_item`,
`appr_task_plan_item_criterion`, `appr_task`, `appr_task_criterion`, `appr_review`; columns `appr_evidence.task_id`,
`appr_programme.review_interval_weeks` (default 12). Rules: `addMonths`, `taskDueDate`, `taskStatusFromEvidence`,
`isTaskOverdue`, `isWithinWindow`, `nextReviewDate`, `firstReviewDate`, `isReviewOverdue`, `reviewFullySigned`.

- **Task plans** (admin, Apprenticeships › Task plans): template per programme (title, valid from/to, brief files)
  with tasks (title, details, evidence type, sequence, **month offset**, expected time, brief files, criteria).
  **Assign** to learners → one task each, due = learner start + month offset (no start date → no due date); idempotent;
  outside the valid window or archived → refused. **Unassign** removes only still-Planned tasks. **Update assigned
  learners** pushes edits to Planned tasks (keeps a task's own files). Tutors may create **individual tasks** for their
  allocated learners. Routes: `/apprenticeship/task-plans/*` (admin), `/apprenticeship/tasks/*`.
- **Tasks**: portfolio **Tasks** tab in all shells; the learner "Answers" a task = evidence with `task_id`, criteria
  pre-ticked. Task status (Planned → Submitted / Referred → Complete) is re-synced in the evidence transaction under a
  row lock; overdue is computed on read. Learners lists + portfolio summary show overdue task counts.
- **Progress reviews** (portfolio **Reviews** tab): first review auto-scheduled at start + interval (past → today + 7,
  same rule everywhere: create, daily back-fill, start-date change). Scheduled → In progress → Awaiting signatures
  (needs held date) → signed by tutor, learner (own view) and employer (recorded by staff on their behalf until employer
  access exists, see `docs/APPRENTICESHIP-EMPLOYER.md`) → **Complete** (locked, snapshot stored, next review scheduled;
  never two open reviews). Fields lock after the first signature; concurrent edits → 409.
- **Notifications** (bell): `appr.task.assigned`, `appr.task.overdue`, `appr.review.sign`, `appr.review.due`; links open
  the portfolio on `?tab=tasks|reviews`.
- **Daily maintenance jobs** (`packages/core/src/services/apprenticeship/maintenance.ts`, scheduled in
  `apps/jobs/src/workers/maintenance.ts`): `apprUploadCleanup` (deletes uploads never saved, or dropped, after 24 h;
  never a key still referenced; re-checked per key), `apprTaskOverdueScan` and `apprReviewDueScan` (claim-before-notify,
  once only; review scan also back-fills missing first reviews). Evidence saved with an expired upload → 400.
- Verified: API 981 pass / 15 known baseline failures; independent security + correctness review (no HIGH; 1 MEDIUM +
  5 LOW fixed); scripted local E2E 58 pass / 0 fail (plan → assign → answer → refer → resubmit → accept → complete;
  access blocks; sync/unassign; review with three signatures → next review; notifications; upload clean-up; scans once).

## Round 2 — Deploy 2 (2026-11-09): GLH and gateway / EPA

Migration `0030_appr_glh_gateway.sql` (additive): `appr_glh_log`; `appr_enrolment.gateway_items`, `gateway_ready_notified_at`,
`gateway_passed_at/by`, `epa_booked_date`, `epa_result`, `epa_result_date`, `glh_minutes` (cache);
`appr_programme.gateway_checklist` (null = default). Rules: `glhTargetMinutes`, `glhDoneMinutes`, `glhExpectedMinutes`,
`gatewayState`, `apprStage`.

- **GLH**: GLH (hours) per unit in programme setup and the CSV `glh` column. Target = Σ unit GLH; done = GLH of complete
  units + staff logs (portfolio **Hours** tab; learner read-only); expected = target × programme expected %. Shown in the
  portfolio, learners lists and CSV; blank when no unit has GLH.
- **Gateway checklist** per programme (setup page; default: all units complete [auto], OTJ target met [auto], English,
  Maths, employer sign-off, tutor sign-off [manual]). Portfolio **Gateway** tab: auto items live from progress, manual
  items ticked by staff with notes; **Ready for gateway** → staff **Confirm gateway** (locks ticks); admin **Reopen**
  (only before an EPA result). EPA: booked date (≥ gateway date), result Pass/Merit/Distinction/Fail + date (≥ gateway
  date, not future); an achieving result sets `achieved_at`, Fail clears it; once a result exists only admins change it;
  concurrent EPA edits → 409. Stage chip (In learning / Ready for gateway / At gateway / EPA booked / Achieved / EPA not
  passed) in lists and the portfolio.
- **Learner lock**: after gateway is confirmed the apprentice can no longer add/edit evidence or notes (checked again
  inside the transaction); staff can. Overdue-task alerts stop for gateway/achieved learners.
- **`appr.gateway.ready`** → allocated tutors (same org) + org admins, once; cleared if readiness drops; released for
  retry if sending fails; the daily scan pages through every learner so none is missed.
- Verified: API 1064 pass / 15 known baseline failures; independent review (no HIGH; 2 MEDIUM + 4 LOW fixed); local
  E2E 51 pass / 0 fail (GLH, checklist, ticks, ready alert once, confirm, learner lock, EPA rules, reopen, scan) and the
  Deploy 1 script re-run 58 pass.

## Programme tutors + named tutors (2026-11-10)

Owner decision: tutors are assigned to apprenticeship programmes the way they are assigned to courses, AND each
apprentice keeps a named tutor.

- **Programme tutor** — `appr_programme_tutor` (migration `0031_appr_programme_tutor.sql`). Set per tutor in Tutor
  Management › **Apprenticeships** (exact-set save, admin only; archived programmes listed only while assigned). Sees and
  marks every apprentice on the programme (portfolio, lists, To mark, tasks, reviews, plan briefs) but gets no alerts.
- **Named tutor** — the existing `tutor_allocation` pair, picked at Add learner and now changeable on the portfolio
  (**Tutors** button, admin): add / remove, programme tutors shown read-only. Gets every tutor alert (evidence, overdue
  tasks, review due/sign, gateway ready). The pair is provider-wide, so removing one also ends that tutor's diploma
  allocation to the learner and archives their message thread (existing de-allocation behaviour). With no named tutor,
  tutor alerts reach nobody — the dialog warns.
- Any tutor who reaches the enrolment may sign a review as the tutor (cover).
- Learners list Tutor column / filter = named tutors.
- API: `GET|PUT /apprenticeship/tutors/:tutorId/programmes` (admin), `GET /apprenticeship/enrolments/:id/tutors`
  (anyone who can see the portfolio), `POST /…/tutors`, `DELETE /…/tutors/:tutorId` (admin). One SQL helper
  `tutorReachSql` scopes every tutor list. Tests `apprenticeship-tutors.test.ts`; local E2E 22 pass.

## Known gaps / next

- Round 2 Deploy 3: IQA sampling, PDF portfolio, summary dashboard.
- Employer access: design only (`docs/APPRENTICESHIP-EMPLOYER.md`). Email notifications when email is on.

Closed 2026-11-09: To mark shows the evidence Type and can add files; tutors marking from To mark get the criteria
tree (programme structure GET is `requireStaff`); Add learner pickers show full names
(`GET /apprenticeship/enrolments/options`, admin only); Skills Portfolio imports split the unit code off the title
(`splitUnitCode`; re-import fills an empty code only); file links open before the await (popup blockers).
Verified end to end on the local stack (learner upload → tutor alert → refer → resubmit → accept → learner alert,
every shell page and cross-role block) — API 855 pass / 15 known baseline failures.

## Apprentice shell, table data, onboarding documents (2026-11-10)

**Tutor display rule (every table).** Show the learner's NAMED tutor (tutor_allocation); if none, the programme
tutor(s) labelled "(programme)"; if neither, an amber "No tutor" chip. SQL: `tutorsDisplaySql` / `noTutorSql`
(`queries/apprenticeship/tutors.ts`); UI: `components/shared/tutor-cell.svelte` + `tutorNames()`. The portfolio
Tutors dialog still manages NAMED tutors only (`getEnrolmentTutors` filters out the programme fallback).

**Tables.** To mark: + Tutor, Task (title + due), Waiting. Learners: email, start → planned end, Tutor (rule),
Onboarding approved/required, filters `noTutor=true` and `onboarding=incomplete`. Evidence tab: Marked by / on. OTJ
tab: By. Reviews: signer names + dates, Next review. Plan assignees: tutor + overdue count. Programmes: Tutors.
Gateway: who ticked / confirmed and when.

**Apprentice shell.** A learner with any apprenticeship enrolment (`myApprenticeshipApi.hasAny`, awaited in the
`/lms` layout) gets `apprenticeNavConfig` (`lms-navigation.ts`) instead of the course sidebar: Dashboard ·
Onboarding (badge x/y) · Units & criteria · Evidence · Tasks · Reviews · Off-the-job · Gateway · Messages · My
courses (only if they also have course enrolments) · Settings. `/lms` and post-login land on `/lms/apprenticeship`
(apprentice dashboard). Section routes `/lms/apprenticeship/{onboarding,units,evidence,tasks,reviews,otj,gateway}`
render the existing portfolio tab components for the current enrolment (switcher when several; per-viewer
localStorage). Learners without an apprenticeship see the unchanged course sidebar.

**Onboarding documents (migration 0032).** `appr_onboarding_doc_type` (org-configurable, programme-scoped or all,
required, allow "I don't have this", order, active; 9 defaults seeded on first read under an advisory lock) and
`appr_onboarding_doc` (one slot per enrolment + type; SUBMITTED | APPROVED | REJECTED). Complete = every active
required applicable type APPROVED (computed on read). Access: admin everything; learner self (upload / replace /
withdraw until APPROVED; sees own files); tutor STATUS ONLY (no files, no writes); else 404. File keys are prefixed
per enrolment + type and must be live `appr_upload` rows for the learner (key-injection guard); dropped files go to
the clean-up job. Review is optimistic on the status the reviewer saw (409 if stale); reject needs a reason.
Notifications: `appr.onboarding.submitted` (admins), `.reviewed` (learner), `.complete` (named tutors + admins, once,
on the incomplete → complete transition). Admin: portfolio Onboarding tab; Apprenticeships › Settings › Onboarding
documents (types in use can only be deactivated). Endpoints under `/apprenticeship`: `GET|DELETE|PUT
/enrolments/:id/onboarding[/:docTypeId]`, `POST .../presign`, `.../:docTypeId/review`, `.../:docTypeId/download`,
`GET|POST /onboarding-types`, `PATCH|DELETE /onboarding-types/:typeId`, `PUT /onboarding-types/order`.
