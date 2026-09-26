"use client";

import { useEffect, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/*
 * TEACH SHADOW: clearance, and the only place in the teaching flow where a
 * real athlete is named.
 *
 * WHY IT IS A SEPARATE PAGE, and not a field on the recorder. Teaching media
 * names nobody -- the video row carries no athlete_id, the capture surface
 * shows no name, and a second device joining by code learns nothing about who
 * is in frame. That property is only worth anything if the name is absent from
 * the teaching surface itself; a picker sitting above the camera would put it
 * straight back, on the one screen the whole slice exists to keep anonymous.
 *
 * SO THE QUESTION IS ASKED ONCE, HERE, BEFORE ANY FOOTAGE EXISTS. The server
 * proves this coach may film this athlete and that every guardian holds
 * current Teach Shadow consent, establishes the restricted participant, and
 * returns a session that mentions none of it. From that point on the flow is
 * anonymous and cannot be made otherwise: the upload route REFUSES a
 * take-backed upload that names an athlete.
 *
 * NOT THE PUBLICATION CONSENT. Teach Shadow consent is its own waiver type.
 * The guardian-facing photo and video consent describes use in gym
 * publications; it says nothing about teaching software to recognise punches,
 * so it cannot stand in for this one, and withdrawing either leaves the other
 * untouched.
 *
 * DELIBERATELY NOT UNDER /teach-shadow. Everything under that path is the
 * anonymous surface. This is the identity step that precedes it, and it lives
 * where the coach's other named-athlete work lives.
 */

const TRAINING_CONTEXTS = [
  { value: 'shadowboxing', label: 'Shadowboxing' },
  { value: 'heavy_bag', label: 'Heavy bag' },
] as const;

export default function CaptureClearancePage() {
  const [athletes, setAthletes] = useState<Array<{ athlete_id: string; full_name: string }>>([]);
  const [athleteId, setAthleteId] = useState('');
  const [trainingContext, setTrainingContext] = useState<string>(TRAINING_CONTEXTS[0].value);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
        const payload = (await response.json().catch(() => ({}))) as {
          athletes?: Array<{ athlete_id: string; full_name: string }>;
          items?: Array<{ athlete_id: string; full_name: string }>;
        };
        setAthletes(payload.athletes ?? payload.items ?? []);
      } catch {
        setErrorMessage('The athlete list could not be read. Reload the page and try again.');
      }
    })();
  }, []);

  async function clearAndStart() {
    setBusy(true);
    setErrorMessage('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/capture-session`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          training_context: trainingContext,
          athlete_id: athleteId,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        session?: { recording_session_id?: string };
      };
      if (!response.ok) {
        throw new Error(payload.error || 'That session could not be started.');
      }
      const recordingSessionId = payload.session?.recording_session_id;
      if (!recordingSessionId) {
        throw new Error('That session could not be started.');
      }

      /*
       * A FULL DOCUMENT LOAD, not a router push. Permissions-Policy is a
       * per-response header: a soft navigation would carry THIS document's
       * camera=() into the recorder and the camera could never open there.
       * Same reason ChromeLink exists for the links that do this.
       */
      window.location.assign(
        `/teach-shadow/capture?recording_session_id=${encodeURIComponent(recordingSessionId)}`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'That session could not be started.');
      setBusy(false);
    }
  }

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="mx-auto w-full max-w-[var(--measure-wide)] px-[var(--s4)] py-[var(--s6)]">
        <p className="t-eyebrow">Teach Shadow</p>
        <h1 className="t-gothic" style={{ fontSize: 'var(--t-3xl)' }}>Clear a participant</h1>

        <p className="t-body mt-[var(--s3)]">
          Say who is being filmed before you start. This is the only step that records who
          the footage is of &mdash; the recording itself, and everything Teach Shadow shows
          afterwards, names nobody.
        </p>

        <div className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s4)]">
          <p role="note" className="t-body">
            Their guardian must have given Teach Shadow consent. That is separate from photo
            and video consent for gym publications, and giving one does not give the other.
          </p>
        </div>

        {errorMessage ? (
          <div role="alert" className="alert alert--warning mt-[var(--s5)]">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title">Attention</p>
              <p className="alert-msg">{errorMessage}</p>
            </div>
          </div>
        ) : null}

        <section className="mt-[var(--s5)] mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
          <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
            Who is being filmed
            <select
              className="input"
              value={athleteId}
              onChange={(event) => setAthleteId(event.target.value)}
            >
              <option value="">Choose an athlete&hellip;</option>
              {athletes.map((athlete) => (
                <option key={athlete.athlete_id} value={athlete.athlete_id}>
                  {athlete.full_name}
                </option>
              ))}
            </select>
          </label>

          <label className="t-eyebrow mt-[var(--s4)] flex flex-col gap-[var(--s2)]">
            What is being filmed
            <select
              className="input"
              value={trainingContext}
              onChange={(event) => setTrainingContext(event.target.value)}
            >
              {TRAINING_CONTEXTS.map((context) => (
                <option key={context.value} value={context.value}>{context.label}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="btn mt-[var(--s4)]"
            disabled={busy || !athleteId}
            onClick={() => { void clearAndStart(); }}
          >
            {busy ? 'Clearing…' : 'Clear and start recording'}
          </button>
        </section>

        {/* Plain anchor: the recorder is a camera document, so reaching it has
            to be a document load rather than a soft navigation. */}
        <p className="mt-[var(--s5)]">
          <a className="btn btn--ghost" href="/teach-shadow">Back to Teach Shadow</a>
        </p>
      </main>
    </RoleSessionGate>
  );
}
