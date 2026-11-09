import { requireStaff } from '$lib/server/guards';

// Gecko Apprenticeships in the tutor caseload shell (Phase B). ADMIN or TUTOR only; the apprenticeship API scopes a
// tutor to their allocated learners (anything else is a 404).
export const load = async ({ locals }) => {
  requireStaff(locals);
  return {};
};
