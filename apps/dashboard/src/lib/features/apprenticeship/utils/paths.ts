/**
 * The apprenticeship screens are shared by the admin area (/org/{site}/apprenticeships) and the tutor caseload
 * shell (/caseload/apprenticeships — Phase B) and, for the apprentice themselves, the learner shell (/lms/apprenticeship —
 * Phase C). Links stay inside whichever shell the user is in; the /org area is admin-only server-side.
 */
export function apprenticeshipsBase(pathname: string, siteName: string | null | undefined): string {
  if (pathname.startsWith('/caseload')) return '/caseload/apprenticeships';
  if (pathname.startsWith('/lms')) return '/lms/apprenticeship';
  return `/org/${siteName}/apprenticeships`;
}
