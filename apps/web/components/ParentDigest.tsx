'use client';

import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymMonthDay } from '@/src/lib/gymTime';
import { milestoneByKey, recognitionPhrase } from '@/src/shared/achievementPaths';

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
  return key.replace(/[._-]+/g, ' ').trim();
}

/** What a parent reads: the catalogue's family wording for a known milestone
 *  ("Worked three rounds straight through"), and only for one the catalogue
 *  does not know, the key with its punctuation taken out. A parent used to
 *  read "Conditioning.Plank One Minute" (F-051). */
function milestoneLabel(key: string): string {
  const known = milestoneByKey(key)?.family;
  if (known) return known;
  // Sentence case, like the catalogue's own wording and the Print page: the
  // first letter, never every word (parent walk 2026-10-19 item 12).
  const fallback = prettyKey(key);
  return fallback.charAt(0).toUpperCase() + fallback.slice(1);
}

/** What the coach's line says. A recognition is a kind and an optional note:
 *  the note when the coach typed one, otherwise the gym's family sentence for
 *  the kind ("Helped somebody in the gym who needed it."). Printing the note
 *  alone left a signature with no words above it (F-063). */
function recognitionWords(item: RecognitionItem): string {
  const note = item.note?.trim() ?? '';
  if (note) return note;
  return recognitionPhrase(item.kind)?.family ?? prettyKey(item.kind ?? '');
}

export default function ParentDigest({ athleteId, childName }: ParentDigestProps) {
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // One half failing while the other answers still makes a digest, but the
  // failed half must say so: an empty list from a failed read is not "nothing
  // written up yet".
  const [recognitionFailed, setRecognitionFailed] = useState(false);
  const [milestoneFailed, setMilestoneFailed] = useState(false);
  const [recognitions, setRecognitions] = useState<RecognitionItem[]>([]);
  const [milestones, setMilestones] = useState<MilestoneItem[]>([]);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  // UXB-13: "Check again" re-runs the same read below; bumping this is all it does.
  const [readNonce, setReadNonce] = useState(0);

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
      setRecognitionFailed(false);
      setMilestoneFailed(false);
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
        } else if (!cancelled) {
          setRecognitions([]);
          setRecognitionFailed(true);
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
        } else if (!cancelled) {
          setMilestones([]);
          setSessionCount(null);
          setMilestoneFailed(true);
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
  }, [athleteId, readNonce]);

  const possessive = childName ? `${childName}’s` : 'Your child’s';

  // UXB-13: one "Check again" for a whole failed read and for either half
  // failing on its own; it re-runs the same two reads.
  const checkAgain = (
    <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => setReadNonce((value) => value + 1)}>
      Check again
    </button>
  );

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

      {/* alert--warning, not alert--critical. alert--critical wears --locked,
          which means MEDICALLY_NOT_ALLOWED -- the top of the safety ladder, a
          person who may not participate. A digest
          that could not be fetched is not that, and this card's own text says
          so in as many words: "Nothing is wrong with the record." The colour
          was contradicting the sentence inside it.

          Putting the medical stop on a load failure is what teaches an eye
          that the mark is furniture. (Red itself is not reserved,
          OD-2026-09-29-001.) Same substitution as PR #576 and the one CI forced
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
            {checkAgain}
          </div>
        </div>
      )}

      {/* No child yet (the hub's child list is loading or failed): there is
          nobody to read for, so the lists stay unsaid rather than empty. */}
      {athleteId && !loading && !failed && (
        <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
          {/* What the coach said, verbatim and attributed. */}
          <div>
            <h4 className="t-label">What the coach said</h4>
            {recognitionFailed ? (
              <>
                <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">
                  The coach’s words could not be loaded just now.
                </p>
                {checkAgain}
              </>
            ) : recognitions.length === 0 ? (
              <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">
                Nothing written up yet. When a coach taps out a recognition, their words land here, signed.
              </p>
            ) : (
              <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
                {recognitions.map((item) => (
                  <li key={item.recognition_id} className="border-l-[3px] border-[color:var(--brass-700)] pl-[var(--s3)]">
                    <p className="t-hand" style={{ fontSize: 'var(--t-md)' }}>{recognitionWords(item)}</p>
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
            {/* UXB-25: this list is the milestones someone marked, which is
                not the hub's "milestones earned" count (that one also counts
                the ones a session total reaches). awarded_by_role is 'coach'
                or 'self' (the athlete's own "Did it"), so the label names both. */}
            <p className="mt-[var(--s1)] text-[length:var(--t-sm)] text-[color:var(--card-ink-muted)]">
              Marked by a coach or by {childName ?? 'your child'}
            </p>
            {milestoneFailed ? (
              <>
                <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">
                  Milestones could not be loaded just now.
                </p>
                {checkAgain}
              </>
            ) : milestones.length === 0 ? (
              <p className="mt-[var(--s2)] text-[length:var(--t-sm)] leading-6 text-[color:var(--card-ink-muted)]">
                No milestones sealed yet. They arrive with the work, at the pace the work happens.
              </p>
            ) : (
              <ul className="mt-[var(--s2)] space-y-[var(--s3)]">
                {milestones.map((item) => (
                  <li key={`${item.milestone_key}-${item.awarded_at}`}>
                    <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--card-ink)]">
                      {milestoneLabel(item.milestone_key)}
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
