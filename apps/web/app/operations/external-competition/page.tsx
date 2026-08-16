'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';

// External competition minimal skeleton (owner decision 2026-08-15: build
// both competition skeletons deliberately skeletal). Competition and entry
// records -- enough to write down where the gym is taking athletes and who
// is going. Federation integration, result sync, brackets, travel, and
// compliance checklists stay unbuilt until real competitions define them;
// the page says so instead of pretending.
//
// Entry rows carry athlete links; names come from the org-scoped athlete
// read. Coaches can read everything here; creating records is admin work
// (the API enforces it -- COMPETITION_WRITE_ROLES).

interface CompetitionRow {
  competition_id: string;
  competition_name: string;
  competition_date: string;
  location: string;
  sanctioning_body: string;
  status: string;
  notes: string;
}

interface EntryRow {
  entry_id: string;
  athlete_id: string;
  athlete_name: string;
  status: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const COMPETITION_BADGE: Record<string, { className: string; glyph: string }> = {
  planned: { className: 'badge badge--monitor', glyph: '◉' },
  completed: { className: 'badge badge--filed', glyph: '▣' },
  cancelled: { className: 'badge badge--locked', glyph: '✕' },
};

const COMPETITION_ACTIONS: Record<string, Array<{ status: string; label: string }>> = {
  planned: [{ status: 'completed', label: 'Mark completed' }, { status: 'cancelled', label: 'Cancel' }],
  completed: [{ status: 'planned', label: 'Reopen' }],
  cancelled: [{ status: 'planned', label: 'Reopen' }],
};

export default function ExternalCompetitionPlatformPage() {
  const [competitions, setCompetitions] = useState<CompetitionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ competition_name: '', competition_date: '', location: '', sanctioning_body: '' });

  const [selectedCompetitionId, setSelectedCompetitionId] = useState<string | null>(null);
  const [entries, setEntries] = useState<EntryRow[]>([]);
  const [entriesLoading, setEntriesLoading] = useState(false);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [entryAthleteId, setEntryAthleteId] = useState('');

  const reloadCompetitions = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/operations/external-competition/competitions`, {
      method: 'GET',
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load competitions.');
    const payload = (await response.json()) as { items?: CompetitionRow[] };
    setCompetitions(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reloadCompetitions(controller.signal);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load competitions.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reloadCompetitions]);

  const reloadEntries = useCallback(async (competitionId: string, signal?: AbortSignal) => {
    const response = await fetch(
      `${apiBase()}/api/pilot/operations/external-competition/entries?competition_id=${encodeURIComponent(competitionId)}`,
      { credentials: 'include', signal },
    );
    if (!response.ok) throw new Error('Unable to load the entry list.');
    const payload = (await response.json()) as { items?: EntryRow[] };
    setEntries(payload.items ?? []);
  }, []);

  // The loading flag is raised in the click handler that selects the
  // competition, not here: setState synchronously inside an effect body
  // cascades renders (react-hooks/set-state-in-effect). The effect only
  // loads and lowers it.
  useEffect(() => {
    if (!selectedCompetitionId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        await reloadEntries(selectedCompetitionId, controller.signal);
        if (controller.signal.aborted) return;
        setErrorMessage(null);
        setEntriesLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the entry list.');
        setEntriesLoading(false);
      }
    })();
    return () => controller.abort();
  }, [selectedCompetitionId, reloadEntries]);

  // Athlete options for the entry picker, loaded once. A viewer whose role
  // gets an empty or refused list simply sees no options -- the entry POST
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
        // Silent: the picker degrades to empty; entry reads still render.
      }
    })();
    return () => controller.abort();
  }, []);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/operations/external-competition/competitions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Create failed (${response.status})`);
      }
      setShowForm(false);
      setForm({ competition_name: '', competition_date: '', location: '', sanctioning_body: '' });
      await reloadCompetitions();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the competition.');
    } finally {
      setBusy(false);
    }
  };

  const handleStatus = async (competitionId: string, status: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/operations/external-competition/competitions`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competition_id: competitionId, status }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Update failed (${response.status})`);
      }
      await reloadCompetitions();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update the competition.');
    } finally {
      setBusy(false);
    }
  };

  const handleAddEntry = async () => {
    if (!selectedCompetitionId || !entryAthleteId) return;
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/operations/external-competition/entries`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competition_id: selectedCompetitionId, athlete_id: entryAthleteId }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Entry failed (${response.status})`);
      }
      setEntryAthleteId('');
      await reloadEntries(selectedCompetitionId);
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to add the entry.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="space-y-[var(--s4)] border-b-2 border-[color:var(--brass-700)] pb-[var(--s6)]">
            <p className="t-eyebrow tracking-[0.18em]">Operations Workspace</p>
            <h1 className="t-command" style={{ fontSize: 'var(--t-2xl)' }}>External Competition Platform</h1>
            <p className="t-body max-w-[80ch]">
              Minimal skeleton by owner decision: competition and entry records only.
              Federation integration, result sync, brackets, travel, and compliance checklists
              stay unbuilt until real competitions define what they must be. Admin roles create
              records; coaches read.
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
              <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Competitions</h2>
              <button type="button" className="btn" onClick={() => setShowForm((current) => !current)}>
                {showForm ? 'Close form' : 'Add competition'}
              </button>
            </div>

            {showForm && (
              <div className="mat-leather mt-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="grid gap-[var(--s3)] md:grid-cols-2">
                  <div className="field">
                    <label className="t-label" htmlFor="competition-name">Competition name</label>
                    <input id="competition-name" className="input" value={form.competition_name}
                      onChange={(e) => setForm((f) => ({ ...f, competition_name: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="competition-date">Date</label>
                    <input id="competition-date" type="date" className="input" value={form.competition_date}
                      onChange={(e) => setForm((f) => ({ ...f, competition_date: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="competition-location">Location (optional)</label>
                    <input id="competition-location" className="input" value={form.location}
                      onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} />
                  </div>
                  <div className="field">
                    <label className="t-label" htmlFor="sanctioning-body">Sanctioning body (optional)</label>
                    <input id="sanctioning-body" className="input" value={form.sanctioning_body}
                      onChange={(e) => setForm((f) => ({ ...f, sanctioning_body: e.target.value }))} />
                  </div>
                </div>
                <div className="mt-[var(--s4)]">
                  <button type="button" className="btn" disabled={busy} onClick={() => void handleCreate()}>
                    {busy ? 'Saving…' : 'Save competition'}
                  </button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-[var(--s7)]">
                <span className="working">Loading competitions...</span>
              </div>
            ) : competitions.length === 0 ? (
              <div className="mat-leather mt-[var(--s4)] rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">No competitions on record</div>
                  <p className="empty-msg mx-auto">When the gym enters an outside meet or tournament, it gets filed here.</p>
                </div>
              </div>
            ) : (
              <ul className="mt-[var(--s4)] space-y-[var(--s3)]">
                {competitions.map((competition) => {
                  const badge = COMPETITION_BADGE[competition.status] ?? COMPETITION_BADGE.planned;
                  const selected = competition.competition_id === selectedCompetitionId;
                  return (
                    <li key={competition.competition_id} className={`mat-leather rounded-[var(--r-lg)] p-[var(--s4)]${selected ? ' mat-leather--raised' : ''}`}>
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <span className="t-body font-semibold text-[color:var(--bone-100)]">{competition.competition_name}</span>
                        <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{competition.status}</span>
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                          {formatGymDateNumeric(competition.competition_date)}
                          {competition.location ? ` · ${competition.location}` : ''}
                          {competition.sanctioning_body ? ` · ${competition.sanctioning_body}` : ''}
                        </span>
                        <button type="button" className="btn btn--ghost" onClick={() => {
                          setEntriesLoading(!selected);
                          setSelectedCompetitionId(selected ? null : competition.competition_id);
                        }}>
                          {selected ? 'Close entries' : 'Open entries'}
                        </button>
                        {(COMPETITION_ACTIONS[competition.status] ?? []).map((action) => (
                          <button key={action.status} type="button" className="btn btn--ghost" disabled={busy}
                            onClick={() => void handleStatus(competition.competition_id, action.status)}>
                            {action.label}
                          </button>
                        ))}
                      </div>

                      {selected && (
                        entriesLoading ? (
                          <div className="mt-[var(--s4)]"><span className="working">Loading entries...</span></div>
                        ) : (
                          <div className="mt-[var(--s4)]">
                            <h3 className="t-command" style={{ fontSize: 'var(--t-sm)' }}>Entries</h3>
                            {entries.length === 0 ? (
                              <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>No athletes entered.</p>
                            ) : (
                              <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
                                {entries.map((entry) => (
                                  <li key={entry.entry_id} className="t-body" style={{ fontSize: 'var(--t-sm)' }}>
                                    {entry.athlete_name} · {entry.status}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <div className="mt-[var(--s3)] grid gap-[var(--s2)] md:max-w-sm">
                              <div className="field">
                                <label className="t-label" htmlFor="entry-athlete">Enter athlete</label>
                                <select id="entry-athlete" className="select" value={entryAthleteId}
                                  onChange={(e) => setEntryAthleteId(e.target.value)}>
                                  <option value="">Select an athlete…</option>
                                  {athletes.map((athlete) => (
                                    <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <button type="button" className="btn" disabled={busy || !entryAthleteId} onClick={() => void handleAddEntry()}>
                                  Add entry
                                </button>
                              </div>
                            </div>
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
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
