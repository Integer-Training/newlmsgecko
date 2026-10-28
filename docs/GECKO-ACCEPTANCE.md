# Gecko Programmes LMS - Acceptance (Phase 8)

- **Date:** 2026-10-28
- **Tester:** Claude (automated, Playwright) for owner
- **Site:** https://gecko.epearlacademy.com (org slug `geckoprogrammes`)
- **Commit:** 0f295ab8
- **Status:** STAGE 1 + STAGE 2 + STAGE 3 complete (8.1-8.7 run; only email-delivery rows remain DEFERRED).
- Legend: ✅ pass · ❌ defect · ⏸ DEFERRED (reason) · ⬜ not yet · N/A not applicable
- Method: every route loaded in a real browser; pass = renders, no console errors / 4xx-5xx API calls other than expected, main actions work. Walked as `admin2` (a non-super Admin) because the super-admin session was logged out before testing; admin-only behaviour is identical for both. Anonymous rows used a fresh browser context.

## Summary (stage 3 run 2026-10-28)

| Section | Pass | Fail | Deferred |
|---|---|---|---|
| 8.1 Auth & public | 20 | 0 | 1 |
| 8.2 Admin | 70 | 7 (D1-D7) | 0 (org switcher N/A) |
| 8.3 Manager | 4 | 0 | 0 |
| 8.4 Tutor | 10 | 1 (D9, low) | 0 |
| 8.5 Learner | 11 | 0 | 0 |
| 8.6 Flows | 11 | 0 | 3 (email off) |
| 8.7 Email templates | 29 | 0 | 1 (live delivery) |

**Stage 3 closed every non-email gap:** registration approve + password, D9 proof, feedback-file attach, tutor-feedback popup, cohorts, upload cleanup. No new defects; minor observations O5/O6 below.

Stage-2 defect **D9** (tutor grading roster lists non-allocated learner3) is now proven LOW severity (see D9 row and 8.4): view only; grading and download are blocked server-side. It is the by-design course-teacher roster, identical to Pearl base (no diff vs 883c4a62 in the caseload/coursework code). D8 was bypassed (manager1 password set via DB).

## Setup notes

- Test data created (all `@gecko-test.invalid`): course **GECKO TEST** (published; 1 phase, 3 units: Unit 1 Workbook = workbook + allowDrafts, Unit 2 Case Study = casestudy + dueAt 2026-12-31 + drafts off, Unit 3 Assignment = workbook kind + allowDrafts; each with a PDF brief); `tutor1` on the course team; learners `learner1`, `learner2` (-> tutor1), `learner3` (-> tutor2) created via Learners page; `manager1` (Manager) via the legacy `/org/geckoprogrammes/users` page. `admin2`, `tutor1`, `tutor2` pre-existing. Temp passwords are held outside the repo.
- The `assignment` kind is hidden from the document picker (by design), so Unit 3 was created as a Workbook.
- Org look-and-feel compared to Pearl read-only = identical (theme blue, customization, signup + AI tutor settings); no change made.
- Login page shows 2 CSP "inline event handler" console errors (cosmetic, inherited; login works).
- Email is deliberately OFF in prod: delivery rows are DEFERRED, not failures.
- Reply-To falls back to `no-reply@gecko-programmes.invalid` until `SMTP_REPLY_TO` is set.
- Created `manager1` has no usable password: the legacy Users page only sends a set-password email (off), and there is no Manager "Reset password" button anywhere (Admins/Tutors/Learners pages have one for their own role only). Resolved for testing by an owner-approved DB password update on `manager1` only (see defect D8).

## Defects found (stage 1)

| # | Route | Defect |
|---|---|---|
| D1 | `/org/geckoprogrammes/users` (legacy) | `GET /proxy/organization/users?page=1&limit=20` returns 500 `Failed to list users` (correlationId 851b0cdb-a0e9-4ee7-ac76-d68ad675ae3f); table shows "No users found". Create user works. |
| D2 | `/org/geckoprogrammes/settings/teams` | `GET /proxy/organization/team` returns 500 `ORG_TEAM_FETCH_FAILED` (correlationId 0bde50eb-03ba-49e8-bab9-c5f7eb19cf7f); team list empty. The same SQL runs fine directly on the DB, so look in the API logs. D1 and D2 may share a cause. |
| D3 | `/org/geckoprogrammes/mcp` (and `/automation` redirect) | Page returns 500 "Something unexpected occurred". |
| D4 | `/org/geckoprogrammes/settings/landingpage` | Page returns 500 (its `/edit` sub-route renders, but shows upstream placeholder text "Become a Certified AI Engineer"). |
| D5 | `/org/geckoprogrammes/media` | `GET /proxy/organization/assets/grouped` returns 400 `ORG_ID_REQUIRED` (cio-org-id header missing); page renders but media list errors. |
| D6 | many admin pages | CSP `img-src` blocks `api.dicebear.com` (course cards), `cdn4.iconfinder.com` (settings), `pgrest.classroomio.com` (quiz) - cosmetic console errors, avatars/placeholders missing. Inherited from Pearl. |
| D7 | `/courses/[id]/exercises/[exerciseId]` | Unknown id renders an empty editor (not a 404) and every navigation away raises an "unsaved changes" confirm dialog. Stock upstream quirk (K7). |
| D8 | manager1 password | No UI path to set a password for a Manager while email is off (see Setup notes). |
| D9 | `/caseload/courses/[id]/submissions?...` (tutor1) | **LOW (UI / read-only).** tutor1 is on the course team (course->tutor assignment = Moodle course-teacher), so `resolveRoster` (`apps/api/src/services/caseload/course-view.ts`) lists EVERY enrolled learner, including learner3 (allocated to tutor2) and unallocated learner4. PROVEN with a real learner3 submission (stage 3): tutor1 CAN see learner3's name, email, status, timestamps and file NAME, and the Grade button is ENABLED and opens the drawer; but `POST /proxy/course/.../coursework/download` returns **403** and `POST /proxy/caseload/submissions/{id}/result` returns **403** `Only an allocated tutor or an admin can record a result`. No tutor1 result exists in `coursework_result`. tutor2 (allocated, not course team) graded learner3 Pass (201) and sees only learner3. Inherited from Pearl (no diff vs 883c4a62). **Owner decision 2026-10-28 (6a): accepted as-is** (matches Pearl; server blocks download + grading). **Superseded the same day:** owner had Pearl fix `ad92abcf5` ported (branch `fix/tutor-allocation-only`, `6d95ad30`) — once deployed, the roster shows allocated learners only; re-verify then. |

D1/D2/D5 are the real functional ones; D3/D4 are admin-only hidden pages.

**Triage (2026-10-28):** `git diff 883c4a62 HEAD` over `packages/db/src/queries`, `apps/api/src/routes`, `apps/api/src/services` and the affected dashboard routes shows branding/email-text changes only — D1–D9 are inherited from Pearl and carried as-is (owner decision D11). API log for D2 shows drizzle `Failed query` on `getOrganizationTeam` (underlying pg error not logged). **D8 launch note:** until email is on, a real Manager can only get a password via a direct DB update (as done for `manager1` with owner approval, 5a).

## 8.1 Auth & public (anonymous) - 21 rows: 20 ✅, 0 ❌, 1 ⏸

- ✅ `/login` (renders, branded; 2 inherited CSP console errors, login works)
- ✅ `/logout` (-> `/login`)
- ✅ `/forgot` (submits, "Email Sent!" shown, no API error)
- ⏸ `/forgot` email arrival - DEFERRED (email off)
- ✅ `/reset` (no token -> "Invalid Token" state)
- ✅ `/signup` (tokenless -> `/login?redirect=/register`)
- ✅ `/register` (K2: bounces to `/login?redirect=%2Fregister` as expected)
- ✅ `/register/thanks` (anonymous -> login redirect)
- ✅ `/onboarding` (anonymous -> login redirect)
- ✅ `/verify-email-error` (renders, branded)
- ✅ `/auth-failed` (renders "Something went wrong")
- ✅ `/invite/[hash]` (bad hash -> branded 404 page)
- ✅ `/invite/link/[hash]` (bad hash -> branded 404 page)
- ✅ `/404` (branded not-found page; unknown paths go to login when anonymous)
- ✅ `/courses` (public catalogue; GECKO TEST listed)
- ✅ `/course/[slug]` (GECKO TEST detail, 3 lessons, Enroll Now)
- ✅ `/course/[slug]/enroll` (Join Course form renders)
- ✅ `/course/[slug]/lesson/[itemSlug]` (404 for a self-paced course = expected; only Public-type courses expose lessons)
- ✅ `/csp-report` (GET 405, POST 204)
- ✅ `/` (anonymous -> `/login?redirect=%2F`)
- ✅ `/change-password` (forced on first login: worked for admin2; anonymous -> login)
- ✅ `/proxy/health` (`{"status":"ok"}`) - extra

## 8.2 Admin - 78 rows: 70 ✅, 7 ❌, 1 ⬜

**Shell**
- ✅ Admin sidebar matches the nav map (Dashboard, Reports x7, Courses, Media, Community, Learners, Tutor Mgmt, Admin Mgmt, Progressions, Broadcasts, Settings x4)
- ✅ Org name/branding (Gecko Programmes, "Powered by Gecko Programmes")
- N/A Org switcher (single org). Broadcast banner covered by 8.6 step 6; notifications bell contents not separately inspected

**Visible in nav**
- ✅ `/dash` (KPIs render)
- ✅ Reports: `/reports/learners` · `/reports/courses` · `/reports/marking` · `/reports/completions` · `/reports/referrals` · `/reports/tutor-feedback` · `/reports/activity-log`
- ✅ `/courses` (cover images blocked by CSP, D6) · Create Course flow works
- ❌ `/media` (D5)
- ✅ `/community` · `/community/ask` · `/community/[cslug]` (unknown slug -> 400 handled, back to courses)
- ✅ `/learners` (3 learners, tutor column correct, New Learner / Reset Password / Login As present) · New Learner works x3
- ✅ `/tutors` (tutor1, tutor2)
- ✅ `/admins` (admin2 + protected Super Admin)
- ✅ `/progression` (3 learners, 0 / 2 workbooks, 0 / 1 case studies)
- ✅ `/broadcasts` (renders)
- ✅ Settings: `/settings` (profile) · `/settings/notifications` · `/settings/org` · `/settings/domains` · `/settings/customize-lms` · `/settings/auth` · `/settings/auth/sso` · `/settings/auth/token-auth`
- ❌ `/settings/teams` (D2)

**Hidden (URL-only)**
- ✅ `/org/geckoprogrammes` root (Home) · `/home` and `/welcome` (-> dash) · `/cohorts` · `/cohorts/[id]` (unknown id -> branded 404) · `/tags` · `/widgets` · `/widgets/[widgetId]` (unknown -> handled 404 from API) · `/widget-preview` · `/audience` · `/audience/import` · `/audience/[...params]` · `/allocation` · `/api` · `/zapier` · `/analytics` · `/compliance` · `/teams-overview` · `/quiz` · `/quiz/[slug]` (CSP image noise, D6) · `/setup`
- ✅ `/org/geckoprogrammes/users` page renders and Create user works (created manager1) - list is ❌ D1
- ❌ `/users` list (D1)
- ❌ `/mcp` and `/automation` redirect (D3)
- ✅ `/settings/billing` · `/settings/ai-credits` · `/settings/ai-tutor` · `/settings/integrations` · `/settings/workspaces` · `/settings/landingpage/edit`
- ❌ `/settings/landingpage` (D4)
- ✅ `/registrations` (renders, 0 pending; approve flow = 8.6 step 5)
- ✅ `/announcements` (admin is redirected to dash - K6 is a manager/tutor gate)
- ✅ `/messages` · `/messages/[threadId]` (unknown id -> handled 404) · `/caseload` (admin sees "Welcome back")
- ✅ Cohort sub-routes: stage 3 created cohort "GECKO TEST COHORT" (+ course GECKO TEST, + learner1 via Invite > Add Students > Grant Access; DB `cohort_member` confirmed) and walked `/cohorts/[id]/newsfeed|courses|people|settings`: all render, no 4xx/5xx. NB the real paths are `/cohorts/[id]/...` (NOT under `/org/geckoprogrammes/`; the org-prefixed form 404s, which is what the stage-1 "unknown id -> 404" row actually hit). Cohort left in place (test data).

**Course workspace (GECKO TEST)**
- ✅ `/courses/[id]` (news feed) · `lessons` · `lessons/[lessonId]` x3 (editor; PDF brief upload works for all 3 kinds; due date + allowDrafts persisted in `lesson.documents`) · `settings` (publish works) · `people` (tutor1 added to course team) · `people/[personId]` · `analytics` · `submissions` · `marks` · `attendance` · `compliance` · `certificates` · `certificates/editor` · `landingpage` · `ai-tutor`
- ❌ `exercises/[exerciseId]` (D7: renders an empty editor for an unknown id + "unsaved changes" prompt; no real exercise created because exercises are not in the coursework loop, K7)

## 8.3 Manager (`manager1`) - 4 rows: 4 ✅, 0 ❌, 0 ⏸

- ✅ Lands on `/reports` (bare learner-progress table, no sidebar/header, K6; "Registrations →" link present)
- ✅ `/registrations` via its link (renders, 0 pending)
- ✅ `/org/geckoprogrammes`, `/org/geckoprogrammes/settings` -> 403 (also `/caseload` 403, `/dash` 404)
- ✅ `/announcements` -> NOT a 403: bounces to `/reports` (200). Differs from the K6 wording, harmless; route guard is `requireManagerOrAdmin`, code identical to 883c4a62 (branding-only diff), so inherited.

## 8.4 Tutor (`tutor1`, `tutor2`) - 11 rows: 10 ✅, 1 ❌ (D9, low), 0 ⏸

- ✅ `/caseload` (Your Learners = 2: learner1+learner2; learner3 absent). tutor2 sees only learner3.
- ✅ `/caseload/[learnerId]`: learner1/2 open (ID-verification, per-unit history with feedback); learner3 for tutor1 -> "Learner not found." (HTTP 200, not 403 - isolation holds, wording differs from plan); learner1 for tutor2 -> same. Branding-only diff vs 883c4a62.
- ✅ `/caseload/courses` · `/caseload/courses/[courseId]` · `.../units/[lessonId]` (3 units, assessment counts, View submissions / Download brief)
- ✅ `/caseload/courses/[courseId]/submissions?lessonId=&assessmentKey=` grading drawer: Pass / Refer + feedback text saved (Refer then Pass both worked, grade history shows entries). Feedback file attach: ✅ stage 3 (tutor1 attached a PDF to a Refer on learner1 Unit 3: `feedback/presign` 200 + result 201; learner1 sees it under "Tutor feedback" and downloads it: `coursework/download` 200, signed URL returns the 193 B PDF).
- ❌ D9 (same page, LOW): roster lists non-allocated learners to a course-team tutor and shows an enabled Grade button; a real learner3 submission is proven NOT downloadable (403) and NOT gradeable (403) by tutor1; tutor2 can grade it. See the D9 row.
- ✅ `/caseload/messages` (empty state) · `/caseload/progression` (learner1 67% / Unit 3, 1/2 workbooks, 1/1 case study; learner2 Created 0%; learner3 absent)
- ✅ `/courses/[id]/lessons/[lessonId]` read-only content view (Attachments, no editor controls)
- ✅ `/org/*` -> 403; `/reports` 403; `/dash` 404; `/lms` 200 (own empty learner dash)
- ✅ Tutor isolation both ways (tutor2 <-> learner1)

## 8.5 Learner (`learner1`) - 11 rows: 11 ✅, 0 ❌, 0 ⏸

- ✅ `/lms` (dashboard: progress, next due, My Tutor, tutor-feedback popup at 2 passed units - popup submitted OK; re-confirmed in stage 3 on learner3: popup "How is tutor2 doing?" appeared right after the 2nd Pass, was submitted, did not reappear, and shows in admin2 `/org/geckoprogrammes/reports/tutor-feedback` (2 responses, 4.5 avg))
- ✅ `/lms/mylearning` · `/lms/exercises` (To do 3, then updated)
- ✅ course -> unit 1: save draft (v1 Draft "Awaiting draft feedback") -> reload shows it -> upload final file -> Submit final (v2 "Awaiting marking")
- ✅ tutor feedback visible ("Tutor feedback ..." under the Refer) -> resubmit v3 -> Pass
- ✅ `/lms/settings` (-> notifications) · `/lms/settings/notifications` · `/lms/settings/integrations` (-> notifications)
- ✅ hidden: `/lms/certificates` · `/lms/cohorts` · `/lms/community` (+ `ask`, `[slug]`) · `/lms/explore` all redirect to `/lms` (hidden by design)
- ✅ `/messages` (thread with tutor1, empty state)
- ✅ `/org/*` -> 403 (also `/caseload`, `/reports`, `/registrations` 403)
- ✅ Unit 2 (case study, drafts off): only Final offered, due 31/12/2026 shown, submit OK

## 8.6 End-to-end flows - 14 rows: 11 ✅, 0 ❌, 3 ⏸ (plus 1 note)

- ✅ Step 1 (admin builds course + coursework + tutor + allocation) - stage 1
- ✅ Step 2 learner draft -> reopen -> upload -> submit (verified in 8.5)
- ⏸ Step 2 tutor "submission created" email - DEFERRED (email off)
- ✅ Step 3 tutor Refer with feedback -> learner sees it -> resubmit -> tutor Pass (unit 1; unit 2 Pass too)
- ⏸ Step 3 learner Refer/Pass emails - DEFERRED (email off)
- ✅ Step 4 progression: after unit-1 Pass learner1 = 33%, 2 passed = 67% / "Unit 3 of 3"; tutor progression matches
- ✅ Step 4 reports as admin2 (`/org/geckoprogrammes/reports/...`; NB `/reports/*` is 404 for admins, it is the manager/tutor-less shell): Learners (avg 22%, workbooks 1/6, case studies 1/3, 51-75% bucket 1), Courses (3 enrolled), Marking (3 graded: 2 Pass 1 Refer, tutor1 pass rate 67%), Completions (0, correct: no course finished), Tutor feedback (1 response, 4/5, learner1 -> tutor1, unit 2). Activity log renders (see O2).
- ✅ Step 5 `/register` anonymous -> `/login?redirect=%2Fregister` (K2 as expected); `/register/thanks`, `/signup` likewise
- ✅ Step 5 admin approval: stage 3 - pending `learner4@gecko-test.invalid` (submitted via POST /proxy/register, K2 workaround) listed at `/registrations` (route is `/registrations`, not under /org/geckoprogrammes), course picked, Approve -> "Application approved"; DB: registration `approved` + decided_by set, `user` + `organizationmember` (role 3) + `groupmember` (GECKO TEST, student) created. Tutor allocation is NOT offered on this screen (learner shows "Unassigned" until set on Learners).
- ✅ Step 5 password via admin Learners > Reset Password (forgot email is off): temp password shown once -> learner4 logs in -> forced `/change-password` -> `/lms` shows 1 enrolled course, 3 units remaining. (Forgot-password email itself stays DEFERRED, see 8.1.)
- ✅ Step 6 broadcast (All learners) published as admin2 -> banner on learner1 `/lms` -> "Dismiss announcement" -> gone after reload (persisted; the broadcast text still appears in the dashboard announcements list)
- ✅ Step 7 upload ~20 MB PDF (20,971,721 B) via lesson editor `?mode=edit` -> presign 200, S3 PUT 200 (~2 min through the browser), listed "gecko-20mb.pdf 20 MB"
- ✅ Step 7 small MP4 (3 s, 43 KB) via Add/Edit Video(s) -> Upload: presign 200, PUT 200, "Queued for processing... Done"
- ✅ Step 7 cleanup (stage 3): 20 MB PDF deleted via the lesson editor Docs tab (Delete > Yes) and the MP4 via Video tab > Video options > Remove video; `lesson.documents` now only `gecko-assignment.pdf`, `lesson.videos` empty. **The storage objects REMAIN** (UI delete only unlinks): `documents/materials/60373bd9-.../40OmTdASTRXenMCkdOlvW-gecko-20mb.pdf` (20,971,721 B), `videos/qlcpDA5p1z-cY-iVb1wrE-gecko-test.mp4` (43,149 B), `media/3lqU9mQyazXg0zb56KU1C-gecko-test-thumbnail.jpg` - orphans (O5); remove from the Supabase dashboard if wanted.

## Observations (not counted as defects)

- O1 Login throttle: after ~12 logins from one IP in ~35 min, `/login` returned "Too many requests. Please try again later." for ~25 min (admin2 blocked, then recovered). Inherited behaviour; relevant to testing, not users.
- O2 Activity log (24 h) shows only `client.error` rows ("Failed to fetch" at `/login`, probably aborted fetches from scripted navigations; one `intl ... "students" was not provided` at `/settings/workspaces`) and no `auth.login.success` rows despite many logins; failed-login count 0.
- O3 Lesson-editor upload dialog says "Maximum size: 5MB (up to 52 MB)" while a 20 MB file uploads fine (wording only).
- O5 Deleting a lesson document/video in the editor does not delete the storage object (orphans accumulate; inherited behaviour).
- O6 Cohort `settings` page opens with an "Unsaved changes" bar before any edit (cosmetic). A registered learner's display name is the email local part ("learner4"), not the submitted "Registrant Four".
- O4 Test passwords for manager1/tutor1/tutor2/learner1-3 were rotated on first login; `final` lines appended to the accounts TSV (outside repo).

## 8.7 Email templates - 29 templates

- ✅ 29/29 templates rendered locally: Gecko branding, all links `gecko.epearlacademy.com`, From = `Gecko Programmes <no-reply@gecko.epearlacademy.com>`
- ⏸ Live delivery - DEFERRED (email off in prod)
- Note: Reply-To falls back to `no-reply@gecko-programmes.invalid` until `SMTP_REPLY_TO` is set.

## Stage 3 note (2026-10-28)

Run as admin2/tutor1/tutor2/learner1/learner3/learner4, each logged in once in its own browser context. Test data created (all `@gecko-test.invalid` / GECKO TEST): learner4 (via registration), cohort GECKO TEST COHORT (course + learner1), learner3 submissions on Unit 1 (Pass by tutor2) and Unit 2 (Pass, plus tutor-feedback response), learner1 Unit 3 v1 (Refer with feedback file by tutor1). learner3's stored final password was rejected at login (cause unknown, single occurrence), so it was rotated via admin Reset Password; new `final` lines for learner3/learner4 are in the accounts TSV (outside repo). No code changes, nothing committed.

## Phase 10 cleanup (2026-10-28)

All Phase 8 test data was removed with owner approval (7a): the 8 `@gecko-test.invalid` accounts, GECKO TEST course, GECKO TEST COHORT and all dependent rows (one DB transaction, rehearsed with rollback first), plus the 17 test files in storage. Remaining: owner account, organisation + plan, seed tables, `media/og/geckoprogrammes.png`. Activity logs from the test day were kept. The rows above describe the state during testing.

**Owner sign-off:** ☐ _(name / date)_
