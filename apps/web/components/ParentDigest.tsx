'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymMonthDay } from '@/src/lib/gymTime';

/**
 * FROM THE CORNER -- the parent digest.
 *
 * The Phase 2 roadmap calls this the blind spot: the person paying almost
 * never sees the room. What this panel shows is the part of the room a
 * guardian is actually admitted to, read from the two athlete-scoped APIs
 * that already answer a parent through assertActorCanAccessAthlete:
 *
 *   - RECOGNITION (/api/pilot/achievements/recognition) -- a coach telling
 *     this child they did well, in the coach's own attributed words. Rendered
 *     in the hand voice, because it is a person's note, not a system message.
 *   - MILESTONES (/api/pilot/achievements/milestones) -- what was reached,
 *     and the completed-session count that travels with the payload.
 *
 * WHAT IS DELIBERATELY ABSENT. The session log: a guardian is not admitted
 * to /api/pilot/sessions/list (every date, RPE and note), and this panel does
 * not reach for a wider read than the API grants -- the milestone route
 * already sends the session COUNT for exactly this reason. No photographs of
 * the child either: the wall module shows the building, and a child's face
 * on a shared surface is a boundary profileVisibility.ts already settled.
 *
 * Empty states are written to be true on day one: a child with no
 * recognitions yet has a coach who hasn't tapped one out yet, not a deficit.
 */

interface RecognitionItem {
  recognition_id: string;
  coach_display_name: string;
  kind: string;
  note: string;
  created_at: string;
}

interface MilestoneItem {
  milestone_key: string;
  awarded_by_role: string;
  note: string;
  awarded_at: string;
}

interface ParentDigestProps {
  readonly athleteId: string | null;
  readonly childName: string | null;
}

const SHOWN = 3;

function shortDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return formatGymMonthDay(parsed) ?? '';
}

/** 'sessions-13' or 'first_spar' -> 'sessions 13' / 'first spar'. */
function prettyKey(key: string): string {
  return key.replace(/[_-]+/g, ' ').trim();
}

export default function ParentDigest({ athleteId, childName }: ParentDigestProps) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [recognitions, setRecognitions] = useState<RecognitionItem[]>([]);
  const [milestones, setMilestones] = useState<MilestoneItem[]>([]);
  const [sessionCount, setSessionCount] = useState<number | null>(null);

  useEffect(() => {
    if (!athleteId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRecognitions([]);
      setMilestones([]);
      setSessionCount(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setFailed(false);
      try {
        const [recognitionResponse, milestoneResponse] = await Promise.all([
          fetch(
            `${apiBase()}/api/pilot/achievements/recognition?athlete_id=${encodeURIComponent(athleteId)}&limit=${SHOWN}`,
            { method: 'GET', credentials: 'include' },
          ),
          fetch(
            `${apiBase()}/api/pilot/achievements/milestones?athlete_id=${encodeURIComponent(athleteId)}`,
            { method: 'GET', credentials: 'include' },
          ),
        ]);
        if (cancelled) return;
        // Both reads refused or broken is a failure worth saying out loud;
        // one of the two answering still makes an honest digest.
        if (!recognitionResponse.ok && !milestoneResponse.ok) {
          setFailed(true);
          setRecognitions([]);
          setMilestones([]);
          setSessionCount(null);
          return;
        }
        if (recognitionResponse.ok) {
          const payload = (await recognitionResponse.json()) as { items?: RecognitionItem[] };
          if (!cancelled) setRecognitions((payload.items ?? []).slice(0, SHOWN));
        } else {
          setRecognitions([]);
        }
        if (milestoneResponse.ok) {
          const payload = (await milestoneResponse.json()) as {
            items?: MilestoneItem[];
            completed_sessions?: number;
          };
          if (!cancelled) {
            setMilestones((payload.items ?? []).slice(0, SHOWN));
            setSessionCount(
              typeof payload.completed_sessions === 'number' ? payload.completed_sessions : null,
            );
          }
        } else {
          setMilestones([]);
          setSessionCount(null);
        }
      } catch {
        if (!cancelled) {
          setFailed(true);
          setRecognitions([]);
          setMilestones([]);
          setSessionCount(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [athleteId]);

  const possessive = childName ? `${childName}’s` : 'Your child’s';

  /* This heading read "since you last looked", and nothing anywhere backs
     that claim. Neither fetch above sends a since/after cursor -- both ask
     for the latest N every time -- and a search of apps/web and infra for
     last-seen/last-viewed/digest-seen state finds none: no column, no
     cookie, no local state. A parent who opened this panel twice in a row
     saw the identical three items under a heading promising what was new
     since last time.

     "As it stands" is what the panel can actually support: the current
     contents of the corner. It deliberately does not say "most recent" or
     "newest first" either -- achievements.ts orders milestones
     `reached_at is null desc, created_at desc`, so an unreached milestone
     leads regardless of age, and a recency claim would be the same kind of
     unbacked wording one line further along. */

  return (
    <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]" aria-label="From the corner">
      <p className="t-eyebrow">From the corner</p>
      <h3 className="mt-[var(--s2)] text-[length:var(--t-md)] font-semibold text-[color:var(--card-ink)]">
        {possessive} corner, as it stands
      </h3>
      {sessionCount !== null && (
        <p className="mt-[var(--s1)] font-mono text-[length:var(--t-xs)] font-bold uppercase tracking-[0.1em] text-[color:var(--card-ink-muted)]">
          {sessionCount} {sessionCount === 1 ? 'session' : 'sessions'} on the card
        </p>
      )}

      {loading && <p className="working mt-[var(--s3)]">Reading the corner</p>}

      {/* alert--warning, not alert--critical. The safeguarding red (#A81E22) is
          reserved for MEDICALLY_NOT_ALLOWED -- the top of the safety ladder, a
          person who may not participate (owner decision 2026-08-19). A digest
          that could not be fetched is not that, and this card's own text says
          so in as many words: "Nothing is wrong with the record." The colour
          was contradicting the sentence inside it.

          Spending the gate's red on a load failure is what teaches an eye that
          the red is furniture, which is the training effect the reservation
          exists to prevent. Same substitution as PR #576 and the one CI forced
          in #778. The glyph moves with it -- the guard's own remediation names
          the pair (alert--critical -> alert--warning, glyph ✕ -> ▲), and a
          warning card still wearing the refusal's ✕ keeps half the alarm. */}
      {failed && !loading && (
        <div className="alert alert--warning alert--tight" role="alert">
          <span className="alert-icon" aria-hidden="true">▲</span>
          <div className="alert-body">
            <p className="alert-msg">
              The corner could not be read just now. Nothing is wrong with the record — try again in a moment.
            </p>
          </div>
        </div>
      )}

      {!loading && !failed && (
        <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
          {/* What the coach said, verbatim and attributed. */}
          <div>
            <h4 className="t-label">What the coach said</h4>
            {recognitions.length === 0 ? (
              <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">
                Nothing written up yet. When a coach taps out a recognition, their words land here, signed.
              </p>
            ) : (
              <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
                {recognitions.map((item) => (
                  <li key={item.recognition_id} className="border-l-[3px] border-[color:var(--brass-700)] pl-[var(--s3)]">
                    <p className="t-hand" style={{ fontSize: 'var(--t-md)' }}>{item.note}</p>
                    <p className="mt-[var(--s1)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.08em] text-[color:var(--card-ink-muted)]">
                      — {item.coach_display_name}
                      {item.created_at && ` · ${shortDate(item.created_at)}`}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* What was reached. */}
          <div>
            <h4 className="t-label">Reached</h4>
            {milestones.length === 0 ? (
              <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">
                No milestones sealed yet. They arrive with the work, at the pace the work happens.
              </p>
            ) : (
              <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
                {milestones.map((item) => (
                  <li key={`${item.milestone_key}-${item.awarded_at}`}>
                    <p className="text-[length:var(--t-sm)] font-semibold capitalize text-[color:var(--card-ink)]">
                      {prettyKey(item.milestone_key)}
                    </p>
                    {item.note && (
                      <p className="text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">{item.note}</p>
                    )}
                    <p className="mt-[var(--s1)] font-mono text-[length:var(--t-xs)] uppercase tracking-[0.08em] text-[color:var(--card-ink-muted)]">
                      {item.awarded_at && shortDate(item.awarded_at)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
