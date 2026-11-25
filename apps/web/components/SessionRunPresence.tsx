'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { apiBase } from '@/lib/apiBase';
import BehaviourSampleWindow from '@/components/BehaviourSampleWindow';
import SessionStaffNotesPanel from '@/components/SessionStaffNotesPanel';
import { unknownOffPage, unknownOutcomeWords } from '@/components/SessionRunClass';
import { keepSave, readSaveQueue, saveQueueAccountConfirmed, saveQueueGeneration, subscribeSaveQueue, type KeptSave } from '@/src/lib/saveQueue';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';
import { attendanceMethodWords } from '@/src/shared/attendanceMethodWords';

// "Who is here" on the live session screen (audit finding F-067).
//
// The coach delivering the session taps each athlete who is in the room. A mark is SESSION
// DETAIL, not attendance: it feeds no attendance report (CT-13), and it never touches the
// athlete's own check-in. Taking a mark back keeps the record of it on the server.
// ON A SESSION TIED TO A CLASS (D4, OD-2026-10-21-002) the same tap also writes that class's
// register, and the screen says what it did: Present, what it was before (OD-2026-10-21-004
// ruling 1), not added and why, or, on an untap, whether the register mark went too (ruling 2).
// Wording PROPOSED.
//
// THE LIST IS THE SERVER'S. GET /api/pilot/session-scripts/runs/[runId]/athletes answers with who
// is marked and with `gym`, the athletes this coach may mark: the gym's live athletes (a coach's
// reach is the whole gym, OD-2026-10-11-007). Nothing here decides who may be marked; the server
// refuses anything else, and its answer is what the screen shows.
//
// A marked athlete gets a staff note box for this session (staff only, OD-2026-10-10-003 items 3
// and 4), and a sampled window on one behaviour (PATTERN-1f, Q5 A: opened from the class that is
// running, on an athlete marked present). Neither reads anything until the coach opens it.
//
// HONEST ABOUT WHAT IS KNOWN. A read that failed is "could not be read", never "nobody here". A
// tap the server refused (400, 401, 403, 404, 409, 422) says nothing was saved; a tap whose answer
// never arrived, or came back as any other error, says it is not known and reads the list again.
// What is shown always belongs to THIS run: a read for another run, or one sent before a tap
// landed, is dropped rather than painted over the newer answer.
//
// A GYM OF HUNDREDS. Everyone marked is always listed. The rest of the gym is listed while it is
// small; past COLLAPSE_AT athletes it is behind "Show all" or the name filter, so the controls
// below this section (log an intervention, End session) stay within reach on a tablet.
//
// THE CLASS REGISTER, ON A TIED SESSION (lane 6C7, U2-6c; staging dry run 2026-11-19: this list was
// empty for a class whose athletes had already pressed "I'm here"). With a class, the section also
// reads GET /api/pilot/scheduler -- the read /schedule draws the same register from, so it shows
// nothing this coach cannot already read there -- and lists, after those marked here, the athletes
// that class's register has Present who are not marked here yet, each with how the mark was made.
// Nothing is copied from the register: a tap marks them here, as it does anyone else. The register
// is read when the section opens, after each tap, and when the coach asks; the line says when.
// A failed read is "could not be read", never "nobody". A register mark for an athlete who is not
// on this gym's list is counted, not named. Wording PROPOSED.

interface Athlete {
  athlete_id: string;
  full_name: string;
}

type Reading =
  | { runId: string; state: 'unavailable' }
  | { runId: string; state: 'loaded'; gym: Athlete[]; present: Set<string> };

/** The tied class's register as last read: who it has Present, and how each mark was made (null: not a known way). */
type RegisterReading =
  | { classId: string; state: 'unavailable' }
  | { classId: string; state: 'loaded'; present: Map<string, string | null>; readAt: number };

/**
 * Who GET /api/pilot/scheduler has Present on one class, or null when the answer cannot be read
 * as a register (so the screen says "could not be read", never "nobody"). A row that is not this
 * class's, not Present, or names no athlete is not this list's.
 */
export function registerPresent(payload: unknown, classId: string): Map<string, string | null> | null {
  if (!payload || typeof payload !== 'object') return null;
  const { attendance: rows, classes } = payload as { attendance?: unknown; classes?: unknown };
  if (!Array.isArray(rows)) return null;
  // A class the answer does not carry (gone, or not this organization's) has no register to read here.
  if (!Array.isArray(classes) || !classes.some((item) => (item as { class_id?: unknown } | null)?.class_id === classId)) {
    return null;
  }
  const present = new Map<string, string | null>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { class_id, athlete_id, status, method } = row as Record<string, unknown>;
    if (class_id !== classId || status !== 'present' || typeof athlete_id !== 'string') continue;
    present.set(athlete_id, attendanceMethodWords(method));
  }
  return present;
}

/** What the class register has that this session does not, in one line. */
export function registerLine(onRegister: number, named: number, unnamed: number): string {
  // The scheduler sends a coach the register of a class they run, cover or scheduled, and nothing
  // for any other: a coach whose cover was taken over gets no rows, which reads the same as an empty
  // register. So no rows is never said to be "nobody" (review of #2055).
  if (onRegister === 0) {
    return 'The class register sent no Present mark for this class. If another coach now covers it, its register is not sent to you, so this does not mean nobody is here.';
  }
  if (named === 0 && unnamed === 0) return 'Everyone marked Present on the class register is marked here.';
  const parts: string[] = [];
  if (named > 0) {
    parts.push(`${named} marked Present on the class register ${named === 1 ? 'is' : 'are'} not marked here yet.`);
  }
  if (unnamed > 0) {
    parts.push(
      `${unnamed} ${named > 0 ? 'more ' : ''}marked Present on the class register ${unnamed === 1 ? 'is' : 'are'} not on this gym’s list of athletes, so no name is shown.`,
    );
  }
  return parts.join(' ');
}

// The route's own refusals: when one of these comes back, the server said no and wrote nothing.
const REFUSAL_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

// Up to this many athletes, the whole gym is listed; past it, only those marked here until asked.
const COLLAPSE_AT = 30;

function isAthlete(value: unknown): value is Athlete {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return typeof row.athlete_id === 'string' && typeof row.full_name === 'string';
}

/** What a tap on a tied session did to the class register (session-scripts/runs/[runId]/athletes). */
export interface RegisterAnswer {
  effect: string;
  previous_status?: string;
  reason?: string;
}

/** A hold as the route sends it: details (one stands), 'unreadable' (not known), or nothing. */
export type HoldAnswer = 'held' | 'unknown' | null;

export function holdAnswer(value: unknown): HoldAnswer {
  if (value === 'unreadable') return 'unknown';
  return value && typeof value === 'object' ? 'held' : null;
}

const WAS: Record<string, string> = { absent: 'marked Absent', excused: 'marked Excused' };
const NOT_ADDED: Record<string, string> = { class_cancelled: 'the class was cancelled', not_your_class: 'you no longer run this class' };

/** The line a tap leaves for the coach: what the class register now shows, and a hold if one stands. */
export function registerNote(name: string, register: RegisterAnswer | undefined, hold: HoldAnswer): string {
  const holdWords = hold === 'held'
    ? ` ${name} has an active Training Hold; the mark was NOT blocked.`
    : hold === 'unknown' ? ` Whether ${name} is on a Training Hold could not be read.` : '';
  if (!register) return holdWords.trim();
  const words: Record<string, string> = {
    created: `${name} is Present on the class register.`,
    already_present: `${name} was already Present on the class register.`,
    flipped: `${name} was ${WAS[register.previous_status ?? ''] ?? 'not marked Present'} on the class register; now Present.`,
    skipped: `${name} is marked here but not on the class register: ${NOT_ADDED[register.reason ?? ''] ?? 'it could not be added'}.`,
    removed: `${name} is off the class register too.`,
    kept: `The class register was changed after your tap, so ${name}'s mark there was left as it is.`,
    unchanged: 'Only the mark here was taken back; the class register was not changed.',
  };
  return `${words[register.effect] ?? ''}${holdWords}`.trim();
}

function refusalText(code: unknown): string {
  if (code === 'SESSION_RUN_NOT_LIVE') return 'This session has already ended, so nothing was saved.';
  if (code === 'SESSION_RUN_NOT_FOUND') return 'This session could not be found for this account, so nothing was saved.';
  if (code === 'SESSION_RUN_ATHLETE_NOT_PERMITTED') return 'This account cannot mark that athlete here. Nothing was saved.';
  return 'The server refused, so nothing was saved.';
}

const NO_REFUSALS: ReadonlyMap<string, string> = new Map();

/** One kept here tap not yet answered: whom it marks, and how. */
type AskedTap = { save: object; athleteId: string; present: boolean };

// Brass and bone: an ordinary message, not the medical stop colour.
const ALERT = 'mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

export default function SessionRunPresence({
  runId,
  tied = false,
  classId = null,
  onPresentCount,
  onRunNotLive,
  isFinishWaiting,
}: {
  runId: string;
  /** The session is tied to a class (D4): marks here also go on its register. */
  tied?: boolean;
  /** The tied class: with it, the section also shows who that class's register already has Present. */
  classId?: string | null;
  /** The number of athletes marked here, each time the server says so; null while it is not known. */
  onPresentCount?: (count: number | null) => void;
  /** The server said this run is over or not this coach's: the live screen should ask what is live now. */
  onRunNotLive?: () => void;
  /** Whether a finish is kept and waiting now: once it lands this list goes, so a refusal is said in the page's list. */
  isFinishWaiting?: () => boolean;
}) {
  const [readingState, setReading] = useState<Reading | null>(null);
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  // What the last tap did to the class register (a tied session), or a hold on the athlete.
  const [note, setNote] = useState<{ athleteId: string; text: string } | null>(null);
  const latestRead = useRef(0);
  const headingId = useId();
  // The tied class's register, read beside the run's own marks; untied, nothing is read.
  const registerClassId = tied && classId ? classId : null;
  const [registerState, setRegister] = useState<RegisterReading | null>(null);
  // A register read is on its way: its button says so, so a press is never met with silence.
  const [registerBusy, setRegisterBusy] = useState(false);
  const latestRegisterRead = useRef(0);

  // An answer for another run is not this run's: until this run's read lands, it is loading.
  const reading: Reading | { state: 'loading' } = useMemo(
    () => (readingState && readingState.runId === runId ? readingState : { state: 'loading' }),
    [readingState, runId],
  );

  const read = useCallback(async () => {
    const ticket = latestRead.current + 1;
    latestRead.current = ticket;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/athletes`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => null)) as { present?: unknown; gym?: unknown } | null;
      if (
        !response.ok
        || !payload
        || !Array.isArray(payload.present)
        || !Array.isArray(payload.gym)
        || !payload.present.every(isAthlete)
        || !payload.gym.every(isAthlete)
      ) {
        throw new Error('unreadable');
      }
      if (latestRead.current !== ticket) return;
      setReading({
        runId,
        state: 'loaded',
        gym: payload.gym as Athlete[],
        present: new Set((payload.present as Athlete[]).map((athlete) => athlete.athlete_id)),
      });
    } catch {
      if (latestRead.current === ticket) setReading({ runId, state: 'unavailable' });
    }
  }, [runId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void read();
  }, [read]);

  // An answer for another class is not this class's: until this class's read lands, it is loading.
  const register: RegisterReading | { state: 'loading' } | null = useMemo(() => {
    if (!registerClassId) return null;
    return registerState && registerState.classId === registerClassId ? registerState : { state: 'loading' };
  }, [registerClassId, registerState]);

  const readRegister = useCallback(async () => {
    if (!registerClassId) return;
    const ticket = latestRegisterRead.current + 1;
    latestRegisterRead.current = ticket;
    setRegisterBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/scheduler`, { method: 'GET', credentials: 'include' });
      const payload = (await response.json().catch(() => null)) as unknown;
      const present = response.ok ? registerPresent(payload, registerClassId) : null;
      if (!present) throw new Error('unreadable');
      if (latestRegisterRead.current !== ticket) return;
      setRegister({ classId: registerClassId, state: 'loaded', present, readAt: Date.now() });
    } catch {
      if (latestRegisterRead.current === ticket) setRegister({ classId: registerClassId, state: 'unavailable' });
    } finally {
      if (latestRegisterRead.current === ticket) setRegisterBusy(false);
    }
  }, [registerClassId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void readRegister();
  }, [readRegister]);

  // HERE TAPS KEPT ON THE OPEN PAGE (W4 item 7, OQ-4; OW27-34 A, OW27-35 A). A tap whose answer is
  // lost is kept and sent again until it goes through, with the milliseconds since the tap, so a late
  // one never undoes an Absent or Excused set after it (Overwatch condition 1, OQ-1's server half).
  // What each kept tap asked, in the order tapped: added once its save is kept, gone with that save's
  // own answer (a later tap of the same athlete wins), and all cleared once nothing kept waits (a
  // sign-out drop tells this list nothing otherwise).
  // While this list is on the page, and no kept finish will take it away; otherwise a refusal gives
  // its words to the page's list.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);

  const [askedTaps, setAskedTaps] = useState<readonly AskedTap[]>([]);
  // Kept taps' refusals, one per athlete and named, as they can come back long after the tap and
  // several at once when the connection returns: each stays until that athlete's next tap is saved or
  // the coach taps OK, never cleared by an unrelated tap.
  const [keptRefusals, setKeptRefusals] = useState<ReadonlyMap<string, string>>(NO_REFUSALS);
  // Refused new notes' words, by athlete, out of sight until that athlete's notes are opened.
  const [noteWords, setNoteWords] = useState<ReadonlyMap<string, string>>(NO_REFUSALS);
  const noteRefusals = useRef(0);
  // They name athletes and hold one person's note text, and come only from kept saves: any drop of the
  // queue (a sign-out, another account, a 401) takes them off the screen at once (a shared floor tablet).
  useEffect(() => {
    let seen = saveQueueGeneration();
    return subscribeSaveQueue(() => {
      if (saveQueueGeneration() === seen) return;
      seen = saveQueueGeneration();
      setKeptRefusals(NO_REFUSALS);
      setNoteWords(NO_REFUSALS);
    });
  }, []);
  // While the page checks again who is signed in (a sign-in elsewhere writes no device mark), they are
  // only counted, and no words go back into a box: the person at the screen may be the next one.
  const accountConfirmed = useSyncExternalStore(subscribeSaveQueue, saveQueueAccountConfirmed, () => false);
  // A kept note refused while its panel was closed: its own line in the alert (two are two), and its
  // words kept for the box.
  const noteRefused = useCallback((athlete: Athlete, words: string, noteText: string): boolean => {
    // This list gone too: the panel says it in the page's list instead.
    if (!onPage.current) return false;
    noteRefusals.current += 1;
    const key = `note ${athlete.athlete_id} ${noteRefusals.current}`;
    setKeptRefusals((current) => new Map(current).set(key, `${athlete.full_name}: ${words}`));
    if (!noteText) return true;
    setNoteWords((current) => {
      const earlier = current.get(athlete.athlete_id);
      return new Map(current).set(athlete.athlete_id, earlier ? `${earlier}\n\n${noteText}` : noteText);
    });
    return true;
  }, []);
  const wordsReturned = useCallback((athleteId: string) => {
    setNoteWords((current) => {
      if (!current.has(athleteId)) return current;
      const next = new Map(current);
      next.delete(athleteId);
      return next;
    });
  }, []);
  const forgetRefusal = useCallback((athleteId: string) => {
    setKeptRefusals((current) => {
      if (!current.has(athleteId)) return current;
      const next = new Map(current);
      next.delete(athleteId);
      return next;
    });
  }, []);
  const asked = useMemo(() => new Map(askedTaps.map((tap) => [tap.athleteId, tap.present])), [askedTaps]);
  useEffect(
    () =>
      subscribeSaveQueue(() => {
        const state = readSaveQueue();
        if (state.waiting.length === 0 && state.checking === 0) setAskedTaps([]);
      }),
    [],
  );
  // Who is marked here, for a kept tap's landed check: null when it cannot be read.
  const readPresent = useCallback(
    async (signal: AbortSignal): Promise<Set<string> | null> => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/athletes`, {
          method: 'GET',
          credentials: 'include',
          signal,
        });
        const payload = (await response.json().catch(() => null)) as { present?: unknown } | null;
        if (!response.ok || !payload || !Array.isArray(payload.present) || !payload.present.every(isAthlete)) return null;
        return new Set((payload.present as Athlete[]).map((athlete) => athlete.athlete_id));
      } catch {
        return null;
      }
    },
    [runId],
  );

  const keptTap = useCallback(
    (athlete: Athlete, present: boolean, resolved: { done: boolean }): KeptSave => {
      let refusalCode: unknown;
      const label = present ? 'Mark an athlete here' : 'Unmark an athlete here';
      // What this tap asked goes with its own answer, saved or refused.
      const release = () => {
        resolved.done = true;
        setAskedTaps((taps) => taps.filter((tap) => tap.save !== resolved));
      };
      const showMark = () => {
        setReading((current) => {
          if (!current || current.runId !== runId || current.state !== 'loaded') return current;
          const next = new Set(current.present);
          if (present) next.add(athlete.athlete_id);
          else next.delete(athlete.athlete_id);
          return { ...current, present: next };
        });
        void readRegister();
      };
      return {
        // No name: the line can outlive this list on a shared floor screen. The row names the athlete.
        label,
        send: ({ signal, msSinceMade }) =>
          fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/athletes`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ athlete_id: athlete.athlete_id, present, tapped_ms_ago: msSinceMade }),
            signal,
          }),
        // A yes is a yes, whatever its body (as today); the route's own refusals are a no; anything else proves nothing.
        answerOf: async (response) => {
          if (response.ok) return 'saved';
          if (!REFUSAL_STATUSES.has(response.status)) return 'unknown';
          const payload = (await response.clone().json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
          refusalCode = payload?.code ?? payload?.error;
          return 'refused';
        },
        // A refused resend: is the mark what this tap asked? (Each tap sets a state, so a repeat changes nothing.)
        checkLanded: async (signal) => {
          const now = await readPresent(signal);
          return now === null ? null : now.has(athlete.athlete_id) === present;
        },
        onSaved: (response) => {
          release();
          // Refused as no longer live, yet the check found the mark: the session has still ended.
          if (refusalCode === 'SESSION_RUN_NOT_LIVE' || refusalCode === 'SESSION_RUN_NOT_FOUND') onRunNotLive?.();
          if (!onPage.current) return;
          // The mark at once (no flicker back while the answer is read), then what it did to the register.
          showMark();
          forgetRefusal(athlete.athlete_id);
          void (async () => {
            const answer = response
              ? ((await response.json().catch(() => null)) as { register?: RegisterAnswer; hold_warning?: unknown } | null)
              : null;
            setNote({ athleteId: athlete.athlete_id, text: registerNote(athlete.full_name, answer?.register, holdAnswer(answer?.hold_warning)) });
          })();
        },
        // Refused: said in this list, where the coach tapped.
        onRefused: (_response, landed) => {
          release();
          if (refusalCode === 'SESSION_RUN_NOT_LIVE' || refusalCode === 'SESSION_RUN_NOT_FOUND') onRunNotLive?.();
          if (!onPage.current || isFinishWaiting?.()) {
            return landed === null ? unknownOffPage('Check who is marked here on the class screen.') : refusalText(refusalCode);
          }
          // Named, as it can come back long after the tap. Not known: said, with the list as last read (a
          // read again that fails would hide the words).
          setKeptRefusals((current) => new Map(current).set(
            athlete.athlete_id,
            landed === null
              ? unknownOutcomeWords(`${present ? 'Mark' : 'Unmark'} ${athlete.full_name} here`)
              : `${athlete.full_name}: ${refusalText(refusalCode)}`,
          ));
          return undefined;
        },
      };
    },
    [forgetRefusal, isFinishWaiting, onRunNotLive, readPresent, readRegister, runId],
  );

  const presentCount = reading.state === 'loaded' ? reading.present.size : null;
  useEffect(() => {
    onPresentCount?.(presentCount);
  }, [onPresentCount, presentCount]);

  const mark = useCallback(
    async (athlete: Athlete, present: boolean) => {
      if (busy) return;
      setBusy(athlete.athlete_id);
      setMessage('');
      setNote(null);
      // A read already on its way was asked before this tap: its answer must not paint over this one.
      latestRead.current += 1;
      try {
        // Kept on the open page (W4 item 7). Not kept (the page does not know who is signed in): sent
        // once, as before. What it asks shows once kept, unless it was answered first.
        const resolved = { done: false };
        if ((await keepSave(keptTap(athlete, present, resolved))) === 'kept') {
          if (!resolved.done) setAskedTaps((taps) => [...taps, { save: resolved, athleteId: athlete.athlete_id, present }]);
          return;
        }
        let response: Response;
        try {
          response = await fetch(
            `${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}/athletes`,
            {
              method: 'POST',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ athlete_id: athlete.athlete_id, present }),
            },
          );
        } catch {
          setMessage(`The connection dropped. It is not known whether ${athlete.full_name} was ${present ? 'marked' : 'unmarked'}; the list has been read again.`);
          await read();
          return;
        }
        if (response.ok) {
          // A yes from the server is a yes, whatever its body: the mark is now what was asked for.
          // On a tied session the body also says what the tap did to the class register.
          const answer = (await response.json().catch(() => null)) as { register?: RegisterAnswer; hold_warning?: unknown } | null;
          setNote({ athleteId: athlete.athlete_id, text: registerNote(athlete.full_name, answer?.register, holdAnswer(answer?.hold_warning)) });
          // A kept tap's refusal for this athlete is past: this tap went through.
          forgetRefusal(athlete.athlete_id);
          setReading((current) => {
            if (!current || current.runId !== runId || current.state !== 'loaded') return current;
            const next = new Set(current.present);
            if (present) next.add(athlete.athlete_id);
            else next.delete(athlete.athlete_id);
            return { ...current, present: next };
          });
          // A tap on a tied session writes the class register too: what it now has is read again.
          void readRegister();
          return;
        }
        const payload = (await response.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
        if (REFUSAL_STATUSES.has(response.status)) {
          const code = payload?.code ?? payload?.error;
          setMessage(refusalText(code));
          if (code === 'SESSION_RUN_NOT_LIVE' || code === 'SESSION_RUN_NOT_FOUND') onRunNotLive?.();
          return;
        }
        setMessage(`It is not known whether ${athlete.full_name} was ${present ? 'marked' : 'unmarked'} (${response.status}); the list has been read again.`);
        await read();
      } finally {
        setBusy(null);
      }
    },
    [busy, forgetRefusal, keptTap, onRunNotLive, read, readRegister, runId],
  );

  const needle = filter.trim().toLowerCase();
  const collapsed = reading.state === 'loaded' && reading.gym.length > COLLAPSE_AT && !showAll && needle === '';
  // Present on the tied class's register and not marked here: named when on this gym's list, counted when not.
  const onRegister = register && register.state === 'loaded' ? register.present : null;
  const registerOnly = useMemo(() => {
    const named = new Set<string>();
    let unnamed = 0;
    if (onRegister && reading.state === 'loaded') {
      const known = new Set(reading.gym.map((athlete) => athlete.athlete_id));
      for (const athleteId of onRegister.keys()) {
        if (reading.present.has(athleteId)) continue;
        if (known.has(athleteId)) named.add(athleteId);
        else unnamed += 1;
      }
    }
    return { named, unnamed };
  }, [onRegister, reading]);
  const shown = useMemo(() => {
    if (reading.state !== 'loaded') return [];
    const matching = reading.gym.filter((athlete) => needle === '' || athlete.full_name.toLowerCase().includes(needle));
    // Marked here, or asked to be and not saved yet: a waiting tap stays in view in a large gym's list.
    const isMarked = (athleteId: string) => reading.present.has(athleteId) || asked.get(athleteId) === true;
    const marked = matching.filter((athlete) => isMarked(athlete.athlete_id));
    const fromRegister = matching.filter((athlete) => !isMarked(athlete.athlete_id) && registerOnly.named.has(athlete.athlete_id));
    // Here first, then those the class register has Present, then everyone else (unless the gym is
    // too big to list), each in the server's name order.
    const rest = matching.filter((athlete) => !isMarked(athlete.athlete_id) && !registerOnly.named.has(athlete.athlete_id));
    return collapsed ? [...marked, ...fromRegister] : [...marked, ...fromRegister, ...rest];
  }, [asked, collapsed, needle, reading, registerOnly]);
  // How many athletes' taps are asked and not saved yet, for the list's own status line.
  // With no list read, every asked tap is counted as waiting.
  const waitingCount = reading.state === 'loaded'
    ? [...asked].filter(([athleteId, present]) => present !== reading.present.has(athleteId)).length
    : asked.size;

  return (
    <section className="mt-[var(--s6)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]" aria-labelledby={headingId}>
      <h3 id={headingId} className="t-label">Who is here</h3>

      {reading.state === 'loading' ? (
        <p className="t-body mt-[var(--s2)]" role="status">Reading who is marked here…</p>
      ) : null}

      {reading.state === 'unavailable' ? (
        <div role="alert" className={ALERT}>
          <p>Who is marked here could not be read just now. That is not the same as nobody.</p>
          <button type="button" className="btn btn--ghost mt-[var(--s2)]" onClick={() => { setMessage(''); void read(); }}>
            Check again
          </button>
        </div>
      ) : null}

      {/* Kept taps' refusals stay through a list that could not be read; OK clears them. */}
      {keptRefusals.size > 0 && !accountConfirmed ? (
        <div role="alert" className={ALERT}>
          <p>
            {keptRefusals.size === 1
              ? '1 message about a save on this list shows again once the page has checked who is signed in.'
              : `${keptRefusals.size} messages about saves on this list show again once the page has checked who is signed in.`}
          </p>
        </div>
      ) : keptRefusals.size > 0 ? (
        <div role="alert" className={ALERT}>
          {[...keptRefusals].map(([athleteId, text]) => <p key={athleteId}>{text}</p>)}
          <button type="button" className="btn btn--kiosk mt-[var(--s2)]" onClick={() => setKeptRefusals(NO_REFUSALS)}>
            OK
          </button>
        </div>
      ) : null}
      {/* Mounted always, so a screen reader announces it when it fills; each row says whose tap waits. */}
      <p role="status" className="sr-only">
        {waitingCount === 0 ? '' : waitingCount === 1 ? 'One here tap is not saved yet.' : `${waitingCount} here taps are not saved yet.`}
      </p>

      {reading.state === 'loaded' ? (
        <>
          <p className="t-body mt-[var(--s2)]" role="status">
            {reading.present.size === 0
              ? 'Nobody marked here yet. Tap each athlete in the room.'
              : `${reading.present.size} marked here.`}
          </p>
          {/* No inline size: an inline --t-xs (11.8px) beat the kiosk .t-body
              floor on this gym-floor screen (sweep finding P-1, 2026-11-23). */}
          <p className="t-body mt-[var(--s1)] text-[color:var(--bone-400)]">
            {tied
              ? 'Staff only. This session is tied to a class: a mark here also goes on that class’s register.'
              : 'Staff only. This is who was in this session; it does not change anyone’s own check-in or attendance.'}
          </p>

          {/* The tied class's register (lane 6C7, U2-6c): what it has that this session does not. */}
          {register?.state === 'loading' ? (
            <p className="t-body mt-[var(--s2)]" role="status">Reading the class register…</p>
          ) : null}
          {register?.state === 'unavailable' ? (
            <div role="alert" className={ALERT}>
              <p>The class register could not be read just now. That is not the same as nobody on it.</p>
            </div>
          ) : null}
          {register?.state === 'loaded' ? (
            <p className="t-body mt-[var(--s2)]">
              {/* Only the counts are announced: the time changes on every read, and a read follows every tap. */}
              <span role="status">{registerLine(register.present.size, registerOnly.named.size, registerOnly.unnamed)}</span>
              {` Class register read at ${formatGymTimeOfDay(register.readAt) ?? 'a time that could not be shown'}.`}
            </p>
          ) : null}
          {register && register.state !== 'loading' ? (
            /* One button for both states, never disabled, so keyboard focus stays on it through a read. */
            <button
              type="button"
              className="btn btn--ghost mt-[var(--s2)]"
              aria-disabled={registerBusy}
              onClick={() => { if (!registerBusy) void readRegister(); }}
            >
              {registerBusy ? 'Reading the class register…' : 'Read the class register again'}
            </button>
          ) : null}

          {message ? <p role="alert" className={ALERT}>{message}</p> : null}
          {/* Read out here; shown under the athlete's own row, where the coach just tapped. */}
          <p role="status" className="sr-only">{note?.text ?? ''}</p>

          {reading.gym.length === 0 ? (
            <p className="t-body mt-[var(--s3)]">There are no athletes in this gym to mark.</p>
          ) : (
            <>
              <label className="field mt-[var(--s3)] block">
                <span className="t-label">Find an athlete</span>
                <input
                  /* input--kiosk: the legacy .input minimum (46px, unlayered)
                     beat both kiosk tap rules (sweep finding P-2). */
                  className="input input--kiosk"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  autoComplete="off"
                />
              </label>
              {reading.gym.length > COLLAPSE_AT && needle === '' ? (
                <button type="button" className="btn btn--ghost mt-[var(--s3)]" aria-expanded={showAll} onClick={() => setShowAll((open) => !open)}>
                  {showAll
                    ? register?.state === 'loaded' ? 'Show only those marked here or on the class register' : 'Show only those marked here'
                    : `Show all ${reading.gym.length} athletes`}
                </button>
              ) : null}
              {shown.length === 0 ? (
                <p className="t-body mt-[var(--s3)]">
                  {needle !== ''
                    ? `No athlete’s name matches “${filter.trim()}”.`
                    : 'Find an athlete by name, or show the whole gym, to mark who is here.'}
                </p>
              ) : (
                <ul className="mt-[var(--s3)] space-y-[var(--s3)]" aria-label="Athletes of this gym">
                  {shown.map((athlete) => {
                    const askedNow = asked.get(athlete.athlete_id);
                    // The button follows what was asked; the words under it say it is not saved yet.
                    const here = askedNow ?? reading.present.has(athlete.athlete_id);
                    const waiting = askedNow !== undefined && askedNow !== reading.present.has(athlete.athlete_id);
                    const fromRegister = registerOnly.named.has(athlete.athlete_id);
                    const registerSource = fromRegister ? onRegister?.get(athlete.athlete_id) ?? null : null;
                    return (
                      <li key={athlete.athlete_id}>
                        <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                          <span className="t-body font-semibold">{athlete.full_name}</span>
                          <button
                            type="button"
                            className={here ? 'btn' : 'btn btn--ghost'}
                            aria-pressed={here}
                            aria-describedby={waiting ? `${headingId}-waiting-${athlete.athlete_id}` : undefined}
                            disabled={busy !== null}
                            aria-busy={busy === athlete.athlete_id}
                            onClick={() => void mark(athlete, !here)}
                          >
                            {busy === athlete.athlete_id ? 'Saving…' : here ? 'Here' : 'Mark here'}
                            <span className="sr-only">{athlete.full_name}</span>
                          </button>
                        </div>
                        {waiting ? (
                          <p id={`${headingId}-waiting-${athlete.athlete_id}`} className="t-body mt-[var(--s1)] text-[color:var(--brass-300)]">
                            {`${here ? 'Marked here' : 'Unmarked here'}: not saved yet. This page keeps sending it while it stays open.`}
                          </p>
                        ) : null}
                        {fromRegister ? (
                          <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]">
                            {`Present on the class register${registerSource ? `, via ${registerSource}` : ''}. Not marked here yet.`}
                          </p>
                        ) : null}
                        {note && note.athleteId === athlete.athlete_id && note.text ? (
                          <p aria-hidden="true" className="t-body mt-[var(--s1)] text-[color:var(--brass-300)]">{note.text}</p>
                        ) : null}
                        {/* The server's mark, as today: a note is taken only for an athlete marked here. */}
                        {reading.present.has(athlete.athlete_id) ? (
                          <>
                            <SessionStaffNotesPanel
                              runId={runId}
                              athleteId={athlete.athlete_id}
                              buttonLabel={`Staff notes on ${athlete.full_name}`}
                              keptOnThisPage
                              isFinishWaiting={isFinishWaiting}
                              onKeptRefused={(words, noteText) => noteRefused(athlete, words, noteText)}
                              returnedWords={accountConfirmed ? noteWords.get(athlete.athlete_id) : undefined}
                              onWordsReturned={() => wordsReturned(athlete.athlete_id)}
                            />
                            <BehaviourSampleWindow runId={runId} athleteId={athlete.athlete_id} athleteName={athlete.full_name} />
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
