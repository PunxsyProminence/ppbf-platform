import { redirect } from 'next/navigation';

/* Medical Restrictions is a section of Athlete Safety now (S2-3 "A: One job
   page"; lane AS-5). The old address, bookmarks included, opens that section.
   The target page keeps the gate this page had (coach and admin). */
export default function MedicalRestrictionsAddress() {
  redirect('/coach/athlete-safety#medical-restrictions');
}
