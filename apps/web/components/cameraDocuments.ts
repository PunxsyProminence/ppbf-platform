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

/** True when this href IS one of the camera documents. */
export function isCameraDocument(href: string): boolean {
  // Compared on the path alone: a query string or hash does not change which
  // document is served, and neither should change how it is reached.
  const path = href.split('?')[0]!.split('#')[0]!.replace(/\/$/, '');
  return (CAMERA_DOCUMENT_ROUTES as readonly string[]).includes(path);
}

/*
 * BOTH ENDS OF A NAVIGATION MATTER, and only one of them was checked at first.
 *
 * Arriving at a recorder by a soft navigation leaves it inside a document
 * served camera=(), so it cannot open a camera. LEAVING one by a soft
 * navigation is the opposite failure and the more serious of the two: the
 * document keeps its camera=(self) grant, and every ordinary page the coach
 * visits afterwards is running with a capability it was never granted, for as
 * long as the tab lives. A cross-site scripting hole on any of those pages
 * then reaches a camera.
 *
 * So a navigation needs a real document load when EITHER end is a camera
 * document. Moving between the two recorders counts: they hold different
 * policies only because they are different documents.
 */
export function requiresDocumentLoad(from: string | null | undefined, to: string): boolean {
  return isCameraDocument(to) || (typeof from === 'string' && isCameraDocument(from));
}
