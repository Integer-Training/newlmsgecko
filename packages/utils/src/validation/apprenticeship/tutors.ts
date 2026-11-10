import * as z from 'zod';

// Gecko Apprenticeships — programme tutors (assignment like a course's tutors) and an apprentice's named tutors.

export const ZTutorIdParam = z.object({ tutorId: z.uuid() });

export const ZTutorProgrammesPut = z.object({
  programmeIds: z
    .array(z.uuid())
    .max(500)
    .transform((ids) => [...new Set(ids)])
});
export type TutorProgrammesPutInput = z.infer<typeof ZTutorProgrammesPut>;

export const ZEnrolmentTutorParam = z.object({ id: z.uuid(), tutorId: z.uuid() });

export const ZEnrolmentTutorAdd = z.object({ tutorId: z.uuid() });
export type EnrolmentTutorAddInput = z.infer<typeof ZEnrolmentTutorAdd>;
