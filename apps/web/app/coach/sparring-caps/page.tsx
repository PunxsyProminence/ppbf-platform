import { redirect } from 'next/navigation';

/* Sparring Caps is a section of Sparring and Limits now (S2-3 "A: One job
   page"; lane AS-5, #2010 Q4-Q6). The old address, bookmarks included, opens
   that section. The target page keeps the gate this page had (coach and admin). */
export default function SparringCapsAddress() {
  redirect('/coach/sparring-exposure#sparring-caps');
}
