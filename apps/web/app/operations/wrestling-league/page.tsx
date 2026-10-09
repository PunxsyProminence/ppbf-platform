'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import OperationsLink from '@/components/OperationsLink';

// Wrestling league minimal skeleton (owner decision 2026-08-15: build both
// competition skeletons deliberately skeletal). Season, event, and roster
// records -- enough to write down that a league exists and who is in it.
// Match cards, brackets, weigh-ins, scoring, and scheduling stay unbuilt
// until a real league defines them; the page says so instead of pretending.
//
// Roster rows carry athlete links; names come from the org-scoped athlete
// read. Coaches can read everything here; creating records is admin work
// (the API enforces it -- LEAGUE_WRITE_ROLES).

interface SeasonRow {
  season_id: string;
  season_name: string;
  starts_on: string;
  ends_on: string | null;
  status: string;
  notes: string;
}

interface EventRow {
  event_id: string;
  event_name: string;
  event_date: string;
  location: string;
  status: string;
}

interface RosterRow {
  entry_id: string;
  athlete_id: string;
  athlete_name: string;
  status: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

// One season's events and roster, tagged with the season they were read for.
// `failed` means the last read of that season did not come back, so the page
// does not know what it holds.
interface SeasonDetail {
  seasonId: string | null;
  events: EventRow[];
  roster: RosterRow[];
  failed: boolean;
}

const NO_DETAIL: SeasonDetail = { seasonId: null, events: [], roster: [], failed: false };

const SEASON_BADGE: Record<string, { className: string; glyph: string }> = {
  planned: { className: 'badge badge--monitor', glyph: '◉' },
  active: { className: 'badge badge--cleared', glyph: '✓' },
  completed: { className: 'badge badge--filed', glyph: '▣' },
};

const SEASON_ACTIONS: Record<string, Array<{ status: string; label: string }>> = {
  planned: [{ status: 'active', label: 'Start season' }],
  active: [{ status: 'completed', label: 'Complete season' }],
  completed: [{ status: 'active', label: 'Reopen' }],
};

export default function WrestlingLeagueManagementPage() {
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // errorMessage is shared by every read and write on the page, so it cannot
  // say whether the list on screen is real. seasonsLoadError and detail.failed
  // can: while the last read of a list failed, the page does not know what it
  // holds and must not print "nothing on record" -- or another season's
  // records -- for it.
  const [seasonsLoadError, setSeasonsLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showSeasonForm, setShowSeasonForm] = useState(false);
  const [seasonForm, setSeasonForm] = useState({ season_name: '', starts_on: '', ends_on: '' });

  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  // The season open right now, readable from inside a reply that was started
  // for another one. Set in the same click that changes selectedSeasonId.
  const openSeasonRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<SeasonDetail>(NO_DETAIL);
  const [detailLoading, setDetailLoading] = useState(false);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [eventForm, setEventForm] = useState({ event_name: '', event_date: '', location: '' });
  const [rosterAthleteId, setRosterAthleteId] = useState('');

  const reloadSeasons = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/operations/wrestling-league/seasons`, {
        method: 'GET',
        credentials: 'include',
        signal,
      });
      if (!response.ok) throw new Error('Unable to load league seasons.');
      const payload = (await response.json()) as { items?: SeasonRow[] };
      setSeasons(payload.items ?? []);
      setSeasonsLoadError(false);
    } catch (error) {
      // An aborted read is the page unmounting, not a failed load.
      if (!signal?.aborted) setSeasonsLoadError(true);
      throw error;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reloadSeasons(controller.signal);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load league seasons.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reloadSeasons]);

  // Returns false, and changes nothing, when another season (or none) was
  // opened while this read was out: its reply -- success or failure -- is not
  // about the season on screen. Only a failure for the open season throws.
  const reloadDetail = useCallback(async (seasonId: string, signal?: AbortSignal): Promise<boolean> => {
    const base = `${apiBase()}/api/pilot/operations/wrestling-league`;
    try {
      const [eventsResponse, rosterResponse] = await Promise.all([
        fetch(`${base}/events?season_id=${encodeURIComponent(seasonId)}`, { credentials: 'include', signal }),
        fetch(`${base}/roster?season_id=${encodeURIComponent(seasonId)}`, { credentials: 'include', signal }),
      ]);
      if (!eventsResponse.ok || !rosterResponse.ok) throw new Error('Unable to load the season detail.');
      const eventsPayload = (await eventsResponse.json()) as { items?: EventRow[] };
      const rosterPayload = (await rosterResponse.json()) as { items?: RosterRow[] };
      if (openSeasonRef.current !== seasonId) return false;
      setDetail({ seasonId, events: eventsPayload.items ?? [], roster: rosterPayload.items ?? [], failed: false });
      return true;
    } catch (error) {
      // An aborted read is the effect being cleaned up, not a failed load.
      if (signal?.aborted) throw error;
      if (openSeasonRef.current !== seasonId) return false;
      setDetail({ seasonId, events: [], roster: [], failed: true });
      throw error;
    }
  }, []);

  // The loading flag is raised in the click handler that selects the season,
  // not here: setState synchronously inside an effect body cascades renders
  // (react-hooks/set-state-in-effect). The effect only loads and lowers it.
  useEffect(() => {
    if (!selectedSeasonId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const applied = await reloadDetail(selectedSeasonId, controller.signal);
        if (controller.signal.aborted || !applied) return;
        setErrorMessage(null);
        setDetailLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the season detail.');
        setDetailLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedSeasonId, reloadDetail]);

  // Athlete options for the roster picker, loaded once. A viewer whose role
  // gets an empty or refused list simply sees no options -- the roster POST
  // is the real gate.
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: AthleteOption[] };
        if (controller.signal.aborted) return;
        setAthletes(payload.items ?? []);
      } catch {
        // Silent: the picker degrades to empty; roster reads still render.
      }
    })();
    return () => controller.abort();
  }, []);

  const postJson = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${apiBase()}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(err.error || `Request failed (${response.status})`);
    }
  };

  const handleCreateSeason = async () => {
    setBusy(true);
    try {
      await postJson('/api/pilot/operations/wrestling-league/seasons', {
        season_name: seasonForm.season_name,
        starts_on: seasonForm.starts_on,
        ends_on: seasonForm.ends_on || null,
      });
      setShowSeasonForm(false);
      setSeasonForm({ season_name: '', starts_on: '', ends_on: '' });
      await reloadSeasons();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the season.');
    } finally {
      setBusy(false);
    }
  };

  const handleSeasonStatus = async (seasonId: string, status: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/operations/wrestling-league/seasons`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ season_id: seasonId, status }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Update failed (${response.status})`);
      }
      await reloadSeasons();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update the season.');
    } finally {
      setBusy(false);
    }
  };

  // After a write, the reload is for the season written to. If the coach has
  // opened another season meanwhile, that season's own read decides the alert;
  // the write's reload leaves it alone.
  const reloadAfterWrite = async (seasonId: string) => {
    const applied = await reloadDetail(seasonId);
    if (applied || openSeasonRef.current === null) setErrorMessage(null);
  };

  const handleCreateEvent = async () => {
    if (!selectedSeasonId) return;
    setBusy(true);
    try {
      await postJson('/api/pilot/operations/wrestling-league/events', {
        season_id: selectedSeasonId,
        event_name: eventForm.event_name,
        event_date: eventForm.event_date,
        location: eventForm.location,
      });
      setEventForm({ event_name: '', event_date: '', location: '' });
      await reloadAfterWrite(selectedSeasonId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the event.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddRosterEntry = async () => {
    if (!selectedSeasonId || !rosterAthleteId) return;
    setBusy(true);
    try {
      await postJson('/api/pilot/operations/wrestling-league/roster', {
        season_id: selectedSeasonId,
        athlete_id: rosterAthleteId,
      });
      setRosterAthleteId('');
      await reloadAfterWrite(selectedSeasonId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to add the athlete.');
    } finally {
      setBusy(false);
    }
  };

  // Withdrawal shares the roster PATCH ({ entry_id, status: 'inactive' }). The
  // entry stays on the roster, marked inactive, rather than being deleted.
  const handleRosterInactive = async (entry: RosterRow) => {
    if (!selectedSeasonId) return;
    const confirmed = window.confirm(
      `Mark ${entry.athlete_name} inactive on this season roster? They stay listed as inactive.`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/operations/wrestling-league/roster`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entry_id: entry.entry_id, status: 'inactive' }),
      });
      if (!response.ok) {
        if (response.status === 404) {
          throw new Error('This roster entry could not be marked inactive. It may already be inactive; reload the list.');
        }
        if (response.status === 403) {
          throw new Error('Only an admin role can mark an athlete inactive on the roster.');
        }
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Update failed (${response.status})`);
      }
      await reloadAfterWrite(selectedSeasonId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to mark the athlete inactive.');
    } finally {
      setBusy(false);
    }
  };

  // Lists (or "none") are printed only when the page holds a good read of the
  // season that is open. Otherwise each list slot says it could not load --
  // the shared alert may since have been replaced or cleared by another action.
  const detailKnown = detail.seasonId === selectedSeasonId && !detail.failed;
  const detailUnknownLine = (
    <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>Unable to load the season detail.</p>
  );

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* Front office: seasons, events and rosters written down. Roster work
          is named in the office's purpose; nothing here is coached. */}
      <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
            <p className="t-eyebrow tracking-[0.18em]">Operations Workspace</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>Wrestling League Management</h1>
            <p className="t-body max-w-[80ch]">
              Minimal skeleton by owner decision: season, event, and roster records only.
              Match cards, brackets, weigh-ins, scoring, and scheduling stay unbuilt until a real
              league defines what they must be. Admin roles create records; coaches read.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical mt-[var(--s5)]" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          <section className="mt-[var(--s6)]">
            <div className="flex flex-wrap items-center gap-[var(--s3)]">
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Seasons</h2>
              <button type="button" className="btn" onClick={() => setShowSeasonForm((current) => !current)}>
                {showSeasonForm ? 'Close form' : 'Add season'}
              </button>
            </div>

            {showSeasonForm && (
              <div className="mat-leather mt-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="grid gap-[var(--s3)] md:grid-cols-3">
                  <div className="field">
                    <label className="t-label" htmlFor="season-name">Season name</label>
                    <input id="season-name" className="input" value={seasonForm.season_name}
                      onChange={(e) => setSeasonForm((f) => ({ ...f, season_name: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="season-starts">Starts</label>
                    <input id="season-starts" type="date" className="input" value={seasonForm.starts_on}
                      onChange={(e) => setSeasonForm((f) => ({ ...f, starts_on: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="season-ends">Ends (optional)</label>
                    <input id="season-ends" type="date" className="input" value={seasonForm.ends_on}
                      onChange={(e) => setSeasonForm((f) => ({ ...f, ends_on: e.target.value }))} />
                  </div>
                </div>
                <div className="mt-[var(--s4)]">
                  <button type="button" className="btn" disabled={busy} onClick={() => void handleCreateSeason()}>
                    {busy ? 'Saving…' : 'Save season'}
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-[var(--s7)]">
                <span className="working">Loading seasons...</span>
              </div>
            ) : seasonsLoadError && seasons.length === 0 ? (
              /* The failure alert above is the whole truth here: nobody could
                 look, so the page does not say the league has no seasons. */
              null
            ) : seasons.length === 0 ? (
              <div className="mat-leather mt-[var(--s4)] rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">No seasons on record</div>
                  <p className="empty-msg mx-auto">When a league season is planned, it gets filed here.</p>
                </div>
              </div>
            ) : (
              <ul className="mt-[var(--s4)] space-y-[var(--s3)]">
                {seasons.map((season) => {
                  const badge = SEASON_BADGE[season.status] ?? SEASON_BADGE.planned;
                  const selected = season.season_id === selectedSeasonId;
                  return (
                    <li key={season.season_id} className={`mat-leather rounded-[var(--r-lg)] p-[var(--s4)]${selected ? ' mat-leather--raised' : ''}`}>
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <span className="t-body font-semibold text-[color:var(--bone-100)]">{season.season_name}</span>
                        <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{season.status}</span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          {formatGymDateNumeric(season.starts_on)}
                          {season.ends_on ? ` – ${formatGymDateNumeric(season.ends_on)}` : ''}
                        </span>
                        <button type="button" className="btn btn--ghost" onClick={() => {
                          const next = selected ? null : season.season_id;
                          openSeasonRef.current = next;
                          setDetailLoading(next !== null);
                          setSelectedSeasonId(next);
                        }}>
                          {selected ? 'Close detail' : 'Open detail'}
                        </button>
                        {(SEASON_ACTIONS[season.status] ?? []).map((action) => (
                          <button key={action.status} type="button" className="btn btn--ghost" disabled={busy}
                            onClick={() => void handleSeasonStatus(season.season_id, action.status)}>
                            {action.label}
                          </button>
                        ))}
                      </div>

                      {selected && (
                        detailLoading ? (
                          <div className="mt-[var(--s4)]"><span className="working">Loading season detail...</span></div>
                        ) : (
                        <div className="mt-[var(--s4)] grid gap-[var(--s4)] lg:grid-cols-2">
                          <section>
                            <h3 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>Events</h3>
                            {!detailKnown ? detailUnknownLine : detail.events.length === 0 ? (
                              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>No events filed for this season.</p>
                            ) : (
                              <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                                {detail.events.map((event) => (
                                  <li key={event.event_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                                    {formatGymDateNumeric(event.event_date)} — {event.event_name}
                                    {event.location ? ` (${event.location})` : ''} · {event.status}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="mt-[var(--s3)] grid gap-[var(--s2)]">
                              <div className="field">
                                <label className="t-label" htmlFor="event-name">Event name</label>
                                <input id="event-name" className="input" value={eventForm.event_name}
                                  onChange={(e) => setEventForm((f) => ({ ...f, event_name: e.target.value }))} />
                              </div>
                              <div className="field">
                                <label className="t-label" htmlFor="event-date">Event date</label>
                                <input id="event-date" type="date" className="input" value={eventForm.event_date}
                                  onChange={(e) => setEventForm((f) => ({ ...f, event_date: e.target.value }))} />
                              </div>
                              <div className="field">
                                <label className="t-label" htmlFor="event-location">Location (optional)</label>
                                <input id="event-location" className="input" value={eventForm.location}
                                  onChange={(e) => setEventForm((f) => ({ ...f, location: e.target.value }))} />
                              </div>
                              <div>
                                <button type="button" className="btn" disabled={busy} onClick={() => void handleCreateEvent()}>
                                  Add event
                                </button>
                              </div>
                            </div>
                          </section>

                          <section>
                            <h3 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>Roster</h3>
                            {!detailKnown ? detailUnknownLine : detail.roster.length === 0 ? (
                              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>No athletes on this season roster.</p>
                            ) : (
                              <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                                {detail.roster.map((entry) => (
                                  <li key={entry.entry_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                                    <span className="inline-flex flex-wrap items-center gap-[var(--s2)]">
                                      {entry.athlete_name} · {entry.status}
                                      {entry.status === 'active' && (
                                        <button type="button" className="btn btn--ghost" disabled={busy}
                                          onClick={() => void handleRosterInactive(entry)}>
                                          Mark inactive
                                        </button>
                                      )}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="mt-[var(--s3)] grid gap-[var(--s2)]">
                              <div className="field">
                                <label className="t-label" htmlFor="roster-athlete">Add athlete</label>
                                <select id="roster-athlete" className="select" value={rosterAthleteId}
                                  onChange={(e) => setRosterAthleteId(e.target.value)}>
                                  <option value="">Select an athlete…</option>
                                  {athletes.map((athlete) => (
                                    <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <button type="button" className="btn" disabled={busy || !rosterAthleteId} onClick={() => void handleAddRosterEntry()}>
                                  Add to roster
                                </button>
                              </div>
                            </div>
                          </section>
                        </div>
                        )
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <div className="mt-[var(--s6)]">
            <OperationsLink className="btn btn--ghost">
              Back to Mission Control
            </OperationsLink>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
