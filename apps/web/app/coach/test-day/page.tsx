'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateNumeric, formatGymTimeOfDay, gymDayIso } from '@/src/lib/gymTime';
import { refusalWords } from '@/src/lib/serverRefusalWords';

// THE QUARTERLY TEST DAY (OD-2026-10-17-026: "A: 20-m shuttle (Rec.)", and
// (b) the coach-entered standing height; the jumps as OD-2026-10-04-020 rules
// them, CMJ height and broad jump, best of 3, either or both). One coach
// records the group's numbers for one date in one save.
//
// A BLANK BOX IS "NOT TESTED": nothing is sent for it, and an athlete with
// every box blank is left off the save. The server writes every filled box or
// none, so a refusal never leaves half a test day behind. The page checks the
// same bounds as the server first, naming the athlete and the box.
//
// ONE SAVE KEY UNTIL THE SERVER SAYS WHAT HAPPENED. The key is kept from the
// first press until a 2xx answer, so a retry after a lost reply -- even one
// where the coach fixed a box or added an athlete -- is the SAME save: the
// server writes what is new, never a second copy, and names any earlier box
// this form no longer carries. A 409 means an earlier press landed with other
// numbers: the first numbers are kept, the boxes clear and nothing is resent.
// A refusal (4xx) drops the key only if no earlier press on it went unanswered.
//
// Staff only: the route refuses everyone but a coach or admin seat of the gym,
// the roster is read only inside the role gate, and this page offers only the
// athletes the route will record for. Heights go to the staff-only height
// record; jumps and the shuttle go to each athlete's own testing history.
// The 55px tap floor comes from this route's layout (KioskSurface). All
// wording here is PROPOSED.
//
// WHOSE NUMBERS (lane 6C7, U2-6c; app scrub CF-13; Overwatch Q3 = A on #2043).
// The list was every athlete the coach can record for, with no way to see only
// tonight's class. One choice now narrows it: "Everyone you can record for"
// (the default, the list as it was) or one class held on the test date. A class
// shows its registered athletes and anyone marked Present on it, and only those
// the route will record for. It is read from GET /api/pilot/scheduler, the read
// /schedule already makes for the same reader, so no new route and nothing new
// is shown. A class is offered only when that read gives it at least one such
// athlete: a coach is not sent the register of a class they do not run, and a
// choice that could only show nobody is not offered. A failed class read says
// so and leaves everyone listed. An athlete with a number typed stays listed
// whatever is chosen, so nothing typed is ever hidden or sent unseen.

interface RosterAthlete { athlete_id: string; full_name?: string }

interface TestDayClass { class_id: string; title: string; start_at: string; end_at: string; status: string }
/** The scheduler read, as Test Day uses it: the classes, and who each has registered or Present. */
interface ClassRead { classes: TestDayClass[]; members: Map<string, Set<string>> }

/** null when the answer cannot be read as a schedule: the page then says the classes could not be loaded. */
function classRead(payload: unknown): ClassRead | null {
  if (!payload || typeof payload !== 'object') return null;
  const { classes, registrations, attendance } = payload as Record<string, unknown>;
  if (!Array.isArray(classes) || !Array.isArray(registrations) || !Array.isArray(attendance)) return null;
  const members = new Map<string, Set<string>>();
  const add = (classId: unknown, athleteId: unknown) => {
    if (typeof classId !== 'string' || typeof athleteId !== 'string') return;
    const set = members.get(classId) ?? new Set<string>();
    set.add(athleteId);
    members.set(classId, set);
  };
  for (const row of registrations as Array<Record<string, unknown> | null>) {
    if (row && row.status === 'registered') add(row.class_id, row.athlete_id);
  }
  for (const row of attendance as Array<Record<string, unknown> | null>) {
    if (row && row.status === 'present') add(row.class_id, row.athlete_id);
  }
  const rows = (classes as Array<Record<string, unknown> | null>).filter((item): item is Record<string, unknown> & TestDayClass =>
    Boolean(item)
    && typeof item?.class_id === 'string'
    && typeof item.title === 'string'
    && typeof item.start_at === 'string'
    && typeof item.end_at === 'string'
    && typeof item.status === 'string');
  // A class row that cannot be read makes the whole answer unreadable: "no class on this date"
  // must never stand for "some classes could not be read" (review of #2057).
  if (rows.length !== classes.length) return null;
  return { classes: rows, members };
}

const FIELDS = [
  { key: 'height_cm', label: 'Height (cm)', inputMode: 'decimal' },
  { key: 'cmj_cm', label: 'CMJ (cm)', inputMode: 'decimal' },
  { key: 'broad_cm', label: 'Broad jump (cm)', inputMode: 'decimal' },
  { key: 'shuttle_level', label: 'Shuttle level', inputMode: 'numeric' },
  { key: 'shuttle_number', label: 'Shuttle number', inputMode: 'numeric' },
] as const;
type FieldKey = (typeof FIELDS)[number]['key'];
type Cells = Partial<Record<FieldKey, string>>;

const MEASURE_WORDS: Record<string, string> = {
  height: 'height',
  'ppbf-jump-cmj-height': 'CMJ',
  'ppbf-jump-broad-distance': 'broad jump',
  'ppbf-shuttle-20m': '20-m shuttle',
};

// The server's limits (athleteHeights.ts, testDay.ts), checked here first so a
// refusal can name the athlete. Typing-slip bounds, not norms.
const ROSTER_CHUNK = 1000;
const MAX_ROWS = 100;
function boundsProblem(key: FieldKey, value: number): string | null {
  switch (key) {
    case 'height_cm':
      return value >= 50 && value <= 250 ? null : 'must be 50 to 250 cm';
    case 'cmj_cm':
    case 'broad_cm':
      return value > 0 && value < 500 ? null : 'must be more than 0 and under 500 cm';
    case 'shuttle_level':
      return Number.isInteger(value) && value >= 1 && value <= 21 ? null : 'must be a whole number from 1 to 21';
    case 'shuttle_number':
      return Number.isInteger(value) && value >= 1 && value <= 16 ? null : 'must be a whole number from 1 to 16';
    default:
      return null;
  }
}

// The save in progress survives a reload or a sign-in in this tab, so a press
// that went unanswered is still the same save afterwards. Per-tab, best effort:
// storage can be missing or refuse, and then the key lives in memory only.
const PENDING_STORE = 'ppbf.testDay.pendingSave';
type Pending = { key: string; uncertain: boolean } | null;
function readPending(): Pending {
  try {
    if (typeof window === 'undefined') return null;
    const parsed = JSON.parse(window.sessionStorage.getItem(PENDING_STORE) ?? 'null') as Pending;
    return parsed && typeof parsed.key === 'string' && typeof parsed.uncertain === 'boolean' ? parsed : null;
  } catch {
    return null;
  }
}
function writePending(value: Pending): void {
  try {
    if (value) window.sessionStorage.setItem(PENDING_STORE, JSON.stringify(value));
    else window.sessionStorage.removeItem(PENDING_STORE);
  } catch {
    // Memory only; nothing else depends on it.
  }
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `test-day-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Names as shown, with a duplicate full name told apart by the end of its id. */
function displayNames(roster: readonly RosterAthlete[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const athlete of roster) {
    const name = athlete.full_name || athlete.athlete_id;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return new Map(roster.map((athlete) => {
    const name = athlete.full_name || athlete.athlete_id;
    return [athlete.athlete_id, (counts.get(name) ?? 0) > 1 ? `${name} (${athlete.athlete_id.slice(-4)})` : name];
  }));
}

function TestDayForm() {
  const [roster, setRoster] = useState<RosterAthlete[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [date, setDate] = useState(() => gymDayIso() ?? '');
  const [cells, setCells] = useState<Record<string, Cells>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'saved' | 'refused'; text: string; also?: string[] } | null>(null);
  // The save in progress: its key, and whether any press on it went unanswered.
  const pending = useRef<Pending>(readPending());
  const setPending = (value: Pending) => {
    pending.current = value;
    writePending(value);
  };
  // Whose numbers: the classes read (null while loading, 'failed' when it could not be read), and
  // the class chosen ('' is everyone).
  const [classData, setClassData] = useState<ClassRead | 'failed' | null>(null);
  const [classId, setClassId] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/athletes/list`, { method: 'GET', credentials: 'include' });
        const payload = res.ok ? ((await res.json()) as { items?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('roster');
        const all = payload.items as RosterAthlete[];
        const ids = new Set<string>();
        for (let i = 0; i < all.length; i += ROSTER_CHUNK) {
          const allowedRes = await fetch(`${apiBase()}/api/pilot/coach/test-day`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action: 'accessible_athletes', athlete_ids: all.slice(i, i + ROSTER_CHUNK).map((a) => a.athlete_id) }),
          });
          const allowed = allowedRes.ok ? ((await allowedRes.json()) as { athlete_ids?: unknown } | null) : null;
          if (!allowed || !Array.isArray(allowed.athlete_ids)) throw new Error('roster');
          for (const id of allowed.athlete_ids as string[]) ids.add(id);
        }
        setRoster(all.filter((a) => ids.has(a.athlete_id)));
      } catch {
        // A roster that could not be read is never shown as "no athletes".
        setFailed(true);
      }
    })();
  }, []);

  // The classes for "Whose numbers", read beside the roster (not after it): the roster is the page; this narrows it.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/scheduler`, { method: 'GET', credentials: 'include' });
        const read = res.ok ? classRead(await res.json().catch(() => null)) : null;
        setClassData(read ?? 'failed');
      } catch {
        // The class choice is a convenience: without it, everyone is listed, and the page says why.
        setClassData('failed');
      }
    })();
  }, []);

  const names = displayNames(roster ?? []);
  const nameOf = (id: string) => names.get(id) ?? id;

  // The classes held on the test date that the read gives at least one recordable athlete for.
  const classOptions = useMemo(() => {
    if (!roster || !classData || classData === 'failed') return [];
    const recordable = new Set(roster.map((athlete) => athlete.athlete_id));
    return classData.classes
      .filter((item) => item.status !== 'cancelled' && gymDayIso(item.start_at) === date)
      .map((item) => ({
        ...item,
        athletes: new Set([...(classData.members.get(item.class_id) ?? [])].filter((id) => recordable.has(id))),
      }))
      .filter((item) => item.athletes.size > 0)
      .sort((left, right) => new Date(left.start_at).getTime() - new Date(right.start_at).getTime());
  }, [classData, date, roster]);
  // A class that is not among the date's options (the date changed) is not a choice: everyone.
  const chosenClass = classOptions.find((item) => item.class_id === classId) ?? null;
  const hasTyped = (athleteId: string) => FIELDS.some((field) => (cells[athleteId]?.[field.key] ?? '').trim() !== '');
  const shownRoster = roster && chosenClass
    ? roster.filter((athlete) => chosenClass.athletes.has(athlete.athlete_id) || hasTyped(athlete.athlete_id))
    : roster;
  const classLabel = (item: TestDayClass) => {
    const start = formatGymTimeOfDay(item.start_at);
    const end = formatGymTimeOfDay(item.end_at);
    return start && end ? `${item.title}, ${start}-${end}` : item.title;
  };

  const save = async () => {
    if (busy || !roster) return;
    setMessage(null);
    if (!date) {
      setMessage({ kind: 'refused', text: 'Choose the test date first. Nothing was sent.' });
      return;
    }
    const rows: Array<Record<string, unknown>> = [];
    for (const athlete of roster) {
      const typed = cells[athlete.athlete_id] ?? {};
      const filled = FIELDS.filter((field) => (typed[field.key] ?? '').trim() !== '');
      if (filled.length === 0) continue;
      const row: Record<string, unknown> = { athlete_id: athlete.athlete_id };
      for (const field of filled) {
        const text = (typed[field.key] ?? '').trim();
        const raw = /^\d+(\.\d+)?$/.test(text) ? Number(text) : Number.NaN;
        // Centimetres are rounded to one decimal, as the server stores them,
        // before the bounds are checked; shuttle boxes must be whole as typed.
        const value = field.key.startsWith('shuttle') ? raw : Math.round(raw * 10) / 10;
        const problem = Number.isFinite(value) ? boundsProblem(field.key, value) : 'is not a number';
        if (problem) {
          setMessage({ kind: 'refused', text: `${nameOf(athlete.athlete_id)}: ${field.label} "${text}" ${problem}. Nothing was sent.` });
          return;
        }
        row[field.key] = value;
      }
      if (('shuttle_level' in row) !== ('shuttle_number' in row)) {
        setMessage({ kind: 'refused', text: `${nameOf(athlete.athlete_id)}: enter both the shuttle level and the shuttle number, or neither. Nothing was sent.` });
        return;
      }
      rows.push(row);
    }
    if (rows.length === 0) {
      setMessage({ kind: 'refused', text: 'Fill in at least one box first.' });
      return;
    }
    if (rows.length > MAX_ROWS) {
      setMessage({ kind: 'refused', text: `At most ${MAX_ROWS} athletes per save; save this group in two parts. Nothing was sent.` });
      return;
    }
    const key = pending.current?.key ?? newKey();
    setPending({ key, uncertain: pending.current?.uncertain ?? false });
    setBusy(true);
    const unknown = () => {
      setPending({ key, uncertain: true });
      setMessage({
        kind: 'refused',
        text: 'That did not go through, and it may or may not have saved. Press Save test day again: a retry is the same save and never saves anything twice.',
      });
    };
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/test-day`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ administered_on: date, request_key: key, rows }),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && payload?.ok === true && typeof payload.written === 'number') {
        setPending(null);
        const written = payload.written;
        const already = typeof payload.already_saved === 'number' ? payload.already_saved : 0;
        const earlier = Array.isArray(payload.earlier_not_on_form)
          ? payload.earlier_not_on_form as Array<{ athlete_id: string; measure: string }>
          : [];
        const when = formatGymDateNumeric(`${date}T12:00:00Z`) ?? date;
        const total = written + already;
        setMessage({
          kind: 'saved',
          text: `Test day for ${when} saved: ${total} result${total === 1 ? '' : 's'}`
            + (already > 0 ? ` (${already} of them from an earlier press).` : '.'),
          also: earlier.map((cell) => `${nameOf(cell.athlete_id)}: ${MEASURE_WORDS[cell.measure] ?? cell.measure}`),
        });
        setCells({});
        return;
      }
      if (response.status === 409) {
        // An earlier press landed with other numbers. Those are kept; resending
        // this form under a new key would save the whole group twice.
        setPending(null);
        setCells({});
        // The boxes are cleared, so a narrowed list would hide whoever has a missing box: everyone again.
        setClassId('');
        setMessage({
          kind: 'refused',
          text: `${refusalWords({ error: payload?.error, status: 409 }, {}, 'An earlier press already saved this test day. The first numbers are kept.')} `
            + 'Anything you added or changed after that press was not saved: enter only the missing boxes again.',
        });
        return;
      }
      if (response.status >= 400 && response.status < 500) {
        // Nothing from THIS press was written. Keep the key if an earlier press
        // went unanswered, so the next try is still the same save.
        if (!pending.current?.uncertain) setPending(null);
        setMessage({
          kind: 'refused',
          text: refusalWords({ error: payload?.error, status: response.status }, {}, 'Nothing from this press was saved. Check the boxes and try again.'),
        });
        return;
      }
      unknown();
    } catch {
      unknown();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <label className="block space-y-[var(--s1)]">
        <span className="t-label block">Test date</span>
        <input
          type="date"
          value={date}
          max={gymDayIso() ?? undefined}
          disabled={busy}
          onChange={(event) => setDate(event.target.value)}
          className="input input--kiosk"
        />
      </label>

      {roster && roster.length > 0 && classOptions.length > 0 ? (
        <label className="block space-y-[var(--s1)]">
          <span className="t-label block">Whose numbers</span>
          <select
            value={chosenClass ? chosenClass.class_id : ''}
            disabled={busy}
            onChange={(event) => setClassId(event.target.value)}
            className="select input--kiosk"
          >
            <option value="">Everyone you can record for</option>
            {classOptions.map((item) => (
              <option key={item.class_id} value={item.class_id}>{classLabel(item)}</option>
            ))}
          </select>
        </label>
      ) : null}
      {/* "Whose numbers" lines (review of #2057). One live region that is always on the page, so
          what lands in it is read out: a region inserted with its text already in it often is not.
          aria-live, not a status role, so these lines are not taken for the page's loading or save status. */}
      <div aria-live="polite" data-testid="class-lines" className="space-y-[var(--s2)]">
        {roster && roster.length > 0 && classData === 'failed' ? (
          /* A failed class read is a degraded page, not an empty answer: a warning with a glyph and
             a title (the roster still loaded, so it is not a refusal). */
          <div className="alert alert--warning">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <div className="alert-body">
              <p className="alert-title">Classes not loaded</p>
              <p className="alert-msg">The classes could not be loaded, so everyone you can record for is listed.</p>
            </div>
          </div>
        ) : null}
        {roster && roster.length > 0 && classData && classData !== 'failed' && classOptions.length === 0 ? (
          <p className="t-body">
            No class on this date has a register you can pick from here, so everyone you can record for is listed.
          </p>
        ) : null}
        {chosenClass ? (
          <p className="t-body">
            {`Registered for, or marked Present on, ${chosenClass.title}, whom you can record for: ${chosenClass.athletes.size}. An athlete with a number typed stays listed.`}
          </p>
        ) : null}
      </div>

      {failed ? (
        <div className="alert alert--warning" role="alert">
          <span className="alert-icon" aria-hidden="true">▲</span>
          <div className="alert-body">
            <p className="alert-title">Not loaded</p>
            <p className="alert-msg">The roster could not be loaded. Reload to try again.</p>
          </div>
        </div>
      ) : roster === null ? (
        <p className="t-body" role="status">Loading the roster…</p>
      ) : roster.length === 0 ? (
        <p className="t-body">No athletes you can record a test day for.</p>
      ) : (
        <ul className="space-y-[var(--s3)]">
          {(shownRoster ?? roster).map((athlete) => {
            const name = nameOf(athlete.athlete_id);
            return (
              <li key={athlete.athlete_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <p className="t-body font-semibold text-[color:var(--bone-100)]">{name}</p>
                <div className="mt-[var(--s2)] grid grid-cols-2 gap-[var(--s2)] sm:grid-cols-5">
                  {FIELDS.map((field) => (
                    <label key={field.key} className="block space-y-[var(--s1)]">
                      <span className="t-label block">{field.label}</span>
                      <input
                        type="text"
                        inputMode={field.inputMode}
                        autoComplete="off"
                        aria-label={`${name}: ${field.label}`}
                        value={cells[athlete.athlete_id]?.[field.key] ?? ''}
                        disabled={busy}
                        onChange={(event) => {
                          const value = event.target.value;
                          setCells((prev) => ({ ...prev, [athlete.athlete_id]: { ...prev[athlete.athlete_id], [field.key]: value } }));
                        }}
                        className="input input--kiosk w-full"
                      />
                    </label>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {roster && roster.length > 0 && (
        <button type="button" className="btn btn--kiosk" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save test day'}
        </button>
      )}
      {message && (
        <div role={message.kind === 'refused' ? 'alert' : 'status'} className="t-body space-y-[var(--s1)]">
          <p>{message.text}</p>
          {message.also && message.also.length > 0 && (
            <>
              <p>Still saved from an earlier press, though not on this form:</p>
              <ul className="list-disc pl-[var(--s4)]">
                {message.also.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
              </ul>
            </>
          )}
        </div>
      )}
    </>
  );
}

export default function TestDayPage() {
  return (
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/coach/test-day"
      allowedRoles={['coach', 'admin']}
      room="floor"
      showShellHeader={false}
    >
      <div className="mx-auto max-w-5xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Testing</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Test Day</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Record each athlete&apos;s standing height, jumps (best of 3) and 20-m shuttle for one date. Leave a box
            empty for anything not tested. Heights are seen by staff only (coaches and the office); jumps and the
            shuttle go on each athlete&apos;s own testing history.
          </p>
          <p className="t-body mt-[var(--s2)]">
            <Link href="/coach/assessments" className="underline">One athlete at a time: Jump Test and Skill Ratings</Link>
          </p>
        </header>
        {/* Inside the gate: nothing is read until the role check lets the page render. */}
        <TestDayForm />
      </div>
    </RoleStandaloneView>
  );
}
