/* Interest-form option lists, in a plain (non-client) module so the server-
   rendered front page can read the labels too: a server component cannot
   index into an export of a 'use client' module. */

// The option lists are wire values, not copy: each is submitted as-is and
// re-checked server-side against VISITOR_TYPES / PROGRAM_INTERESTS /
// CONTACT_METHODS in src/server/pilot/publicInterest.ts. Only the labels a
// visitor reads are plain English. The Records are complete so a value added
// to a list fails typecheck until it has a label.
export const visitorTypeOptions = [
  'Athlete / Participant',
  'Parent / Guardian',
  'Volunteer',
  'Coach',
  'Donor / Sponsor',
  'Board / Community Partner',
  'General Visitor',
] as const;
export type VisitorType = (typeof visitorTypeOptions)[number];

export const visitorTypeLabels: Record<VisitorType, string> = {
  'Athlete / Participant': 'I want to train here',
  'Parent / Guardian': 'I am a parent or guardian',
  Volunteer: 'I want to volunteer',
  Coach: 'I want to coach',
  'Donor / Sponsor': 'I want to donate or sponsor',
  'Board / Community Partner': 'I am here about a partnership',
  'General Visitor': 'I am just looking around',
};

export const programInterestOptions = [
  'Boxing / Fitness',
  'Youth Development',
  'Adaptive Training',
  'Competition Track',
  'Parent Support',
  'Volunteer Support',
  'Sponsorship / Partnership',
  'General Information',
] as const;
export type ProgramInterest = (typeof programInterestOptions)[number];

export const programInterestLabels: Record<ProgramInterest, string> = {
  'Boxing / Fitness': 'Boxing or fitness training (fitness only is fine)',
  'Youth Development': 'Youth boxing and mentorship (under 18)',
  'Adaptive Training': 'Adaptive training (injury, disability, long time off)',
  'Competition Track': 'Competing as an amateur boxer',
  'Parent Support': 'Questions from a parent or guardian',
  'Volunteer Support': 'Volunteering',
  'Sponsorship / Partnership': 'Sponsorship or partnership',
  'General Information': 'Something else -- I just have a question',
};

export const contactMethodOptions = ['Email', 'Phone', 'Either'] as const;
export type ContactMethod = (typeof contactMethodOptions)[number];

export const contactMethodLabels: Record<ContactMethod, string> = {
  Email: 'Email me',
  Phone: 'Call or text me',
  Either: 'Either is fine',
};
