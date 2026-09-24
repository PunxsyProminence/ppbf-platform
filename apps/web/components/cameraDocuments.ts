/*
 * THE DOCUMENTS THAT MAY OPEN A CAMERA, AND HOW YOU HAVE TO ARRIVE AT ONE.
 *
 * THE DEFECT THIS EXISTS TO PREVENT, because it is invisible and total.
 * Permissions-Policy is delivered with a DOCUMENT, and next.config.ts serves
 * camera=(self) on exactly two paths. But `<Link>` does not fetch a document:
 * the App Router patches the current one in place, so a coach who reaches a
 * recorder by clicking a link is still inside whatever page they started on --
 * a page that was served camera=(). The recorder renders, the button works,
 * getUserMedia is refused, and the message a coach sees blames their browser
 * permissions for a policy the app sent itself.
 *
 * It fails the other way too. Leaving a capture route by `<Link>` carries
 * camera=(self) onto a page that was never meant to have it, for as long as
 * the tab lives.
 *
 * So arriving at, and leaving, a camera document is a FULL PAGE LOAD. That is
 * what `<a>` does in this router and `<Link>` does not. The cost is one page
 * load before filming; the alternative is a recorder that cannot record.
 *
 * KEPT AS DATA rather than as a rule in a document, because the two lists that
 * must agree -- this one and CAPTURE_ROUTES in next.config.ts -- are checked
 * against each other by cameraDocumentNavigation.test.ts, which also fails on
 * any `<Link>` in app/ or components/ that points at one of these.
 */
export const CAMERA_DOCUMENT_ROUTES = [
  '/teach-shadow/capture',
  '/coach/video-analysis/capture',
] as const;

/** True when navigating to this href must reload the document. */
export function isCameraDocument(href: string): boolean {
  // Compared on the path alone: a query string or hash does not change which
  // document is served, and neither should change how it is reached.
  const path = href.split('?')[0]!.split('#')[0]!.replace(/\/$/, '');
  return (CAMERA_DOCUMENT_ROUTES as readonly string[]).includes(path);
}
