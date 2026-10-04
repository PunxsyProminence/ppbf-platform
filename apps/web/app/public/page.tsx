import { permanentRedirect } from 'next/navigation';

/* One front page (Jason, 2026-10-03: "home page and public is the same
   page"). /public's interest form, programs and FAQ now live on /, and this
   address forwards there permanently so old links and bookmarks still land. */
export default function PublicPage(): never {
  permanentRedirect('/');
}
