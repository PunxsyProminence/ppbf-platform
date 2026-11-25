'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { refusalWords } from '@/src/lib/serverRefusalWords';
import { AI_DRAFT_MARK, DRAFT_NOT_CHECKED, blockCoachingLines, blockNeedsDrillText } from '@/src/lib/sessionScriptWords';
import CoachLiveTiles, { type PainTileRead } from '@/components/CoachLiveTiles';
import RoundTimerControls from '@/components/RoundTimerControls';
import CoachInstructionPanel from '@/components/drills/CoachInstructionPanel';
import { readReferenceInstruction } from '@/components/drills/drillInstructionRead';
import { useDrillOpener } from '@/components/drills/useDrillOpener';
import { useLinkedDrillText } from '@/components/drills/useLinkedDrillText';
import { BlockKindIcon, blockKindWord } from '@/components/blockKindIcons';
import SessionRunPresence from '@/components/SessionRunPresence';
import SessionRunClass, { unknownOffPage, unknownOutcomeWords } from '@/components/SessionRunClass';
import SessionNoShows from '@/components/SessionNoShows';
import {
  keepSave,
  prepareSaveQueue,
  readSaveQueue,
  subscribeSaveQueue,
  type KeptSave,
} from '@/src/lib/saveQueue';
import type { LiveSessionScriptRun, SessionScriptRunRow } from '@/src/server/pilot/sessionScriptRuns';
import type { SessionScriptBlockRow, SessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';
import type { GymTvListItem } from '@/src/server/pilot/gymTvs';
import { formatGymTimeOfDay } from '@/src/lib/gymTime';

// The live surface of a session script run: one coach, one room, one row in
// pilot.session_script_runs. This component renders and moves that row through
// the EXISTING run routes and holds no state machine of its own -- every
// transition is a PATCH naming an action, and whatever run the server returns
// is the truth the screen shows next.
//
// THE SERVER OWNS THE CLOCK. elapsed_seconds arrives computed; between
// responses the browser ticks a smooth display forward from the last
// server-stamped value, and that ticking is presentation only -- it is never
// written back, never persisted, and every server response resets it.

type Block = SessionScriptBlockRow;

// Mirror of the browse page's markers, so a block reads the same on the floor
// as it did in the plan. Kinds not listed render without a marker.
const NOTABLE_KINDS: Record<string, string> = {
  drill_round: 'Drill',
  reset_minute: 'Reset',
  teaching_minute: 'Teaching',
  conditioning: 'Conditioning',
  reflection: 'Reflection',
};

// The intervention-execution link. pilot.intervention_executions.session_run_id
// (pilot_intervention_executions_session_run_fk) already ties an execution to the
// run that was live when it started -- this is the ONLY surface that sets it,
// because "in progress" is a fact this screen already holds and nowhere else does.
interface InterventionAthleteOption {
  athlete_id: string;
  full_name: string;
}

interface InterventionProtocolOption {
  protocol_id: string;
  title: string;
  version: number;
  athlete_id: string | null;
  status: string;
}

interface LoggedIntervention {
  execution_id: string;
  athlete_name: string;
  protocol_title: string;
  created_at: string;
}

// "On the floor" was here, and it was not presence.
//
// It listed every athlete whose id came back from
// /api/pilot/coach/readiness-board, and called them "athletes with a fresh
// check-in" in five places. The readiness board reads pilot.readiness, and
// every row in pilot.readiness was TYPED BY STAFF DURING INTAKE REVIEW --
// method 'staff_entered_intake' or 'UNKNOWN', nothing else exists. See
// readinessProvenance.ts and docs/capabilities/READINESS_PROVENANCE_FACTS.md.
//
// So a staff member forming a judgement about an athlete at a desk, possibly
// days before the session, put that athlete on a coach's screen under the
// heading "On the floor". Nobody arrived, nobody checked in, and nothing was
// observed. A coach running a live session read it as who was in the room.
//
// THERE IS NO AUTHORIZED PRESENCE SOURCE TO SWAP IN. Athlete self check-ins
// live in pilot.athlete_check_ins, and that route is SELF ONLY by design:
// app/api/pilot/athlete/check-in/route.ts:19-21 says "coach/admin views of
// arrivals are a later, separate read surface". Reaching for it here would be
// the same substitution with a better-looking source. Attendance is the
// coach/terminal register the passbook counts, which is not this either.
//
// The panel is therefore removed rather than repointed.
//
// WHO WAS IN THE ROOM IS NOW RECORDED BY THE COACH (audit finding F-067), not
// inferred from any other table: SessionRunPresence lists the gym's athletes
// and the delivering coach taps each one who is here. That is its own record
// (sessionRunAthletes.ts on the server), session detail and not attendance (CT-13); it
// touches no athlete's own check-in. On a session tied to a class (D4, OD-2026-10-21-002) the
// same tap also writes that class's register (sessionRunClass.ts), which is attendance.
//
// athletes_present stays what it was: a COUNT the coach states at finish. It
// starts from the number marked here, until the coach types in it; what the
// coach leaves in the box is what is saved. Nobody marked leaves it empty, so
// an empty room is never recorded that nobody counted.

function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(rest).padStart(2, '0')}`;
}

// Refusal codes in words for a coach mid-class; a code or a status number is
// never shown (UXB-09). The words live in src/lib/serverRefusalWords.ts.
function describeRunError(code: unknown, status?: number): string {
  return refusalWords({ error: code, status });
}

// WHAT A WRITE'S ANSWER PROVES (ChatGPT pilot audit 2026-10-17, item 1). A refusal (4xx)
// changed nothing, and a 2xx carrying the object is the server's word. Anything else -- the
// request threw, the server failed (5xx), or a yes came back without the object -- proves
// nothing either way: the write may already be committed. So the screen asks the server what
// it now holds and says that, rather than claiming "not logged" or "nothing changed" and
// inviting a repeat that could log the same thing twice. All wording PROPOSED (lane L40).
const RUN_NOT_SAVED = 'No clear answer came back, and the server shows it was not saved. Try again.';
const RUN_UNCHECKED = 'No clear answer came back and the server could not be checked. Reload the page before trying again.';
const RUN_END_UNKNOWN = 'No clear answer came back, and the server does not show how this session ended. Reload the page before trying again.';
const LOG_SAVED = 'No clear answer came back, but the server shows the intervention was logged.';
// With the request key below, a retry of the same tap is answered with the record the first send
// wrote if that write lands late, so "try again" cannot log it twice (finding F-135). Accepted
// by Overwatch for lane L55.
const LOG_NOT_SAVED = 'No clear answer came back, and the server does not show the intervention yet. Try again -- it will not be logged twice.';
const LOG_UNCHECKED = 'No clear answer came back and the server could not be checked. Check The Work before logging it again.';
const RUN_OUT_OF_DATE = 'The session shown was out of date and has been reloaded from the server.';
export const RUN_GONE = 'This session is no longer live on the server. Nothing further can be recorded through this screen.';

/** True only for a refusal: the server answered and wrote nothing. */
function isRefusal(status: number): boolean {
  return status >= 400 && status < 500;
}

/** What the live run shows about the run action that was asked, or null when it does not show it. */
function savedRunWords(body: Record<string, unknown>, live: LiveSessionScriptRun, blocks: readonly Block[]): string | null {
  switch (body.action) {
    case 'pause':
      return live.is_paused ? 'the session is paused' : null;
    case 'resume':
      return live.is_paused ? null : 'the session is running';
    case 'advance': {
      if (live.current_block_id !== body.to_block_id) return null;
      const label = blocks.find((item) => item.block_id === body.to_block_id)?.block_label;
      return label ? `the session is on ${label}` : 'the session is on the block you picked';
    }
    case 'show_on_wall':
      if (live.show_on_wall !== body.show) return null;
      // Lane U2-6a: the switch allows a TV; it does not put the session on one.
      return live.show_on_wall ? 'the session is allowed on a TV' : 'the session is not allowed on a TV';
    default:
      return null;
  }
}

// A kept run action's refusals that the server gives only after looking up the action's request key
// and finding it unrecorded (keyedSessionScriptRunAction): the action never landed. Any other refusal
// of a resend leaves it not known. Decided by the key alone, never by the run's state matching what
// was asked, which another tab or device making the same change would also produce (OVERWATCH
// 7170099938, Codex P2 4698738015 on #2178).
const RUN_REFUSED_AFTER_KEY = new Set(['SESSION_RUN_NOT_LIVE', 'SESSION_RUN_HAS_NO_SCRIPT', 'SESSION_RUN_BLOCK_NOT_IN_SCRIPT']);

/** Nothing kept is waiting on this page (saved, refused, or dropped at a sign-out). */
function queueIdle(): boolean {
  const state = readSaveQueue();
  return state.waiting.length === 0 && state.checking === 0;
}

type PendingRun = Partial<Pick<LiveSessionScriptRun, 'is_paused' | 'show_on_wall' | 'current_block_id'>>;
/** An intervention execution of this run as the ledger lists it (the fields a landed check reads). */
type RunExecution = {
  execution_id: string;
  created_at: string;
  recorded_by_account_id?: string;
  version?: number;
  /** The key that started the record's lineage: a kept log's landed check matches by it. */
  request_key?: string | null;
};
/** A ledger that names no request keys (a server older than this page): which log is this tap's cannot be told by key. */
function namesNoKeys(items: readonly RunExecution[]): boolean {
  return items.length > 0 && items.every((item) => item.request_key === undefined);
}
/** One kept run action not yet answered: what it asks, and whether it ends the session. */
type AskedRun = { save: object; asked: PendingRun; finish: boolean };

/** The part of the run a run action asks for, or null (a finish). */
function askedByRunAction(body: Record<string, unknown>): PendingRun | null {
  switch (body.action) {
    case 'pause':
      return { is_paused: true };
    case 'resume':
      return { is_paused: false };
    case 'advance':
      return typeof body.to_block_id === 'string' ? { current_block_id: body.to_block_id } : null;
    case 'show_on_wall':
      return { show_on_wall: body.show === true };
    default:
      return null;
  }
}

/**
 * What the waiting and failed lines call a run action (W4 item 7, OQ-3): the control's own words.
 * Words PROPOSED (UI not tied down, OD-2026-10-02-004).
 */
export function runActionLabel(body: Record<string, unknown>, blocks: readonly Block[]): string {
  switch (body.action) {
    case 'pause':
      return 'Pause session';
    case 'resume':
      return 'Resume session';
    case 'advance': {
      const label = blocks.find((item) => item.block_id === body.to_block_id)?.block_label;
      return label ? `Move to ${label}` : 'Move to the block you picked';
    }
    case 'show_on_wall':
      return body.show ? 'Allow on a TV: on' : 'Allow on a TV: off';
    case 'finish':
      return body.run_state === 'abandoned' ? 'Record as abandoned' : 'Record as completed';
    default:
      return 'Session change';
  }
}

/** The settled run handed back: only what the page reads from it, which both the PATCH answer
 *  and the finished-sessions read carry. */
export type SettledRunSummary = Pick<SessionScriptRunRow, 'run_id' | 'script_id' | 'run_state'>;

interface SessionScriptLiveDeliveryProps {
  readonly initialRun: LiveSessionScriptRun;
  /** The run settled (completed or abandoned) -- the server's settled row. */
  readonly onSettled: (run: SettledRunSummary) => void;
  /** The run is no longer live server-side and no live run replaced it. */
  readonly onRunGone: (message: string) => void;
  /**
   * Bumped by the screen when Gym TVs sends, takes off or disconnects a TV, so the TV status line
   * reads the TVs again (lane U2-6a, Overwatch Q10 = A: no timer).
   */
  readonly tvStatusRefresh?: number;
  /**
   * Told the run this screen now holds, after every server answer that changes it (lane U2-6a),
   * so a panel beside the console -- Gym TVs on the class screen -- never works from an older
   * copy of the switch or of which run is live.
   */
  readonly onRunChange?: (run: LiveSessionScriptRun) => void;
  /**
   * The screen's pain read, for the top row's pain tile (lane U2-6b-2): the class screen's one
   * read, which its pain list also draws. Without it the tile reads the feed itself.
   */
  readonly painFeed?: PainTileRead;
}

/** One read of the gym's TVs, as the TV status line holds it (lane U2-6a). */
export type TvStatusRead =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | {
      readonly state: 'loaded';
      readonly tvs: readonly Pick<GymTvListItem, 'tv_name' | 'status' | 'current_run_id'>[];
      readonly readAt: number;
    };

/**
 * Where this session is, said only as far as the TV read can know it (Overwatch's 6a ruling, with
 * its Q1 correction: "TV status not checked" for ANY role whenever the read is refused or fails,
 * and until it has answered). "ON" only when a paired TV's current_run_id is this run.
 */
export function tvStatusLine(read: TvStatusRead, runId: string): { readonly on: boolean; readonly text: string } {
  if (read.state !== 'loaded') return { on: false, text: 'TV status not checked' };
  const paired = read.tvs.filter((tv) => tv.status === 'paired');
  const showing = paired.filter((tv) => tv.current_run_id === runId).map((tv) => tv.tv_name);
  if (showing.length > 0) return { on: true, text: `ON ${showing.join(', ')}` };
  if (paired.length === 0) return { on: false, text: 'No TV paired' };
  return { on: false, text: 'Not on a TV' };
}

export default function SessionScriptLiveDelivery({
  initialRun,
  onSettled,
  onRunGone,
  tvStatusRefresh = 0,
  onRunChange,
  painFeed,
}: SessionScriptLiveDeliveryProps) {
  const [run, setRun] = useState<LiveSessionScriptRun>(initialRun);
  // A plain session (issue #1523) has no plan: no blocks to show or move between. Everything
  // else -- the clock, pause, the TV switch, logging an intervention, finishing -- is the same.
  const isPlain = initialRun.script_id === null;
  // The displayed clock. Seeded from the server's elapsed_seconds and RESET to
  // the server's value on every response; between responses an interval ticks
  // it forward for smoothness. Presentation only -- it is never sent anywhere,
  // never persisted, and any drift lasts only until the next server response.
  const [displaySeconds, setDisplaySeconds] = useState(initialRun.elapsed_seconds);

  const applyServerRun = useCallback((next: LiveSessionScriptRun) => {
    setRun(next);
    setDisplaySeconds(next.elapsed_seconds);
  }, []);

  useEffect(() => {
    onRunChange?.(run);
  }, [run, onRunChange]);

  // WHERE THE SESSION IS ON THE TVS (lane U2-6a). Read when the console opens, after the switch
  // changes, and when the screen says Gym TVs acted (tvStatusRefresh). No timer (Q10 = A); the
  // line says when it was read. The newest read wins; a late answer to an older one is dropped.
  const [tvRead, setTvRead] = useState<TvStatusRead>({ state: 'loading' });
  const tvReadSeq = useRef(0);
  useEffect(() => {
    const seq = ++tvReadSeq.current;
    // Until this read answers, the last one may be out of date (the switch just changed, or Gym
    // TVs just acted): it is not shown as current.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTvRead({ state: 'loading' });
    void (async () => {
      let next: TvStatusRead;
      try {
        const response = await fetch(`${apiBase()}/api/pilot/gym-tvs`, { credentials: 'include' });
        const payload = (await response.json().catch(() => null)) as { tvs?: unknown } | null;
        next = response.ok && payload && Array.isArray(payload.tvs)
          ? { state: 'loaded', tvs: payload.tvs as GymTvListItem[], readAt: Date.now() }
          : { state: 'failed' };
      } catch {
        next = { state: 'failed' };
      }
      if (seq === tvReadSeq.current) setTvRead(next);
    })();
  }, [run.run_id, run.show_on_wall, tvStatusRefresh]);
  const tvStatus = tvStatusLine(tvRead, run.run_id);
  const tvReadAt = tvRead.state === 'loaded' ? formatGymTimeOfDay(new Date(tvRead.readAt)) : null;

  // Tick once a second while running. While paused the interval is off and the
  // display holds the server's frozen reading.
  useEffect(() => {
    if (run.is_paused) return;
    const id = setInterval(() => setDisplaySeconds((seconds) => seconds + 1), 1000);
    return () => clearInterval(id);
  }, [run.is_paused, run.run_id]);

  // The plan being delivered, read from the existing browse route. The run can
  // be paused or finished without it, but blocks cannot be named or navigated
  // until it loads -- so its failure is its own visible state, never an
  // empty plan.
  const [detail, setDetail] = useState<SessionScriptWithDetail | null>(null);
  const [detailState, setDetailState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  // No state is set before the first await (the page's own convention): the
  // initial state is already 'loading', and the retry button sets it back
  // before calling this again.
  const loadDetail = useCallback(async () => {
    if (initialRun.script_id === null) return;
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/session-scripts?script_id=${encodeURIComponent(initialRun.script_id)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('detail');
      const payload = (await response.json()) as { script?: SessionScriptWithDetail };
      if (!payload.script) throw new Error('detail');
      setDetail(payload.script);
      setDetailState('loaded');
    } catch {
      setDetail(null);
      setDetailState('unavailable');
    }
  }, [initialRun.script_id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadDetail();
  }, [loadDetail]);

  const blocks: Block[] = detail?.blocks ?? [];
  const currentIndex = blocks.findIndex((block) => block.block_id === run.current_block_id);
  const currentBlock = currentIndex >= 0 ? blocks[currentIndex] : null;
  // Run actions kept and not yet saved (W4 item 7): what each asks, in the order tapped, so the next
  // tap works from what the coach asked, not from the run as last read. Each entry is added once its
  // save is kept and goes with that save's answer, never another's; a later one wins. What is shown
  // as the run stays the server's.
  const [askedRuns, setAskedRuns] = useState<readonly AskedRun[]>([]);
  const asked = askedRuns.reduce<LiveSessionScriptRun>((all, entry) => ({ ...all, ...entry.asked }), run);
  const askedIndex = blocks.findIndex((block) => block.block_id === asked.current_block_id);
  const previousBlock = askedIndex > 0 ? blocks[askedIndex - 1] : null;
  const nextBlock = askedIndex >= 0 && askedIndex < blocks.length - 1 ? blocks[askedIndex + 1] : null;

  // Lane U2-6e (Overwatch Q4 = A): the current block's linked drill is read
  // when one of its Say, Watch or Fix lines is empty, and kept for the rest of
  // the run, so those lines show the drill's text instead of "Not written yet".
  const currentNeedsDrill = currentBlock !== null && blockNeedsDrillText(currentBlock);
  const drillTexts = useLinkedDrillText(currentNeedsDrill ? [currentBlock.drill_id as string] : []);

  // THE DRILL BEHIND THE CURRENT BLOCK (audit 2026-10-17 item 1). A plan made
  // from a template copies a step's name, minutes, scale, contact and note, not
  // the drill's setup, execution, cues or corrections. The coach opens the drill
  // the block links -- that version, through the drill library's own read
  // (readReferenceInstruction, as the Coach Cards page does) and its own
  // DrillDetail, with the block's scale level opened -- in place under the
  // block, so the session keeps running, and closes it to return to the block.
  // Opening writes nothing. The panel belongs to the block it was opened from:
  // when the session moves on it is closed (a read still loading is cancelled),
  // so going back to that block does not reopen it, and focus stays with the
  // control the coach used to move -- the Coach Cards page's rule.
  const drill = useDrillOpener();
  const { openKey: openDrillKey, close: closeDrill } = drill;
  const drillOpen = currentBlock !== null && openDrillKey === currentBlock.block_id;
  useEffect(() => {
    if (openDrillKey !== null && openDrillKey !== run.current_block_id) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      closeDrill({ returnFocus: false });
    }
  }, [openDrillKey, run.current_block_id, closeDrill]);
  function toggleDrill(block: Block) {
    if (drill.openKey === block.block_id) {
      drill.close();
      return;
    }
    const referenceDrillId = block.drill_id;
    if (referenceDrillId === null) return;
    drill.open(block.block_id, `live-block-instructions-${block.block_id}`, (signal) =>
      readReferenceInstruction(referenceDrillId, signal),
    );
  }

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  // Set when this console hands the page a settled run; a finish once kept locks the run actions.
  const settledHere = useRef(false);
  // No run action while one is in hand, or once a finish is kept: it cannot be taken back, and an
  // action queued behind it would only be refused once the session has ended.
  const finishKept = askedRuns.some((entry) => entry.finish);
  const controlsLocked = actionBusy !== null || finishKept;
  // Once a kept finish lands this console goes, so a refusal said here meanwhile would go unread:
  // it is said in the page's list instead. Set when the finish is kept and when it is answered, so a
  // refusal arriving before the next render reads it right; the screens below ask through a getter.
  const finishKeptNow = useRef(finishKept);
  useEffect(() => {
    finishKeptNow.current = finishKept;
  }, [finishKept]);
  const isFinishWaiting = useCallback(() => finishKeptNow.current, []);
  // Asked and not yet saved, in words beside the controls: the buttons follow what was asked, while
  // the badge, the block and the switch's state as saved are the server's.
  const askedNotSaved = [
    asked.is_paused !== run.is_paused ? (asked.is_paused ? 'Pause session' : 'Resume session') : null,
    asked.current_block_id !== run.current_block_id
      ? runActionLabel({ action: 'advance', to_block_id: asked.current_block_id }, blocks)
      : null,
    asked.show_on_wall !== run.show_on_wall
      ? runActionLabel({ action: 'show_on_wall', show: asked.show_on_wall }, blocks)
      : null,
  ].filter((words): words is string => words !== null);
  const askedLineId = `asked-not-saved-${run.run_id}`;
  // While this console is on the page; a save that resolves after it has gone gives its words to
  // the page's list instead, so they are said somewhere.
  const onPage = useRef(true);
  useEffect(() => {
    onPage.current = true;
    return () => {
      onPage.current = false;
    };
  }, []);
  const settledByThisConsole = useCallback((settled: SettledRunSummary) => {
    settledHere.current = true;
    onSettled(settled);
  }, [onSettled]);
  // The page keeps its live-floor saves (W4 item 7): it learns who is signed in when it opens.
  useEffect(() => {
    prepareSaveQueue();
  }, []);

  // ---- Log an intervention against THIS run --------------------------
  // The picklists a coach needs to log one: the roster they coach, and the
  // ACTIVE protocols (a retired or draft protocol is not a live plan to
  // execute against). Both load independently of the script plan above --
  // a failed script-plan read must not also hide this control.
  const [logAthletes, setLogAthletes] = useState<InterventionAthleteOption[]>([]);
  const [logAthletesState, setLogAthletesState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');
  const [logProtocols, setLogProtocols] = useState<InterventionProtocolOption[]>([]);
  const [logProtocolsState, setLogProtocolsState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
        if (!response.ok) throw new Error('athletes');
        const payload = (await response.json()) as { items?: InterventionAthleteOption[] };
        setLogAthletes(payload.items ?? []);
        setLogAthletesState('loaded');
      } catch {
        setLogAthletes([]);
        setLogAthletesState('unavailable');
      }
    })();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-protocols`, { credentials: 'include' });
        if (!response.ok) throw new Error('protocols');
        const payload = (await response.json()) as { items?: InterventionProtocolOption[] };
        setLogProtocols((payload.items ?? []).filter((p) => p.status === 'active'));
        setLogProtocolsState('loaded');
      } catch {
        setLogProtocols([]);
        setLogProtocolsState('unavailable');
      }
    })();
  }, []);

  const [logOpen, setLogOpen] = useState(false);
  const [logAthleteId, setLogAthleteId] = useState('');
  const [logProtocolId, setLogProtocolId] = useState('');
  const [logBusy, setLogBusy] = useState(false);
  const [logError, setLogError] = useState('');
  // Kept logs not yet saved: said in the log panel too, where the coach tapped (W4 item 7).
  // One entry per kept log, keyed by its pair's request key: the same pair tapped twice is one log.
  const [logsWaiting, setLogsWaiting] = useState<readonly { save: object; key: unknown }[]>([]);
  const logsWaitingCount = new Set(logsWaiting.map((entry) => entry.key)).size;
  const [loggedInterventions, setLoggedInterventions] = useState<LoggedIntervention[]>([]);
  // A drop (a sign-out, another account, a 401) tells this screen nothing: once nothing kept is
  // waiting on the page, nothing is asked, no finish waits and no log waits here either. (Each is
  // added only once its save is kept, so the queue's own notices while it takes a save clear nothing
  // of it.)
  useEffect(
    () =>
      subscribeSaveQueue(() => {
        if (!queueIdle()) return;
        setAskedRuns([]);
        setLogsWaiting([]);
      }),
    [],
  );

  // ONE TAP, ONE INTERVENTION (finding F-135). A read that finds nothing does not prove a write
  // still in flight will not commit after it, so a retry must not be a new log. Each tap of an
  // athlete and protocol in this run gets one random request key, sent again on every retry of
  // that pair while its answer is unsettled; the server answers a repeated key with the execution
  // the first send started (POST intervention-executions, request_key). Only an answer about THIS
  // tap ends it: logged (said by the server or found by the check), or its key refused as another
  // intervention's. Any other refusal keeps the key -- a refused retry says nothing about an
  // earlier send still in flight, and a key that names nothing is simply written. Null marks a pair
  // whose key could not be made (no randomUUID); then none is sent, as before.
  const logRequestKeys = useRef(new Map<string, string | null>());
  // Each pair key belongs to the account whose kept log first sent it, or whose log the server says
  // it wrote. The server answers a repeated key within the organization, so another account's tap of
  // the same pair (someone else signed in on this page) sends its own key, one per pair key and
  // account: it never replays the last person's log as theirs, and their own second tap is still one
  // log. A landed log retires its pair key, so a later tap of the pair gets new keys altogether.
  const pairKeyAccounts = useRef(new Map<string, string>());
  const accountPairKeys = useRef(new Map<string, string>());

  // A protocol authored for one specific athlete never applies to another --
  // the server enforces this too (startExecution), but narrowing the list
  // here means a coach cannot even select a mismatched pair.
  const availableProtocols = logProtocols.filter(
    (protocol) => !protocol.athlete_id || protocol.athlete_id === logAthleteId,
  );

  // This athlete's executions already tied to this run under this protocol, newest first, from
  // the existing ledger read; null when the read fails, times out, or its answer has no list.
  const readRunExecutions = useCallback(
    async (
      athleteId: string,
      protocolId: string,
      signal?: AbortSignal,
    ): Promise<RunExecution[] | null> => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/intervention-executions?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include', cache: 'no-store', signal },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as {
          items?: (RunExecution & { session_run_id: string | null; protocol_id: string })[];
        };
        if (!Array.isArray(payload.items)) return null;
        return payload.items.filter((item) => item.session_run_id === run.run_id && item.protocol_id === protocolId);
      } catch {
        return null;
      }
    },
    [run.run_id],
  );

  const keptLog = useCallback(
    (
      athleteId: string,
      protocolId: string,
      athleteName: string,
      protocolTitle: string,
      pairKey: string | null,
      forgetPairKey: () => void,
      resolved: { done: boolean },
    ): KeptSave => {
      let refusal: { error?: string; code?: string } = {};
      let landedItem: { execution_id: string; created_at: string } | null = null;
      // Who sent it last, and under which key.
      let sent: { by: string; key: string } | null = null;
      const label = `Intervention log: ${protocolTitle}`;
      const settleOnce = () => {
        resolved.done = true;
        setLogsWaiting((entries) => entries.filter((entry) => entry.save !== resolved));
      };
      const showLogged = (item: { execution_id: string; created_at: string }) => {
        forgetPairKey();
        // A second tap of the same pair is answered with the same record: listed once.
        setLoggedInterventions((items) => (items.some((logged) => logged.execution_id === item.execution_id) ? items : [
          { execution_id: item.execution_id, athlete_name: athleteName, protocol_title: protocolTitle, created_at: item.created_at },
          ...items,
        ]));
      };
      return {
        // No athlete name: the line can outlive the log panel on a shared floor screen.
        label,
        send: ({ signal, requestKey, madeByAccountId }) => {
          let key = requestKey;
          if (pairKey) {
            const owner = pairKeyAccounts.current.get(pairKey);
            if (owner === undefined) pairKeyAccounts.current.set(pairKey, madeByAccountId);
            if (owner === undefined || owner === madeByAccountId) key = pairKey;
            else {
              const slot = `${pairKey} ${madeByAccountId}`;
              key = accountPairKeys.current.get(slot) ?? requestKey;
              accountPairKeys.current.set(slot, key);
            }
          }
          sent = { by: madeByAccountId, key };
          return fetch(`${apiBase()}/api/pilot/coach/intervention-executions`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              athlete_id: athleteId,
              protocol_id: protocolId,
              session_run_id: run.run_id,
              // The pair's own key while it is unsaved (F-135): a second tap of the same pair, or a
              // retry after today's "Try again", is the same log, never a second one.
              request_key: key,
              made_by_account_id: madeByAccountId,
            }),
            signal,
          });
        },
        answerOf: async (response) => {
          const payload = (await response.clone().json().catch(() => ({}))) as {
            item?: { recorded_by_account_id?: unknown; version?: unknown };
            replayed?: unknown;
            error?: string;
            code?: string;
          };
          if (isRefusal(response.status) && response.status !== 408 && response.status !== 429) {
            refusal = payload;
            return 'refused';
          }
          // The pair's key wrote another account's log (a key first sent on today's path, then someone
          // else signed in): this log is not written. The key is theirs; this one goes again under its own.
          // Only an uncorrected record names who wrote it: a correction is recorded by the corrector, so
          // a corrected replay counts as this log, as before (never a second one).
          const recordedBy = payload.item?.recorded_by_account_id;
          if (response.ok && payload.replayed === true && pairKey && sent?.key === pairKey && payload.item?.version === 1
            && typeof recordedBy === 'string' && recordedBy !== sent.by) {
            pairKeyAccounts.current.set(pairKey, recordedBy);
            return 'unknown';
          }
          return response.ok && payload.item ? 'saved' : 'unknown';
        },
        // A refused resend: does this run hold the log this save's own key started? Matched by the key
        // only: another tap of the same pair, from another tab or device of the same account, has its
        // own key and is never taken for this one (Codex P2 and OVERWATCH on #2178).
        checkLanded: async (signal) => {
          const last = sent;
          if (last === null) return null;
          const after = await readRunExecutions(athleteId, protocolId, signal);
          if (after === null || namesNoKeys(after)) return null;
          // Another account's uncorrected log under a shared pair key (first sent on today's path) is
          // not this one.
          landedItem = after.find((item) => item.request_key === last.key
            && (item.version !== 1 || item.recorded_by_account_id === last.by)) ?? null;
          return landedItem !== null;
        },
        onSaved: (response) => {
          settleOnce();
          void (async () => {
            const item = response
              ? ((await response.json().catch(() => ({}))) as { item?: { execution_id: string; created_at: string } }).item
              : landedItem;
            if (item) showLogged(item);
          })();
        },
        // Refused: said in the log panel, where the coach tapped.
        onRefused: (response, landed) => {
          settleOnce();
          if (refusal.code === 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED') forgetPairKey();
          const reason = refusalWords({ error: refusal.error, status: response.status }, {}, 'The intervention was not logged.');
          // Off the page, the page's list says it, after the save's own name.
          if (!onPage.current || finishKeptNow.current) {
            return landed === null ? unknownOffPage('Check The Work before logging it again.') : reason;
          }
          setLogError(landed === null ? unknownOutcomeWords(label) : reason);
          return undefined;
        },
      };
    },
    [readRunExecutions, run.run_id],
  );

  const logIntervention = useCallback(async () => {
    if (logBusy) return;
    if (!logAthleteId || !logProtocolId) {
      setLogError('Pick an athlete and a protocol first.');
      return;
    }
    setLogBusy(true);
    setLogError('');
    const pair = JSON.stringify([run.run_id, logAthleteId, logProtocolId]);
    const keys = logRequestKeys.current;
    if (!keys.has(pair)) {
      keys.set(pair, typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : null);
    }
    const requestKey = keys.get(pair) ?? null;
    const athleteName = logAthletes.find((a) => a.athlete_id === logAthleteId)?.full_name ?? logAthleteId;
    const protocolTitle = logProtocols.find((p) => p.protocol_id === logProtocolId)?.title ?? logProtocolId;
    const showLogged = (item: { execution_id: string; created_at: string }) => {
      keys.delete(pair);
      setLoggedInterventions((items) => [
        { execution_id: item.execution_id, athlete_name: athleteName, protocol_title: protocolTitle, created_at: item.created_at },
        ...items,
      ]);
      setLogProtocolId('');
    };
    try {
      // Kept on the open page (W4 item 7, OQ-3): resent with the pair's request key until it goes
      // through, instead of "Try again". The server writes it once however often it is sent (F-135),
      // and only for the account that made it (made_by_account_id, OQ-1). The choice is cleared once
      // kept; a second tap of the same pair while it is unsaved carries the same key.
      const resolved = { done: false };
      const kept = await keepSave(
        // Forgets the pair's key only while it is still this tap's: never a newer tap's key.
        keptLog(logAthleteId, logProtocolId, athleteName, protocolTitle, requestKey, () => {
          if (keys.get(pair) === requestKey) keys.delete(pair);
        }, resolved),
      );
      if (kept === 'kept') {
        // Said once kept (the account check settles first), unless it was answered already.
        if (!resolved.done) setLogsWaiting((entries) => [...entries, { save: resolved, key: requestKey ?? resolved }]);
        setLogProtocolId('');
        return;
      }
      // Today's way. The "before" picture, so a lost answer can be checked against it afterwards: an
      // earlier log of the same pair in this run (from before a reload, say) must not read as this
      // one. A failed read never stops the log, and a slow one holds it back three seconds at most.
      const before = await readRunExecutions(
        logAthleteId,
        logProtocolId,
        typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(3000) : undefined,
      );
      try {
        const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-executions`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          // The link this whole control exists for: session_run_id ties the
          // execution to the run that is live right now, on the row the
          // server already has pilot_intervention_executions_session_run_fk for.
          body: JSON.stringify({
            athlete_id: logAthleteId,
            protocol_id: logProtocolId,
            session_run_id: run.run_id,
            ...(requestKey ? { request_key: requestKey } : {}),
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          item?: { execution_id: string; created_at: string };
          error?: string;
          code?: string;
        };
        if (response.ok && payload.item) {
          showLogged(payload.item);
          return;
        }
        if (isRefusal(response.status)) {
          if (payload.code === 'INTERVENTION_EXECUTION_REQUEST_KEY_REUSED') keys.delete(pair);
          setLogError(refusalWords({ error: payload.error, status: response.status }, {}, 'The intervention was not logged. Try again.'));
          return;
        }
      } catch {
        // Thrown: the request may or may not have reached the server. Checked below.
      }
      const after = await readRunExecutions(logAthleteId, logProtocolId);
      if (after === null) {
        setLogError(LOG_UNCHECKED);
        return;
      }
      // A tap that sent a key is matched by it alone (OVERWATCH 7158257725): another tab's tap of the
      // pair is never taken for this one, and this tap's own log is found even when an earlier attempt
      // of it landed late, into the before picture, or there is no before picture. Without a key, or
      // from a server that names none, any new log, as before.
      const byKey = requestKey !== null && requestKey !== undefined && !namesNoKeys(after);
      const known = new Set([...(before ?? []), ...loggedInterventions].map((item) => item.execution_id));
      const fresh = byKey
        ? after.filter((item) => item.request_key === requestKey)
        : after.filter((item) => !known.has(item.execution_id));
      if (fresh.length === 0) {
        setLogError(LOG_NOT_SAVED);
        return;
      }
      // Without the before picture, a record this screen did not log cannot be placed (by key it can).
      if (!byKey && before === null) {
        setLogError(LOG_UNCHECKED);
        return;
      }
      showLogged(fresh[0]);
      setLogError(LOG_SAVED);
    } finally {
      setLogBusy(false);
    }
  }, [keptLog, logAthleteId, logAthletes, logBusy, logProtocolId, logProtocols, loggedInterventions, readRunExecutions, run.run_id]);

  // A run can stop being live underneath this screen (finished on another
  // device, or settled by a race). The recovery is always the same: ask the
  // server what is live now, and either show that or hand control back.
  // The coach's live run as the server holds it now: the run, null for none, or 'unreadable'.
  const readLiveRun = useCallback(async (signal?: AbortSignal): Promise<LiveSessionScriptRun | null | 'unreadable'> => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal,
      });
      if (!response.ok) return 'unreadable';
      const payload = (await response.json()) as { run?: LiveSessionScriptRun | null };
      return payload.run === undefined ? 'unreadable' : payload.run;
    } catch {
      return 'unreadable';
    }
  }, []);

  // Another run is live, or none is: show that one, or hand control back.
  const showOtherLiveRun = useCallback(
    (live: LiveSessionScriptRun | null) => {
      if (live) {
        applyServerRun(live);
        setActionError(RUN_OUT_OF_DATE);
        return;
      }
      onRunGone(RUN_GONE);
    },
    [applyServerRun, onRunGone],
  );

  const resyncAfterNotLive = useCallback(async () => {
    // Once this run has settled here, a kept save refused because it is no longer live says nothing:
    // the page already says how it ended.
    if (settledHere.current) return;
    const live = await readLiveRun();
    if (live === 'unreadable') {
      setActionError('This session may no longer be live, and the server could not be reached to confirm. Reload to recover the real state.');
      return;
    }
    showOtherLiveRun(live);
  }, [readLiveRun, showOtherLiveRun]);

  // This run among the gym's finished sessions: its settled row, null when it is not there settled,
  // or 'unreadable'.
  const readSettledRun = useCallback(async (signal?: AbortSignal): Promise<SettledRunSummary | null | 'unreadable'> => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs?finished=true`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal,
      });
      if (!response.ok) return 'unreadable';
      const payload = (await response.json()) as { runs?: SettledRunSummary[] };
      if (!Array.isArray(payload.runs)) return 'unreadable';
      const settled = payload.runs.find((item) => item.run_id === run.run_id);
      return settled && (settled.run_state === 'completed' || settled.run_state === 'abandoned') ? settled : null;
    } catch {
      return 'unreadable';
    }
  }, [run.run_id]);

  // A run action whose answer proved nothing: read what the server holds and say that.
  const recoverRunAction = useCallback(
    async (body: Record<string, unknown>) => {
      const live = await readLiveRun();
      if (live === 'unreadable') {
        setActionError(RUN_UNCHECKED);
        return;
      }
      if (live && live.run_id === run.run_id) {
        applyServerRun(live);
        const words = body.action === 'finish' ? null : savedRunWords(body, live, detail?.blocks ?? []);
        setActionError(words ? `No clear answer came back, but the server shows it was saved: ${words}.` : RUN_NOT_SAVED);
        return;
      }
      if (body.action !== 'finish') {
        showOtherLiveRun(live);
        return;
      }
      // This run is no longer live: a finish that landed is among the gym's finished sessions.
      const settled = await readSettledRun();
      if (settled === 'unreadable') setActionError(RUN_UNCHECKED);
      else if (settled) settledByThisConsole(settled);
      else setActionError(RUN_END_UNKNOWN);
    },
    [applyServerRun, detail, readLiveRun, readSettledRun, run.run_id, settledByThisConsole, showOtherLiveRun],
  );

  // A run action kept on the open page (W4 item 7, OQ-3; OW27-35 A): sent now, or after the saves
  // before it, and resent until it goes through, with the waiting words meanwhile. Every send carries
  // the save's own request key: the server records it with the action and answers a resend of a key
  // it holds as saved (`replayed`), writing nothing more. A refused RESEND is decided by that key
  // before any failed words (condition 2): RUN_REFUSED_AFTER_KEY means it never landed, and any other
  // refusal leaves it not known.
  const keptRunAction = useCallback(
    (body: Record<string, unknown>, resolved: { done: boolean }): KeptSave => {
      const blocks = detail?.blocks ?? [];
      let refusal: { error?: string } = {};
      const label = runActionLabel(body, blocks);
      // What this save asked goes with its own answer, saved or refused.
      const releaseAsked = () => {
        resolved.done = true;
        if (body.action === 'finish') finishKeptNow.current = false;
        setAskedRuns((entries) => entries.filter((entry) => entry.save !== resolved));
      };
      return {
        label,
        send: ({ signal, requestKey }) =>
          fetch(`${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(run.run_id)}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, request_key: requestKey }),
            signal,
          }),
        answerOf: async (response) => {
          const payload = (await response.clone().json().catch(() => ({}))) as { run?: unknown; replayed?: unknown; error?: string };
          // 408 and 429 say "not now", not "no": sent again, as the queue's default does.
          if (isRefusal(response.status) && response.status !== 408 && response.status !== 429) {
            refusal = payload;
            return 'refused';
          }
          // A yes without the run proves nothing (it is sent again: it sets a state), unless it says an
          // earlier send of this key landed: a live action on a run that has ended since has no run.
          return response.ok && (payload.run || payload.replayed === true) ? 'saved' : 'unknown';
        },
        // Decided by this save's own key: no read of the run, whose state another tab or device could match.
        checkLanded: async () => (refusal.error !== undefined && RUN_REFUSED_AFTER_KEY.has(refusal.error) ? false : null),
        onSaved: (response) => {
          releaseAsked();
          void (async () => {
            const payload = response
              ? ((await response.json().catch(() => ({}))) as { run?: LiveSessionScriptRun | SessionScriptRunRow | null; replayed?: unknown })
              : {};
            if (!payload.run) {
              // An earlier send landed, and the run has ended since (not here): the console resyncs.
              if (payload.replayed === true) void resyncAfterNotLive();
              return;
            }
            if (body.action === 'finish') settledByThisConsole(payload.run);
            else applyServerRun(payload.run as LiveSessionScriptRun);
          })();
        },
        // Refused: said on the console, where the coach tapped (not in the page's waiting list).
        onRefused: (response, landed) => {
          releaseAsked();
          if (settledHere.current) return undefined;
          if (refusal.error === 'SESSION_RUN_NOT_LIVE' || refusal.error === 'SESSION_RUN_NOT_FOUND') {
            void resyncAfterNotLive();
            return undefined;
          }
          // A refused resend that could not be checked: whether an earlier send landed is not known.
          const reason = describeRunError(refusal.error, response.status);
          // Off the page, the page's list says it, after the save's own name.
          // A finish's own refusal is said here: its release above has cleared the flag, and the console stays.
          if (!onPage.current || finishKeptNow.current) {
            return landed === null ? unknownOffPage('Check the session on the class screen before doing it again.') : reason;
          }
          setActionError(landed === null ? unknownOutcomeWords(label) : reason);
          return undefined;
        },
      };
    },
    [applyServerRun, detail, resyncAfterNotLive, run.run_id, settledByThisConsole],
  );

  const mutateRun = useCallback(
    async (body: Record<string, unknown>, busyKey: string): Promise<void> => {
      // One mutation at a time: a double-tapped control must not race itself.
      // (Pause/resume are additionally idempotent server-side.) The lock holds
      // through any recovery read below, and while the queue takes the save.
      if (actionBusy) return;
      setActionBusy(busyKey);
      setActionError('');
      try {
        // Kept on the open page (W4 item 7). Not kept (the page does not know who is signed in):
        // sent once, and a lost answer read back, as before.
        // What it asks is what the next tap works from once it is kept (the account check settles
        // first, under this tap's busy lock), unless it was answered already.
        const resolved = { done: false };
        if ((await keepSave(keptRunAction(body, resolved))) === 'kept') {
          const askedHere = askedByRunAction(body);
          if (!resolved.done && (askedHere || body.action === 'finish')) {
            if (body.action === 'finish') finishKeptNow.current = true;
            setAskedRuns((entries) => [...entries, { save: resolved, asked: askedHere ?? {}, finish: body.action === 'finish' }]);
          }
          return;
        }
        let response: Response;
        try {
          response = await fetch(
            `${apiBase()}/api/pilot/session-scripts/runs/${encodeURIComponent(run.run_id)}`,
            {
              method: 'PATCH',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            },
          );
        } catch {
          await recoverRunAction(body);
          return;
        }

        const payload = (await response.json().catch(() => ({}))) as {
          run?: LiveSessionScriptRun | SessionScriptRunRow;
          error?: string;
        };

        if (isRefusal(response.status)) {
          if (payload.error === 'SESSION_RUN_NOT_LIVE' || payload.error === 'SESSION_RUN_NOT_FOUND') {
            await resyncAfterNotLive();
            return;
          }
          setActionError(describeRunError(payload.error, response.status));
          return;
        }

        if (!response.ok || !payload.run) {
          await recoverRunAction(body);
          return;
        }
        if (body.action === 'finish') {
          settledByThisConsole(payload.run);
          return;
        }
        applyServerRun(payload.run as LiveSessionScriptRun);
      } finally {
        setActionBusy(null);
      }
    },
    [actionBusy, applyServerRun, keptRunAction, recoverRunAction, resyncAfterNotLive, run.run_id, settledByThisConsole],
  );

  // ---- Finish / abandon -------------------------------------------------
  // Two steps on purpose: "End session" only opens the settle panel, and the
  // panel's own buttons name the outcome they record. A stray tap on the floor
  // must never settle a session.
  const [settleOpen, setSettleOpen] = useState(false);
  const [blocksCompleted, setBlocksCompleted] = useState('');
  // A count the coach stated when starting is theirs: it is kept, and the marks do not replace it.
  const startCount = typeof initialRun.athletes_present === 'number' ? String(initialRun.athletes_present) : '';
  const [athletesPresent, setAthletesPresent] = useState(startCount);
  // Once the coach types in the box (or stated a count at start), the marks no longer fill it.
  const [athletesPresentTyped, setAthletesPresentTyped] = useState(startCount !== '');
  // Whether the number in the box is the marks as last read; a failed read makes it unknown.
  const [marksKnown, setMarksKnown] = useState(false);
  // The marks here, as last read: the no-shows offer reads its count again when they change.
  const [athletesPresentMarks, setAthletesPresentMarks] = useState<number | null>(null);
  // The tied class was cancelled since the tie: taps stay on the session (the class line says so).
  const [classCancelled, setClassCancelled] = useState(false);
  const presentFromMarks = useCallback(
    (count: number | null) => {
      setMarksKnown(count !== null);
      setAthletesPresentMarks(count);
      if (athletesPresentTyped || count === null) return;
      setAthletesPresent(count > 0 ? String(count) : '');
    },
    [athletesPresentTyped, setAthletesPresent],
  );
  const [resetProtocolUsed, setResetProtocolUsed] = useState(false);
  const [deviationNote, setDeviationNote] = useState('');
  const [whatWorked, setWhatWorked] = useState('');
  const [whatDidNot, setWhatDidNot] = useState('');
  const [settleFieldError, setSettleFieldError] = useState('');

  function finishBody(runState: 'completed' | 'abandoned'): Record<string, unknown> | null {
    const body: Record<string, unknown> = { action: 'finish', run_state: runState };
    // Optional numbers: empty means "not stated" and is simply not sent --
    // never coerced to 0, which would record an empty room nobody counted.
    for (const [field, raw] of [
      ['blocks_completed', blocksCompleted],
      ['athletes_present', athletesPresent],
    ] as const) {
      const trimmed = raw.trim();
      if (trimmed === '') continue;
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < 0) {
        setSettleFieldError(`${field === 'blocks_completed' ? 'Blocks completed' : 'Athletes present'} must be a whole number.`);
        return null;
      }
      body[field] = value;
    }
    if (resetProtocolUsed) body.reset_protocol_used = true;
    if (deviationNote.trim() !== '') body.deviation_note = deviationNote.trim();
    if (whatWorked.trim() !== '') body.what_worked = whatWorked.trim();
    if (whatDidNot.trim() !== '') body.what_did_not = whatDidNot.trim();
    return body;
  }

  async function settle(runState: 'completed' | 'abandoned') {
    setSettleFieldError('');
    const body = finishBody(runState);
    if (!body) return;
    await mutateRun(body, `finish-${runState}`);
  }

  return (
    // Look B (OD-2026-10-17-011, carried to the coach's screen by lane L39 PR 3): the console is a
    // board in the wall-board kit's frame, its top row the coach's tiles, its controls brass plates.
    // The kit's rules are `.ge-wallboard .ge-frame`, so the scope is the wrapper, not the board.
    <div className="ge-wallboard">
    <section aria-label="Live session delivery" className="ge-scripts-live ge-frame coach-live rounded-[var(--r-lg)] p-[var(--s5)]">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
        <div>
          <p className="t-eyebrow">Delivering now</p>
          <h2 className="t-command mt-[var(--s2)] text-[length:var(--t-xl)]">
            {isPlain ? 'Plain session' : detail ? detail.name : 'Session in progress'}
          </h2>
          {!isPlain && (
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-400)]">
              This session follows the plan as it was when the session started (version {run.script_version}).
            </p>
          )}
          {!isPlain && detail && detail.version !== run.script_version && (
            <p className="mt-[var(--s2)] text-[length:var(--t-md)] font-semibold text-[var(--restricted-ink)]">
              The plan below is version {detail.version}; this session pinned version {run.script_version} at start.
            </p>
          )}
        </div>
        <div className="text-right">
          <p aria-label="Elapsed delivery time" className="font-mono text-[length:var(--t-2xl)] font-black text-[color:var(--bone-100)]">
            {formatElapsed(displaySeconds)}
          </p>
          {run.is_paused ? (
            <span className="badge badge--restricted"><i>▲</i>PAUSED</span>
          ) : (
            <span className="badge badge--cleared"><i>✓</i>RUNNING</span>
          )}
        </div>
      </div>

      {/* The top row: attendance, need attention, athlete pain reports and the SHADOW queue, counts only. */}
      <CoachLiveTiles painFeed={painFeed} />

      {/* The floor controls: big, few, and above the fold. */}
      <div className="coach-live-controls mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
        <button
          type="button"
          onClick={() => void mutateRun({ action: asked.is_paused ? 'resume' : 'pause' }, 'pause-resume')}
          disabled={controlsLocked}
          aria-describedby={asked.is_paused !== run.is_paused ? askedLineId : undefined}
          className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {asked.is_paused ? 'Resume session' : 'Pause session'}
        </button>
        {!isPlain && (
        <>
        <button
          type="button"
          onClick={() => previousBlock && void mutateRun({ action: 'advance', to_block_id: previousBlock.block_id }, 'advance')}
          disabled={controlsLocked || !previousBlock}
          aria-describedby={asked.current_block_id !== run.current_block_id ? askedLineId : undefined}
          className="btn btn--ghost px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Previous block
        </button>
        <button
          type="button"
          onClick={() => nextBlock && void mutateRun({ action: 'advance', to_block_id: nextBlock.block_id }, 'advance')}
          disabled={controlsLocked || !nextBlock}
          aria-describedby={asked.current_block_id !== run.current_block_id ? askedLineId : undefined}
          className="btn btn--ghost px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Next block
        </button>
        </>
        )}
      </div>

      {/* Mounted always, so a screen reader announces the line when it fills. */}
      <p
        id={askedLineId}
        role="status"
        className={askedNotSaved.length > 0 ? 't-body mt-[var(--s2)] text-[length:var(--t-md)]' : 'sr-only'}
      >
        {askedNotSaved.length > 0
          ? `Not saved yet: ${askedNotSaved.join('; ')}. The buttons follow what you asked; the session shown is what the server last showed.`
          : ''}
      </p>

      {/* The coach's "Allow on a TV" switch (Overwatch's 6a ruling; Q2 = A). Off by default on
          every run: a private lesson stays off the gym wall unless the coach allows it. The button
          sends the value it wants, not "toggle", so a retried tap cannot flip it back; its state is
          the server's, in words beside it, not colour alone. The switch puts nothing on a TV: the
          coach sends the session from Gym TVs below (GymTvPanel), which refuses while it is off.
          The status beside it is the TVs' own answer, never the switch's. */}
      <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
        <button
          type="button"
          role="switch"
          aria-checked={asked.show_on_wall}
          aria-describedby={asked.show_on_wall !== run.show_on_wall ? askedLineId : undefined}
          onClick={() => void mutateRun({ action: 'show_on_wall', show: !asked.show_on_wall }, 'show-on-wall')}
          disabled={controlsLocked}
          className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
        >
          Allow on a TV
        </button>
        {/* The switch's state in words, in sentence case: an upper-case "ON" beside "Allow on a TV"
            would read as the TV status. aria-checked already says it to a screen reader. */}
        <span aria-hidden="true" className="t-body text-[color:var(--bone-200)]">
          {asked.show_on_wall ? 'On' : 'Off'}{asked.show_on_wall !== run.show_on_wall ? ' (not saved yet)' : ''}
        </span>
        {tvStatus.on ? (
          <span className="badge badge--cleared"><i aria-hidden="true">✓</i>{tvStatus.text}</span>
        ) : (
          // Unknown is not drawn like a known "not on a TV": its own glyph, and its words.
          <span className="badge badge--filed"><i aria-hidden="true">{tvRead.state === 'loaded' ? '—' : '?'}</i>{tvStatus.text}</span>
        )}
        {tvReadAt && <span className="t-data text-[color:var(--bone-400)]">as of {tvReadAt.toLowerCase()}</span>}
        <p className="t-data text-[color:var(--bone-400)]">
          With this on, send the session to a gym TV from Gym TVs below.
        </p>
      </div>

      {/* The class this session runs (D4), near the top: tied, a "here" tap also goes on its register. */}
      <SessionRunClass
        key={`class-${run.run_id}`}
        runId={run.run_id}
        classId={run.class_id ?? null}
        onClassChange={(classId) => setRun((current) => ({ ...current, class_id: classId }))}
        onRunNotLive={() => void resyncAfterNotLive()}
        onClassCancelled={setClassCancelled}
        isFinishWaiting={isFinishWaiting}
      />

      {/* The round clock (WO-N1-03): its own row and its own route, so a refused timer action never
          reads as a refused session action. */}
      <div className="coach-live-timer">
        <RoundTimerControls runId={run.run_id} onRunNotLive={() => void resyncAfterNotLive()} />
      </div>

      {actionError && (
        <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
          {actionError}
        </p>
      )}

      {/* The plan, current block first-class. A plain session has none. */}
      {!isPlain && detailState === 'loading' && (
        <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">Loading the plan...</p>
      )}

      {!isPlain && detailState === 'unavailable' && (
        <div className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
          <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
            The plan for this session could not be loaded, so its blocks cannot be shown or
            navigated. The session itself is still live -- pausing, resuming and ending it still work.
          </p>
          <button
            type="button"
            onClick={() => {
              setDetailState('loading');
              void loadDetail();
            }}
            className="btn btn--ghost mt-[var(--s3)]"
          >
            Retry loading the plan
          </button>
        </div>
      )}

      {!isPlain && detailState === 'loaded' && (
        <>
          {currentBlock ? (
            <div className="mt-[var(--s4)] rounded-[var(--r-lg)] border-2 border-[color:var(--brass-700)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="t-label">Current block</p>
              <div className="mt-[var(--s2)] flex flex-wrap items-baseline gap-[var(--s3)]">
                <span className="plaque">{currentBlock.start_offset_min}-{currentBlock.end_offset_min} min</span>
                <h3 className="t-command text-[length:var(--t-lg)]">{currentBlock.block_label}</h3>
                {NOTABLE_KINDS[currentBlock.block_kind] && (
                  <span className="t-label">{NOTABLE_KINDS[currentBlock.block_kind]}</span>
                )}
                {currentBlock.scale_level && <span className="t-label">Scale {currentBlock.scale_level}</span>}
              </div>
              {blockCoachingLines(
                currentBlock,
                currentNeedsDrill ? drillTexts.get(currentBlock.drill_id as string) ?? { state: 'loading' } : null,
              ).map((line) => (
                <p key={`${currentBlock.block_id}-${line.label}`} className="t-body mt-[var(--s2)] text-[color:var(--bone-200)]">
                  <span className="t-label">{line.label}: </span>
                  {line.value}
                  {/* OW25-57: the per-field AI-draft mark, for coaches and admins (the only roles this console renders for). */}
                  {line.fromDrill && line.draft === true && (
                    <>
                      {' '}
                      <span className="badge badge--filed ml-[var(--s2)]"><i aria-hidden="true">◉</i>{AI_DRAFT_MARK}</span>
                    </>
                  )}
                  {line.fromDrill && line.draft === null && (
                    <>
                      {' '}
                      <span className="t-muted">({DRAFT_NOT_CHECKED})</span>
                    </>
                  )}
                </p>
              ))}
              {currentBlock.drill_id !== null && (
                <div className="mt-[var(--s3)]">
                  <button
                    type="button"
                    id={`live-block-instructions-${currentBlock.block_id}`}
                    className="btn btn--ghost"
                    aria-expanded={drillOpen}
                    aria-label={`${drillOpen ? 'Hide' : 'View'} instructions: ${currentBlock.block_label}`}
                    onClick={() => toggleDrill(currentBlock)}
                  >
                    {drillOpen ? 'Hide instructions' : 'View instructions'}
                  </button>
                  {drillOpen && (
                    <CoachInstructionPanel
                      loading={drill.loading}
                      failed={drill.failed}
                      opened={drill.opened}
                      chosenScale={currentBlock.scale_level}
                    />
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="mt-[var(--s4)] text-[length:var(--t-md)] font-semibold text-[var(--restricted-ink)]">
              The session&apos;s current block is not in the plan shown below. Pick a block to move
              the session onto it.
            </p>
          )}

          <h3 className="t-label mt-[var(--s5)]">All blocks, in running order</h3>
          <ol className="mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
            {blocks.map((block, index) => {
              const isCurrent = block.block_id === run.current_block_id;
              return (
                <li
                  key={block.block_id}
                  aria-current={isCurrent ? 'step' : undefined}
                  className={`flex flex-wrap items-center justify-between gap-[var(--s3)] rounded-[var(--r-md)] border p-[var(--s3)] ${
                    isCurrent
                      ? 'border-[color:var(--brass-700)] bg-[rgb(var(--brass-400-rgb)_/_.10)]'
                      : 'border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)]'
                  }`}
                >
                  <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                    <span className="plaque">{block.start_offset_min}-{block.end_offset_min} min</span>
                    {blockKindWord(block.block_kind) && (
                      <span className="coach-live-kind">
                        <span className="ge-pictogram">
                          <BlockKindIcon kind={block.block_kind} />
                        </span>
                        <span className="t-label">{blockKindWord(block.block_kind)}</span>
                      </span>
                    )}
                    <span className="t-body text-[color:var(--bone-200)]">{block.block_label}</span>
                    {isCurrent && <span className="t-label text-[color:var(--brass-300)]">Current</span>}
                    {!isCurrent && currentIndex >= 0 && (
                      <span className="t-label text-[color:var(--bone-400)]">
                        {index < currentIndex ? 'Earlier' : 'Upcoming'}
                      </span>
                    )}
                  </div>
                  {!isCurrent && (
                    <button
                      type="button"
                      onClick={() => void mutateRun({ action: 'advance', to_block_id: block.block_id }, 'advance')}
                      disabled={controlsLocked}
                      className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Go to this block
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}

      {/* Keyed by run: a run swapped in by a resync starts its own list, never the old run's. */}
      <SessionRunPresence
        key={run.run_id}
        runId={run.run_id}
        tied={Boolean(run.class_id) && !classCancelled}
        classId={run.class_id ?? null}
        onPresentCount={presentFromMarks}
        onRunNotLive={() => void resyncAfterNotLive()}
      />

      {/* Logging an intervention against THIS run. A protocol run once here is
          tied to the run in progress via session_run_id -- the same link
          startExecution has always accepted, just never had a caller for
          during a live session. Closing out adherence and actual exposure
          still happens on the execution ledger; this only starts the link. */}
      <div className="mt-[var(--s6)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
        {!logOpen ? (
          <button type="button" onClick={() => setLogOpen(true)} className="btn btn--ghost">
            Log an intervention...
          </button>
        ) : (
          <div className="space-y-[var(--s3)]">
            <p className="t-label">Log an intervention delivered in this session</p>
            <p className="t-body text-[color:var(--bone-300)]">
              This ties the execution to the session run in progress. Adherence, actual exposure
              and close-out are recorded afterward on The Work.
            </p>

            {logAthletesState === 'unavailable' || logProtocolsState === 'unavailable' ? (
              <p role="alert" className="rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                {logAthletesState === 'unavailable' && logProtocolsState === 'unavailable'
                  ? 'The athlete roster and the protocol list could not be loaded, so nothing can be logged from here.'
                  : logAthletesState === 'unavailable'
                    ? 'The athlete roster could not be loaded, so nothing can be logged from here.'
                    : 'The protocol list could not be loaded, so nothing can be logged from here.'}
              </p>
            ) : (
              <div className="grid items-end gap-[var(--s3)] sm:grid-cols-2">
                <label className="field">
                  <span className="t-label">Athlete</span>
                  <select
                    className="select"
                    value={logAthleteId}
                    onChange={(event) => { setLogAthleteId(event.target.value); setLogProtocolId(''); }}
                    disabled={logAthletesState === 'loading'}
                  >
                    <option value="">Choose an athlete</option>
                    {logAthletes.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="t-label">Protocol</span>
                  <select
                    className="select"
                    value={logProtocolId}
                    onChange={(event) => setLogProtocolId(event.target.value)}
                    disabled={logProtocolsState === 'loading'}
                  >
                    <option value="">Select a protocol...</option>
                    {availableProtocols.map((protocol) => (
                      <option key={protocol.protocol_id} value={protocol.protocol_id}>
                        {protocol.title} (v{protocol.version})
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {logError && (
              <p role="alert" className="rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                {logError}
              </p>
            )}
            <p role="status" className={logsWaitingCount > 0 ? 't-body text-[length:var(--t-md)]' : 'sr-only'}>
              {logsWaitingCount === 0
                ? ''
                : `${logsWaitingCount === 1 ? 'One intervention is' : `${logsWaitingCount} interventions are`} not saved yet. This page keeps sending ${logsWaitingCount === 1 ? 'it' : 'them'} while it stays open.`}
            </p>

            {loggedInterventions.length > 0 && (
              <ul className="space-y-[var(--s2)]">
                {loggedInterventions.map((item) => (
                  <li key={item.execution_id} className="flex flex-wrap items-center gap-[var(--s3)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s2)]">
                    <span className="badge badge--cleared"><i aria-hidden="true">✓</i>logged</span>
                    <span className="t-body text-[color:var(--bone-200)]">{item.protocol_title}</span>
                    <span className="t-data">{item.athlete_name}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-wrap gap-[var(--s3)]">
              <button
                type="button"
                onClick={() => void logIntervention()}
                disabled={logBusy || logAthletesState !== 'loaded' || logProtocolsState !== 'loaded'}
                className="btn disabled:cursor-not-allowed disabled:opacity-60"
              >
                {logBusy ? 'Logging...' : 'Log intervention'}
              </button>
              <button
                type="button"
                onClick={() => { setLogOpen(false); setLogError(''); }}
                disabled={logBusy}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
              >
                Done logging
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Ending the session. */}
      <div className="mt-[var(--s6)] border-t border-[color:rgb(var(--brass-400-rgb)_/_.22)] pt-[var(--s4)]">
        {!settleOpen ? (
          <button type="button" onClick={() => setSettleOpen(true)} className="btn btn--ghost">
            End session...
          </button>
        ) : (
          <div className="space-y-[var(--s3)]">
            <p className="t-label">End this session</p>
            <p className="t-body text-[color:var(--bone-300)]">
              Completed means the delivery finished as a session. Abandoned means it ended without
              being completed -- both are kept as the record of tonight. Every field below is
              optional.
            </p>
            {/* Tied to a class: the one-tap no-shows offer (OD-2026-10-21-004 ruling 3), never automatic. */}
            {run.class_id && (
              <SessionNoShows
                runId={run.run_id}
                classId={run.class_id}
                presentCount={athletesPresentMarks}
                onRunNotLive={() => void resyncAfterNotLive()}
                isFinishWaiting={isFinishWaiting}
              />
            )}
            <div className="grid gap-[var(--s3)] sm:grid-cols-2">
              {/* A plain session has no blocks to count. */}
              {!isPlain && (
                <label className="field">
                  <span className="t-label">Blocks completed</span>
                  <input
                    value={blocksCompleted}
                    onChange={(event) => setBlocksCompleted(event.target.value)}
                    inputMode="numeric"
                    className="input"
                  />
                </label>
              )}
              <div>
                <label className="field">
                  <span className="t-label">Athletes present</span>
                  <input
                    value={athletesPresent}
                    onChange={(event) => { setAthletesPresentTyped(true); setAthletesPresent(event.target.value); }}
                    inputMode="numeric"
                    className="input"
                    aria-describedby={!athletesPresentTyped && marksKnown && athletesPresent !== '' ? 'athletes-present-from-marks' : undefined}
                  />
                </label>
                {!athletesPresentTyped && marksKnown && athletesPresent !== '' && (
                  <p id="athletes-present-from-marks" className="t-body mt-[var(--s1)] text-[color:var(--bone-400)]" style={{ fontSize: 'var(--t-xs)' }}>
                    Filled in from the athletes marked here. Change it if your count is different.
                  </p>
                )}
              </div>
            </div>
            <label className="inline-flex min-h-[var(--tap)] items-center gap-[var(--s2)]">
              <input
                type="checkbox"
                checked={resetProtocolUsed}
                onChange={(event) => setResetProtocolUsed(event.target.checked)}
              />
              <span className="t-label">Reset protocol was used</span>
            </label>
            <label className="field">
              <span className="t-label">Deviation from the plan</span>
              <textarea
                value={deviationNote}
                onChange={(event) => setDeviationNote(event.target.value)}
                className="textarea min-h-[56px]"
              />
            </label>
            <label className="field">
              <span className="t-label">What worked</span>
              <textarea
                value={whatWorked}
                onChange={(event) => setWhatWorked(event.target.value)}
                className="textarea min-h-[56px]"
              />
            </label>
            <label className="field">
              <span className="t-label">What did not</span>
              <textarea
                value={whatDidNot}
                onChange={(event) => setWhatDidNot(event.target.value)}
                className="textarea min-h-[56px]"
              />
            </label>
            {settleFieldError && (
              <p role="alert" className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{settleFieldError}</p>
            )}
            <p role="status" className={finishKept ? 't-body text-[length:var(--t-md)]' : 'sr-only'}>
              {finishKept ? 'Ending this session is not saved yet. This page keeps sending it, and it cannot be taken back.' : ''}
            </p>
            <div className="flex flex-wrap gap-[var(--s3)]">
              <button
                type="button"
                onClick={() => void settle('completed')}
                disabled={controlsLocked}
                className="btn disabled:cursor-not-allowed disabled:opacity-60"
              >
                Record as completed
              </button>
              <button
                type="button"
                onClick={() => void settle('abandoned')}
                disabled={controlsLocked}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
              >
                Record as abandoned
              </button>
              <button
                type="button"
                onClick={() => { setSettleOpen(false); setSettleFieldError(''); }}
                disabled={controlsLocked}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
              >
                Keep delivering
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
    </div>
  );
}
