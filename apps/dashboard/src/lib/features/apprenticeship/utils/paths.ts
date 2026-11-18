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

export interface WorkspaceTab {
  key: string;
  label: string;
  href: string;
  /** Pathname test for the active tab (query ignored). */
  isActive: (pathname: string) => boolean;
  /** Show the to-mark count badge on this tab. */
  badge?: 'toMark';
}

const stripSlash = (p: string) => p.replace(/\/+$/, '');
const under = (pathname: string, href: string) => {
  const p = stripSlash(pathname);
  return p === href || p.startsWith(`${href}/`);
};

function tab(base: string, key: string, label: string, sub: string, badge?: 'toMark'): WorkspaceTab {
  const href = `${base}/${sub}`;
  return { key, label, href, badge, isActive: (p) => under(p, href) };
}

function learnersTab(base: string): WorkspaceTab {
  return {
    key: 'learners',
    label: 'Learners',
    href: base,
    isActive: (p) => stripSlash(p) === base || under(p, `${base}/learners`)
  };
}

/** Admin workspace tabs (/org/{site}/apprenticeships). */
export function adminWorkspaceTabs(base: string): WorkspaceTab[] {
  return [
    tab(base, 'summary', 'Overview', 'summary'),
    learnersTab(base),
    tab(base, 'to-mark', 'To mark', 'to-mark', 'toMark'),
    tab(base, 'task-plans', 'Task plans', 'task-plans'),
    tab(base, 'iqa', 'Quality (IQA)', 'iqa'),
    tab(base, 'programmes', 'Programmes', 'programmes'),
    tab(base, 'settings', 'Settings', 'settings')
  ];
}

/** Tutor workspace tabs (/caseload/apprenticeships). */
export function tutorWorkspaceTabs(base: string): WorkspaceTab[] {
  return [
    learnersTab(base),
    tab(base, 'summary', 'Overview', 'summary'),
    tab(base, 'to-mark', 'To mark', 'to-mark', 'toMark'),
    tab(base, 'iqa', 'IQA feedback', 'iqa')
  ];
}
