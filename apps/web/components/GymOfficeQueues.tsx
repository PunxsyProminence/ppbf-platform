'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

/**
 * THE MORNING CHECK'S QUEUES ON THE GYM OFFICE (lane AS-10, PR AS10-3; app
 * scrub OFF-03; Overwatch Q1 A, Q2 A, Q3 A).
 *
 * The Safety strip above already counts the safety review's five feeds. The
 * office's other review queues had no count or link on its home: four were
 * reachable only from the header or the menu. Each row here names the queue's
 * page by its own title, links it, and counts what that page itself shows as
 * waiting, from the same read the page makes (one exception, Video Compliance
 * Review, below), so the number on the home is the number on the page.
 *
 * Counts only: no name, no row detail, reaches this screen. Each read is the
 * organization admin's own, through a route that already admits them; no new
 * route, no new permission. A read that fails, is refused or answers in a shape
 * this file does not know says "could not be read", never 0. A read the server
 * cuts at its limit says so ("50+", or "in the newest 50 uploads"), so a
 * partial count never looks complete. It adds no rule, no gate and no warning.
 * Copy is PROPOSED.
 */

/** What a queue's read counted: how many, and whether the read was cut at the server's limit. */
export interface QueueCount {
  n: number;
  cut: boolean;
}

export interface QueueSpec {
  key: string;
  /** The queue page's own h1, so the link reads as the page it opens. */
  title: string;
  href: string;
  /** The page's own read: the same path, method and body. */
  url: string;
  init?: RequestInit;
  /** The page's own words for what is waiting ("Missing a waiver" filter, "Needs attention" heading, ...). */
  what: string;
  /**
   * How a cut read is said. 'plus': the whole list is the queue, so the count
   * is at least what came back ("50+"). 'window': the queue is a filter over a
   * cut list, so the count is only within what was read ("in the newest 50 uploads").
   */
  cutWords: { kind: 'plus' } | { kind: 'window'; within: string };
  /** The count from the payload, or null when the payload is not the shape the page reads. */
  count: (payload: unknown) => QueueCount | null;
}

/** The array at `key` of a payload, or null when there is none. */
function listAt(payload: unknown, key: string): unknown[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = (payload as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : null;
}

function field(row: unknown, key: string): unknown {
  return row && typeof row === 'object' ? (row as Record<string, unknown>)[key] : undefined;
}

/** The read limits the routes apply to these requests; gymOfficeQueues.test.tsx pins each to its route's source. */
export const VIDEO_COMPLIANCE_LIMIT = 50;
export const VIDEO_LIST_LIMIT = 50;
/** How many rows still 'new' the Feedback Triage count asks for (the route allows up to 200). */
export const FEEDBACK_NEW_LIMIT = 100;
export const SHADOW_REVIEWS_LIMIT = 200;

/** Staff Credentials' "Needs attention" bands (app/admin/credentials/page.tsx). */
const CREDENTIAL_ATTENTION_BANDS = new Set(['submitted', 'expired', 'expiring_soon', 'revoked']);

export const QUEUES: readonly QueueSpec[] = [
  {
    key: 'waivers',
    title: 'Waiver Compliance',
    href: '/admin/waiver-status',
    url: '/api/pilot/admin/waiver-status',
    what: 'missing a waiver',
    cutWords: { kind: 'plus' },
    // The page's default view: active athletes with any tracked waiver not
    // signed. The server fills every tracked type (missing when none is on
    // file), so "any value not signed" is the page's isComplete, negated.
    count: (payload) => {
      const items = listAt(payload, 'items');
      if (!items) return null;
      let n = 0;
      for (const row of items) {
        const waivers = field(row, 'waivers');
        if (!waivers || typeof waivers !== 'object') return null;
        const statuses = Object.values(waivers as Record<string, unknown>);
        if (statuses.length === 0) return null;
        if (field(row, 'active_flag') === true && statuses.some((status) => status !== 'signed')) n += 1;
      }
      return { n, cut: false };
    },
  },
  {
    key: 'media-consent',
    title: 'Media Consent Audit',
    href: '/admin/athlete-consent',
    url: '/api/pilot/admin/athlete-consent',
    what: 'missing consent',
    cutWords: { kind: 'plus' },
    // The page's default filter, "Missing consent": consent_ok is not true.
    count: (payload) => {
      const items = listAt(payload, 'items');
      if (!items) return null;
      if (items.some((row) => typeof field(row, 'consent_ok') !== 'boolean')) return null;
      return { n: items.filter((row) => field(row, 'consent_ok') === false).length, cut: false };
    },
  },
  {
    key: 'video-compliance',
    title: 'Video Compliance Review',
    href: '/admin/video-compliance',
    // NOT the console's own read: /api/pilot/admin/video-compliance signs a
    // stream URL for every queued item (a bearer credential for a minor's
    // footage, that route's own comment), and counting must not mint them on
    // every Gym Office load. This route runs the same getOrganizationPublications
    // query, status pending_review, same 50-row default, whole gym for an
    // organization admin, and returns rows with no URL.
    url: '/api/pilot/publications/create?status=pending_review',
    what: 'pending review',
    cutWords: { kind: 'plus' },
    count: (payload) => {
      const items = listAt(payload, 'items');
      if (!items) return null;
      return { n: items.length, cut: items.length >= VIDEO_COMPLIANCE_LIMIT };
    },
  },
  {
    key: 'video-scan',
    title: 'Video Scan Review',
    href: '/admin/video-review',
    url: '/api/pilot/video/list?scope=all',
    what: 'quarantined or flagged',
    cutWords: { kind: 'window', within: `in the newest ${VIDEO_LIST_LIMIT} uploads` },
    // The page's own filter over its own read (app/admin/video-review/page.tsx).
    count: (payload) => {
      const items = listAt(payload, 'items');
      // Every row carries both strings; a row without them is a shape this
      // count does not know, and "0 quarantined" would look like an all-clear.
      if (!items || items.some((row) => typeof field(row, 'status') !== 'string' || typeof field(row, 'scan_state') !== 'string')) return null;
      const held = items.filter(
        (row) =>
          field(row, 'status') === 'quarantined'
          || field(row, 'scan_state') === 'needs_human_review'
          || field(row, 'scan_state') === 'blocked',
      );
      return { n: held.length, cut: items.length >= VIDEO_LIST_LIMIT };
    },
  },
  {
    key: 'portraits',
    title: 'Portrait Review',
    href: '/admin/portrait-review',
    url: '/api/pilot/admin/portrait-review',
    what: 'pending',
    cutWords: { kind: 'plus' },
    count: (payload) => {
      const portraits = listAt(payload, 'portraits');
      return portraits ? { n: portraits.length, cut: false } : null;
    },
  },
  {
    key: 'feedback',
    title: 'Feedback Triage',
    href: '/admin/feedback',
    url: '/api/pilot/feedback/list',
    // NOT the page's own read: the page lists every status, safeguarding first,
    // then newest. Counting from that read would ship up to 100 submissions of
    // any status (closed safeguarding disclosures included) to count one, and
    // its 100 are not "the newest 100". The route's own triage_status filter
    // sends only rows still new, and the count is exact (AS10-3 review).
    init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ triage_status: 'new', limit: FEEDBACK_NEW_LIMIT }) },
    what: 'new',
    cutWords: { kind: 'plus' },
    count: (payload) => {
      const items = listAt(payload, 'items');
      // A row that is not new means the filter was not applied: not a count of new.
      if (!items || items.some((row) => field(row, 'triage_status') !== 'new')) return null;
      return { n: items.length, cut: items.length >= FEEDBACK_NEW_LIMIT };
    },
  },
  {
    key: 'shadow-reviews',
    title: 'SHADOW Human Review',
    href: '/admin/shadow-reviews',
    url: '/api/pilot/shadow/reviews?status=open',
    what: 'open',
    cutWords: { kind: 'plus' },
    count: (payload) => {
      const reviews = listAt(payload, 'reviews');
      return reviews ? { n: reviews.length, cut: reviews.length >= SHADOW_REVIEWS_LIMIT } : null;
    },
  },
  {
    key: 'credentials',
    title: 'Staff Credentials',
    href: '/admin/credentials',
    url: '/api/pilot/admin/credentials',
    what: 'need attention',
    cutWords: { kind: 'plus' },
    count: (payload) => {
      const items = listAt(payload, 'items');
      if (!items) return null;
      if (items.some((row) => typeof field(row, 'band') !== 'string')) return null;
      return { n: items.filter((row) => CREDENTIAL_ATTENTION_BANDS.has(field(row, 'band') as string)).length, cut: false };
    },
  },
];

type QueueState = { state: 'reading' } | { state: 'unread' } | { state: 'read'; count: QueueCount };

/** A row's words: never 0 for a read that failed, and never a cut count that looks whole. */
export function queueWords(spec: QueueSpec, read: QueueState): string {
  if (read.state === 'reading') return 'Reading…';
  if (read.state === 'unread') return 'Could not be read';
  const { n, cut } = read.count;
  if (!cut) return `${n} ${spec.what}`;
  return spec.cutWords.kind === 'plus' ? `${n}+ ${spec.what}` : `${n} ${spec.what} ${spec.cutWords.within}`;
}

export default function GymOfficeQueues() {
  const [reads, setReads] = useState<Record<string, QueueState>>(() =>
    Object.fromEntries(QUEUES.map((spec) => [spec.key, { state: 'reading' } as QueueState])),
  );

  useEffect(() => {
    const controller = new AbortController();
    // Each queue is read on its own: one slow or failed read never holds
    // another's answer back.
    for (const spec of QUEUES) {
      void (async () => {
        let next: QueueState;
        try {
          const response = await fetch(`${apiBase()}${spec.url}`, { ...spec.init, credentials: 'include', signal: controller.signal });
          const payload: unknown = await response.json().catch(() => null);
          const count = response.ok ? spec.count(payload) : null;
          next = count ? { state: 'read', count } : { state: 'unread' };
        } catch {
          next = { state: 'unread' };
        }
        if (controller.signal.aborted) return;
        setReads((previous) => ({ ...previous, [spec.key]: next }));
      })();
    }
    return () => controller.abort();
  }, []);

  return (
    <div className="mt-[var(--s5)]">
      <h3 id="gym-office-queues" className="t-command" style={{ fontSize: 'var(--t-md)' }}>Needs review</h3>
      <ul aria-labelledby="gym-office-queues" className="mt-[var(--s3)] grid gap-[var(--s3)] sm:grid-cols-2 lg:grid-cols-4">
        {QUEUES.map((spec) => (
          <li key={spec.key} className="mat-leather--raised rounded-[var(--r-md)] px-[var(--s4)] py-[var(--s3)]">
            <Link href={spec.href} className="t-label underline">
              {spec.title}
            </Link>
            <p className="t-data mt-[var(--s1)] text-[color:var(--bone-100)]">{queueWords(spec, reads[spec.key])}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
