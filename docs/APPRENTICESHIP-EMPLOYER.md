# Gecko Apprenticeships — Employer access (design only, not built)

Status: **documented 2026-11-09, not implemented** (owner decision 4a: "nothing for now, write it down"). Until this is
built, staff record the employer's review signature and comments on the employer's behalf (name + time + who recorded
it, `appr_review.employer_recorded_by`), and witness testimonies are added by staff as evidence of type "Witness
Testimony".

## What employers need

1. **Sign progress reviews** (read the review, add a comment, sign with name).
2. **Give witness testimony** against criteria (short statement, optional file).
3. **See their apprentices' progress** (status, % done vs expected, off-the-job hours, upcoming review, gateway readiness).
4. **Gateway sign-off** (the "employer sign-off" item on the gateway checklist).

## Option A — secure one-time links (recommended first step)

- Staff click "Send to employer" on a review / testimony request / gateway item → Gecko creates a signed, single-use
  link that expires (e.g. 14 days), tied to one record and one action.
- Employer opens the link (no account), sees only that record, signs / writes the testimony, submits. The link is then
  spent; the record shows "Signed by <name> via employer link on <date>".
- While email is off, staff copy the link and send it themselves; once email is on, Gecko sends it.
- **Data:** `appr_employer` (org, name, company, email, phone), `appr_enrolment.employer_id`, `appr_employer_link`
  (token hash, purpose REVIEW_SIGN | TESTIMONY | GATEWAY_SIGNOFF, record id, expires_at, used_at, created_by).
- **Security:** token stored hashed; one record, one action; rate-limited; no portfolio browsing; audit every use;
  links revocable; IP/user agent logged on use.
- **No change to Gecko's role system** (diplomas untouched).

## Option B — full Employer login role (later, if needed)

- New org role EMPLOYER (alongside Admin / Manager / Tutor / Learner), linked to apprentices via `appr_employer_link`
  table (employer ↔ learner), dashboard with their apprentices, read-only portfolios, review signing, testimonies.
- Touches the shared role system (`packages/utils/src/constants/roles.ts`, Actor, guards, navigation) used by the
  diploma flow too → needs its own WHAT/WHY/IMPACT approval and a full access-control test pass.

## Open questions for the owner (when this is picked up)

1. One employer contact per apprentice, or several (line manager + HR)?
2. Must the employer sign every review, or can a review complete without it (e.g. "employer unavailable" with reason)?
3. Should employers see evidence files, or progress only?
4. Link expiry (7 / 14 / 30 days)?
