'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';

type OpponentStance = 'Orthodox' | 'Southpaw' | 'Switch';
type PunchType = 'Jab' | 'Cross' | 'Hook' | 'Uppercut' | 'Body' | 'Other';

const PUNCH_TYPES: PunchType[] = ['Jab', 'Cross', 'Hook', 'Uppercut', 'Body', 'Other'];

const RECOVERY_NOTES_MAX_LENGTH = 300;

// Deep-Track: the rich data-entry path for athletes/coaches willing to take
// the time to log a full sparring session, in exchange for the formula
// engine actually being able to compute Accuracy, Connect Differential,
// Contact Exposure, Focus Attainment, and 7-Day Weight Change from it.
interface DeepTrackResult {
  ok: boolean;
  // How many observations the server actually accepted. Zero means nothing was
  // recorded at all, which the athlete must be told to re-enter; anything above
  // zero is a kept record they must not submit a second time.
  savedCount: number;
  // Set when the server raised a safety review because contact was logged for an
  // athlete with no current medical clearance. The submission still succeeded --
  // the record is kept deliberately -- but the athlete should be told, not left
  // to discover it from a coach later.
  safetyReviewRaised: boolean;
  // What earns clearance, from the gate's own requirement_text -- the "teaching
  // moment" doctrine: a stop names what's missing and where to fix it, not just
  // that it happened. Undefined when no review was raised.
  safetyReviewLesson: string | undefined;
}

async function submitDeepTrackObservations(input: {
  athleteId: string;
  contextId: string;
  observedAt: string;
  totalRoundsCompleted: number;
  contactLevel: number;
  punchType: PunchType;
  punchesAttempted: number;
  punchesLanded: number;
  punchesAbsorbed: number;
  focusAchieved: boolean;
  recoveryNotes: string;
  bodyWeightKg: number | null;
  opponentStance: OpponentStance;
}): Promise<DeepTrackResult> {
  const baseDimensions = { opponentStance: input.opponentStance };

  const observations: Array<{
    kind: string;
    value: number;
    unit: string;
    dimensions?: Record<string, string | number | boolean>;
  }> = [
    // The contact pair is sent only when contact actually happened. The
    // rounds field on this form is TOTAL session rounds, so sending it as
    // 'contact_rounds' for a contact level of 0 ('None') would report 6
    // rounds of contact for a bag-work session -- which files a
    // contact-without-clearance safety flag against an athlete who honestly
    // logged that no contact occurred. Omitting the whole pair keeps the
    // formula engine's pair-per-context invariant intact and contributes
    // exactly what a zero-contact session should to Contact Exposure:
    // nothing.
    ...(input.contactLevel > 0
      ? [
          { kind: 'contact_level', value: input.contactLevel, unit: 'level_0_3', dimensions: baseDimensions },
          { kind: 'contact_rounds', value: input.totalRoundsCompleted, unit: 'count', dimensions: baseDimensions },
        ]
      : []),
    { kind: 'punch_attempted', value: input.punchesAttempted, unit: 'count', dimensions: { punchType: input.punchType } },
    { kind: 'punch_landed', value: input.punchesLanded, unit: 'count', dimensions: { punchType: input.punchType } },
    { kind: 'punch_absorbed', value: input.punchesAbsorbed, unit: 'count', dimensions: baseDimensions },
    { kind: 'focus_achieved', value: input.focusAchieved ? 1 : 0, unit: 'boolean_0_1' },
  ];

  if (input.bodyWeightKg != null) {
    observations.push({ kind: 'body_weight', value: input.bodyWeightKg, unit: 'kilograms' });
  }

  const notes = input.recoveryNotes.trim();
  if (notes.length > 0) {
    observations.push({
      kind: 'recovery_notes',
      value: 1,
      unit: 'text_present_0_1',
      // The observations API rejects any dimension string over 300 characters
      // outright, so the note is bounded to what the record can hold.
      dimensions: { notes: notes.slice(0, RECOVERY_NOTES_MAX_LENGTH) },
    });
  }

  const results = await Promise.allSettled(observations.map(async (observation) => {
    const response = await fetch(`${apiBase()}/api/pilot/shadow/formulas/observations`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      athleteId: input.athleteId,
      contextId: input.contextId,
      kind: observation.kind,
      value: observation.value,
      unit: observation.unit,
      dimensions: observation.dimensions ?? {},
      observedAt: input.observedAt,
      idempotencyKey: `${input.contextId}-${observation.kind}`,
    }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      safetyReview?: { raised?: boolean; lesson?: string };
    };
    return {
      ok: response.ok,
      safetyReviewRaised: payload.safetyReview?.raised === true,
      safetyReviewLesson: payload.safetyReview?.lesson,
    };
  }));

  const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const savedCount = fulfilled.filter((value) => value.ok).length;

  return {
    ok: savedCount === results.length,
    savedCount,
    // Any one of the contact observations tripping the gate is enough; they all
    // concern the same session.
    safetyReviewRaised: fulfilled.some((value) => value.safetyReviewRaised),
    safetyReviewLesson: fulfilled.find((value) => value.safetyReviewLesson)?.safetyReviewLesson,
  };
}

export default function SparringTelemetryPage() {
  const [athleteId, setAthleteId] = useState<string | null>(null);
  const [totalRoundsCompleted, setTotalRoundsCompleted] = useState(6);
  const [opponentStance, setOpponentStance] = useState<OpponentStance>('Orthodox');
  const [contactLevel, setContactLevel] = useState(1);
  const [punchType, setPunchType] = useState<PunchType>('Jab');
  const [punchesAttempted, setPunchesAttempted] = useState(0);
  const [punchesLanded, setPunchesLanded] = useState(0);
  const [punchesAbsorbed, setPunchesAbsorbed] = useState(0);
  const [focusAchieved, setFocusAchieved] = useState(true);
  const [bodyWeightKg, setBodyWeightKg] = useState('');
  const [recoveryNotes, setRecoveryNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [lastSubmitted, setLastSubmitted] = useState('Not submitted yet');
  const [statusMessage, setStatusMessage] = useState('Ready for combat telemetry capture.');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, { method: 'POST', credentials: 'include' });
        const payload = (await response.json()) as { authenticated?: boolean; athlete_id?: string };
        if (response.ok && payload.authenticated && payload.athlete_id) {
          setAthleteId(payload.athlete_id);
        }
      } catch {
        // Session lookup failure just disables submission below.
      }
    })();
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!athleteId) {
      setStatusMessage('Athlete session not found. Sign in again to log a session.');
      return;
    }
    if (punchesLanded > punchesAttempted) {
      setStatusMessage('Punches landed cannot exceed punches attempted.');
      return;
    }

    setIsSubmitting(true);
    const contextId = `sparring_${Date.now()}`;
    const observedAt = new Date().toISOString();

    try {
      const { ok, savedCount, safetyReviewRaised, safetyReviewLesson } = await submitDeepTrackObservations({
        athleteId,
        contextId,
        observedAt,
        totalRoundsCompleted,
        contactLevel,
        punchType,
        punchesAttempted,
        punchesLanded,
        punchesAbsorbed,
        focusAchieved,
        recoveryNotes,
        bodyWeightKg: bodyWeightKg.trim() ? Number(bodyWeightKg) : null,
        opponentStance,
      });

      if (savedCount === 0) {
        setStatusMessage('Nothing was saved. No part of this session reached the SHADOW formula engine -- '
          + 'check your connection and log it again.');
        return;
      }

      const timestamp = formatGymTimeOfDay(new Date()) ?? '';
      setLastSubmitted(timestamp);
      const savedMessage = safetyReviewRaised
        ? 'Telemetry saved. Because there is no current medical clearance on file for this athlete, '
          + 'a safety review has been raised for your coach. The session was still recorded -- do not re-enter it.'
          + (safetyReviewLesson ? ` ${safetyReviewLesson}` : '')
        : 'Telemetry saved and sent to the SHADOW formula engine for coach review.';

      setStatusMessage(ok
        ? savedMessage
        : 'Telemetry partially saved. Some metrics may be missing from coach review.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const contactLevelLabel = ['None', 'Light', 'Moderate', 'Heavy'][contactLevel] ?? 'Unknown';

  return (
    /* Athlete-facing gym-floor surface: ink ground, the floor room's brick wall
       (same pattern as /schedule), and Law 5 sizing throughout — every control
       clears var(--tap), the working type sits at var(--t-md). */
    <main className="room--floor min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
      <header className="flex flex-wrap items-center justify-between gap-[var(--s4)] border-b-[3px] border-[color:var(--brass-500)] bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s4)]">
        <div>
          <p className="t-eyebrow">Track D/E · Deep-Track</p>
          <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>Combat Telemetry Log</h1>
        </div>
        <span className="plaque">SHADOW formula engine surface</span>
      </header>

      <form onSubmit={onSubmit} className="px-[var(--s5)] py-[var(--s6)]">
        <div className="grid items-start gap-[var(--s5)] lg:grid-cols-[var(--split-major)_var(--split-minor)]">
          <section className="mat-leather--raised grid gap-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s6)]">
            <div className="grid gap-[var(--s2)]">
              <h2 className="t-command m-0" style={{ fontSize: 'var(--t-lg)' }}>Session Capture</h2>
              <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                Log rounds, contact, punch output, focus, and weight for the coach review pipeline. Every field here
                feeds a real SHADOW formula -- this is the high-effort, high-quality-feedback path.
              </p>
            </div>

            <div className="grid gap-[var(--s5)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="roundsCompleted" className="t-label">Total Rounds Completed</label>
                <input
                  id="roundsCompleted"
                  type="number"
                  min={1}
                  max={12}
                  value={totalRoundsCompleted}
                  onChange={(event) => setTotalRoundsCompleted(Number(event.target.value))}
                  className="input input--kiosk"
                />
              </div>

              <div className="field">
                <label htmlFor="opponentStance" className="t-label">Opponent Stance</label>
                <select
                  id="opponentStance"
                  value={opponentStance}
                  onChange={(event) => setOpponentStance(event.target.value as OpponentStance)}
                  className="select input--kiosk"
                >
                  <option value="Orthodox">Orthodox</option>
                  <option value="Southpaw">Southpaw</option>
                  <option value="Switch">Switch</option>
                </select>
              </div>
            </div>

            <div className="grid gap-[var(--s3)]">
              <label htmlFor="contactLevel" className="t-label">Contact Level</label>
              <div className="flex flex-wrap items-center justify-between gap-[var(--s4)]">
                <input
                  id="contactLevel"
                  type="range"
                  min={0}
                  max={3}
                  step={1}
                  value={contactLevel}
                  onChange={(event) => setContactLevel(Number(event.target.value))}
                  className="min-h-[var(--tap)] cursor-pointer"
                  style={{ accentColor: 'var(--brass-400)', flex: '1 1 260px' }}
                />
                <span className="plaque min-w-[122px] text-center">
                  {contactLevel}/3 {contactLevelLabel}
                </span>
              </div>
            </div>

            <div className="grid gap-[var(--s5)] sm:grid-cols-3">
              <div className="field">
                <label htmlFor="punchType" className="t-label">Primary Punch Type</label>
                <select
                  id="punchType"
                  value={punchType}
                  onChange={(event) => setPunchType(event.target.value as PunchType)}
                  className="select input--kiosk"
                >
                  {PUNCH_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="punchesAttempted" className="t-label">Attempted</label>
                <input
                  id="punchesAttempted"
                  type="number"
                  min={0}
                  value={punchesAttempted}
                  onChange={(event) => setPunchesAttempted(Math.max(0, Number(event.target.value)))}
                  className="input input--kiosk"
                />
              </div>
              <div className="field">
                <label htmlFor="punchesLanded" className="t-label">Landed</label>
                <input
                  id="punchesLanded"
                  type="number"
                  min={0}
                  value={punchesLanded}
                  onChange={(event) => setPunchesLanded(Math.max(0, Number(event.target.value)))}
                  className="input input--kiosk"
                />
              </div>
            </div>

            <div className="grid gap-[var(--s5)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="punchesAbsorbed" className="t-label">Punches Absorbed</label>
                <input
                  id="punchesAbsorbed"
                  type="number"
                  min={0}
                  value={punchesAbsorbed}
                  onChange={(event) => setPunchesAbsorbed(Math.max(0, Number(event.target.value)))}
                  className="input input--kiosk"
                />
              </div>
              <div className="field">
                <label htmlFor="bodyWeight" className="t-label">Body Weight (kg, optional)</label>
                <input
                  id="bodyWeight"
                  type="number"
                  min={0}
                  step="0.1"
                  value={bodyWeightKg}
                  onChange={(event) => setBodyWeightKg(event.target.value)}
                  placeholder="Leave blank to skip"
                  className="input input--kiosk"
                />
              </div>
            </div>

            <label className="flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)] text-[length:var(--t-md)]">
              <input
                type="checkbox"
                checked={focusAchieved}
                onChange={(event) => setFocusAchieved(event.target.checked)}
                className="h-[21px] w-[21px] accent-[var(--brass-600)]"
              />
              <span>Today&apos;s technical focus was achieved</span>
            </label>

            <div className="field">
              <label htmlFor="recoveryNotes" className="t-label">Recovery Notes</label>
              <textarea
                id="recoveryNotes"
                value={recoveryNotes}
                onChange={(event) => setRecoveryNotes(event.target.value)}
                maxLength={RECOVERY_NOTES_MAX_LENGTH}
                placeholder="How the athlete felt afterward, recovery plan, anything the coach should know..."
                className="textarea input--kiosk h-[89px]"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !athleteId}
              className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale"
            >
              {isSubmitting ? 'Saving…' : 'Log Combat Session'}
            </button>
          </section>

          <aside className="mat-leather grid gap-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <div className="grid gap-[var(--s2)]">
              <p className="t-eyebrow m-0">SHADOW formula status</p>
              <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-200)]" role="status">{statusMessage}</p>
            </div>

            <div className="grid gap-[var(--s4)] sm:grid-cols-2">
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Rounds</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{totalRoundsCompleted}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Stance</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{opponentStance}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Contact</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{contactLevelLabel}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Last save</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-md)' }}>{lastSubmitted}</p>
              </div>
            </div>

            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-200)]">
              This is Deep-Track: rounds, contact level, punch accuracy, focus attainment, and weight all become real
              inputs to SHADOW&apos;s formula engine (Accuracy, Connect Differential, Contact Exposure, Focus
              Attainment Rate, 7-Day Weight Change) the moment you submit.
            </div>
          </aside>
        </div>
      </form>

      <footer className="t-muted px-[var(--s5)] pb-[var(--s6)]">
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}
