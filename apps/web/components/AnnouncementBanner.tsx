'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// Mirrors the closed vocabularies in src/server/pilot/announcements.ts and the
// check constraints behind them. Declared here as well because this module is
// client-side and must not pull the database layer into the bundle;
// announcementBanner.test.tsx asserts the two lists stay identical.
export const ANNOUNCEMENT_PLACEMENTS = [
  'gym_notices',
  'athlete_workspace',
  'coach_workspace',
  'everywhere',
] as const;

export type AnnouncementPlacement = (typeof ANNOUNCEMENT_PLACEMENTS)[number];

export const ANNOUNCEMENT_KINDS = ['notice', 'motivation'] as const;

export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export const PLACEMENT_LABELS: Record<AnnouncementPlacement, string> = {
  gym_notices: 'Gym Notices (sign-in page)',
  athlete_workspace: 'Athlete Workspace',
  coach_workspace: 'Coach Workspace',
  everywhere: 'Everywhere',
};

export const KIND_LABELS: Record<AnnouncementKind, string> = {
  notice: 'Notice',
  motivation: 'Motivation',
};

export interface AnnouncementItem {
  announcement_id: string;
  message: string;
  author_name: string;
  author_role: string;
  created_at: string;
  placement: AnnouncementPlacement;
  kind: AnnouncementKind;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export type AnnouncementLifecycle = 'live' | 'scheduled' | 'expired' | 'retired';

export const LIFECYCLE_LABELS: Record<AnnouncementLifecycle, string> = {
  live: 'LIVE',
  scheduled: 'SCHEDULED',
  expired: 'EXPIRED',
  retired: 'RETIRED',
};

/**
 * Where a single record stands right now. A null bound is an unset bound, not
 * a closed one, so it never on its own keeps an item off a surface.
 */
export function announcementLifecycle(item: AnnouncementItem, now: number = Date.now()): AnnouncementLifecycle {
  if (!item.active) {
    return 'retired';
  }

  const startsAt = item.starts_at ? Date.parse(item.starts_at) : null;
  if (startsAt !== null && !Number.isNaN(startsAt) && startsAt > now) {
    return 'scheduled';
  }

  const endsAt = item.ends_at ? Date.parse(item.ends_at) : null;
  if (endsAt !== null && !Number.isNaN(endsAt) && endsAt <= now) {
    return 'expired';
  }

  return 'live';
}

export function announcementReachesPlacement(item: AnnouncementItem, placement: AnnouncementPlacement): boolean {
  return item.placement === placement || item.placement === 'everywhere';
}

export function formatAnnouncementTime(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  try {
    return new Date(parsed).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

interface AnnouncementBannerProps {
  readonly placement: AnnouncementPlacement;
  readonly kind?: AnnouncementKind;
  readonly limit?: number;
  /**
   * 'public' reads the signed-out feed, which serves only the default
   * organization's Gym Notices; every other surface is behind the session.
   */
  readonly source?: 'session' | 'public';
  readonly heading?: string;
  readonly className?: string;
  readonly showByline?: boolean;
}

/**
 * Draws whatever an author has made live on one surface.
 *
 * Three rules hold whatever happens to the request: nothing is rendered when
 * there is nothing live, a failed read renders nothing rather than an error
 * that would sit on top of the page's real work, and an item outside its
 * schedule window or already retired is never drawn.
 */
export default function AnnouncementBanner({
  placement,
  kind = 'notice',
  limit = 3,
  source = 'session',
  heading,
  className,
  showByline,
}: Readonly<AnnouncementBannerProps>) {
  const [items, setItems] = useState<AnnouncementItem[]>([]);

  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        const response = source === 'public'
          ? await fetch(`${apiBase()}/api/pilot/announcements/public?limit=${limit}`, {
            method: 'GET',
            credentials: 'include',
            signal: controller.signal,
          })
          : await fetch(`${apiBase()}/api/pilot/announcements/get`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ placement, kind, limit }),
            signal: controller.signal,
          });

        if (!response.ok) {
          setItems([]);
          return;
        }

        const payload = (await response.json()) as { ok?: boolean; announcements?: AnnouncementItem[] };
        if (payload.ok !== true) {
          setItems([]);
          return;
        }

        setItems(
          (payload.announcements ?? []).filter(
            (item) => announcementReachesPlacement(item, placement)
              && item.kind === kind
              && announcementLifecycle(item) === 'live',
          ),
        );
      } catch {
        // A banner is decoration on top of whatever the page is really for.
        // It stays silent and empty rather than reporting its own failure.
        setItems([]);
      }
    })();

    return () => controller.abort();
  }, [placement, kind, limit, source]);

  if (items.length === 0) {
    return null;
  }

  const withByline = showByline ?? kind === 'notice';

  return (
    <section
      aria-label={heading ?? KIND_LABELS[kind]}
      className={className ?? 'rounded-lg border border-[rgba(0,0,0,0.12)] bg-white p-3'}
    >
      {heading ? <p className="mb-2 text-xs font-semibold text-[var(--black)]">{heading}</p> : null}
      <div className="space-y-2">
        {items.map((item) => (
          <article
            key={item.announcement_id}
            className="rounded-2xl border border-[rgba(0,0,0,0.12)] bg-white px-4 py-3 shadow-[var(--shadow-sm)]"
          >
            <p className="text-sm leading-6 text-[var(--black)]">{item.message}</p>
            {withByline ? (
              <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.08em] text-[var(--gray-medium)]">
                By {item.author_name} ({item.author_role}) - {formatAnnouncementTime(item.created_at)}
              </p>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}
