'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';

/**
 * Recording that a guardian signed.
 *
 * pilot.waivers has existed in the base schema since the beginning, and
 * POST /api/pilot/intake/domain-upsert with entity_type 'waiver' has written to
 * it, role-gated and behind no feature flag. What did not exist was any screen
 * that called it: a repo-wide search for `domain-upsert` across .tsx returned
 * nothing. So a signature could be recorded by an API call and by nobody
 * standing in the gym.
 *
 * That gap mattered more than a missing feature would have, because two
 * separate planning documents disagreed about whether consent capture existed
 * at all -- one said build it, the other said done -- and both were reasoning
 * from what they could see rather than from the route.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO. It does not collect a signature.
 * It records that one was given: who signed, in what capacity, on what date,
 * against which consent version. The paper or the conversation is still the
 * artifact; this is the gym's record that it happened, which is the thing that
 * has to be findable a year later when somebody asks.
 *
 * It also does not gate anything. Nothing here blocks training, and no code
 * reads these rows to decide whether an athlete may participate. Wiring that is
 * a separate decision with real consequences on a Tuesday evening, and it
 * should be made deliberately rather than arrived at.
 */

interface RosterAthlete {
  athlete_id: string;
  full_name: string;
  active_flag: boolean;
}

/** A row of pilot.waivers as domain-get returns it. */
interface WaiverRow {
  waiver_id: string;
  athlete_id: string;
  waiver_type: string;
  signed_by_name: string;
  signed_by_role: string;
  signed_at: string;
  consent_version: string;
  status: string;
  notes: string;
}

/**
 * pilot.waivers.waiver_type is plain `text` with no database constraint, so
 * this list is the only thing holding the vocabulary together. Free text here
 * would produce four spellings of "medical" inside a month and make the
 * question "does this athlete have a medical release on file" unanswerable.
 */
const WAIVER_TYPES = [
  { value: 'general', label: 'General participation' },
  { value: 'medical_release', label: 'Medical release' },
  { value: 'photo_media', label: 'Photo and media' },
  { value: 'travel', label: 'Travel and competition' },
];

/** Who signed, in what capacity. Same reasoning as the type list above. */
const SIGNER_ROLES = [
  { value: 'guardian', label: 'Parent or legal guardian' },
  { value: 'athlete', label: 'Athlete (18 or over)' },
  { value: 'organization_admin', label: 'Gym administrator, on file' },
];

const STATUSES = [
  { value: 'signed', label: 'Signed' },
  { value: 'declined', label: 'Declined' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

/** Today as a calendar day, for the date input's default. */
function todayValue(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

function ConsentConsole() {
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [rosterError, setRosterError] = useState('');
  const [athleteId, setAthleteId] = useState('');

  const [waivers, setWaivers] = useState<WaiverRow[]>([]);
  const [waiversLoaded, setWaiversLoaded] = useState(false);
  const [waiversError, setWaiversError] = useState('');

  const [waiverType, setWaiverType] = useState('general');
  const [signedByName, setSignedByName] = useState('');
  const [signedByRole, setSignedByRole] = useState('guardian');
  const [signedAt, setSignedAt] = useState(todayValue);
  const [consentVersion, setConsentVersion] = useState('v1');
  const [status, setStatus] = useState('signed');
  const [notes, setNotes] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState('');

  // No state is set before the first await: a synchronous setState inside an
  // effect cascades a render before the request has left.
  const loadRoster = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      // `items`, and only `items`. Every branch of
      // app/api/pilot/athletes/list/route.ts answers with that key. Accepting a
      // second spelling as a fallback is what let the drill library read
      // `drills` from a route that always sent `items` and render empty for
      // weeks without a single test noticing.
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        items?: RosterAthlete[];
      };
      if (!response.ok) {
        throw new Error(payload.error || 'The roster could not be loaded.');
      }
      setRoster(payload.items ?? []);
      setRosterError('');
    } catch (error) {
      setRoster([]);
      setRosterError(error instanceof Error ? error.message : 'The roster could not be loaded.');
    }
  }, []);

  const loadWaivers = useCallback(async (forAthlete: string) => {
    if (!forAthlete) {
      setWaivers([]);
      setWaiversLoaded(false);
      return;
    }
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-get`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athlete_id: forAthlete }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        waivers?: WaiverRow[];
      };
      if (!response.ok) {
        throw new Error(payload.error || 'What is already on file could not be loaded.');
      }
      setWaivers(payload.waivers ?? []);
      setWaiversError('');
    } catch (error) {
      setWaivers([]);
      setWaiversError(error instanceof Error ? error.message : 'What is already on file could not be loaded.');
    } finally {
      setWaiversLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadRoster();
    })();
  }, [loadRoster]);

  useEffect(() => {
    void (async () => {
      await loadWaivers(athleteId);
    })();
  }, [athleteId, loadWaivers]);

  const selectedAthlete = useMemo(
    () => roster.find((athlete) => athlete.athlete_id === athleteId),
    [roster, athleteId],
  );

  const canSave = athleteId !== '' && signedByName.trim() !== '' && signedAt !== '' && !isSaving;

  async function recordConsent() {
    setIsSaving(true);
    setSaveError('');
    setSaved('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'waiver',
          athlete_id: athleteId,
          payload: {
            waiver_type: waiverType,
            signed_by_name: signedByName.trim(),
            signed_by_role: signedByRole,
            // The column is timestamptz and the input gives a calendar day.
            // Noon rather than midnight so the stored instant lands on the day
            // that was typed in every timezone this gym will ever be read from,
            // instead of the day before it west of Greenwich.
            signed_at: `${signedAt}T12:00:00.000Z`,
            consent_version: consentVersion.trim() || 'v1',
            status,
            notes: notes.trim(),
          },
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'That could not be recorded.');
      }
      setSaved('Recorded.');
      setSignedByName('');
      setNotes('');
      await loadWaivers(athleteId);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'That could not be recorded.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--canvas-tan)] px-4 py-8 text-[var(--black)]">
      <div className="mx-auto max-w-3xl">
        <p className="text-[11px] font-mono uppercase tracking-[0.3em] text-[color:var(--brass-800)]">
          Consent on file
        </p>
        <h1 className="mt-2 font-display text-3xl font-black tracking-tight">Record a signed consent</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
          This records that a consent or waiver was given, so the gym can answer later who signed and
          when. It does not collect a signature, and it does not stop anyone training.
        </p>

        <Link
          href="/admin"
          className="mt-4 inline-flex min-h-[44px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.12em]"
        >
          Back to admin
        </Link>

        {rosterError ? (
          <p className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm">
            {rosterError}
          </p>
        ) : null}

        <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
            Athlete
            <select
              aria-label="Athlete"
              value={athleteId}
              onChange={(event) => setAthleteId(event.target.value)}
              className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
            >
              <option value="">Choose an athlete</option>
              {roster.map((athlete) => (
                <option key={athlete.athlete_id} value={athlete.athlete_id}>
                  {athlete.full_name}
                  {athlete.active_flag ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>

          {athleteId ? (
            <>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                  What was signed
                  <select
                    aria-label="What was signed"
                    value={waiverType}
                    onChange={(event) => setWaiverType(event.target.value)}
                    className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
                  >
                    {WAIVER_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                  Who signed
                  <input
                    type="text"
                    aria-label="Who signed"
                    value={signedByName}
                    onChange={(event) => setSignedByName(event.target.value)}
                    placeholder="Full name"
                    className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
                  />
                </label>

                <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                  In what capacity
                  <select
                    aria-label="In what capacity"
                    value={signedByRole}
                    onChange={(event) => setSignedByRole(event.target.value)}
                    className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
                  >
                    {SIGNER_ROLES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                  Date signed
                  <input
                    type="date"
                    aria-label="Date signed"
                    value={signedAt}
                    onChange={(event) => setSignedAt(event.target.value)}
                    className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
                  />
                </label>

                <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                  Consent version
                  <input
                    type="text"
                    aria-label="Consent version"
                    value={consentVersion}
                    onChange={(event) => setConsentVersion(event.target.value)}
                    className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
                  />
                </label>

                <label className="block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                  Status
                  <select
                    aria-label="Status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                    className="mt-1 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 text-sm normal-case tracking-normal"
                  >
                    {STATUSES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="mt-4 block text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--gray-dark)]">
                Notes
                <textarea
                  aria-label="Notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Where the paper is kept, or anything the next person needs"
                  className="mt-1 h-20 w-full border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm normal-case tracking-normal"
                />
              </label>

              <button
                type="button"
                disabled={!canSave}
                onClick={() => { void recordConsent(); }}
                className="mt-4 w-full border-2 border-[var(--black)] bg-[color:var(--brass-800)] px-4 text-xs font-black uppercase tracking-[0.12em] text-[var(--white)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? 'Recording...' : `Record consent for ${selectedAthlete?.full_name ?? 'this athlete'}`}
              </button>

              {saveError ? (
                <p className="mt-3 border-l-4 border-[color:var(--rust-500)] bg-[var(--canvas-tan)] px-3 py-2 text-sm">
                  {saveError}
                </p>
              ) : null}
              {saved ? (
                <p className="mt-3 border-l-4 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 text-sm">{saved}</p>
              ) : null}
            </>
          ) : null}
        </section>

        {athleteId ? (
          <section className="mt-6">
            <h2 className="font-display text-xl font-black tracking-tight">Already on file</h2>
            {waiversError ? (
              <p className="mt-2 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-3 py-2 text-sm">
                {waiversError}
              </p>
            ) : null}
            {/*
              An empty list and a list that failed to load are different facts,
              and saying "nothing on file" when the request failed would be the
              worst possible error on this screen -- it reads as "no consent was
              ever given" for a child whose guardian signed.
            */}
            {waiversLoaded && !waiversError && waivers.length === 0 ? (
              <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
                Nothing recorded for this athlete yet.
              </p>
            ) : null}
            <ul className="mt-3 grid gap-3">
              {waivers.map((waiver) => (
                <li
                  key={waiver.waiver_id}
                  className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--gray-dark)]">
                    <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
                      {waiver.waiver_type}
                    </span>
                    <span className="border-2 border-[var(--black)] bg-[var(--canvas-tan)] px-2 py-1 text-[var(--black)]">
                      {waiver.status}
                    </span>
                    <span>{formatCalendarDay(waiver.signed_at?.slice(0, 10))}</span>
                  </div>
                  <p className="mt-2 leading-6">
                    {waiver.signed_by_name} &middot; {waiver.signed_by_role} &middot; {waiver.consent_version}
                  </p>
                  {waiver.notes ? (
                    <p className="mt-2 border-l-4 border-[var(--black)] bg-[var(--canvas-tan)] px-3 py-2 leading-6 text-[var(--gray-dark)]">
                      {waiver.notes}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </main>
  );
}

export default function ConsentPage() {
  // Matches POST /api/pilot/intake/domain-upsert exactly, which admits
  // organization_admin and coach. A wider gate here would render a console
  // whose every request failed, which is the pattern this codebase keeps
  // having to remove.
  return (
    <RoleSessionGate allowedRoles={['admin', 'coach']}>
      <ConsentConsole />
    </RoleSessionGate>
  );
}
