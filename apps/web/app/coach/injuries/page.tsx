import { redirect } from 'next/navigation';

/* Injury Record is a section of Athlete Safety now (S2-3 "A: One job page";
   lane AS-5). The old address, bookmarks included, opens that section. The
   target page keeps the gate this page had (coach and admin). */
export default function InjuryRecordAddress() {
  redirect('/coach/athlete-safety#injury-record');
}
