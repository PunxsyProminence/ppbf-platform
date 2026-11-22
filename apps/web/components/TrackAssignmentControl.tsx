'use client';

import { useEffect, useRef, useState } from 'react';
import { apiBase } from '@/lib/apiBase';
import { allTrackIds, trackManifests, type TrackID } from '@/components/trackAssignments';

/*
 * WHO TRAINS ON WHAT, moved verbatim from the Capabilities page (app/admin/
 * page.tsx) to Athlete Records (lane AS-10, PR AS10-4; app scrub OFF-13;
 * Overwatch Q8 A, Q9 A). The code below is unchanged; only its home moved,
 * plus the two helpers it shares with that page (readResponseError,
 * toErrorMessage), copied here unchanged.
 */

async function readResponseError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error || fallback;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

const TRACK_CAPABILITY_PREVIEW: Record<TrackID, string[]> = {
  non_contact: ['CAP-001'],
  usa_boxing: ['CAP-001', 'CAP-003'],
  a2p: ['CAP-002', 'CAP-003'],
  pro: ['CAP-002', 'CAP-003'],
  collegiate: ['CAP-001', 'CAP-003'],
  usa_masters: ['CAP-001', 'CAP-002'],
  spec_ops: ['CAP-002'],
};

interface TrackRosterAthlete {
  athlete_id: string;
  full_name: string;
}

type TrackSaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'refused'; message: string }
  // Nothing reached the route, so nothing is saved.
  | { kind: 'failed'; message: string }
  // The save was sent and no answer about it came back: stored or not is unknown.
  | { kind: 'unconfirmed'; message: string };

const TRACK_SAVE_UNCONFIRMED =
  'The save was not confirmed -- it may or may not have been stored. Reload to see what the server kept.';

const TRACK_ASSIGNMENTS_URL = '/api/pilot/admin/track-assignments';

/**
 * The stored map as the route returned it: known track ids only, in the
 * manifest's order. Null when the reply carries no map at all. That is a read
 * that did not work, and it must never be taken for a gym with nobody on a
 * track: Save lays this admin's changes over this map and sends the whole of
 * it, so an empty stand-in would wipe every other athlete's tracks.
 */
function readTrackMap(value: unknown): Map<string, TrackID[]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const map = new Map<string, TrackID[]>();
  for (const [athleteId, tracks] of Object.entries(value as Record<string, unknown>)) {
    const known = Array.isArray(tracks) ? allTrackIds.filter((trackId) => tracks.includes(trackId)) : [];
    // An entry with no known track is an athlete on no track: left out.
    if (known.length > 0) {
      map.set(athleteId, known);
    }
  }
  return map;
}

/** The roster as the route returned it, by name. Null when the reply carries no list. */
function readTrackRoster(value: unknown): TrackRosterAthlete[] | null {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) {
    return null;
  }
  const roster: TrackRosterAthlete[] = [];
  for (const item of items as Array<Partial<TrackRosterAthlete> | null>) {
    if (item && typeof item.athlete_id === 'string' && item.athlete_id !== '' && typeof item.full_name === 'string') {
      roster.push({ athlete_id: item.athlete_id, full_name: item.full_name });
    }
  }
  return roster.sort((left, right) => left.full_name.localeCompare(right.full_name));
}

function sameTracks(left: TrackID[], right: TrackID[]): boolean {
  return left.length === right.length && left.every((trackId) => right.includes(trackId));
}

/**
 * Who Trains On What (OD-2026-10-07-010 ruling 3): a track is set for a real
 * athlete of this gym, picked by name from the live roster.
 *
 * NOTHING SAVES UNTIL "SAVE TRACKS" IS PRESSED. The control used to save on
 * load and on every click, which wrote its own starting values into the gym's
 * record before anyone had chosen anything. A toggle now only changes
 * `changes`, the athletes this admin has edited since the last read.
 *
 * THE ROUTE REPLACES THE GYM'S WHOLE MAP, so a save from a screen that has
 * been open a while would put back whatever another admin changed in the
 * meantime. Save therefore reads the stored map again and lays only this
 * admin's `changes` over it. An athlete left with no track is left out of the
 * map: no track is invented for anyone. (What is sent for the athletes this
 * admin did not touch is their stored entry as readTrackMap reads it: known
 * track ids, in the manifest's order. The route refuses anything else.)
 */
export default function TrackAssignmentControl({ canAssign }: { readonly canAssign: boolean | null }) {
  const [athletes, setAthletes] = useState<TrackRosterAthlete[] | null>(null);
  const [stored, setStored] = useState<Map<string, TrackID[]> | null>(null);
  const [changes, setChanges] = useState<Map<string, TrackID[]>>(() => new Map());
  const [loadError, setLoadError] = useState('');
  const [selectedAthleteId, setSelectedAthleteId] = useState('');
  const [status, setStatus] = useState<TrackSaveStatus>({ kind: 'idle' });
  // Read by saveTracks before React has re-rendered the button as disabled, so
  // a double press cannot start a second save beside the first.
  const saveInFlight = useRef(false);

  useEffect(() => {
    // The route admits the gym's own admins only; another sign-in would be
    // answered with a refusal, so it is not asked. Null is a session not read
    // yet, or one that could not be read: nothing is asked, and nobody is told
    // they may not.
    if (canAssign !== true) {
      return;
    }
    void (async () => {
      try {
        const [rosterResponse, mapResponse] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' }),
          fetch(`${apiBase()}${TRACK_ASSIGNMENTS_URL}`, { method: 'GET', credentials: 'include' }),
        ]);
        if (!rosterResponse.ok) {
          setLoadError(await readResponseError(rosterResponse, 'The roster could not be loaded'));
          return;
        }
        if (!mapResponse.ok) {
          setLoadError(await readResponseError(mapResponse, 'Track assignments could not be loaded'));
          return;
        }
        const roster = readTrackRoster(await rosterResponse.json().catch(() => null));
        const map = readTrackMap(((await mapResponse.json().catch(() => null)) as { assignments?: unknown } | null)?.assignments);
        if (roster === null) {
          setLoadError('The roster could not be read');
          return;
        }
        if (map === null) {
          setLoadError('Track assignments could not be read');
          return;
        }
        setAthletes(roster);
        setStored(map);
      } catch (error) {
        setLoadError(toErrorMessage(error, 'Tracks could not be loaded'));
      }
    })();
  }, [canAssign]);

  const loaded = athletes !== null && stored !== null;
  const roster = athletes ?? [];
  const saving = status.kind === 'saving';
  const savedTracks = (athleteId: string): TrackID[] => stored?.get(athleteId) ?? [];
  const shownTracks = (athleteId: string): TrackID[] => changes.get(athleteId) ?? savedTracks(athleteId);
  const selectedTracks = selectedAthleteId ? shownTracks(selectedAthleteId) : [];

  // Two athletes can share a name; the id tells them apart only then.
  const athleteLabel = (athlete: TrackRosterAthlete): string =>
    roster.filter((other) => other.full_name === athlete.full_name).length > 1
      ? `${athlete.full_name} (${athlete.athlete_id})`
      : athlete.full_name;
  // After a save that was sent and never answered, "not saved" would be a
  // claim: the changes may be stored. They are only not confirmed.
  const unconfirmed = status.kind === 'unconfirmed';
  const unsavedNames = roster.filter((athlete) => changes.has(athlete.athlete_id)).map(athleteLabel);

  function toggleTrack(trackId: TrackID) {
    if (!loaded || saving || !selectedAthleteId) {
      return;
    }
    const current = shownTracks(selectedAthleteId);
    const next = allTrackIds.filter((id) => (id === trackId ? !current.includes(id) : current.includes(id)));
    setChanges((existing) => {
      const updated = new Map(existing);
      // Back to what is stored is not a change, so it is not sent.
      if (sameTracks(next, savedTracks(selectedAthleteId))) {
        updated.delete(selectedAthleteId);
      } else {
        updated.set(selectedAthleteId, next);
      }
      return updated;
    });
    setStatus({ kind: 'idle' });
  }

  async function saveTracks() {
    if (!loaded || saveInFlight.current || changes.size === 0) {
      return;
    }
    saveInFlight.current = true;
    const sending = new Map(changes);
    setStatus({ kind: 'saving' });
    try {
      // The re-read has its own catch: if it is the read that drops, nothing
      // was sent, and that is a different thing to say than "not confirmed".
      let next: Map<string, TrackID[]> | null = null;
      let rereadError = 'Track assignments could not be read';
      try {
        const freshResponse = await fetch(`${apiBase()}${TRACK_ASSIGNMENTS_URL}`, { method: 'GET', credentials: 'include' });
        if (freshResponse.ok) {
          next = readTrackMap(((await freshResponse.json().catch(() => null)) as { assignments?: unknown } | null)?.assignments);
        } else {
          rereadError = await readResponseError(freshResponse, rereadError);
        }
      } catch (error) {
        rereadError = toErrorMessage(error, rereadError);
      }
      if (next === null) {
        setStatus({ kind: 'failed', message: `${rereadError}. Nothing was sent, so nothing is saved.` });
        return;
      }
      for (const [athleteId, tracks] of sending) {
        if (tracks.length > 0) {
          next.set(athleteId, tracks);
        } else {
          next.delete(athleteId);
        }
      }

      const response = await fetch(`${apiBase()}${TRACK_ASSIGNMENTS_URL}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ assignments: Object.fromEntries(next) }),
      });
      if (!response.ok) {
        const message = await readResponseError(response, 'Track assignments could not be saved');
        // A 4xx is the route saying no, and it writes nothing when it does. A
        // 5xx is not an answer about the write either way.
        setStatus(
          response.status >= 400 && response.status < 500
            ? { kind: 'refused', message }
            : { kind: 'unconfirmed', message: `${message}. ${TRACK_SAVE_UNCONFIRMED}` },
        );
        return;
      }
      setStored(next);
      setChanges(new Map());
      setStatus({ kind: 'saved' });
    } catch (error) {
      setStatus({
        kind: 'unconfirmed',
        message: `${toErrorMessage(error, 'Track assignments could not be saved')}. ${TRACK_SAVE_UNCONFIRMED}`,
      });
    } finally {
      saveInFlight.current = false;
    }
  }

  return (
    <article className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
      <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Who Trains On What</h2>
      {canAssign === false && (
        <p className="t-body mt-[var(--s3)]">
          Tracks are set from the gym&apos;s own admin sign-in. This sign-in cannot read or change them.
        </p>
      )}
      {canAssign === true && (
        <>
          <p className="t-body mt-[var(--s3)]">
            Pick an athlete, choose their tracks, then press Save tracks. Nothing is saved until you do. The capability
            counts on each card are a planning preview, not live wiring — read them as intent, not as what is switched on.
          </p>
          {loadError && (
            <p role="alert" className="mt-[var(--s3)] text-[length:var(--t-sm)] text-[var(--restricted-ink)]">
              {loadError}. Tracks cannot be shown or saved until this loads; reload to try again.
            </p>
          )}
          {!loaded && !loadError && (
            <p className="t-body mt-[var(--s3)]">Reading the roster and tracks…</p>
          )}
          {loaded && roster.length === 0 && (
            <p className="t-body mt-[var(--s3)]">No athletes are on this gym&apos;s roster yet, so there is nobody to put on a track.</p>
          )}
          {loaded && roster.length > 0 && (
            <div className="mt-4 grid gap-4 lg:grid-cols-[300px_1fr]">
              <div>
                <label className="t-label mb-[var(--s3)] block" htmlFor="trackAthlete">
                  Athlete
                </label>
                <select
                  id="trackAthlete"
                  value={selectedAthleteId}
                  onChange={(event) => setSelectedAthleteId(event.target.value)}
                  disabled={saving}
                  className="input"
                >
                  <option value="">Choose an athlete</option>
                  {roster.map((athlete) => (
                    <option key={athlete.athlete_id} value={athlete.athlete_id}>
                      {athleteLabel(athlete)}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => void saveTracks()}
                  disabled={saving || changes.size === 0}
                  className="btn mt-[var(--s4)]"
                >
                  {saving ? 'Saving…' : 'Save tracks'}
                </button>
                {unsavedNames.length > 0 && !saving && (
                  <p className="mt-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                    {unconfirmed ? 'Not confirmed saved' : 'Not saved yet'}: {unsavedNames.join(', ')}
                  </p>
                )}
                <p role="status" className="mt-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--bone-100)]">
                  {status.kind === 'saved' && 'Saved.'}
                  {status.kind === 'refused' && `Refused: ${status.message}`}
                  {(status.kind === 'failed' || status.kind === 'unconfirmed') && `Failed: ${status.message}`}
                </p>
              </div>

              <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
                {allTrackIds.map((trackId) => {
                  const assigned = selectedTracks.includes(trackId);
                  const unsaved = !!selectedAthleteId && assigned !== savedTracks(selectedAthleteId).includes(trackId);
                  return (
                    <button
                      key={trackId}
                      type="button"
                      aria-pressed={assigned}
                      disabled={!selectedAthleteId || saving}
                      onClick={() => toggleTrack(trackId)}
                      className={`grid gap-[var(--s3)] rounded-[var(--r-md)] border px-[var(--s4)] py-[var(--s4)] text-left ${
                        assigned
                          ? 'mat-leather--raised border-[color:var(--brass-400)] bg-[rgb(var(--brass-400-rgb)_/_.07)] text-[color:var(--bone-100)]'
                          : 'mat-leather border-[color:var(--hide-700)] text-[color:var(--bone-300)]'
                      }`}
                    >
                      <span className="text-[length:var(--t-md)] font-semibold">{trackManifests[trackId].name}</span>
                      <span className="text-[length:var(--t-sm)]">Assigned Capabilities: {TRACK_CAPABILITY_PREVIEW[trackId].length} preview mapped</span>
                      <span className="text-[length:var(--t-sm)]">Assigned Roles: Athlete / Coach</span>
                      {/* Both lines are about the athlete chosen. With nobody
                          chosen they would say "Unassigned" about no one. */}
                      {selectedAthleteId && (
                        <>
                          <span className="text-[length:var(--t-sm)]">
                            Status: {assigned ? 'Assigned' : 'Unassigned'}
                            {unsaved ? (unconfirmed ? ' (not confirmed)' : ' (not saved)') : ''}
                          </span>
                          <span className="text-[length:var(--t-sm)]">Review Needed: {assigned ? 'No' : 'Yes'}</span>
                        </>
                      )}
                      <span className="t-muted">{TRACK_CAPABILITY_PREVIEW[trackId].join(', ')}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </article>
  );
}
