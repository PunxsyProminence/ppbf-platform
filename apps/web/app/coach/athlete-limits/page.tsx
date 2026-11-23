import { redirect } from 'next/navigation';

/* Athlete Limits is a section of Sparring and Limits now (S2-3 "A: One job
   page"; lane AS-5, #2010 Q4-Q6). The old address, bookmarks included, opens
   that section. The target page keeps the gate this page had (coach and admin). */
export default function AthleteLimitsAddress() {
  redirect('/coach/sparring-exposure#athlete-limits');
}
