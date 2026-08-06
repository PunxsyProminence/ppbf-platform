'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * THEN AND NOW -- the before/after frame, built from the record.
 *
 * The Phase 2 roadmap wanted a first-session picture held next to a current
 * one. The platform deliberately cannot do that with photographs: the
 * portrait store keeps exactly one image per member and a replacement
 * OVERWRITES it, precisely so no history of a child's face accumulates in a
 * container (see blob.ts). So this frame holds what the record can honestly
 * show instead -- the day they first walked in against where the work has
 * got to -- and it fills itself as history accrues, which is what the
 * roadmap asked of the frame ("build the frame; it populates itself").
 *
 * Reads three athlete-scoped routes the signed-in athlete is already
 * admitted to (sessions/list, achievements/milestones,
 * achievements/recognition), all through assertActorCanAccessAthlete
 * server-side. Renders nothing but this athlete's own record.
 */

interface SessionItem {
  date?: string;
  created_at?: string;
}

interface MilestoneItem {
  milestone_key: string;
  note: string;
  awarded_at: string;
}

interface RecognitionItem {
  recognition_id: string;
  coach_display_name: string;
  note: string;
  created_at: string;
}

interface ThenAndNowProps {
  readonly athleteId: string | null;
}

function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function prettyKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim();
}

export default function ThenAndNow({ athleteId }: ThenAndNowProps) {
  const [loaded, setLoaded] = useState(false);
  const [firstSession, setFirstSession] = useState<string | null>(null);
  const [sessionCount, setSessionCount] = useState(0);
  const [firstMilestone, setFirstMilestone] = useState<MilestoneItem | null>(null);
  const [latestMilestone, setLatestMilestone] = useState<MilestoneItem | null>(null);
  const [latestRecognition, setLatestRecognition] = useState<RecognitionItem | null>(null);

  useEffect(() => {
    if (!athleteId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const [sessionsResponse, milestonesResponse, recognitionResponse] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/sessions/list?athlete_id=${encodeURIComponent(athleteId)}`, {
            method: 'GET',
            credentials: 'include',
          }),
          fetch(`${apiBase()}/api/pilot/achievements/milestones?athlete_id=${encodeURIComponent(athleteId)}`, {
            method: 'GET',
            credentials: 'include',
          }),
          fetch(`${apiBase()}/api/pilot/achievements/recognition?athlete_id=${encodeURIComponent(athleteId)}&limit=1`, {
            method: 'GET',
            credentials: 'include',
          }),
        ]);
        if (cancelled) return;

        if (sessionsResponse.ok) {
          const payload = (await sessionsResponse.json()) as { items?: SessionItem[] };
          const dates = (payload.items ?? [])
            .map((item) => item.date ?? item.created_at)
            .filter((value): value is string => typeof value === 'string')
            .sort();
          if (!cancelled) {
            setSessionCount((payload.items ?? []).length);
            setFirstSession(dates[0] ?? null);
          }
        }
        if (milestonesResponse.ok) {
          const payload = (await milestonesResponse.json()) as { items?: MilestoneItem[] };
          const byDate = [...(payload.items ?? [])].sort((a, b) => a.awarded_at.localeCompare(b.awarded_at));
          if (!cancelled) {
            setFirstMilestone(byDate[0] ?? null);
            setLatestMilestone(byDate[byDate.length - 1] ?? null);
          }
        }
        if (recognitionResponse.ok) {
          const payload = (await recognitionResponse.json()) as { items?: RecognitionItem[] };
          if (!cancelled) setLatestRecognition(payload.items?.[0] ?? null);
        }
      } catch {
        // The frame stays empty rather than failing loud: this panel is a
        // keepsake, not an instrument, and its empty state is designed.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [athleteId]);

  if (!athleteId || !loaded) return null;

  const firstDay = longDate(firstSession);
  const hasHistory = firstDay !== null || firstMilestone !== null;

  return (
    <section className="mat-leather rounded-[var(--r-md)] p-[var(--s5)]" aria-label="Then and now">
      <p className="t-eyebrow">Then and now</p>

      {!hasHistory ? (
        <p className="t-body mt-[var(--s3)]" style={{ fontSize: 'var(--t-md)' }}>
          Day one goes up here the day it happens. This frame fills itself.
        </p>
      ) : (
        <div className="mt-[var(--s4)] grid gap-[var(--s4)] sm:grid-cols-2">
          <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
            <p className="t-label">Then</p>
            {firstDay && (
              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-md)' }}>
                First walked in <span className="t-data">{firstDay}</span>
              </p>
            )}
            {firstMilestone && (
              <p className="t-muted mt-[var(--s2)]">
                First thing sealed: <span className="capitalize">{prettyKey(firstMilestone.milestone_key)}</span>
              </p>
            )}
          </div>
          <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
            <p className="t-label">Now</p>
            <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-md)' }}>
              <span className="t-data">{sessionCount}</span> {sessionCount === 1 ? 'session' : 'sessions'} on the card
            </p>
            {latestMilestone && (
              <p className="t-muted mt-[var(--s2)]">
                Latest seal: <span className="capitalize">{prettyKey(latestMilestone.milestone_key)}</span>
              </p>
            )}
            {latestRecognition && (
              <p className="t-muted mt-[var(--s2)]">
                &ldquo;{latestRecognition.note}&rdquo; — {latestRecognition.coach_display_name}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
