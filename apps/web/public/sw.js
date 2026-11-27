/*
 * THE PUSH-ONLY SERVICE WORKER (lane W5-WP, WP-1c; plan and GO on #2228).
 *
 * It does two things and nothing else:
 *   - on a push, it shows one pop-up whose title is "Open the app", with no
 *     body (QE A on #2228; OD-2026-11-19-009, "Only 'open the app'");
 *   - on a tap of that pop-up, it brings an open window of the app forward,
 *     or opens the app at "/".
 *
 * IT READS NOTHING FROM THE PUSH. The words are fixed here, so whatever a push
 * carries can never put a name, a message or an event on a lock screen.
 *
 * ONE POP-UP AT A TIME. Every pop-up shares one tag, so a new one replaces the
 * last instead of stacking up; `renotify` makes the replacement alert again.
 *
 * NO fetch HANDLER AND NO CACHE. It does not touch page loads, saves or
 * offline storage (W4-7 keeps failed saves in the open page). It is registered
 * only when a person turns push on with a tap (WP-3), and never on a device
 * marked as a gym tablet (OW27-17 B).
 */

const TITLE = 'Open the app';
const TAG = 'open-the-app';

self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification(TITLE, { tag: TAG, renotify: true }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      return open ? open.focus() : self.clients.openWindow('/');
    }),
  );
});
