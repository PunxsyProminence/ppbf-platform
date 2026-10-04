'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import MentalSkillsView, {
  type LoadState,
  type MentalGoal,
  type MentalSkillsData,
} from '@/components/MentalSkillsView';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import {
  CUE_KIND_LABELS,
  IMAGERY_AFTER,
  IMAGERY_SOURCE,
  IMAGERY_STEPS,
  SELF_TALK_EXPLAINER,
  VISIBILITY_LINES,
  type SelfTalkCueKind,
} from '@/src/lib/mentalSkills/content';

/*
 * The athlete's mental skills page (map item 21): their coach's mental goals
 * (read-only, the 'mental' domain of their development plan), their own
 * self-talk cue, and a short imagery session they can log.
 *
 * SELF ONLY. Neither request names an athlete: both routes take the subject
 * from the session and ignore any athlete_id, and this page never sends one.
 * Education, not prescription: no target, no total, no score.
 *
 * REMOVE (OD-2026-10-04-023). The athlete can remove their own cue or session.
 * It is hidden from them, their guardian and their coach; the gym keeps the
 * row and an audit record. There is no edit: they enter a new one instead.
 */

const CUE_MAX = 60;
const MINUTES_MAX = 60;

/** The athlete's own entries; the route takes the subject from the session. */
async function fetchEntries(signal?: AbortSignal): Promise<MentalSkillsData> {
  const response = await fetch(`${apiBase()}/api/pilot/athlete/mental-skills`, {
    method: 'GET',
    credentials: 'include',
    signal,
  });
  if (!response.ok) throw new Error('mental-skills');
  const payload = (await response.json()) as Partial<MentalSkillsData>;
  if (!Array.isArray(payload.imagery_sessions)) throw new Error('shape');
  return { current_cue: payload.current_cue ?? null, imagery_sessions: payload.imagery_sessions };
}

interface FamilyBlock {
  status?: string;
  objectives?: Array<{ objective_id: string; domain: string; objective: string; status: string }>;
}

export default function AthleteMentalSkillsPage() {
  const [data, setData] = useState<MentalSkillsData | null>(null);
  const [state, setState] = useState<LoadState>('loading');
  const [goals, setGoals] = useState<MentalGoal[]>([]);
  const [goalsState, setGoalsState] = useState<LoadState>('loading');
  const [cueText, setCueText] = useState('');
  const [cueKind, setCueKind] = useState<SelfTalkCueKind | ''>('');
  const [minutes, setMinutes] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  // A ref, not state: two taps inside one render must not both get through.
  const inFlight = useRef(false);

  /** After a save. A failed reload keeps what is on screen rather than
   * replacing it with "could not be read" right after "saved". */
  async function refreshEntries(): Promise<boolean> {
    try {
      setData(await fetchEntries());
      setState('loaded');
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const fresh = await fetchEntries(controller.signal);
        setData(fresh);
        setState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setData(null);
        setState('unavailable');
      }
    })();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athlete/development-blocks`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('blocks');
        const payload = (await response.json()) as { blocks?: FamilyBlock[] };
        if (!Array.isArray(payload.blocks)) throw new Error('shape');
        // Current goals only: active objectives in active blocks. Drafts,
        // finished and cancelled goals stay on the development plan page,
        // where their status is shown.
        setGoals(
          payload.blocks.filter((block) => block.status === 'active').flatMap((block) => (block.objectives ?? [])
            .filter((o) => o.domain === 'mental' && o.status === 'active')
            .map((o) => ({ objective_id: o.objective_id, objective: o.objective }))),
        );
        setGoalsState('loaded');
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        setGoals([]);
        setGoalsState('unavailable');
      }
    })();
    return () => controller.abort();
  }, []);

  async function post(body: Record<string, unknown>, done: string): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athlete/mental-skills`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (response.status === 404) {
          // A remove of an entry already gone (another tab, a double send):
          // say so and show the list as it now is, rather than "try again".
          setMessage('That entry is already gone.');
          await refreshEntries();
          return false;
        }
        // Only a validation refusal's own words are shown; anything else is generic.
        setMessage(response.status === 400 && payload.error ? payload.error : 'That did not save. Try again.');
        return false;
      }
      setMessage((await refreshEntries()) ? done : `${done} The list could not refresh; reload the page to see it.`);
      return true;
    } catch {
      setMessage('That did not save. Try again.');
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function saveCue() {
    if (!cueText.trim() || !cueKind) {
      setMessage('Write a cue and pick which kind it is.');
      return;
    }
    if (await post({ kind: 'self_talk_cue', cue_text: cueText, cue_kind: cueKind }, 'Cue saved.')) {
      setCueText('');
      setCueKind('');
    }
  }

  async function removeEntry(entryId: string) {
    if (!window.confirm(
      'Remove this entry? It will no longer show to you, your guardian or your coach. '
      + 'If it is your current cue, your previous cue shows again. The gym keeps a record that you removed it.',
    )) return;
    await post({ action: 'remove', entry_id: entryId }, 'Entry removed.');
  }

  async function logSession() {
    const value = Number(minutes);
    if (!Number.isInteger(value) || value < 1 || value > MINUTES_MAX) {
      setMessage(`Minutes must be a whole number from 1 to ${MINUTES_MAX}.`);
      return;
    }
    if (await post({ kind: 'imagery_session', minutes: value, content_key: IMAGERY_SOURCE.contentKey }, 'Session logged.')) {
      setMinutes('');
    }
  }

  return (
    <RoleStandaloneView
      roleLabel="Mental Skills"
      routeLabel="/athlete/mental-skills"
      allowedRoles={['athlete']}
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Athlete Development</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Mental Skills</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Your self-talk cue and your imagery sessions. {VISIBILITY_LINES.athlete}
          </p>
          <Link href="/athlete/dashboard" className="btn btn--ghost mt-[var(--s4)]">
            Back to your workspace
          </Link>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <MentalSkillsView
            state={state}
            data={data}
            goals={goals}
            goalsState={goalsState}
            subjectLabel="your"
            onRemove={(entryId) => void removeEntry(entryId)}
            removing={saving}
          />
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]" aria-labelledby="cue-form-heading">
          <h2 id="cue-form-heading" className="t-eyebrow">Choose a self-talk cue</h2>
          <p className="t-body">{SELF_TALK_EXPLAINER}</p>
          <label htmlFor="cue-text" className="t-label">Your cue, in your own words</label>
          <input
            id="cue-text"
            value={cueText}
            maxLength={CUE_MAX}
            onChange={(event) => { setCueText(event.target.value); setMessage(''); }}
            className="input input--kiosk"
          />
          <fieldset className="space-y-[var(--s2)]">
            <legend className="t-label">Which kind is it?</legend>
            {(Object.keys(CUE_KIND_LABELS) as SelfTalkCueKind[]).map((kind) => (
              <label key={kind} className="t-data flex items-center gap-[var(--s2)] min-h-[var(--tap)]">
                <input
                  type="radio"
                  name="cue-kind"
                  value={kind}
                  checked={cueKind === kind}
                  onChange={() => setCueKind(kind)}
                />
                {CUE_KIND_LABELS[kind]}
              </label>
            ))}
          </fieldset>
          <button type="button" onClick={() => void saveCue()} disabled={saving} className="btn btn--kiosk disabled:opacity-50">
            Save cue
          </button>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s3)]" aria-labelledby="imagery-heading">
          <h2 id="imagery-heading" className="t-eyebrow">Imagery session</h2>
          <p className="t-label m-0">From the drill {IMAGERY_SOURCE.drillName}</p>
          <ol className="list-decimal pl-[var(--s5)] space-y-[var(--s2)]">
            {IMAGERY_STEPS.map((step) => (
              <li key={step} className="t-body">{step}</li>
            ))}
          </ol>
          <p className="t-body">{IMAGERY_AFTER}</p>
          <label htmlFor="imagery-minutes" className="t-label">Minutes</label>
          <input
            id="imagery-minutes"
            type="number"
            inputMode="numeric"
            min={1}
            max={MINUTES_MAX}
            step={1}
            value={minutes}
            onChange={(event) => { setMinutes(event.target.value); setMessage(''); }}
            className="input input--kiosk"
          />
          <button type="button" onClick={() => void logSession()} disabled={saving} className="btn btn--kiosk disabled:opacity-50">
            Log session
          </button>
        </section>

        {/* Always mounted: a live region inserted already filled is often not announced. */}
        <p className="t-body" role="status">{message}</p>
      </div>
    </RoleStandaloneView>
  );
}
