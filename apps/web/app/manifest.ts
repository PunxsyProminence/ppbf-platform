import type { MetadataRoute } from 'next';

import { getOperatingOrganizationProfileOrNull } from '@/src/server/pilot/organizationProfileStore';

/*
 * THE WEB APP MANIFEST (lane W5-WP, WP-1c; plan and GO on #2228).
 *
 * WHY IT EXISTS. On an iPhone or iPad, web push reaches only a site added to
 * the Home Screen (Next's own guide, node_modules/next/dist/docs/01-app/
 * 02-guides/progressive-web-apps.md: "iOS 16.4+ for applications installed
 * to the home screen"), and a site is added as an app through this file.
 * Push itself is turned on with a tap on /profile (WP-3), never on a device
 * marked as a gym tablet (OW27-17 B).
 *
 * WHAT IT SAYS. The gym's name, from its stored profile, as the root
 * layout's title builds it; the app starts at "/login" and opens on its own,
 * without the browser's bars. "/login" sends a signed-in person straight to
 * their own home (SignInPanel.tsx) and shows anyone else the sign-in form; "/"
 * is the public homepage (QI A on #2228). The icon is the existing seal, app/icon.svg,
 * and nothing else (QF A on #2228: no new image file; a Home Screen icon
 * pass is a later visual item for Jason). No colours are set here: the look
 * is unchanged.
 *
 * READ PER REQUEST, as the layout is: the profile is read from the database,
 * which the image build does not have. If it cannot be read, the name is the
 * layout's own fallback, "Platform", and no gym fact is invented.
 */
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const gym = await getOperatingOrganizationProfileOrNull();
  return {
    // A fixed id, so the installed app keeps its identity if start_url ever
    // changes (browsers otherwise derive it from start_url).
    id: '/',
    name: gym ? `${gym.shortName} Platform` : 'Platform',
    short_name: gym ? gym.shortName : 'Platform',
    start_url: '/login',
    display: 'standalone',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}
