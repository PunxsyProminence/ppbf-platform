'use client';

import { useCallback, useEffect, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric } from '@/src/lib/gymTime';
import { NOT_SURE, refusalWords } from '@/src/lib/serverRefusalWords';
import BackHome from '@/components/BackHome';

// Program memberships and scholarships (radar rows "Membership Tracking" and
// "Scholarship Tracking"). A scholarship is a stored DISCOUNT on a real
// membership -- 100% for a full scholarship -- never a bypass: the athlete
// has a membership row like everyone else, and when charging arrives the fee
// computes from this record. Nothing on this page bills anyone.
//
// Membership rows carry athlete links; names come from the org-scoped
// athlete read. Admin-only, both directions (the API enforces it).

interface MembershipRow {
  membership_id: string;
  athlete_id: string;
  athlete_name: string;
  program_name: string;
  status: string;
  started_on: string;
  ended_on: string | null;
  scholarship_percent: number;
  scholarship_note: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

// The programs catalog (pilot.programs): enrollment picks a program from
// here instead of retyping its name, so "Junior Boxing" can never drift
// into "Jr Boxing" and silently split one group into two ledgers.
interface ProgramRow {
  program_id: string;
  program_name: string;
  status: string;
  active_member_count: number;
}

const STATUS_BADGE: Record<string, { className: string; glyph: string }> = {
  active: { className: 'badge badge--cleared', glyph: '✓' },
  lapsed: { className: 'badge badge--restricted', glyph: '▲' },
  ended: { className: 'badge badge--filed', glyph: '▣' },
};

const NEXT_ACTIONS: Record<string, Array<{ status: string; label: string }>> = {
  active: [{ status: 'lapsed', label: 'Mark lapsed' }, { status: 'ended', label: 'End membership' }],
  lapsed: [{ status: 'active', label: 'Reactivate' }, { status: 'ended', label: 'End membership' }],
  ended: [],
};

const SCHOLARSHIP_LEVELS = [0, 25, 50, 75, 100];

const PROGRAM_BADGE: Record<string, { className: string; glyph: string }> = {
  active: { className: 'badge badge--cleared', glyph: '✓' },
  archived: { className: 'badge badge--filed', glyph: '▣' },
};

type EnrollForm = { athlete_id: string; program_name: string; started_on: string; scholarship_percent: number };
const EMPTY_FORM: EnrollForm = { athlete_id: '', program_name: '', started_on: '', scholarship_percent: 0 };

// The enrollment route's own refusals, in words an office admin can act on
// (route.ts POST). The duplicate-active sentence is already words and passes
// through. PROPOSED (lane L41).
const ENROLL_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'Missing athlete_id.': 'Choose an athlete.',
  'Missing program_name.': 'Choose a program.',
  'started_on must be YYYY-MM-DD.': 'Choose a start date.',
  'Not found': "That athlete is not on this gym's roster.",
};
// PROPOSED (lane L41).
const ROW_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  'Not found': 'That membership could not be found.',
};

/** A save counts as confirmed only when the reply carries the row that was asked for. */
function isSavedRow(item: unknown, sent: EnrollForm): item is MembershipRow {
  if (!item || typeof item !== 'object') return false;
  const row = item as Partial<MembershipRow>;
  return typeof row.membership_id === 'string' && row.membership_id !== ''
    && row.athlete_id === sent.athlete_id
    && row.program_name === sent.program_name.trim()
    && row.status === 'active';
}

/** Words for a write the server answered with an error: a 4xx changed nothing; anything else may have. */
async function writeFailureWords(response: Response, known: Readonly<Record<string, string>>): Promise<string> {
  const payload = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (response.status >= 400 && response.status < 500) {
    return `Not saved. ${refusalWords({ error: payload.error, status: response.status }, known, 'Try again.')}`;
  }
  return NOT_SURE;
}

// The athlete list feeds every athlete picker on this page. A failed read is
// not an empty roster, so each picker says which one it is.
function RosterNotice({ state, empty, onCheckAgain }: {
  state: 'loading' | 'loaded' | 'failed';
  empty: boolean;
  onCheckAgain: () => void;
}) {
  if (state === 'loading') return <p className="working mt-[var(--s2)]">Loading the athlete list…</p>;
  if (state === 'failed') {
    return (
      <div className="mt-[var(--s2)] flex items-center gap-[var(--s2)]" role="status">
        <p className="t-body">Couldn&apos;t load the athlete list.</p>
        <button type="button" className="btn--lever" onClick={onCheckAgain}>Check again</button>
      </div>
    );
  }
  return empty ? <p className="t-body mt-[var(--s2)]">No athletes on this gym&apos;s roster yet.</p> : null;
}

export default function MembershipsPage() {
  const [items, setItems] = useState<MembershipRow[]>([]);
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [loading, setLoading] = useState(true);
  // True once a read of the memberships list has come back. Until then an
  // empty list is not a record of none, so the empty sentence stays hidden.
  const [listRead, setListRead] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<EnrollForm>(EMPTY_FORM);
  const [roster, setRoster] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [rosterAttempt, setRosterAttempt] = useState(0);
  // What a write is known to have done when that is not plain failure: saved
  // but the list did not refresh, or not known yet. `recheck` is what Check
  // again does: re-read the list, or re-read it to settle an unconfirmed save.
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string; recheck: 'list' | 'save' | null } | null>(null);
  const [pendingSave, setPendingSave] = useState<EnrollForm | null>(null);
  const [checking, setChecking] = useState(false);
  const [programs, setPrograms] = useState<ProgramRow[]>([]);
  const [programsLoad, setProgramsLoad] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [showNewProgram, setShowNewProgram] = useState(false);
  const [newProgramName, setNewProgramName] = useState('');
  const [catalogProgramName, setCatalogProgramName] = useState('');

  const reload = useCallback(async (signal?: AbortSignal): Promise<MembershipRow[]> => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/memberships`, {
        method: 'GET',
        credentials: 'include',
        signal,
      });
      if (!response.ok) throw new Error('Unable to load memberships.');
      const payload = (await response.json()) as { items?: MembershipRow[] };
      const rows = payload.items ?? [];
      setItems(rows);
      setListRead(true);
      return rows;
    } catch (error) {
      // A failed re-read after a write leaves the list stale: rows on screen
      // stay, but an empty list is no longer a record of none.
      setListRead(false);
      throw error;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
      } catch {
        // The list block says it could not load; an aborted load is the page
        // unmounting, not a failure to report.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Unable to load athletes.');
        const payload = (await response.json()) as { items?: AthleteOption[] };
        if (controller.signal.aborted) return;
        setAthletes(payload.items ?? []);
        setRoster('loaded');
      } catch {
        if (controller.signal.aborted) return;
        setRoster('failed');
      }
    })();
    return () => controller.abort();
  }, [rosterAttempt]);

  const checkRosterAgain = () => {
    setRoster('loading');
    setRosterAttempt((attempt) => attempt + 1);
  };

  const reloadPrograms = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/admin/programs`, {
      method: 'GET',
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load programs.');
    const payload = (await response.json()) as { items?: ProgramRow[] };
    setPrograms(payload.items ?? []);
    setProgramsLoad('loaded');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reloadPrograms(controller.signal);
      } catch {
        // The select degrades to empty; the catalog section says the list
        // could not be read rather than "no programs", which would invite a
        // duplicate program. The page still renders.
        if (controller.signal.aborted) return;
        setProgramsLoad((current) => (current === 'loaded' ? current : 'unavailable'));
      }
    })();
    return () => controller.abort();
  }, [reloadPrograms]);

  /** POSTs a new program to the catalog; returns the created row or null. */
  const postProgram = async (name: string): Promise<ProgramRow | null> => {
    setBusyId('program-new');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/programs`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program_name: name }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Create failed (${response.status})`);
      }
      const payload = (await response.json()) as { item?: ProgramRow };
      const created = payload.item ?? null;
      // The catalog write has already succeeded; from here on nothing may
      // report the create as failed or lose the new program. The POST
      // returns the counted row shape, so it can stand in for the list
      // entry until a refresh lands.
      if (created) {
        setPrograms((current) => [
          ...current.filter((program) => program.program_id !== created.program_id),
          created,
        ]);
      }
      try {
        await reloadPrograms();
        setErrorMessage(null);
      } catch {
        // Non-fatal: the optimistic row keeps the flow working; the banner
        // only reports the stale list.
        setErrorMessage('The program was created, but the program list could not be refreshed.');
      }
      return created;
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to create the program.');
      return null;
    } finally {
      setBusyId(null);
    }
  };

  /** The enroll form's inline affordance: create, then select the new program. */
  const handleAddProgram = async () => {
    const created = await postProgram(newProgramName);
    if (!created) return;
    setForm((f) => ({ ...f, program_name: created.program_name }));
    setNewProgramName('');
    setShowNewProgram(false);
  };

  const patchProgram = async (programId: string, status: 'active' | 'archived') => {
    setBusyId(`program-${programId}`);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/programs`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ program_id: programId, status }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Update failed (${response.status})`);
      }
      await reloadPrograms();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to update the program.');
    } finally {
      setBusyId(null);
    }
  };

  /** Re-reads the list; true when it came back. A "didn't refresh" notice clears once it does. */
  const recheckList = async (): Promise<boolean> => {
    try {
      await reload();
      setNotice((current) => (current?.recheck === 'list' ? null : current));
      return true;
    } catch {
      return false;
    }
  };

  const patch = async (membershipId: string, body: Record<string, unknown>) => {
    setBusyId(membershipId);
    setErrorMessage(null);
    setNotice(null);
    try {
      let response: Response | null = null;
      try {
        response = await fetch(`${apiBase()}/api/pilot/admin/memberships`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ membership_id: membershipId, ...body }),
        });
      } catch {
        // No answer: the change may or may not have landed.
      }
      if (response && response.status >= 400 && response.status < 500) {
        setErrorMessage(await writeFailureWords(response, ROW_REFUSAL_WORDS));
        return;
      }
      if (response?.ok) {
        // The change is saved; a failed refresh is only a stale list.
        if (!(await recheckList())) setNotice({ tone: 'warning', text: "Saved. The list didn't refresh.", recheck: 'list' });
        return;
      }
      // A 5xx or no answer: re-read so the rows on screen are what the server holds.
      setErrorMessage(NOT_SURE);
      if (!(await recheckList())) setNotice({ tone: 'warning', text: "The list didn't refresh.", recheck: 'list' });
    } finally {
      setBusyId(null);
    }
  };

  /** Settles a save whose answer was lost by saying what the list now shows. */
  const settleSave = async (sent: EnrollForm) => {
    const program = sent.program_name.trim();
    const pickedName = athletes.find((athlete) => athlete.athlete_id === sent.athlete_id)?.full_name ?? 'this athlete';
    let rows: MembershipRow[];
    try {
      rows = await reload();
    } catch {
      // The form keeps what was typed until the list can be read.
      setPendingSave(sent);
      setNotice({ tone: 'warning', text: 'Not sure it was saved, and the list could not be read. Check before saving again.', recheck: 'save' });
      return;
    }
    setPendingSave(null);
    const shown = rows.find((row) => row.athlete_id === sent.athlete_id && row.program_name === program && row.status === 'active');
    if (!shown) {
      setNotice(null);
      setErrorMessage(`Not saved: the list does not show ${pickedName} active in ${program}. Save again when ready.`);
      return;
    }
    setErrorMessage(null);
    setNotice({ tone: 'success', text: `The list now shows ${shown.athlete_name} active in ${shown.program_name}. No need to save again.`, recheck: null });
    // A form retyped for another enrollment while this one was unsettled stays.
    if (JSON.stringify(form) !== JSON.stringify(sent)) return;
    setShowForm(false);
    setForm(EMPTY_FORM);
  };

  const handleCreate = async () => {
    const sent = form;
    setBusyId('new');
    setErrorMessage(null);
    setNotice(null);
    setPendingSave(null);
    try {
      let response: Response | null = null;
      try {
        response = await fetch(`${apiBase()}/api/pilot/admin/memberships`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sent),
        });
      } catch {
        // No answer at all: settled below by reading the list.
      }
      if (response && response.status >= 400 && response.status < 500) {
        // Refused before writing: nothing saved, and the form keeps what was typed.
        setErrorMessage(await writeFailureWords(response, ENROLL_REFUSAL_WORDS));
        return;
      }
      const payload = response?.ok ? ((await response.json().catch(() => null)) as { item?: unknown } | null) : null;
      if (payload && isSavedRow(payload.item, sent)) {
        // Confirmed: from here nothing may report the save as failed or lose
        // the row. The reply is the list's own row shape, so it stands in
        // until a refresh lands.
        const saved = payload.item;
        setItems((current) => [...current.filter((row) => row.membership_id !== saved.membership_id), saved]);
        setShowForm(false);
        setForm(EMPTY_FORM);
        if (!(await recheckList())) {
          setNotice({ tone: 'warning', text: `Saved: ${saved.athlete_name} in ${saved.program_name}. The list didn't refresh.`, recheck: 'list' });
        }
        return;
      }
      // A 5xx, no answer, or a reply that does not show the row: not known yet.
      await settleSave(sent);
    } finally {
      setBusyId(null);
    }
  };

  const checkAgain = async () => {
    setChecking(true);
    try {
      if (notice?.recheck === 'save' && pendingSave) await settleSave(pendingSave);
      else await recheckList();
    } finally {
      setChecking(false);
    }
  };

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Revenue</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Program Memberships</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Who is enrolled in what, with scholarships recorded as discounts — a full scholarship
              is 100%, never an athlete waved invisibly past the system. No billing happens here;
              fees are planned with the payment lanes, and nothing reads these records for billing yet.
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

          {notice && (
            <div className={`alert alert--${notice.tone}`} role="status">
              <span className="alert-icon" aria-hidden="true">{notice.tone === 'success' ? '✓' : '▲'}</span>
              <div className="alert-body">
                <p className="alert-msg">{notice.text}</p>
                {notice.recheck && (
                  <div className="alert-action">
                    <button type="button" className="btn btn--ghost" disabled={checking} onClick={() => void checkAgain()}>
                      Check again
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="mb-[var(--s4)]">
            <button type="button" className="btn" onClick={() => setShowForm((current) => !current)}>
              {showForm ? 'Close form' : 'Enroll athlete'}
            </button>
          </div>

          {showForm && (
            /* "Paper forms" is this room's Feel line and mat-paper appeared on
               no /admin route. The design system's own guardian-portal screen
               is the pattern: .field / .input / .select / .btn on a paper
               panel. */
            <section className="mat-paper mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
              <div className="grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label className="t-label" htmlFor="membership-athlete">Athlete</label>
                  <select id="membership-athlete" className="select" value={form.athlete_id}
                    onChange={(e) => setForm((f) => ({ ...f, athlete_id: e.target.value }))}>
                    <option value="">Choose an athlete</option>
                    {athletes.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                    ))}
                  </select>
                  <RosterNotice state={roster} empty={athletes.length === 0} onCheckAgain={checkRosterAgain} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="program-name">Program</label>
                  {/* A select fed by the catalog, not free text: retyping the
                      name is how one group used to split into two spellings. */}
                  <select id="program-name" className="select" value={form.program_name}
                    onChange={(e) => setForm((f) => ({ ...f, program_name: e.target.value }))}>
                    <option value="">Select a program…</option>
                    {programs.filter((program) => program.status === 'active').map((program) => (
                      <option key={program.program_id} value={program.program_name}>{program.program_name}</option>
                    ))}
                  </select>
                  {showNewProgram ? (
                    <div className="mt-[var(--s2)] flex items-center gap-[var(--s2)]">
                      <input aria-label="New program name" className="input" value={newProgramName}
                        onChange={(e) => setNewProgramName(e.target.value)} />
                      <button type="button" className="btn" disabled={busyId === 'program-new' || !newProgramName.trim()}
                        onClick={() => void handleAddProgram()}>
                        {busyId === 'program-new' ? 'Adding…' : 'Add program'}
                      </button>
                    </div>
                  ) : (
                    <button type="button" className="btn--lever mt-[var(--s2)]" onClick={() => setShowNewProgram(true)}>
                      New program
                    </button>
                  )}
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="started-on">Start date</label>
                  <input id="started-on" type="date" className="input" value={form.started_on}
                    onChange={(e) => setForm((f) => ({ ...f, started_on: e.target.value }))} />
                </div>
                <div className="field">
                  <label className="t-label" htmlFor="scholarship-percent">Scholarship</label>
                  <select id="scholarship-percent" className="select" value={form.scholarship_percent}
                    onChange={(e) => setForm((f) => ({ ...f, scholarship_percent: Number(e.target.value) }))}>
                    {SCHOLARSHIP_LEVELS.map((level) => (
                      <option key={level} value={level}>{level === 0 ? 'None' : `${level}% discount`}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="mt-[var(--s4)]">
                <button type="button" className="btn" disabled={busyId === 'new'} onClick={() => void handleCreate()}>
                  {busyId === 'new' ? 'Saving…' : 'Save membership'}
                </button>
              </div>
            </section>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading memberships...</span>
            </div>
          ) : !listRead && items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">Couldn&apos;t load memberships.</div>
                <button type="button" className="btn btn--ghost mt-[var(--s3)]" disabled={checking} onClick={() => void checkAgain()}>
                  Check again
                </button>
              </div>
            </div>
          ) : items.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No memberships on record</div>
                <p className="empty-msg mx-auto">When an athlete enrolls in a program, it gets filed here.</p>
              </div>
            </div>
          ) : (
            /* Enrollments are records, not cards: one ruled row each, on the
               sheet this office keeps its registers on. */
            <section className="mat-paper overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
              <table className="ledger">
                <caption className="text-left">Program memberships</caption>
                <thead>
                  <tr>
                    <th scope="col">Athlete</th>
                    <th scope="col">Program</th>
                    <th scope="col">Status</th>
                    <th scope="col">Scholarship</th>
                    <th scope="col">Dates</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => {
                    const badge = STATUS_BADGE[row.status] ?? STATUS_BADGE.active;
                    return (
                      <tr key={row.membership_id}>
                        <td className="font-bold">{row.athlete_name}</td>
                        <td>{row.program_name}</td>
                        <td><span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{row.status}</span></td>
                        <td>
                          {row.scholarship_percent > 0 ? (
                            <span className="badge badge--monitor"><i aria-hidden="true">◉</i>{row.scholarship_percent}% scholarship</span>
                          ) : (
                            <span aria-hidden="true">—</span>
                          )}
                        </td>
                        <td className="ledger-id whitespace-nowrap">
                          since {formatGymDateNumeric(row.started_on)}
                          {row.ended_on ? ` — ended ${formatGymDateNumeric(row.ended_on)}` : ''}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-[var(--s2)]">
                            {/* .btn--ghost is bone text on a translucent black
                                wash, tuned for leather; a lever carries its own
                                dark surface and reads on the sheet. */}
                            {(NEXT_ACTIONS[row.status] ?? []).map((action) => (
                              <button key={action.status} type="button" className="btn--lever"
                                disabled={busyId === row.membership_id}
                                onClick={() => void patch(row.membership_id, { status: action.status })}>
                                {action.label}
                              </button>
                            ))}
                            {row.status !== 'ended' && (
                              <label className="t-label flex items-center gap-[var(--s2)]" htmlFor={`scholarship-${row.membership_id}`}>
                                Scholarship
                                <select id={`scholarship-${row.membership_id}`} className="select" value={row.scholarship_percent}
                                  disabled={busyId === row.membership_id}
                                  onChange={(e) => void patch(row.membership_id, { scholarship_percent: Number(e.target.value) })}>
                                  {SCHOLARSHIP_LEVELS.map((level) => (
                                    <option key={level} value={level}>{level === 0 ? 'None' : `${level}%`}</option>
                                  ))}
                                </select>
                              </label>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          {/* The catalog itself: every persistent group this gym runs, with
              its live headcount. Archiving retires the name from the enroll
              select; it never touches membership rows -- enrollment history
              is a record, not a casualty of tidying the list. */}
          <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
            {programsLoad === 'loading' ? (
              <div className="flex justify-center py-[var(--s5)]">
                <span className="working">Loading programs...</span>
              </div>
            ) : programsLoad === 'unavailable' ? (
              <div className="empty">
                <div className="empty-title">Programs could not be read</div>
                <p className="empty-msg mx-auto">This is not a record of none, and a program may already exist. Reload the page before creating one.</p>
              </div>
            ) : programs.length === 0 ? (
              <div className="empty">
                <div className="empty-title">No programs on record</div>
                <p className="empty-msg mx-auto">Create the first program to enroll athletes into it.</p>
              </div>
            ) : (
              <table className="ledger">
                <caption className="text-left">Programs</caption>
                <thead>
                  <tr>
                    <th scope="col">Program</th>
                    <th scope="col">Status</th>
                    <th scope="col">Active members</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {programs.map((program) => {
                    const badge = PROGRAM_BADGE[program.status] ?? PROGRAM_BADGE.active;
                    return (
                      <tr key={program.program_id}>
                        <td className="font-bold">{program.program_name}</td>
                        <td><span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{program.status}</span></td>
                        <td>{program.active_member_count}</td>
                        <td>
                          <button type="button" className="btn--lever"
                            disabled={busyId === `program-${program.program_id}`}
                            onClick={() => void patchProgram(program.program_id, program.status === 'active' ? 'archived' : 'active')}>
                            {program.status === 'active' ? 'Archive' : 'Reactivate'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div className="mt-[var(--s4)] flex items-center gap-[var(--s2)]">
              <label className="t-label" htmlFor="program-create-name">Program name</label>
              <input id="program-create-name" className="input" value={catalogProgramName}
                onChange={(e) => setCatalogProgramName(e.target.value)} />
              <button type="button" className="btn" disabled={busyId === 'program-new' || !catalogProgramName.trim()}
                onClick={() => void (async () => {
                  const created = await postProgram(catalogProgramName);
                  if (created) setCatalogProgramName('');
                })()}>
                {busyId === 'program-new' ? 'Creating…' : 'Create program'}
              </button>
            </div>
          </section>

          <div className="mt-[var(--s5)]">
            <BackHome />
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
