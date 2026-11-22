'use client';

import { type FormEvent, useId, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// A SAMPLED WINDOW on one athlete, from the live session screen (PATTERN-1f; PunxsyProminence/ppbf-platform#2082).
// A coach watching one behaviour taps Shown or Not shown once per chance; each tap is a behaviour
// report (PATTERN-1e routes, app/api/pilot/coach/behaviour-windows). Opened from the class that is
// running, on an athlete marked present (Q5 A); the task is set once and the cause is left unsaid
// (Q3 A); ten chances unless set, closable early (Q7 A); "Change last tap" flips the coach's own
// last tap, as a revision (Q8 A). A second coach joins an open window and starts at the chance the
// count stands at, seeing no one else's taps (Q2 A).
//
// WHAT IT SHOWS. Only what this coach tapped: x shown of n. No tier, label or bar (Q6, LL-Q2), and
// nothing of another coach. Staff only, like the routes it calls. Shown and Not shown differ by word
// and icon, not colour; targets are at least --tap and text at least --t-md (gym-floor tablets).
// It reads nothing until the coach opens it. A read that failed says so; it is never "none".
// Wording PROPOSED.

const CONTEXTS: Array<{ value: string; label: string }> = [
  { value: 'session', label: 'Session' },
  { value: 'drill_assignment', label: 'Drill assignment' },
  { value: 'assessment', label: 'Assessment' },
  { value: 'film_study', label: 'Film study' },
  { value: 'open_floor', label: 'Open floor' },
  { value: 'technical_sparring', label: 'Technical sparring' },
  { value: 'sparring_games', label: 'Sparring games' },
  { value: 'sparring_drills', label: 'Sparring drills' },
  { value: 'open_sparring', label: 'Open sparring' },
];
const TASKS: Array<{ value: string; label: string }> = [
  { value: 'controlled', label: 'Controlled' },
  { value: 'constrained_live', label: 'Constrained live' },
  { value: 'live', label: 'Live' },
];

// The routes' own refusals: the server said no and saved nothing.
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);
const CONTROL = 'min-h-[var(--tap)] text-[length:var(--t-md)]';
const BIG = `btn ${CONTROL} min-h-[calc(var(--tap)*2)] min-w-[160px] flex-1`;
const WINDOWS = '/api/pilot/coach/behaviour-windows';

type Polarity = 'occurrence' | 'counterexample';
interface BehaviourName { behaviour_key: string; label: string; status: string }
interface WindowRow { window_id: string; athlete_id: string; behaviour_key: string; task_constraint: string; chances: number; closed_at: string | null }
interface Tap { chance: number; polarity: Polarity }
type View =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable'; what: string }
  | { state: 'choose'; names: BehaviourName[]; open: WindowRow[] }
  | { state: 'window'; names: BehaviourName[]; window: WindowRow; currentChance: number; taps: Tap[] };

const call = (path: string, init?: RequestInit) => fetch(`${apiBase()}${path}`, { credentials: 'include', ...init });
const jsonBody = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function reasonOf(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `the server answered ${response.status}`;
}

export default function BehaviourSampleWindow({ runId, athleteId, athleteName }: {
  runId: string;
  athleteId: string;
  athleteName: string;
}) {
  const [view, setView] = useState<View>({ state: 'closed' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // The last tap this coach made on this screen: what "Change last tap" flips. Not known after a reload.
  const [lastTap, setLastTap] = useState<Tap | null>(null);
  const [form, setForm] = useState({ behaviourKey: '', context: 'session', task: 'controlled', chances: '10' });
  const id = useId();

  const readList = async () => {
    setView({ state: 'loading' });
    try {
      const [keys, windows] = await Promise.all([
        call('/api/pilot/coach/behaviour-keys'),
        call(`${WINDOWS}?sessionRunId=${encodeURIComponent(runId)}`),
      ]);
      const keysBody = keys.ok ? ((await keys.json().catch(() => null)) as { keys?: unknown } | null) : null;
      const windowsBody = windows.ok ? ((await windows.json().catch(() => null)) as { windows?: unknown } | null) : null;
      if (!Array.isArray(keysBody?.keys) || !Array.isArray(windowsBody?.windows)) {
        setView({ state: 'unavailable', what: 'The behaviour names or this run\'s windows' });
        return;
      }
      const names = keysBody.keys as BehaviourName[];
      setForm((now) => ({ ...now, behaviourKey: names.find((name) => name.status === 'active')?.behaviour_key ?? '' }));
      setView({ state: 'choose', names, open: (windowsBody.windows as WindowRow[]).filter((row) => row.athlete_id === athleteId) });
    } catch {
      setView({ state: 'unavailable', what: 'The behaviour names or this run\'s windows' });
    }
  };

  const readWindow = async (windowId: string, names: BehaviourName[]) => {
    try {
      const response = await call(`${WINDOWS}/${encodeURIComponent(windowId)}`);
      const body = response.ok ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
      if (!body?.window || typeof body.currentChance !== 'number' || !Array.isArray(body.myTaps)) throw new Error('unreadable');
      setView({ state: 'window', names, window: body.window as WindowRow, currentChance: body.currentChance, taps: body.myTaps as Tap[] });
    } catch {
      setView({ state: 'unavailable', what: 'This window' });
    }
  };

  const join = async (row: WindowRow, names: BehaviourName[]) => {
    setLastTap(null);
    setMessage('');
    await readWindow(row.window_id, names);
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (view.state !== 'choose') return;
    setBusy(true);
    setMessage('');
    try {
      const response = await call(WINDOWS, {
        method: 'POST',
        ...jsonBody({
          athleteId, behaviourKey: form.behaviourKey, sessionRunId: runId, attemptContext: form.context,
          taskConstraint: form.task, chances: Number(form.chances),
        }),
      });
      if (response.ok) {
        const body = (await response.json()) as { window: WindowRow };
        setLastTap(null);
        setView({ state: 'window', names: view.names, window: body.window, currentChance: 1, taps: [] });
        return;
      }
      setMessage(REFUSAL_STATUSES.has(response.status)
        ? `Not opened: ${await reasonOf(response)}`
        : `It is not known whether the window was opened (${response.status}); the list has been read again.`);
      if (!REFUSAL_STATUSES.has(response.status)) await readList();
    } catch {
      setMessage('It is not known whether the window was opened; the list has been read again.');
      await readList();
    } finally {
      setBusy(false);
    }
  };

  const send = async (body: { action: string; chance?: number; polarity?: Polarity }, what: string) => {
    if (view.state !== 'window') return;
    const current = view;
    setBusy(true);
    setMessage('');
    let known = false;
    try {
      const response = await call(`${WINDOWS}/${encodeURIComponent(current.window.window_id)}`, { method: 'PATCH', ...jsonBody(body) });
      if (response.ok) {
        const answer = (await response.json()) as { tap?: Tap; window?: WindowRow };
        if (answer.window) {
          setView({ ...current, window: answer.window });
        } else if (answer.tap) {
          const tap = answer.tap;
          setLastTap(tap);
          setView({ ...current, taps: [...current.taps.filter((mine) => mine.chance !== tap.chance), tap] });
        }
        return;
      }
      known = REFUSAL_STATUSES.has(response.status);
      setMessage(known
        ? `Not saved: ${await reasonOf(response)}`
        : `It is not known whether the ${what} was saved (${response.status}); the window has been read again.`);
    } catch {
      setMessage(`It is not known whether the ${what} was saved; the window has been read again.`);
    } finally {
      setBusy(false);
    }
    await readWindow(current.window.window_id, current.names);
  };

  const nameOf = (names: BehaviourName[], key: string) => names.find((name) => name.behaviour_key === key)?.label ?? 'A behaviour';
  const panelId = `${id}-panel`;

  return (
    <div className="mt-[var(--s2)]">
      <button
        type="button"
        className={`btn btn--ghost ${CONTROL}`}
        aria-expanded={view.state !== 'closed'}
        aria-controls={panelId}
        onClick={() => {
          setMessage('');
          if (view.state === 'closed') void readList();
          else setView({ state: 'closed' });
        }}
      >
        {view.state === 'closed' ? 'Watch a behaviour' : 'Close this screen'}
        <span className="sr-only">{` for ${athleteName}`}</span>
      </button>

      {view.state !== 'closed' ? (
        <div id={panelId} className="mt-[var(--s3)] space-y-[var(--s3)] text-[length:var(--t-md)]">
          {view.state === 'loading' ? <p>Reading the behaviour names and this run&rsquo;s windows&hellip;</p> : null}

          {view.state === 'unavailable' ? (
            <>
              <p>{`${view.what} could not be read just now.`}</p>
              <button type="button" className={`btn ${CONTROL}`} onClick={() => void readList()}>Read again</button>
            </>
          ) : null}

          {view.state === 'choose' ? (
            <>
              {view.open.length > 0 ? (
                <ul className="space-y-[var(--s2)]" aria-label={`Open windows on ${athleteName}`}>
                  {view.open.map((row) => (
                    <li key={row.window_id}>
                      <button type="button" className={`btn ${CONTROL}`} disabled={busy} onClick={() => void join(row, view.names)}>
                        {`Join: ${nameOf(view.names, row.behaviour_key)}`}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {view.names.some((name) => name.status === 'active') ? (
                <form className="flex flex-wrap items-end gap-[var(--s3)]" onSubmit={(event) => void open(event)}>
                  <div className="flex flex-col"><label htmlFor={`${id}-name`}>Behaviour</label>
                    <select id={`${id}-name`} className={CONTROL} value={form.behaviourKey}
                      onChange={(event) => setForm({ ...form, behaviourKey: event.target.value })}>
                      {view.names.filter((name) => name.status === 'active').map((name) => (
                        <option key={name.behaviour_key} value={name.behaviour_key}>{name.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col"><label htmlFor={`${id}-context`}>What they are doing</label>
                    <select id={`${id}-context`} className={CONTROL} value={form.context}
                      onChange={(event) => setForm({ ...form, context: event.target.value })}>
                      {CONTEXTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col"><label htmlFor={`${id}-task`}>Task</label>
                    <select id={`${id}-task`} className={CONTROL} value={form.task}
                      onChange={(event) => setForm({ ...form, task: event.target.value })}>
                      {TASKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col"><label htmlFor={`${id}-chances`}>Chances</label>
                    <input id={`${id}-chances`} className={CONTROL} type="number" min={1} max={50} value={form.chances}
                      onChange={(event) => setForm({ ...form, chances: event.target.value })} />
                  </div>
                  <button type="submit" className={`btn ${CONTROL}`} disabled={busy}>Open the window</button>
                </form>
              ) : (
                <p>This gym has no active behaviour name yet, so a window cannot be opened.</p>
              )}
            </>
          ) : null}

          {view.state === 'window' ? (() => {
            const { window, taps, currentChance } = view;
            const next = taps.length > 0 ? Math.max(...taps.map((tap) => tap.chance)) + 1 : currentChance;
            const shown = taps.filter((tap) => tap.polarity === 'occurrence').length;
            const taskWords = TASKS.find((item) => item.value === window.task_constraint)?.label ?? window.task_constraint;
            return (
              <>
                <p className="font-semibold">{`${nameOf(view.names, window.behaviour_key)}: ${athleteName} (${taskWords})`}</p>
                {window.closed_at ? (
                  <p>This window is closed.</p>
                ) : next > window.chances ? (
                  <p>{`All ${window.chances} chances are tapped: the window is full.`}</p>
                ) : (
                  <>
                    <p className="font-semibold">{`Chance ${next} of ${window.chances}`}</p>
                    <div className="flex flex-wrap gap-[var(--s4)]">
                      <button type="button" className={BIG} disabled={busy}
                        onClick={() => void send({ action: 'tap', chance: next, polarity: 'occurrence' }, 'tap')}>
                        <span aria-hidden="true">✓ </span>Shown
                      </button>
                      <button type="button" className={BIG} disabled={busy}
                        onClick={() => void send({ action: 'tap', chance: next, polarity: 'counterexample' }, 'tap')}>
                        <span aria-hidden="true">✗ </span>Not shown
                      </button>
                    </div>
                  </>
                )}
                {!window.closed_at && lastTap ? (
                  <button type="button" className={`btn btn--ghost ${CONTROL}`} disabled={busy}
                    onClick={() => void send({ action: 'change_last', polarity: lastTap.polarity === 'occurrence' ? 'counterexample' : 'occurrence' }, 'change')}>
                    {`Change last tap to ${lastTap.polarity === 'occurrence' ? 'Not shown' : 'Shown'}`}
                    <span className="sr-only">{` (chance ${lastTap.chance})`}</span>
                  </button>
                ) : null}
                <p>{taps.length === 0 ? 'You: no taps yet' : `You: ${shown} shown of ${taps.length} tapped`}</p>
                {!window.closed_at ? (
                  <button type="button" className={`btn btn--ghost ${CONTROL}`} disabled={busy}
                    onClick={() => void send({ action: 'close' }, 'close')}>
                    Close the window
                  </button>
                ) : null}
              </>
            );
          })() : null}

          <p role="status">{message}</p>
        </div>
      ) : null}
    </div>
  );
}
