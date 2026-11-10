import { classroomio } from '$lib/utils/services/api';
import { call } from './call';

// Gecko Apprenticeships — client for programme tutors (Tutor Management › Apprenticeships) and an apprentice's named
// tutors (portfolio). Shapes mirror apps/api/src/services/apprenticeship/tutors.ts.

export interface TutorProgrammes {
  assignedProgrammeIds: string[];
  programmes: { id: string; title: string; status: string }[];
}

export interface TutorRef {
  id: string;
  name: string;
}

export interface EnrolmentTutors {
  /** Tutor of record (alerts, review sign-off). */
  named: TutorRef[];
  /** Assigned to the whole programme (see + mark, no alerts). */
  programme: TutorRef[];
}

class ApprTutorsApi {
  tutorProgrammes(tutorId: string) {
    return call<TutorProgrammes>(() =>
      classroomio.apprenticeship.tutors[':tutorId'].programmes.$get({ param: { tutorId } })
    );
  }

  setTutorProgrammes(tutorId: string, programmeIds: string[]) {
    return call<TutorProgrammes>(() =>
      classroomio.apprenticeship.tutors[':tutorId'].programmes.$put({ param: { tutorId }, json: { programmeIds } })
    );
  }

  enrolmentTutors(enrolmentId: string) {
    return call<EnrolmentTutors>(() =>
      classroomio.apprenticeship.enrolments[':id'].tutors.$get({ param: { id: enrolmentId } })
    );
  }

  addNamed(enrolmentId: string, tutorId: string) {
    return call<EnrolmentTutors>(() =>
      classroomio.apprenticeship.enrolments[':id'].tutors.$post({ param: { id: enrolmentId }, json: { tutorId } })
    );
  }

  removeNamed(enrolmentId: string, tutorId: string) {
    return call<EnrolmentTutors>(() =>
      classroomio.apprenticeship.enrolments[':id'].tutors[':tutorId'].$delete({ param: { id: enrolmentId, tutorId } })
    );
  }
}

export const apprTutorsApi = new ApprTutorsApi();
