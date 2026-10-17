import { permanentRedirect } from 'next/navigation';

/* One parent front door (UX audit A-10). /guardian was a second landing named
   "Guardian Portal" that showed no records; the Parent Hub is where a parent
   sees their child. This address forwards there permanently so old links and
   bookmarks still land, and it has no catalog door of its own. */
export default function GuardianPage(): never {
  permanentRedirect('/parent/dashboard');
}
