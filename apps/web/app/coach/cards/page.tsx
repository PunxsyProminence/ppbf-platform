'use client';

import { useCallback, useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatCalendarDay } from '@/lib/calendarDay';
import { formatGymStamp } from '@/src/lib/gymTime';

// Coach Cards -- issue work straight onto the assignment spine, to one
// athlete or to a whole program. No gap, no detection, no new engine: a
// card is a drill assignment the athlete already knows how to log against,
// and verification reuses the completions verify endpoint verbatim.

interface RosterAthlete {
  athlete_id: string;
  display_name: string;
}

interface ProgramOption {
  program_id: string;
  program_name: string;
  status: string;
  active_member_count: number;
}

interface DrillLibraryItem {
  drill_id: string;
  name: string;
  focus: string;
  difficulty: string;
  active: boolean;
}

interface CardCompletion {
  completion_id: string;
  completed_at: string;
  reps_completed: number | null;
  notes: string;
  verification_status: string;
  verified_at: string | null;
}

interface CoachCard {
  assignment_id: string;
  athlete_id: string;
  athlete_name: string;
  issuance_id: string | null;
  drill_name: string;
  drill_description: string;
  drill_display_name: string;
  drill_display_description: string;
  drill_difficulty: string;
  rep_count: number | null;
  duration_minutes: number | null;
  frequency_per_week: number | null;
  due_date: string | null;
  status: string;
  completion_percentage: number;
  assigned_at: string;
  completions: CardCompletion[];
}

interface IssuanceGroup {
  issuance_id: string | null;
  assigned_at: string;
  cards: CoachCard[];
}

interface IssuanceReport {
  program_id: string;
  program_name: string;
  issuance_id: string;
  issued: { athlete_id: string; athlete_name: string; assignment_id: string }[];
  skipped: { athlete_id: string; athlete_name: string }[];
}

const EMPTY_FORM = {
  athlete_id: '',
  program_id: '',
  title: '',
  description: '',
  drill_id: '',
  drill_difficulty: 'intermediate',
  rep_count: '',
  duration_minutes: '',
  frequency_per_week: '',
  due_date: '',
};

export default function CoachCardsPage() {
  const [mode, setMode] = useState<'athlete' | 'program'>('athlete');
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [roster, setRoster] = useState<RosterAthlete[]>([]);
  const [programs, setPrograms] = useState<ProgramOption[]>([]);
  const [drills, setDrills] = useState<DrillLibraryItem[]>([]);
  const [groups, setGroups] = useState<IssuanceGroup[]>([]);
  const [report, setReport] = useState<IssuanceReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const loadCards = useCallback(async () => {
    const res = await fetch(`${apiBase()}/api/pilot/coach/cards`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Failed to load cards: ${res.status}`);
    const data = (await res.json()) as { items?: IssuanceGroup[] };
    setGroups(data.items || []);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const [rosterRes, programsRes, drillsRes] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/admin/programs`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/drills`, { credentials: 'include' }),
        ]);
        if (rosterRes.ok) {
          const data = (await rosterRes.json()) as { items?: RosterAthlete[] };
          setRoster(data.items || []);
        }
        if (programsRes.ok) {
          const data = (await programsRes.json()) as { items?: ProgramOption[] };
          // Archived programs keep their history but are not offered new
          // work from this form.
          setPrograms((data.items || []).filter((program) => program.status === 'active'));
        }
        if (drillsRes.ok) {
          const data = (await drillsRes.json()) as { items?: DrillLibraryItem[] };
          setDrills((data.items || []).filter((drill) => drill.active));
        }
        await loadCards();
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Failed to load');
      } finally {
        setLoading(false);
      }
    })();
  }, [loadCards]);

  const onLibraryPick = (drillId: string) => {
    const drill = drills.find((item) => item.drill_id === drillId);
    if (!drill) {
      setForm((prev) => ({ ...prev, drill_id: '' }));
      return;
    }
    setForm((prev) => ({
      ...prev,
      drill_id: drill.drill_id,
      title: prev.title || drill.name,
      description: prev.description || drill.focus,
      drill_difficulty: drill.difficulty || 'intermediate',
    }));
  };

  const handleIssue = async () => {
    setErrorMessage('');
    if (mode === 'athlete' && !form.athlete_id) {
      setErrorMessage('Pick an athlete.');
      return;
    }
    if (mode === 'program' && !form.program_id) {
      setErrorMessage('Pick a program.');
      return;
    }
    if (!form.drill_id && (!form.title.trim() || !form.description.trim())) {
      setErrorMessage('Give the card a title and description, or pick a drill.');
      return;
    }
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        title: form.title.trim(),
        description: form.description.trim(),
        drill_difficulty: form.drill_difficulty,
      };
      if (mode === 'athlete') body.athlete_id = form.athlete_id;
      else body.program_id = form.program_id;
      if (form.drill_id) body.drill_id = form.drill_id;
      if (form.rep_count.trim()) body.rep_count = Number(form.rep_count);
      if (form.duration_minutes.trim()) body.duration_minutes = Number(form.duration_minutes);
      if (form.frequency_per_week.trim()) body.frequency_per_week = Number(form.frequency_per_week);
      if (form.due_date) body.due_date = form.due_date;

      const res = await fetch(`${apiBase()}/api/pilot/coach/cards`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `Issue failed (${res.status})`);
      }
      const payload = await res.json();
      // A group issue answers with the issued/skipped report; it is shown
      // verbatim so the coach knows exactly who got the card and who did not.
      setReport(mode === 'program' ? (payload as IssuanceReport) : null);
      setForm({ ...EMPTY_FORM });
      await loadCards();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to issue card');
    } finally {
      setBusy(false);
    }
  };

  const handleVerify = async (card: CoachCard, completion: CardCompletion, verified: boolean) => {
    setBusy(true);
    setErrorMessage('');
    try {
      const res = await fetch(`${apiBase()}/api/pilot/progression/completions`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          completion_id: completion.completion_id,
          athlete_id: card.athlete_id,
          verify: true,
          verified,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Verify failed');
      }
      await loadCards();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Verify failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/cards" allowedRoles={['coach']} room="floor" showShellHeader={false}>
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Coach Cards</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Issue Work. Watch It Land.</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            A card goes to one athlete or to a whole program. The athlete sees it on their progression page,
            logs completions against it, and you verify here. No gap required.
          </p>
        </header>

        {errorMessage && (
          <div className="alert alert--critical" role="alert">
            <span className="alert-icon" aria-hidden="true">✕</span>
            <div className="alert-body">
              <p className="alert-title">Failed</p>
              <p className="alert-msg">{errorMessage}</p>
            </div>
          </div>
        )}

        {/* Issue form */}
        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Issue a Card</h2>

          <div className="mt-[var(--s4)] flex gap-[var(--s2)]" role="group" aria-label="Card target">
            <button
              type="button"
              className={mode === 'athlete' ? 'btn' : 'btn btn--ghost'}
              aria-pressed={mode === 'athlete'}
              onClick={() => setMode('athlete')}
            >
              One athlete
            </button>
            <button
              type="button"
              className={mode === 'program' ? 'btn' : 'btn btn--ghost'}
              aria-pressed={mode === 'program'}
              onClick={() => setMode('program')}
            >
              Whole program
            </button>
          </div>

          <div className="mt-[var(--s4)] grid grid-cols-1 gap-[var(--s4)] md:grid-cols-2">
            {mode === 'athlete' ? (
              <div className="field">
                <label htmlFor="card-athlete" className="t-label">Athlete</label>
                <select
                  id="card-athlete"
                  className="select"
                  value={form.athlete_id}
                  onChange={(e) => setForm((prev) => ({ ...prev, athlete_id: e.target.value }))}
                >
                  <option value="">Choose from roster…</option>
                  {roster.map((athlete) => (
                    <option key={athlete.athlete_id} value={athlete.athlete_id}>
                      {athlete.display_name || athlete.athlete_id}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="card-program" className="t-label">Program</label>
                <select
                  id="card-program"
                  className="select"
                  value={form.program_id}
                  onChange={(e) => setForm((prev) => ({ ...prev, program_id: e.target.value }))}
                >
                  <option value="">Choose a program…</option>
                  {programs.map((program) => (
                    <option key={program.program_id} value={program.program_id}>
                      {program.program_name} ({program.active_member_count} active)
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="field">
              <label htmlFor="card-drill" className="t-label">From the drill library (optional)</label>
              <select
                id="card-drill"
                className="select"
                value={form.drill_id}
                onChange={(e) => onLibraryPick(e.target.value)}
              >
                <option value="">Type it out instead…</option>
                {drills.map((drill) => (
                  <option key={drill.drill_id} value={drill.drill_id}>{drill.name}</option>
                ))}
              </select>
            </div>

            <div className="field">
              <label htmlFor="card-title" className="t-label">Title</label>
              <input
                id="card-title"
                type="text"
                className="input"
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                placeholder="Shadowbox: 3 rounds, southpaw looks"
              />
            </div>

            <div className="field">
              <label htmlFor="card-difficulty" className="t-label">Difficulty</label>
              <select
                id="card-difficulty"
                className="select"
                value={form.drill_difficulty}
                onChange={(e) => setForm((prev) => ({ ...prev, drill_difficulty: e.target.value }))}
              >
                <option value="beginner">beginner</option>
                <option value="intermediate">intermediate</option>
                <option value="advanced">advanced</option>
                <option value="elite">elite</option>
              </select>
            </div>

            <div className="field md:col-span-2">
              <label htmlFor="card-description" className="t-label">Description</label>
              <textarea
                id="card-description"
                className="textarea"
                rows={2}
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="What exactly to do, and what to focus on."
              />
            </div>

            <div className="field">
              <label htmlFor="card-reps" className="t-label">Reps (optional)</label>
              <input
                id="card-reps"
                type="number"
                min={0}
                className="input"
                value={form.rep_count}
                onChange={(e) => setForm((prev) => ({ ...prev, rep_count: e.target.value }))}
              />
            </div>

            <div className="field">
              <label htmlFor="card-duration" className="t-label">Duration, minutes (optional)</label>
              <input
                id="card-duration"
                type="number"
                min={0}
                className="input"
                value={form.duration_minutes}
                onChange={(e) => setForm((prev) => ({ ...prev, duration_minutes: e.target.value }))}
              />
            </div>

            <div className="field">
              <label htmlFor="card-frequency" className="t-label">Sessions per week (optional)</label>
              <input
                id="card-frequency"
                type="number"
                min={1}
                className="input"
                value={form.frequency_per_week}
                onChange={(e) => setForm((prev) => ({ ...prev, frequency_per_week: e.target.value }))}
              />
              {/* Honest statement of touchAssignmentProgress's no-frequency
                  rule rather than a silently imposed default. */}
              <p className="t-muted mt-[var(--s2)] text-[length:var(--t-xs)]">
                Left blank, each logged session counts 25% and four logs complete the card.
              </p>
            </div>

            <div className="field">
              <label htmlFor="card-due" className="t-label">Due date (optional)</label>
              <input
                id="card-due"
                type="date"
                className="input"
                value={form.due_date}
                onChange={(e) => setForm((prev) => ({ ...prev, due_date: e.target.value }))}
              />
            </div>
          </div>

          <div className="mt-[var(--s4)]">
            <button type="button" className="btn" disabled={busy} onClick={() => void handleIssue()}>
              {busy ? 'Issuing…' : mode === 'program' ? 'Issue to program' : 'Issue card'}
            </button>
          </div>
        </section>

        {/* Group issuance report, verbatim */}
        {report && (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]" aria-label="Issuance report">
            <h2 className="t-command text-[length:var(--t-lg)]">Issued to {report.program_name}</h2>
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
              {report.issued.length} issued, {report.skipped.length} skipped.
            </p>
            {report.issued.length > 0 && (
              <div className="mt-[var(--s3)]">
                <p className="t-label">Issued</p>
                <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                  {report.issued.map((entry) => (
                    <li key={entry.athlete_id} className="t-body text-[length:var(--t-sm)]">{entry.athlete_name}</li>
                  ))}
                </ul>
              </div>
            )}
            {report.skipped.length > 0 && (
              <div className="mt-[var(--s3)]">
                <p className="t-label">Skipped — not on your roster or coverage</p>
                <ul className="mt-[var(--s2)] space-y-[var(--s1)]">
                  {report.skipped.map((entry) => (
                    <li key={entry.athlete_id} className="t-body text-[length:var(--t-sm)]">{entry.athlete_name}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {/* Issued cards, grouped by issuance */}
        <section>
          <h2 className="t-command mb-[var(--s4)] text-[length:var(--t-lg)]">My Cards</h2>
          {loading ? (
            <p className="t-body text-[color:var(--bone-300)]">Loading cards…</p>
          ) : groups.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty" style={{ padding: 'var(--s6) var(--s5)' }}>
                <p className="empty-msg mx-auto">No cards issued yet</p>
              </div>
            </div>
          ) : (
            <div className="space-y-[var(--s4)]">
              {groups.map((group) => {
                const first = group.cards[0];
                return (
                  <div key={group.issuance_id ?? first.assignment_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">
                        {first.drill_display_name || first.drill_name}
                      </p>
                      {group.issuance_id ? (
                        <span className="badge badge--monitor"><i aria-hidden="true">◉</i>group · {group.cards.length}</span>
                      ) : (
                        <span className="badge badge--cleared"><i aria-hidden="true">✓</i>individual</span>
                      )}
                      <span className="t-data text-[length:var(--t-xs)] text-[color:var(--bone-400)]">
                        {formatGymStamp(group.assigned_at)}
                      </span>
                      {first.due_date && (
                        <span className="t-data text-[length:var(--t-xs)] text-[color:var(--bone-400)]">
                          due {formatCalendarDay(first.due_date)}
                        </span>
                      )}
                    </div>
                    <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                      {first.drill_display_description || first.drill_description}
                    </p>

                    <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                      {group.cards.map((card) => (
                        <li key={card.assignment_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]">
                          <div className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                            <p className="t-body font-semibold">{card.athlete_name}</p>
                            <p className="t-data text-[length:var(--t-xs)] text-[color:var(--bone-400)]">
                              {card.completion_percentage}% · {card.status.replaceAll('_', ' ')}
                            </p>
                          </div>
                          {card.completions.length > 0 && (
                            <div className="mt-[var(--s2)] space-y-[var(--s2)]">
                              {card.completions.map((completion) => (
                                <div
                                  key={completion.completion_id}
                                  className="flex flex-wrap items-center justify-between gap-[var(--s2)]"
                                >
                                  <div>
                                    <span className="t-data text-[length:var(--t-xs)]">{formatGymStamp(completion.completed_at)}</span>
                                    <span className="t-data ml-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-400)]">
                                      {completion.verification_status}
                                    </span>
                                    {completion.notes ? (
                                      <p className="t-muted mt-[var(--s1)] text-[length:var(--t-xs)]">{completion.notes}</p>
                                    ) : null}
                                  </div>
                                  {completion.verification_status === 'pending' && (
                                    <div className="flex gap-[var(--s2)]">
                                      <button
                                        type="button"
                                        className="btn btn--ghost"
                                        disabled={busy}
                                        onClick={() => void handleVerify(card, completion, true)}
                                      >
                                        Verify
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn--ghost"
                                        disabled={busy}
                                        onClick={() => void handleVerify(card, completion, false)}
                                      >
                                        Dispute
                                      </button>
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </RoleStandaloneView>
  );
}
