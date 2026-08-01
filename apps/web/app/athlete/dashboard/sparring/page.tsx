'use client';

import { FormEvent, useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

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
    { kind: 'contact_level', value: input.contactLevel, unit: 'level_0_3', dimensions: baseDimensions },
    { kind: 'contact_rounds', value: input.totalRoundsCompleted, unit: 'count', dimensions: baseDimensions },
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
      safetyReview?: { raised?: boolean };
    };
    return { ok: response.ok, safetyReviewRaised: payload.safetyReview?.raised === true };
  }));

  const fulfilled = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const savedCount = fulfilled.filter((value) => value.ok).length;

  return {
    ok: savedCount === results.length,
    savedCount,
    // Any one of the contact observations tripping the gate is enough; they all
    // concern the same session.
    safetyReviewRaised: fulfilled.some((value) => value.safetyReviewRaised),
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
      const { ok, savedCount, safetyReviewRaised } = await submitDeepTrackObservations({
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

      const timestamp = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      setLastSubmitted(timestamp);
      const savedMessage = safetyReviewRaised
        ? 'Telemetry saved. Because there is no current medical clearance on file for this athlete, '
          + 'a safety review has been raised for your coach. The session was still recorded -- do not re-enter it.'
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
    <main className="min-h-screen bg-[#0a0a0a] text-[#e8d7c6]">
      <header className="border-b-4 border-[#8b4444] bg-[#1a1a1a] px-10 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[0.72rem] uppercase tracking-[0.24em] text-[#d4a574] font-mono">
              Track D/E · Deep-Track
            </div>
            <div className="font-display text-2xl tracking-tight">Combat Telemetry Log</div>
          </div>
          <div className="inline-flex items-center gap-2 border-2 border-[#8b4444] bg-[#3d2817] px-3 py-2 text-xs font-mono text-[#e8d7c6]">
            SHADOW formula engine surface
          </div>
        </div>
      </header>

      <form onSubmit={onSubmit} className="px-10 py-7">
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
          <section className="grid gap-4 border-4 border-[#8b4444] bg-[#1a1a1a] p-6 shadow-2xl shadow-black/70">
            <div className="grid gap-1.5">
              <h2 className="m-0 font-display text-2xl tracking-tight">Session Capture</h2>
              <p className="m-0 leading-6 text-[#b0a095]">
                Log rounds, contact, punch output, focus, and weight for the coach review pipeline. Every field here
                feeds a real SHADOW formula -- this is the high-effort, high-quality-feedback path.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <label htmlFor="roundsCompleted" className="font-semibold">Total Rounds Completed</label>
                <input
                  id="roundsCompleted"
                  type="number"
                  min={1}
                  max={12}
                  value={totalRoundsCompleted}
                  onChange={(event) => setTotalRoundsCompleted(Number(event.target.value))}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
                />
              </div>

              <div className="grid gap-2">
                <label htmlFor="opponentStance" className="font-semibold">Opponent Stance</label>
                <select
                  id="opponentStance"
                  value={opponentStance}
                  onChange={(event) => setOpponentStance(event.target.value as OpponentStance)}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
                >
                  <option value="Orthodox">Orthodox</option>
                  <option value="Southpaw">Southpaw</option>
                  <option value="Switch">Switch</option>
                </select>
              </div>
            </div>

            <div className="grid gap-2.5">
              <label htmlFor="contactLevel" className="font-semibold">Contact Level</label>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <input
                  id="contactLevel"
                  type="range"
                  min={0}
                  max={3}
                  step={1}
                  value={contactLevel}
                  onChange={(event) => setContactLevel(Number(event.target.value))}
                  style={{ accentColor: '#d4a574', flex: '1 1 260px' }}
                />
                <span className="min-w-[122px] border-2 border-[#8b4444] bg-[#3d2817] px-3 py-2 text-center text-sm text-[#e8d7c6]">
                  {contactLevel}/3 {contactLevelLabel}
                </span>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="grid gap-2">
                <label htmlFor="punchType" className="font-semibold">Primary Punch Type</label>
                <select
                  id="punchType"
                  value={punchType}
                  onChange={(event) => setPunchType(event.target.value as PunchType)}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
                >
                  {PUNCH_TYPES.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label htmlFor="punchesAttempted" className="font-semibold">Attempted</label>
                <input
                  id="punchesAttempted"
                  type="number"
                  min={0}
                  value={punchesAttempted}
                  onChange={(event) => setPunchesAttempted(Math.max(0, Number(event.target.value)))}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
                />
              </div>
              <div className="grid gap-2">
                <label htmlFor="punchesLanded" className="font-semibold">Landed</label>
                <input
                  id="punchesLanded"
                  type="number"
                  min={0}
                  value={punchesLanded}
                  onChange={(event) => setPunchesLanded(Math.max(0, Number(event.target.value)))}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <label htmlFor="punchesAbsorbed" className="font-semibold">Punches Absorbed</label>
                <input
                  id="punchesAbsorbed"
                  type="number"
                  min={0}
                  value={punchesAbsorbed}
                  onChange={(event) => setPunchesAbsorbed(Math.max(0, Number(event.target.value)))}
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574]"
                />
              </div>
              <div className="grid gap-2">
                <label htmlFor="bodyWeight" className="font-semibold">Body Weight (kg, optional)</label>
                <input
                  id="bodyWeight"
                  type="number"
                  min={0}
                  step="0.1"
                  value={bodyWeightKg}
                  onChange={(event) => setBodyWeightKg(event.target.value)}
                  placeholder="Leave blank to skip"
                  className="w-full border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574] placeholder-[#6a5a4a]"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
              <input type="checkbox" checked={focusAchieved} onChange={(event) => setFocusAchieved(event.target.checked)} className="w-4 h-4" />
              <span>Today&apos;s technical focus was achieved</span>
            </label>

            <div className="grid gap-2">
              <label htmlFor="recoveryNotes" className="font-semibold">Recovery Notes</label>
              <textarea
                id="recoveryNotes"
                value={recoveryNotes}
                onChange={(event) => setRecoveryNotes(event.target.value)}
                maxLength={RECOVERY_NOTES_MAX_LENGTH}
                placeholder="How the athlete felt afterward, recovery plan, anything the coach should know..."
                className="w-full h-20 border-2 border-[#8b4444] bg-[#0f0f0f] px-3.5 py-3 text-[#e8d7c6] outline-none transition focus:border-[#d4a574] placeholder-[#6a5a4a]"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !athleteId}
              className="mt-1 w-fit border-2 border-[#8b4444] bg-[#5a2a2a] px-4 py-3 font-semibold text-[#e8d7c6] transition hover:border-[#d4a574] hover:bg-[#8b4444] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting ? 'Saving…' : 'Log Combat Session'}
            </button>
          </section>

          <aside className="grid gap-4 border-4 border-[#3d2817] bg-[#1a1a1a] p-6">
            <div className="grid gap-2">
              <div className="font-mono text-[0.72rem] uppercase tracking-[0.22em] text-[#d4a574]">
                SHADOW formula status
              </div>
              <p className="m-0 leading-6 text-[#e8d7c6]">{statusMessage}</p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Rounds</div>
                <div className="mt-2 text-2xl font-black text-[#e8d7c6]">{totalRoundsCompleted}</div>
              </div>
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Stance</div>
                <div className="mt-2 text-2xl font-black text-[#e8d7c6]">{opponentStance}</div>
              </div>
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Contact</div>
                <div className="mt-2 text-2xl font-black text-[#e8d7c6]">{contactLevelLabel}</div>
              </div>
              <div className="border-2 border-[#5a4a3a] bg-[#0f0f0f] p-3.5">
                <div className="font-mono text-xs uppercase tracking-[0.16em] text-[#d4a574]">Last save</div>
                <div className="mt-2 text-lg font-black text-[#e8d7c6]">{lastSubmitted}</div>
              </div>
            </div>

            <div className="border-2 border-[#8b4444] bg-[#3d2817] p-3.5 leading-6 text-[#e8d7c6]">
              This is Deep-Track: rounds, contact level, punch accuracy, focus attainment, and weight all become real
              inputs to SHADOW&apos;s formula engine (Accuracy, Connect Differential, Contact Exposure, Focus
              Attainment Rate, 7-Day Weight Change) the moment you submit.
            </div>
          </aside>
        </div>
      </form>

      <footer className="px-10 pb-8 text-sm text-[#8a8a8a]">
        Punxsy Prominence Boxing and Fitness, Registered Office: 204 PENNSYLVANIA AVE, BIG RUN(PA), PA 15715
      </footer>
    </main>
  );
}
