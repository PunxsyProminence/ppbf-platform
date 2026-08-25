'use client';

import { FormEvent, useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';
import { GYM_ADDRESS, GYM_NAME } from '@/components/PrintSheet';

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
  const [lastSubmitted, setLastSubmitted] = useState('Nothing logged yet');
  const [statusMessage, setStatusMessage] = useState('Nothing logged yet. Fill this in after you spar.');

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
      setStatusMessage('You are not signed in any more. Sign in again and this will save.');
      return;
    }
    if (punchesLanded > punchesAttempted) {
      setStatusMessage('You cannot land more than you threw. Check those two numbers.');
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
        setStatusMessage('Nothing saved. None of this got through -- check your connection '
          + 'and put it in again.');
        return;
      }

      const timestamp = formatGymTimeOfDay(new Date()) ?? '';
      setLastSubmitted(timestamp);
      // The ordinary-path copy may not claim a coach sees this. Nothing reads
      // ordinary sparring observations back out: /shadow/formulas/results has
      // no client caller, and no coach surface or SHADOW context queries
      // shadow_formula_observations. What IS true is that the safety
      // exceptions reach a coach -- missing medical clearance, or contact
      // during a hold, file a flagged near miss -- so that branch keeps
      // saying so, because that one is backed.
      const savedMessage = safetyReviewRaised
        ? 'Saved. There is no current medical clearance on file for this athlete, so '
          + 'your coach has been asked to look at it. What you wrote is kept -- do not put it in again.'
          + (safetyReviewLesson ? ` ${safetyReviewLesson}` : '')
        : 'Saved to your training record.';

      setStatusMessage(ok
        ? savedMessage
        : 'Some of it saved, some did not -- check your connection. What went through is on your record.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const contactLevelLabel = ['None', 'Light', 'Moderate', 'Heavy'][contactLevel] ?? 'Unknown';

  return (
    /* This page had no role gate at all -- every sibling athlete route wraps in
       RoleStandaloneView, this one rendered the full form to a signed-out
       visitor and relied entirely on the API route's own requireRole to
       reject the eventual submit. The data was never actually exposed
       (observations/route.ts enforces this exact role list server-side), but
       the page shell painted for anyone, which every other gated surface
       refuses to do. RoleStandaloneView's own <main> now supplies the room
       ground and background this page used to set on its own top-level
       element, so those classes move off it to avoid nesting two <main>s.

       allowedRoles matches observations/route.ts, not just ['athlete']:
       buildingMap.ts already lists this route as OPEN rather than
       athlete-only, and the API accepts coach and admin roles too -- a coach
       logging a session on a shared tablet is a real path, not a leftover.
       Server-side that list is ['athlete', 'coach', 'organization_admin',
       'admin']; client-side ClubRole's 'admin' already represents
       organization_admin (roleRoutes.ts), and platform_owner (Omega) is
       deliberately absent here for the same reason it's absent from #414's
       film-study proposals route -- Omega is broader in breadth but strictly
       narrower in depth, and this is an ordinary operational surface, not
       one of the surfaces Omega is scoped for.
       roleLabel is a description of the surface, not a claim about who's
       allowed, matching how multi-role pages elsewhere name themselves
       (Evidence Review, Decision Loop Review) rather than naming one role. */
    <RoleStandaloneView roleLabel="Sparring Log" routeLabel="/athlete/dashboard/sparring" allowedRoles={['athlete', 'coach', 'admin']} showShellHeader={false} room="floor">
      {/* The night console's voice was on a child's sparring screen. "Combat
          Telemetry Log", "SHADOW formula engine surface", "Track D/E ·
          Deep-Track" -- telemetry is the After Hours room's own Feel word, and
          this is the gym floor: brick, caged lamps, and a coach in the corner
          saying short things. roleLabel above has said "Sparring Log" all
          along; the page now agrees with it.

          bg-[var(--hide-950)] is off the band too. It is not the dead
          page-level kind -- this header is a CHILD of the room, so the ink
          really did paint over the brick the room hangs, on the one strip
          across the top of the screen. The brass rule below it is what
          separates the header from the form; it never needed a second ground
          to do that. */}
      <header className="flex flex-wrap items-center justify-between gap-[var(--s4)] border-b-[3px] border-[color:var(--brass-500)] px-[var(--s5)] py-[var(--s4)]">
        <div>
          <p className="t-eyebrow">Your Corner</p>
          <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-xl)' }}>Sparring Log</h1>
        </div>
        <span className="plaque">Your training record</span>
      </header>

      <form onSubmit={onSubmit} className="px-[var(--s5)] py-[var(--s6)]">
        <div className="grid items-start gap-[var(--s5)] lg:grid-cols-[var(--split-major)_var(--split-minor)]">
          <section className="mat-leather--raised grid gap-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s6)]">
            <div className="grid gap-[var(--s2)]">
              <h2 className="t-command m-0" style={{ fontSize: 'var(--t-lg)' }}>What happened today</h2>
              <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
                Rounds, contact, what you threw, what landed, what you took, and how you felt after. It takes a
                couple of minutes and it is the most complete record of your own work you can keep.
              </p>
            </div>

            <div className="grid gap-[var(--s5)] sm:grid-cols-2">
              <div className="field">
                <label htmlFor="roundsCompleted" className="t-label">Rounds you finished</label>
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
                <label htmlFor="opponentStance" className="t-label">Their stance</label>
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
              <label htmlFor="contactLevel" className="t-label">How hard the contact was</label>
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
                <label htmlFor="punchType" className="t-label">Punch you threw most</label>
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
                <label htmlFor="punchesAttempted" className="t-label">Thrown</label>
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
                <label htmlFor="punchesAbsorbed" className="t-label">Punches you took</label>
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
                <label htmlFor="bodyWeight" className="t-label">Your weight (kg, if you want)</label>
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
              <span>I did the thing we were working on</span>
            </label>

            <div className="field">
              <label htmlFor="recoveryNotes" className="t-label">Notes on how it went</label>
              <textarea
                id="recoveryNotes"
                value={recoveryNotes}
                onChange={(event) => setRecoveryNotes(event.target.value)}
                maxLength={RECOVERY_NOTES_MAX_LENGTH}
                placeholder="How you felt after, anything that hurt, anything you want to work on..."
                className="textarea input--kiosk h-[89px]"
              />
            </div>

            <button
              type="submit"
              disabled={isSubmitting || !athleteId}
              className="btn btn--kiosk disabled:cursor-not-allowed disabled:opacity-50 disabled:grayscale"
            >
              {isSubmitting ? 'Saving…' : 'Log This Session'}
            </button>
          </section>

          <aside className="mat-leather grid gap-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <div className="grid gap-[var(--s2)]">
              <p className="t-eyebrow m-0">Where this stands</p>
              <p className="m-0 text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-200)]" role="status">{statusMessage}</p>
            </div>

            <div className="grid gap-[var(--s4)] sm:grid-cols-2">
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Rounds</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{totalRoundsCompleted}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Their stance</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{opponentStance}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Contact</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>{contactLevelLabel}</p>
              </div>
              <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="t-label m-0">Last saved</p>
                <p className="t-data m-0 mt-[var(--s2)]" style={{ fontSize: 'var(--t-md)' }}>{lastSubmitted}</p>
              </div>
            </div>

            <div className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)] text-[length:var(--t-sm)] leading-relaxed text-[color:var(--bone-200)]">
              Nothing here is graded and nothing here is shared with the other kids. It stays on your
              record, and over time it is how you can see what is actually changing instead of guessing.
            </div>
          </aside>
        </div>
      </form>

      {/* Reuses PrintSheet's GYM_NAME/GYM_ADDRESS -- same fix as
          coach/environment/passbook-check/page.tsx, same reason. */}
      <footer className="t-muted px-[var(--s5)] pb-[var(--s6)]">
        {GYM_NAME}, Registered Office: {GYM_ADDRESS}
      </footer>
    </RoleStandaloneView>
  );
}
