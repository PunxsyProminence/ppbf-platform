'use client';

import { type FormEvent, useId, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

// A SAMPLED WINDOW on one athlete, from the live session screen (PATTERN-1f; PunxsyProminence/ppbf-platform#2082).
// A coach watching one behaviour taps Shown or Not shown once per chance; each tap is a behaviour
// report (PATTERN-1e routes, app/api/pilot/coach/behaviour-windows). Opened from the class that is
// running, on an athlete marked present (Q5 A); the task is set once and the cause is left unsaid
// (Q3 A); ten chances unless set, closable early (Q7 A); "Change last tap" flips the coach's own
// last tap, as a revision (Q8 A). A coach who joins, or comes back to, a window starts at the chance
// the count stands at (Overwatch 7084899452 point 2) and sees no one else's taps (Q2 A); from there
// each of their taps moves them on one chance.
//
// WHAT IT SHOWS. Only what this coach tapped: x shown of n. No tier, label or bar (Q6, LL-Q2), and
// nothing of another coach. Staff only, like the routes it calls. Shown and Not shown differ by word
// and icon, not colour. Gym-floor sizes: every button takes the sheet's tap floor (.btn--tap) and
// the two tap buttons twice it, inline, because a utility class cannot beat .btn; the live screen
// is a kiosk surface, which sets --t-md on every control. It reads nothing until the coach opens it.
// A read that failed says so; it is never "none". Wording PROPOSED.

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
const BUTTON = 'btn btn--tap';
// The two tap buttons: twice --tap tall and at least 160px wide (the plan's floor for a tablet).
const BIG_SIZE = { minHeight: 'calc(var(--tap) * 2)', minWidth: '160px' };
const WINDOWS = '/api/pilot/coach/behaviour-windows';

type Polarity = 'occurrence' | 'counterexample';
interface BehaviourName { behaviour_key: string; label: string; status: string }
interface WindowRow {
  window_id: string; athlete_id: string; behaviour_key: string; context_kind: string; context_id: string;
  task_constraint: string; chances: number; closed_at: string | null;
}
interface Tap { chance: number; polarity: Polarity }
type View =
  | { state: 'closed' }
  | { state: 'loading' }
  | { state: 'unavailable'; what: string; windowId?: string; names?: BehaviourName[] }
  | { state: 'choose'; names: BehaviourName[]; open: WindowRow[] }
  | { state: 'window'; names: BehaviourName[]; window: WindowRow; next: number; taps: Tap[] };

const call = (path: string, init?: RequestInit) => fetch(`${apiBase()}${path}`, { credentials: 'include', ...init });
const jsonBody = (body: unknown): RequestInit => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const wordOf = (list: Array<{ value: string; label: string }>, value: string) => list.find((item) => item.value === value)?.label ?? value;
const contextOf = (row: WindowRow) => (row.context_kind === 'context' ? wordOf(CONTEXTS, row.context_id)
  : row.context_kind === 'drill' ? 'a library drill' : 'a plan block');
const polarityWord = (polarity: Polarity) => (polarity === 'occurrence' ? 'Shown' : 'Not shown');

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
  // The last tap this coach made on this screen: what "Change last tap" flips. Forgotten whenever it
  // is not known which tap is the coach's last (a lost answer, another window, a reload).
  const [lastTap, setLastTap] = useState<Tap | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [form, setForm] = useState({ behaviourKey: '', context: 'session', task: 'controlled', chances: '10' });
  // Each opening of the panel is a new generation: an answer for a panel since hidden is dropped.
  const generation = useRef(0);
  const id = useId();

  const show = (seen: number, next: View) => {
    if (seen === generation.current) setView(next);
  };

  const readList = async (seen: number) => {
    show(seen, { state: 'loading' });
    const failed: View = { state: 'unavailable', what: 'The behaviour names or this run\'s windows' };
    try {
      const [keys, windows] = await Promise.all([
        call('/api/pilot/coach/behaviour-keys'),
        call(`${WINDOWS}?sessionRunId=${encodeURIComponent(runId)}`),
      ]);
      const keysBody = keys.ok ? ((await keys.json().catch(() => null)) as { keys?: unknown } | null) : null;
      const windowsBody = windows.ok ? ((await windows.json().catch(() => null)) as { windows?: unknown } | null) : null;
      if (!Array.isArray(keysBody?.keys) || !Array.isArray(windowsBody?.windows)) {
        show(seen, failed);
        return;
      }
      const names = keysBody.keys as BehaviourName[];
      setForm((now) => ({ ...now, behaviourKey: names.find((name) => name.status === 'active')?.behaviour_key ?? '' }));
      show(seen, { state: 'choose', names, open: (windowsBody.windows as WindowRow[]).filter((row) => row.athlete_id === athleteId) });
    } catch {
      show(seen, failed);
    }
  };

  // keepNext: the coach is mid-window, so they keep their place (moved on past any tap of theirs the
  // read shows there). Without it they are joining: they start where the count stands.
  const readWindow = async (seen: number, windowId: string, names: BehaviourName[], keepNext?: number) => {
    try {
      const response = await call(`${WINDOWS}/${encodeURIComponent(windowId)}`);
      const body = response.ok ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null;
      if (!body?.window || typeof body.currentChance !== 'number' || !Array.isArray(body.myTaps)) throw new Error('unreadable');
      const taps = body.myTaps as Tap[];
      const ownNext = Math.max(0, ...taps.map((tap) => tap.chance)) + 1;
      const next = keepNext === undefined ? body.currentChance : Math.max(keepNext, ownNext);
      show(seen, { state: 'window', names, window: body.window as WindowRow, next, taps });
    } catch {
      show(seen, { state: 'unavailable', what: 'This window', windowId, names });
    }
  };

  const join = async (windowId: string, names: BehaviourName[]) => {
    setLastTap(null);
    setConfirmClose(false);
    setMessage('');
    await readWindow(generation.current, windowId, names);
  };

  const open = async (event: FormEvent) => {
    event.preventDefault();
    if (view.state !== 'choose') return;
    const seen = generation.current;
    setBusy(true);
    setMessage('Saving…');
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
        setConfirmClose(false);
        setMessage('');
        show(seen, { state: 'window', names: view.names, window: body.window, next: 1, taps: [] });
        return;
      }
      if (REFUSAL_STATUSES.has(response.status)) {
        setMessage(`Not opened: ${await reasonOf(response)}`);
        return;
      }
      setMessage(`It is not known whether the window was opened (${response.status}); reading the list again.`);
    } catch {
      setMessage('It is not known whether the window was opened; reading the list again.');
    } finally {
      setBusy(false);
    }
    await readList(seen);
  };

  const send = async (body: { action: string; chance?: number; polarity?: Polarity }, what: string) => {
    if (view.state !== 'window') return;
    const current = view;
    const seen = generation.current;
    setBusy(true);
    setMessage('Saving…');
    try {
      const response = await call(`${WINDOWS}/${encodeURIComponent(current.window.window_id)}`, { method: 'PATCH', ...jsonBody(body) });
      if (response.ok) {
        const answer = (await response.json()) as { tap?: Tap; window?: WindowRow };
        setConfirmClose(false);
        if (answer.window) {
          setMessage('');
          show(seen, { ...current, window: answer.window });
        } else if (answer.tap) {
          const tap = answer.tap;
          setLastTap(tap);
          setMessage(`Saved: chance ${tap.chance}, ${polarityWord(tap.polarity)}.`);
          const next = body.action === 'tap' ? tap.chance + 1 : current.next;
          show(seen, { ...current, next, taps: [...current.taps.filter((mine) => mine.chance !== tap.chance), tap] });
        }
        return;
      }
      if (REFUSAL_STATUSES.has(response.status)) {
        setMessage(`Not saved: ${await reasonOf(response)}`);
      } else {
        setLastTap(null);
        setMessage(`It is not known whether the ${what} was saved (${response.status}); reading the window again.`);
      }
    } catch {
      setLastTap(null);
      setMessage(`It is not known whether the ${what} was saved; reading the window again.`);
    } finally {
      setBusy(false);
    }
    await readWindow(seen, current.window.window_id, current.names, current.next);
  };

  const nameOf = (names: BehaviourName[], key: string) => names.find((name) => name.behaviour_key === key)?.label ?? 'A behaviour';
  const panelId = `${id}-panel`;

  return (
    <div className="mt-[var(--s2)]">
      <button
        type="button"
        className={`${BUTTON} btn--ghost`}
        aria-expanded={view.state !== 'closed'}
        aria-controls={panelId}
        onClick={() => {
          generation.current += 1;
          setMessage('');
          setConfirmClose(false);
          if (view.state === 'closed') void readList(generation.current);
          else setView({ state: 'closed' });
        }}
      >
        {view.state === 'closed' ? 'Watch a behaviour' : 'Hide'}
        <span className="sr-only">{view.state === 'closed' ? ` for ${athleteName}` : ` the behaviour window for ${athleteName}`}</span>
      </button>

      {view.state !== 'closed' ? (
        <div id={panelId} className="mt-[var(--s3)] space-y-[var(--s3)] text-[length:var(--t-md)]">
          {view.state === 'loading' ? <p>Reading the behaviour names and this run&rsquo;s windows&hellip;</p> : null}

          {view.state === 'unavailable' ? (
            <>
              <p>{`${view.what} could not be read just now.`}</p>
              <button type="button" className={BUTTON} onClick={() => {
                const { windowId, names } = view;
                if (windowId && names) void readWindow(generation.current, windowId, names);
                else void readList(generation.current);
              }}>Read again</button>
            </>
          ) : null}

          {view.state === 'choose' ? (
            <>
              {view.open.length > 0 ? (
                <ul className="space-y-[var(--s2)]" aria-label={`Open windows on ${athleteName}`}>
                  {view.open.map((row) => (
                    <li key={row.window_id}>
                      <button type="button" className={BUTTON} disabled={busy} onClick={() => void join(row.window_id, view.names)}>
                        {`Join: ${nameOf(view.names, row.behaviour_key)} (${wordOf(TASKS, row.task_constraint)}, ${contextOf(row)}, ${row.chances} chances)`}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {view.names.some((name) => name.status === 'active') ? (
                <form className="flex flex-wrap items-end gap-[var(--s3)]" onSubmit={(event) => void open(event)}>
                  <div className="flex flex-col"><label htmlFor={`${id}-name`}>Behaviour</label>
                    <select id={`${id}-name`} className="select input--kiosk" value={form.behaviourKey}
                      onChange={(event) => setForm({ ...form, behaviourKey: event.target.value })}>
                      {view.names.filter((name) => name.status === 'active').map((name) => (
                        <option key={name.behaviour_key} value={name.behaviour_key}>{name.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col"><label htmlFor={`${id}-context`}>What they are doing</label>
                    <select id={`${id}-context`} className="select input--kiosk" value={form.context}
                      onChange={(event) => setForm({ ...form, context: event.target.value })}>
                      {CONTEXTS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col"><label htmlFor={`${id}-task`}>Task</label>
                    <select id={`${id}-task`} className="select input--kiosk" value={form.task}
                      onChange={(event) => setForm({ ...form, task: event.target.value })}>
                      {TASKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </div>
                  <div className="flex flex-col"><label htmlFor={`${id}-chances`}>Chances</label>
                    <input id={`${id}-chances`} className="input input--kiosk" type="number" min={1} max={50} value={form.chances}
                      onChange={(event) => setForm({ ...form, chances: event.target.value })} />
                  </div>
                  <button type="submit" className={BUTTON} disabled={busy} aria-busy={busy}>Open the window</button>
                </form>
              ) : (
                <p>This gym has no active behaviour name yet, so a window cannot be opened.</p>
              )}
            </>
          ) : null}

          {view.state === 'window' ? (() => {
            const { window, taps, next } = view;
            const shown = taps.filter((tap) => tap.polarity === 'occurrence').length;
            const tapButton = (polarity: Polarity, icon: string) => (
              <button type="button" className="btn flex-1" style={BIG_SIZE} disabled={busy} aria-busy={busy}
                onClick={() => void send({ action: 'tap', chance: next, polarity }, 'tap')}>
                <span aria-hidden="true">{`${icon} `}</span>{polarityWord(polarity)}
                <span className="sr-only">{` for ${athleteName}, chance ${next}`}</span>
              </button>
            );
            return (
              <>
                <p className="font-semibold">
                  {`${nameOf(view.names, window.behaviour_key)}: ${athleteName} (${wordOf(TASKS, window.task_constraint)}, ${contextOf(window)})`}
                </p>
                {window.closed_at ? (
                  <p>This window is closed.</p>
                ) : next > window.chances ? (
                  <p>{`All ${window.chances} chances are tapped: the window is full.`}</p>
                ) : (
                  <>
                    <p className="font-semibold">{`Chance ${next} of ${window.chances}`}</p>
                    <div className="flex flex-wrap gap-[var(--s4)]">
                      {tapButton('occurrence', '✓')}
                      {tapButton('counterexample', '✗')}
                    </div>
                  </>
                )}
                {!window.closed_at && lastTap ? (
                  <button type="button" className={`${BUTTON} btn--ghost`} disabled={busy} aria-busy={busy}
                    onClick={() => void send({ action: 'change_last', polarity: lastTap.polarity === 'occurrence' ? 'counterexample' : 'occurrence' }, 'change')}>
                    {`Change last tap to ${polarityWord(lastTap.polarity === 'occurrence' ? 'counterexample' : 'occurrence')}`}
                    <span className="sr-only">{` (chance ${lastTap.chance})`}</span>
                  </button>
                ) : null}
                <p>{taps.length === 0 ? 'You: no taps yet' : `You: ${shown} shown of ${taps.length} tapped`}</p>
                {!window.closed_at && !confirmClose ? (
                  <button type="button" className={`${BUTTON} btn--ghost`} disabled={busy} onClick={() => setConfirmClose(true)}>
                    Close the window
                  </button>
                ) : null}
                {!window.closed_at && confirmClose ? (
                  <div className="space-y-[var(--s2)]">
                    <p>Closing ends this window for every coach, and it cannot be opened again.</p>
                    <div className="flex flex-wrap gap-[var(--s3)]">
                      <button type="button" className={BUTTON} disabled={busy} aria-busy={busy} onClick={() => void send({ action: 'close' }, 'close')}>
                        Yes, close it
                      </button>
                      <button type="button" className={`${BUTTON} btn--ghost`} disabled={busy} onClick={() => setConfirmClose(false)}>
                        Keep it open
                      </button>
                    </div>
                  </div>
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
