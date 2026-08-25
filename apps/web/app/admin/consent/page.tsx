'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/**
 * The same three vocabularies, read backwards.
 *
 * pilot.waivers stores the KEY -- `medical_release`, `organization_admin`,
 * `withdrawn` -- and the register used to print it raw, so a screen whose whole
 * job is answering "who signed, and what" answered in column names. The clerk
 * who filed it wrote "Medical release". Nothing is invented here: the labels
 * are the ones the form already offers, so the record reads back in the words
 * it was entered in. The key is not dropped -- it moves to the mono "Filed
 * under" column, because that is what somebody searches the cabinet by.
 */
function labelFor(options: { value: string; label: string }[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

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

  // The empty register's invite has to land somewhere on THIS page: an empty
  // state that only tells you to go and do it elsewhere is not a front desk.
  const whoSignedRef = useRef<HTMLInputElement>(null);

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
    /* FRONT OFFICE. The door files this under office (buildingMap.ts) and the
       header comment above says why: this screen RECORDS that a guardian
       signed, and recording is desk work.

       The class is the PAIR. `.room` carries the light (.room::before) and the
       plate layer (.room::after); `.room--office` only DECLARES the --plate
       that .room::after consumes, so a surface wearing the modifier alone gets
       a plank texture, no lamp and no plate -- defect #498.

       And nothing below this element may carry a full-viewport background. An
       unlayered .room--office beats a layered bg-[...] on the SAME element,
       but a child painting `min-h-screen bg-[...]` covers the wall, the light
       and the plate at once. The container below states width, padding and
       rhythm and deliberately no ground. */
    <main className="room room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s6)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-3xl space-y-[var(--s5)]">
        <header className="relative mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
          {/* The desk lamp. .lamp draws the shade and the pool of light under
              it -- the office's own fixture, hung the way /admin and
              /admin/people hang theirs. */}
          <span className="lamp" aria-hidden="true" style={{ left: '50%', translate: '-50% 0' }} />
          <p className="t-eyebrow">Consent on file</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Record a signed consent
          </h1>
          <p className="t-body mt-[var(--s3)] max-w-[68ch]">
            This records that a consent or waiver was given, so the gym can answer later who signed and
            when. It does not collect a signature, and it does not stop anyone training.
          </p>
          <p className="mt-[var(--s4)]">
            {/* Ghost is correct HERE and nowhere else on this page: it is bone
                text on a translucent black wash, tuned for leather. Every
                secondary control that landed on the paper below is a
                .btn--lever instead -- ppbf.css documents ghost-on-light as
                grey-on-grey. */}
            <Link href="/admin" className="btn btn--ghost">
              Back to admin
            </Link>
          </p>
        </header>

        {rosterError ? (
          /* Law 3: a glyph and an uppercase label, never the red on its own. */
          <div role="alert" className="alert alert--critical alert--tight">
            <span className="alert-icon" aria-hidden="true">✕</span>
            <div className="alert-body">
              <p className="alert-title">Roster unavailable</p>
              <p className="alert-msg">{rosterError}</p>
            </div>
          </div>
        ) : null}

        {/* "Paper forms" is this room's Feel line and this is the form. The
            .field / .t-label / .input / .select / .btn set is the design
            system's own paper-form pattern -- the same one /admin/credentials
            and /admin/memberships moved to. */}
        <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
          <div className="field">
            <label className="t-label" htmlFor="consent-athlete">Athlete</label>
            <select
              id="consent-athlete"
              value={athleteId}
              onChange={(event) => setAthleteId(event.target.value)}
              className="select"
            >
              <option value="">Choose an athlete</option>
              {roster.map((athlete) => (
                <option key={athlete.athlete_id} value={athlete.athlete_id}>
                  {athlete.full_name}
                  {athlete.active_flag ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </div>

          {athleteId ? (
            <>
              <div className="mt-[var(--s4)] grid gap-[var(--s4)] sm:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor="consent-what">What was signed</label>
                  <select
                    id="consent-what"
                    value={waiverType}
                    onChange={(event) => setWaiverType(event.target.value)}
                    className="select"
                  >
                    {WAIVER_TYPES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="consent-who">Who signed</label>
                  <input
                    id="consent-who"
                    ref={whoSignedRef}
                    type="text"
                    value={signedByName}
                    onChange={(event) => setSignedByName(event.target.value)}
                    placeholder="Full name"
                    className="input"
                  />
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="consent-capacity">In what capacity</label>
                  <select
                    id="consent-capacity"
                    value={signedByRole}
                    onChange={(event) => setSignedByRole(event.target.value)}
                    className="select"
                  >
                    {SIGNER_ROLES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="consent-date">Date signed</label>
                  <input
                    id="consent-date"
                    type="date"
                    value={signedAt}
                    onChange={(event) => setSignedAt(event.target.value)}
                    className="input"
                  />
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="consent-version">Consent version</label>
                  <input
                    id="consent-version"
                    type="text"
                    value={consentVersion}
                    onChange={(event) => setConsentVersion(event.target.value)}
                    className="input"
                  />
                </div>

                <div className="field">
                  <label className="t-label" htmlFor="consent-status">Status</label>
                  <select
                    id="consent-status"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                    className="select"
                  >
                    {STATUSES.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="field mt-[var(--s4)]">
                <label className="t-label" htmlFor="consent-notes">Notes</label>
                <textarea
                  id="consent-notes"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Where the paper is kept, or anything the next person needs"
                  className="textarea h-20"
                />
              </div>

              <button
                type="button"
                disabled={!canSave}
                onClick={() => { void recordConsent(); }}
                className="btn mt-[var(--s4)] w-full disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isSaving ? 'Recording...' : `Record consent for ${selectedAthlete?.full_name ?? 'this athlete'}`}
              </button>

              {/* Outcomes INSIDE the paper panel are a badge and a line of
                  prose, not .alert. Every .alert--* rule in ppbf.css pins
                  `color: var(--bone-100)` and the sheet restates it for
                  .on-canvas only -- an alert dropped on .mat-paper is bone on
                  cream. The badge carries its own dark chip and its own ink,
                  which is why #514 moved the needs-review cell onto one, and
                  the glyph plus the uppercase label keep Law 3. The two alerts
                  on this page that ARE .alert both stand on the wall. */}
              {saveError ? (
                <div role="alert" className="mt-[var(--s4)] flex flex-wrap items-center gap-[var(--s3)]">
                  <span className="badge badge--locked"><i aria-hidden="true">✕</i>Not recorded</span>
                  <p className="t-body">{saveError}</p>
                </div>
              ) : null}
              {saved ? (
                <div role="status" className="mt-[var(--s4)] flex flex-wrap items-center gap-[var(--s3)]">
                  <span className="badge badge--cleared"><i aria-hidden="true">✓</i>On file</span>
                  <p className="t-body">{saved}</p>
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        {athleteId ? (
          <section className="space-y-[var(--s4)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Already on file</h2>
            {waiversError ? (
              <div role="alert" className="alert alert--critical alert--tight">
                <span className="alert-icon" aria-hidden="true">✕</span>
                <div className="alert-body">
                  <p className="alert-title">Records unavailable</p>
                  <p className="alert-msg">{waiversError}</p>
                </div>
              </div>
            ) : null}
            {/*
              An empty list and a list that failed to load are different facts,
              and saying "nothing on file" when the request failed would be the
              worst possible error on this screen -- it reads as "no consent was
              ever given" for a child whose guardian signed.
            */}
            {waiversLoaded && !waiversError && waivers.length === 0 ? (
              /* The room's own named empty state rather than a lone sentence.
                 .pap so .empty takes its paper inks -- the bone rungs are
                 authored against leather and go faint on the sheet. */
              <div className="mat-paper pap rounded-[var(--r-lg)] p-[var(--s5)]">
                <div className="empty">
                  <div className="empty-glyph" aria-hidden="true">▤</div>
                  <div className="empty-title">Nothing filed yet.</div>
                  <p className="empty-msg">Nothing recorded for this athlete yet.</p>
                  <div className="empty-action">
                    <button type="button" className="btn" onClick={() => whoSignedRef.current?.focus()}>
                      Record the first one
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {waivers.length > 0 ? (
              /* A register, not a stack of cards: one ruled row per record, in
                 the mono voice Law 4 gives anything auditable. .ledger is the
                 office's record furniture and this page is the office's record.
                 The raw column values -- `medical_release`, `signed` -- are
                 machine keys, so the cells read the vocabulary's own labels and
                 the keys move to a mono "Filed under" column rather than being
                 dropped: they are what somebody searches the cabinet by. */
              <div className="mat-paper pap overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
                <table className="ledger">
                  <caption className="text-left">
                    Consent records for {selectedAthlete?.full_name ?? 'this athlete'}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">What was signed</th>
                      <th scope="col">Who signed</th>
                      <th scope="col">In what capacity</th>
                      <th scope="col">Date signed</th>
                      <th scope="col">Status</th>
                      <th scope="col">Notes</th>
                      <th scope="col">Filed under</th>
                    </tr>
                  </thead>
                  <tbody>
                    {waivers.map((waiver) => (
                      <tr key={waiver.waiver_id}>
                        <td>{labelFor(WAIVER_TYPES, waiver.waiver_type)}</td>
                        <td className="font-bold">{waiver.signed_by_name}</td>
                        <td>{labelFor(SIGNER_ROLES, waiver.signed_by_role)}</td>
                        <td className="whitespace-nowrap">{formatCalendarDay(waiver.signed_at?.slice(0, 10))}</td>
                        <td>{labelFor(STATUSES, waiver.status)}</td>
                        <td>{waiver.notes ? waiver.notes : <span aria-hidden="true">—</span>}</td>
                        <td className="ledger-id whitespace-nowrap">
                          {waiver.waiver_type} · {waiver.status} · {waiver.consent_version}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
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
