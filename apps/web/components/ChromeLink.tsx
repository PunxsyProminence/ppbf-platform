"use client";

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { requiresDocumentLoad } from './cameraDocuments';

/*
 * A LINK IN THE GLOBAL CHROME, WHICH IS MOUNTED ON THE RECORDERS TOO.
 *
 * The session bar, the corridor, the card catalog and the safety badge render
 * on every signed-in surface -- including the two documents that are served
 * camera=(self). Leaving one of those by a soft navigation keeps the document,
 * and with it the camera grant, on every ordinary page the coach visits
 * afterwards, for as long as the tab lives. A cross-site scripting hole on any
 * of those later pages then reaches a camera rather than stopping at the DOM.
 *
 * WHY A COMPONENT RATHER THAN A RULE PEOPLE REMEMBER. Nothing about these
 * controls looks like it concerns a camera: their destinations are ordinary
 * pages, `<Link>` is correct for every one of them from every other route, and
 * the failure is silent. The first repair fixed the links that pointed AT a
 * recorder and missed every link that points away from one -- which is the
 * larger set and the worse direction. One component, used by the chrome, is
 * what stops the next control added to the bar reopening it.
 *
 * Ordinary page-level links do not need this. They are rendered by a page that
 * either is a camera document -- and those use plain anchors, which
 * cameraDocumentNavigation.test.ts enforces -- or is not one, in which case
 * only a link pointing AT a recorder matters, which the same test enforces.
 */
export default function ChromeLink({
  href,
  className,
  children,
  ...rest
}: {
  readonly href: string;
  readonly className?: string;
  readonly children: ReactNode;
  readonly 'aria-label'?: string;
  readonly 'aria-current'?: 'page' | undefined;
  readonly title?: string;
}) {
  const pathname = usePathname();

  if (requiresDocumentLoad(pathname, href)) {
    return <a href={href} className={className} {...rest}>{children}</a>;
  }
  return <Link href={href} className={className} {...rest}>{children}</Link>;
}
