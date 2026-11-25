'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { keepSave, readSaveQueue, subscribeSaveQueue, type KeptSave } from '@/src/lib/saveQueue';
import type { ClassChoice } from '@/src/shared/sessionClassChoice';
import SessionClassPicker, { classTimes, type ClassChoiceInfo } from './SessionClassPicker';

// The class a live session is running, on the live screen (D4, OD-2026-10-21-002): tied, its
// "here" taps also go on that class's register; untied (open gym), they do not
// (OD-2026-10-13-016). The coach can tie the session to one of today's classes, which copies the
// marks already made, or untie it, which leaves the register as it is. Wording PROPOSED.

export interface RunClassView {
  class_id: string;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  no_shows: number;
  /** Who they are: the no-shows tap sends these names (W4 item 7, OVERWATCH 7160191377). */
  no_show_ids: string[];
}

type Copied = { athlete_id: string; effect: string; previous_status?: string };

/**
 * Words for a kept save whose resend was refused and could not be checked (W4 item 7): whether it
 * was saved is not known, so it is not called failed. Said where the coach tapped.
 */
/** Off the screen, the page's list says it under its own "not known" heading, after the save's name. */
export function unknownOffPage(check: string): string {
  return `the server refused it when it was sent again, and whether it was saved could not be checked. ${check}`;
}
/** Why a kept save refused as the run gone was not saved, for the page's list (the tie and the no-shows tap). */
export function goneWords(code: string): string {
  return code === 'SESSION_RUN_NOT_LIVE'
    ? 'the session had already ended when it reached the server'
    : 'the session could not be found for this account';
}
export function unknownOutcomeWords(label: string): string {
  return `${label}: the server refused it when it was sent again and could not be checked, so it is not known whether it was saved. Check what this screen shows before doing it again.`;
}

/** The live run's class as GET /api/pilot/session-scripts/runs answers it, or null. */
export async function fetchRunClass(signal?: AbortSignal): Promise<RunClassView | null> {
  const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, { credentials: 'include', signal });
  if (!response.ok) throw new Error('run');
  return ((await response.json()) as { class?: RunClassView }).class ?? null;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a tie did to the register, in counts (the names are on the who-is-here list). */
export function tieSummary(title: string, copied: readonly Copied[]): string {
  const count = (effect: string, previous?: string) =>
    copied.filter((row) => row.effect === effect && (previous === undefined || row.previous_status === previous)).length;
  const present = count('created') + count('already_present');
  const parts = [
    present > 0 ? `${plural(present, 'athlete is', 'athletes are')} Present on its register` : '',
    count('flipped', 'absent') > 0 ? `${plural(count('flipped', 'absent'), 'was', 'were')} marked Absent and ${count('flipped', 'absent') === 1 ? 'is' : 'are'} now Present` : '',
    count('flipped', 'excused') > 0 ? `${plural(count('flipped', 'excused'), 'was', 'were')} marked Excused and ${count('flipped', 'excused') === 1 ? 'is' : 'are'} now Present` : '',
    count('register_newer') > 0 ? `${plural(count('register_newer'), 'mark', 'marks')} changed on the register after your tap ${count('register_newer') === 1 ? 'stays' : 'stay'} as the register says` : '',
    count('skipped') > 0 ? `${plural(count('skipped'), 'athlete was', 'athletes were')} not added` : '',
  ].filter(Boolean);
  return `Tied to ${title}.${parts.length ? ` ${parts.join('; ')}.` : ''}`;
}

const RUN_GONE = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_NOT_FOUND']);
// The tie's refusals given only after its request key was looked up and found unrecorded
// (setSessionRunClass): the tie never landed. Any other refusal of a resend leaves it not known.
// Decided by the key alone, never by the run holding the class asked for, which another tab or
// device tying the same class would also produce (OVERWATCH 7170099938 on #2178).
const TIE_REFUSED_AFTER_KEY = new Set([
  'SESSION_RUN_NOT_LIVE',
  'SESSION_CLASS_NOT_FOUND',
  'SESSION_CLASS_NOT_YOURS',
  'SESSION_CLASS_CANCELLED',
  'SESSION_CLASS_NOT_TODAY',
  'SESSION_CLASS_ALREADY_LIVE',
]);

type TieAnswer = { class_id?: string | null; copied?: Copied[]; released?: string[]; replayed?: unknown; live?: unknown };

export default function SessionRunClass({
  runId,
  classId,
  onClassChange,
  onRunNotLive,
  onClassCancelled,
  isFinishWaiting,
}: {
  readonly runId: string;
  readonly classId: string | null;
  readonly onClassChange: (classId: string | null) => void;
  /** The session ended elsewhere (or was closed for being idle): the parent resyncs. */
  readonly onRunNotLive: () => void;
  /** Whether the tied class has been cancelled since, as last read (the who-is-here footer follows it). */
  readonly onClassCancelled?: (cancelled: boolean) => void;
  /** Whether a finish is kept and waiting now: once it lands this screen goes, so a refusal is said in the page's list. */
  readonly isFinishWaiting?: () => boolean;
}) {
  const [view, setView] = useState<RunClassView | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [choice, setChoice] = useState<ClassChoice>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // The picker's classes, so a kept tie can name its class while it waits.
  const pickedClasses = useRef<ClassChoiceInfo['classes']>([]);
  const onPick = useCallback((next: ClassChoice, info?: ClassChoiceInfo) => {
    setChoice(next);
    if (info) pickedClasses.current = info.classes;
  }, []);
  // The run this line is for now: a kept tie that lands after the console moved to another run says nothing.
  const currentRun = useRef(runId);
  useEffect(() => {
    currentRun.current = runId;
  }, [runId]);
  // A kept tie not yet saved, in words on this line. A drop (a sign-out) tells this line nothing:
  // once nothing kept waits on the page, the words go.
  const [waitingWords, setWaitingWords] = useState('');
  useEffect(
    () =>
      subscribeSaveQueue(() => {
        const state = readSaveQueue();
        if (state.waiting.length === 0 && state.checking === 0) setWaitingWords('');
      }),
    [],
  );
  // While this line is on the page, and no kept finish will take it away; otherwise a refusal gives
  // its words to the page's list.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);

  // The class's name and times, read when the session is (or becomes) tied.
  useEffect(() => {
    if (!classId) return undefined;
    let live = true;
    void (async () => {
      const read = await fetchRunClass().catch(() => null);
      if (live) setView(read);
    })();
    return () => {
      live = false;
    };
  }, [classId]);

  // What a tie (or untie) the server took did, in words. `changedSince`: this tap landed, and the
  // session's class was changed again after it (another tab or device); the words say what it is now.
  async function showTied(payload: TieAnswer, changedSince?: string) {
    setChoosing(false);
    onClassChange(payload.class_id ?? null);
    const lead = changedSince ? `${changedSince}: saved, but the session's class was changed again after it. ` : '';
    if (payload.class_id) {
      const tied = await fetchRunClass().catch(() => null);
      setView(tied);
      setMessage(`${lead}${tieSummary(tied?.title ?? 'the class', payload.copied ?? [])}`);
    } else {
      const kept = payload.released?.length ?? 0;
      setMessage(`${lead}No class now (open gym).${kept ? ` The ${plural(kept, 'mark', 'marks')} this session put on the class register ${kept === 1 ? 'stays' : 'stay'}.` : ''}`);
    }
  }

  // Kept on the open page and resent until it goes through (W4 item 7, OQ-3). Every send carries the
  // save's own request key: the server records it with the tie and answers a resend of a key it holds
  // as saved (`replayed`), writing nothing more. A refused RESEND is decided by that key before any
  // failed words (Overwatch condition 2): TIE_REFUSED_AFTER_KEY means it never landed; any other
  // refusal leaves it not known.
  function keptTie(next: string | null, resolved: { done: boolean }): KeptSave {
    let refusal: { error?: string; message?: string } = {};
    const title = next ? pickedClasses.current.find((item) => item.class_id === next)?.title : undefined;
    const label = next ? `Tie the session to ${title ?? 'a class'}` : 'Untie the session from its class';
    const forThisRun = () => currentRun.current === runId;
    return {
      label,
      send: ({ signal, requestKey }) =>
        fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'tie_class', class_id: next, request_key: requestKey }),
          signal,
        }),
      answerOf: async (response) => {
        if (response.ok) return 'saved';
        refusal = (await response.clone().json().catch(() => ({}))) as typeof refusal;
        return response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429 ? 'refused' : 'unknown';
      },
      // Decided by this save's own key: no read of the run, whose class another tab or device could match.
      checkLanded: async () => (refusal.error !== undefined && TIE_REFUSED_AFTER_KEY.has(refusal.error) ? false : null),
      onSaved: (response) => {
        resolved.done = true;
        setWaitingWords('');
        if (!forThisRun() || !response) return;
        void (async () => {
          const payload = (await response.json().catch(() => ({}))) as TieAnswer;
          // An earlier send landed, and the session has ended since (not here): the console resyncs.
          if (payload.replayed === true && payload.live === false) {
            onRunNotLive();
            return;
          }
          // The class the server holds now, said as changed since when it is not the one this tap set.
          await showTied(payload, payload.replayed === true && (payload.class_id ?? null) !== next ? label : undefined);
        })();
      },
      // Refused: said on this line, where the coach tapped.
      onRefused: (_response, landed) => {
        resolved.done = true;
        setWaitingWords('');
        const gone = refusal.error !== undefined && RUN_GONE.has(refusal.error);
        if (gone && forThisRun()) onRunNotLive();
        // The run gone, or no longer this line's: said in the page's list, as the console says only
        // that the session ended (and nothing once it settled here), never that this was not saved.
        if (gone || !forThisRun()) {
          // The session has ended: its class is read under Finished sessions, not on this line.
          if (landed === null) {
            return unknownOffPage(gone ? 'Check the class shown for this session under Finished sessions.' : 'Check which class the session is tied to before tying it again.');
          }
          return gone ? `The class was not changed: ${goneWords(refusal.error as string)}.` : refusal.message ?? 'The class could not be changed.';
        }
        const reason = refusal.message ?? 'The class could not be changed.';
        // Off the page, the page's list says it, after the save's own name.
        if (!onPage.current || isFinishWaiting?.()) {
          return landed === null ? unknownOffPage('Check which class the session is tied to before tying it again.') : reason;
        }
        setMessage(landed === null ? unknownOutcomeWords(label) : reason);
        return undefined;
      },
    };
  }

  async function tie(next: string | null) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      const resolved = { done: false };
      const kept = keptTie(next, resolved);
      if ((await keepSave(kept)) === 'kept') {
        setChoosing(false);
        // Said once kept (the account check settles first), unless it was answered already.
        if (!resolved.done) setWaitingWords(`${kept.label}: not saved yet. This page keeps sending it while it stays open.`);
        return;
      }
      // Not kept (the page does not know who is signed in): sent once, as before.
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(runId)}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'tie_class', class_id: next }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        class_id?: string | null;
        copied?: Copied[];
        released?: string[];
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        if (payload.error && RUN_GONE.has(payload.error)) {
          onRunNotLive();
          return;
        }
        setMessage(payload.message ?? 'The class could not be changed. Try again.');
        return;
      }
      await showTied(payload);
    } catch {
      setMessage('Network error -- the class was not changed.');
    } finally {
      setBusy(false);
    }
  }

  // The name shown is this class's only, never the one tied before a retie.
  const shown = view && view.class_id === classId ? view : null;
  const cancelled = shown?.status === 'cancelled';
  useEffect(() => {
    onClassCancelled?.(cancelled);
  }, [cancelled, onClassCancelled]);

  return (
    <div className="mt-[var(--s3)]">
      {classId ? (
        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          <p className="t-body">
            Class: <strong>{shown?.title ?? 'a scheduled class'}</strong>
            {shown && classTimes(shown) ? `, ${classTimes(shown)}` : ''}.{' '}
            {shown?.status === 'cancelled'
              ? 'This class was cancelled: marks here stay on the session only.'
              : 'Marks here also go on its register.'}
          </p>
          <button type="button" onClick={() => void tie(null)} disabled={busy} className="btn btn--ghost disabled:opacity-60">
            {busy ? 'Saving…' : 'Untie from the class'}
          </button>
        </div>
      ) : !choosing ? (
        <div className="flex flex-wrap items-center gap-[var(--s3)]">
          <p className="t-body">No class (open gym). Marks here do not go on a class register.</p>
          <button type="button" onClick={() => { setChoice(undefined); setMessage(''); setChoosing(true); }} className="btn btn--ghost">
            Tie to a class...
          </button>
        </div>
      ) : (
        <div className="space-y-[var(--s3)]">
          <SessionClassPicker value={choice} onChange={onPick} name={`tie-${runId}`} mode="tie" />
          <div className="flex flex-wrap gap-[var(--s3)]">
            <button type="button" onClick={() => choice && void tie(choice)} disabled={busy || !choice} className="btn disabled:opacity-60">
              {busy ? 'Saving…' : 'Tie to this class'}
            </button>
            <button type="button" onClick={() => setChoosing(false)} disabled={busy} className="btn btn--ghost">
              Cancel
            </button>
          </div>
        </div>
      )}
      <p role="status" className="t-body mt-[var(--s2)] text-[color:var(--brass-300)]">
        {waitingWords || message}
      </p>
    </div>
  );
}
