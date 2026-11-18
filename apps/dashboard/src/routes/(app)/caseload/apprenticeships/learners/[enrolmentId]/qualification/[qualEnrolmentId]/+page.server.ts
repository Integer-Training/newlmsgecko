import { requireStaff } from '$lib/server/guards';

// A learner's qualification page in the tutor caseload shell. ADMIN or TUTOR only; the apprenticeship API scopes a
// tutor to their allocated learners (anything else is a 404).
export const load = async ({ locals }) => {
  requireStaff(locals);
  return {};
};
