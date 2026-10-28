# Gecko Programmes — items waiting on owner decisions

Phase 2 rebrand (2026-10-27) left these for when the **domain (`{{GECKO_DOMAIN}}` / `{{APP_DOMAIN}}`),
logo set and sender email** are decided (REPLICATION.md Q2). Owner rule 4a: dead ClassroomIO links on
hidden screens were removed; visible text without a Gecko equivalent was made neutral. Nothing here
blocks a local build. Inherited vendor-hosted assets (ClassroomIO CDN) are carried as-is (D11) until
self-hosted copies exist.

## Dashboard / UI / utils
- packages/utils/src/constants/domains.ts:6 — TENANT_ROOT_DOMAIN 'myclassroomio.com' (tenant sites, used by add-org-modal, domains settings, visit-org-site-btn, store/org.ts) — needs Gecko tenant root domain
- packages/utils/src/constants/domains.ts:9 — BRAND_ROOT_DOMAIN 'classroomio.com' (getAppOrigin on non-selfhosted) — needs Gecko app/brand domain
- packages/utils/src/constants/embeds.ts:1 — EMBED_PUBLIC_HOST 'embed.classroomio.com' — needs Gecko embed host (or leave if widgets stay off)
- packages/utils/src/openapi/public-api.ts:2 — PUBLIC_API_OPENAPI_URL api.cdn.clsrio.com (used by apps/api upload-openapi-spec.ts) — needs Gecko CDN/bucket URL
- packages/utils/src/openapi/public-api.ts:1 — PUBLIC_API_BASE_URL now 'https://<your-api-url>/public-api/v1' (hidden API screen snippets) — needs real Gecko API URL
- apps/dashboard/src/lib/features/automation/utils/automation-utils.ts:7,104,118,129,147 — MCP package now '<mcp-server-package>', API URL '<your-api-url>' — needs Gecko MCP npm package name + API URL (env var names CLASSROOMIO_API_* kept)
- apps/dashboard/src/lib/features/settings/{components/auth-token-auth.svelte:56,pages/token-auth.svelte:48} — baseUrl example 'https://<your-api-host>' — needs Gecko API host
- apps/dashboard/src/lib/features/ui/sidebar/footer/menu.svelte — removed Documentation + "Need help" (help@classroomio.com) items — needs Gecko docs URL + support email to restore
- apps/dashboard/src/routes/+page.svelte:82, +error.svelte:54, 404/+page.svelte:11 — removed "Contact Us"/"Try Free Tools" buttons, Go Home now '/' — needs Gecko contact URL if wanted
- apps/dashboard/src/routes/(auth)/verify-email-error/+page.svelte — removed Contact Support (mailto help@classroomio.com) button — needs Gecko support email
- apps/dashboard/src/routes/(app)/org/[slug]/api/+page.svelte:29 — removed API docs button — needs Gecko API docs URL
- apps/dashboard/src/lib/features/course/pages/settings.svelte:551 — removed course-types "learn more" link — needs Gecko docs URL
- apps/dashboard/src/lib/features/ui/upgrade-modal.svelte:85 — removed "Learn more" button (early-adopter blog) — needs URL or leave removed
- apps/dashboard/src/lib/features/settings/pages/integrations.svelte:59 — removed Telegram bot button (t.me/classroomio_bot) — needs Gecko bot handle
- apps/dashboard/src/lib/features/org/components/quiz/play/connect-to-play.svelte:40 — text 'your Gecko Programmes quiz play page' — needs Gecko quiz-play domain
- apps/dashboard/src/routes/(auth)/onboarding/+page.svelte:102 — DomainInput suffix now '' — needs Gecko tenant domain suffix
- apps/dashboard/src/routes/(org-site)/course/[slug]/{+page.server.ts:88,lesson/[itemSlug]/+page.server.ts:61} — removed twitter handle/site '@classroomio' — needs Gecko Twitter/X handle
- apps/dashboard/src/lib/utils/functions/org-site-og-url.ts:92 — removed cloud fallback api.classroomio.com (returns null) — needs Gecko API origin if non-selfhosted ever used
- apps/dashboard/src/lib/features/ui/powered-by.svelte:48, packages/ui/src/custom/{public-course/powered-by.svelte,simple-logo-nav}: vendor links now '/' — needs Gecko marketing URL
- apps/dashboard/src/lib/features/app/layout-setup.ts:103 — notCustomDomainHosts still lists classroomio.com, myclassroomio.com — needs Gecko hosts (leave/prune)
- apps/dashboard/src/lib/utils/csp-domains.js:7-32 — CSP allows classroomio.com, clsrio.com, pgrest.classroomio.com, embed/play/app/api hosts — prune once assets self-hosted
- apps/dashboard/src/lib/utils/constants/quiz.ts (16 URLs pgrest.classroomio.com) — vendor-hosted quiz SVGs — needs self-hosted copies (Gecko Supabase/static)
- apps/dashboard/src/lib/features/widget/utils/layout-thumbnail.ts:4, settings/pages/landingpage.svelte:52, course/components/view-as-student-modal.svelte:50 (assets.cdn.clsrio.com) — vendor CDN images — needs self-hosted copies
- apps/dashboard/src/lib/utils/functions/org-site-og-url.ts:3 — DEFAULT_CLOUD_MEDIA_CDN_URL img.cdn.clsrio.com — needs Gecko media CDN
- '/images/classroomio-course-img-template.jpg' (user-analytics, course-list-row, settings, learning, customize-lms, packages/ui course-card/constants.ts) — static filename in apps/dashboard/static (other agent); rename file + refs together
- packages/ui/src/custom/simple-logo-nav/simple-logo-nav.svelte — tagline "One Platform for Customer, Partner, and Employee Training" is upstream marketing copy; reword if desired
- locales: custom_domain_not_classroomio value still says 'classroomio' (matches the validation rule in domains.svelte, which now checks Gecko constants)

## Email / API / jobs / db
- packages/email/src/utils/constants.ts:38-39 — default From/Reply-To are no-reply@gecko-programmes.invalid — needs real sender domain (or set SMTP_SENDER / SMTP_REPLY_TO env)
- packages/email/src/templates/default.ts (buildMasthead fallback) — text-only "Gecko Programmes" masthead — needs Gecko logo URL if wanted; footer has no links — needs real site/terms/privacy URLs if wanted
- packages/email/src/emails/welcome.ts — demo CTA button removed (was classroomio.com/demo); forgot-password.ts support-address sentence removed — needs a real support email/booking URL
- apps/api/src/services/org/og.ts:12 — DEFAULT_OG_IMAGE still brand.cdn.clsrio.com — needs Gecko OG image URL
- apps/api/src/services/widget-payload.ts:21 — DEFAULT_WIDGET_APP_BASE_URL https://classroomio.com — needs real app base URL
- apps/api/src/constants/index.ts:9, packages/db/src/constants.ts:12-13 — CORS/trusted-origin wildcards *.classroomio.com / *.myclassroomio.com — needs real tenant root domain
- packages/db/src/utils/seed/exerciseTemplate.ts:5 — exercise templates fetched from assets.cdn.clsrio.com — needs self-hosted JSON copy
- apps/dashboard/.env.example:18,41,47-48 — clsrio.com CDN examples and PRIVATE_APP_HOST=classroomio.com — needs real domain
- apps/api/src/services/org/domain.ts:204 — blocks custom domains containing classroomio — keep or replace with real domain

## Static assets
- Part D: logo*.svg/png, favicon.ico, opengraph PNGs are neutral 'GP'/'Gecko Programmes' placeholders (#1D4EE2). Replace with real logo when decided; regenerate at the same sizes (logo-512.png = 1024x1024 RGBA; favicon.ico 16/32/48).
- apps/dashboard/static/certificate-template.png — shows a "Classroomio" wordmark bottom-left (certificate-template.svg embeds PNGs, unverified). Certificates are hidden (CERTIFICATES_ENABLED=false); replace art before enabling.
- Not deployed but brand-bearing: packages/db/src/scripts/notify-students-over-limit.ts:53 (upgrade link), apps/api/scripts/upload-openapi-spec.{js,ts} (API server URLs) — one-off scripts, edit if ever run.

## Ported Pearl fixes

- ✅ Pearl `ad92abcf5` "fix(access): tutors see only their allocated learners on every surface" ported on branch `fix/tutor-allocation-only` (commit `6d95ad30`, 2026-10-28) — logic identical to Pearl, Gecko branding kept; awaiting owner push/merge + deploy.
- After deploy: re-check D9 (`docs/GECKO-ACCEPTANCE.md`) — a course-team tutor should no longer see non-allocated learners on `/caseload/courses/[id]/submissions`.
