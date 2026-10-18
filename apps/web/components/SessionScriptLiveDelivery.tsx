'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { refusalWords } from '@/src/lib/serverRefusalWords';
import { explainLine } from '@/src/lib/sessionScriptWords';
import RoundTimerControls from '@/components/RoundTimerControls';
import CoachInstructionPanel from '@/components/drills/CoachInstructionPanel';
import { readReferenceInstruction } from '@/components/drills/drillInstructionRead';
import { useDrillOpener } from '@/components/drills/useDrillOpener';
import SessionRunPresence from '@/components/SessionRunPresence';
import type { LiveSessionScriptRun, SessionScriptRunRow } from '@/src/server/pilot/sessionScriptRuns';
import type { SessionScriptBlockRow, SessionScriptWithDetail } from '@/src/server/pilot/sessionScripts';

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
// touches no athlete's own check-in.
//
// athletes_present stays what it was: a COUNT the coach states at finish. It
// starts from the number marked here, until the coach types in it; what the
// coach leaves in the box is what is saved. Nobody marked leaves it empty, so
// an empty room is never recorded that nobody counted.

/** The four authored coaching fields, omitting the ones the author left empty. */
function blockDetailLines(block: Block): { label: string; value: string }[] {
  return [
    { label: 'Say', value: block.what_to_say ?? '' },
    explainLine(block.what_to_explain ?? ''),
    { label: 'Watch', value: block.what_to_watch ?? '' },
    { label: 'Fix', value: block.what_to_fix ?? '' },
  ].filter((line) => line.value.trim() !== '');
}

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
const LOG_NOT_SAVED = 'No clear answer came back, and the server shows the intervention was not logged. Try again.';
const LOG_UNCHECKED = 'No clear answer came back and the server could not be checked. Check The Work before logging it again.';
const RUN_OUT_OF_DATE = 'The session shown was out of date and has been reloaded from the server.';
const RUN_GONE = 'This session is no longer live on the server. Nothing further can be recorded through this screen.';

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
      return live.show_on_wall ? 'the session is on the TV' : 'the session is off the TV';
    default:
      return null;
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
}

export default function SessionScriptLiveDelivery({
  initialRun,
  onSettled,
  onRunGone,
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
  const previousBlock = currentIndex > 0 ? blocks[currentIndex - 1] : null;
  const nextBlock = currentIndex >= 0 && currentIndex < blocks.length - 1 ? blocks[currentIndex + 1] : null;

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
  const [loggedInterventions, setLoggedInterventions] = useState<LoggedIntervention[]>([]);

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
    ): Promise<{ execution_id: string; created_at: string }[] | null> => {
      try {
        const response = await fetch(
          `${apiBase()}/api/pilot/coach/intervention-executions?athlete_id=${encodeURIComponent(athleteId)}`,
          { method: 'GET', credentials: 'include', cache: 'no-store', signal },
        );
        if (!response.ok) return null;
        const payload = (await response.json()) as {
          items?: { execution_id: string; created_at: string; session_run_id: string | null; protocol_id: string }[];
        };
        if (!Array.isArray(payload.items)) return null;
        return payload.items.filter((item) => item.session_run_id === run.run_id && item.protocol_id === protocolId);
      } catch {
        return null;
      }
    },
    [run.run_id],
  );

  const logIntervention = useCallback(async () => {
    if (logBusy) return;
    if (!logAthleteId || !logProtocolId) {
      setLogError('Pick an athlete and a protocol first.');
      return;
    }
    setLogBusy(true);
    setLogError('');
    const athleteName = logAthletes.find((a) => a.athlete_id === logAthleteId)?.full_name ?? logAthleteId;
    const protocolTitle = logProtocols.find((p) => p.protocol_id === logProtocolId)?.title ?? logProtocolId;
    const showLogged = (item: { execution_id: string; created_at: string }) => {
      setLoggedInterventions((items) => [
        { execution_id: item.execution_id, athlete_name: athleteName, protocol_title: protocolTitle, created_at: item.created_at },
        ...items,
      ]);
      setLogProtocolId('');
    };
    try {
      // The "before" picture, so a lost answer can be checked against it afterwards: an earlier
      // log of the same pair in this run (from before a reload, say) must not read as this one.
      // A failed read never stops the log, and a slow one holds it back three seconds at most.
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
          }),
        });
        const payload = (await response.json().catch(() => ({}))) as {
          item?: { execution_id: string; created_at: string };
          error?: string;
        };
        if (response.ok && payload.item) {
          showLogged(payload.item);
          return;
        }
        if (isRefusal(response.status)) {
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
      const known = new Set([...(before ?? []), ...loggedInterventions].map((item) => item.execution_id));
      const fresh = after.filter((item) => !known.has(item.execution_id));
      if (fresh.length === 0) {
        setLogError(LOG_NOT_SAVED);
        return;
      }
      // Without the before picture, a record this screen did not log cannot be placed.
      if (before === null) {
        setLogError(LOG_UNCHECKED);
        return;
      }
      showLogged(fresh[0]);
      setLogError(LOG_SAVED);
    } finally {
      setLogBusy(false);
    }
  }, [logAthleteId, logAthletes, logBusy, logProtocolId, logProtocols, loggedInterventions, readRunExecutions, run.run_id]);

  // A run can stop being live underneath this screen (finished on another
  // device, or settled by a race). The recovery is always the same: ask the
  // server what is live now, and either show that or hand control back.
  // The coach's live run as the server holds it now: the run, null for none, or 'unreadable'.
  const readLiveRun = useCallback(async (): Promise<LiveSessionScriptRun | null | 'unreadable'> => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
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
    const live = await readLiveRun();
    if (live === 'unreadable') {
      setActionError('This session may no longer be live, and the server could not be reached to confirm. Reload to recover the real state.');
      return;
    }
    showOtherLiveRun(live);
  }, [readLiveRun, showOtherLiveRun]);

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
      try {
        const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs?finished=true`, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });
        if (response.ok) {
          const payload = (await response.json()) as { runs?: SettledRunSummary[] };
          const settled = payload.runs?.find((item) => item.run_id === run.run_id);
          if (settled && (settled.run_state === 'completed' || settled.run_state === 'abandoned')) {
            onSettled(settled);
            return;
          }
          if (Array.isArray(payload.runs)) {
            setActionError(RUN_END_UNKNOWN);
            return;
          }
        }
      } catch {
        // Falls through to "could not be checked".
      }
      setActionError(RUN_UNCHECKED);
    },
    [applyServerRun, detail, onSettled, readLiveRun, run.run_id, showOtherLiveRun],
  );

  const mutateRun = useCallback(
    async (body: Record<string, unknown>, busyKey: string): Promise<void> => {
      // One mutation at a time: a double-tapped control must not race itself.
      // (Pause/resume are additionally idempotent server-side.) The lock holds
      // through any recovery read below.
      if (actionBusy) return;
      setActionBusy(busyKey);
      setActionError('');
      try {
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
          onSettled(payload.run);
          return;
        }
        applyServerRun(payload.run as LiveSessionScriptRun);
      } finally {
        setActionBusy(null);
      }
    },
    [actionBusy, applyServerRun, onSettled, recoverRunAction, resyncAfterNotLive, run.run_id],
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
  const presentFromMarks = useCallback(
    (count: number | null) => {
      setMarksKnown(count !== null);
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
    <section aria-label="Live session delivery" className="ge-scripts-live mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
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

      {/* The floor controls: big, few, and above the fold. */}
      <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
        <button
          type="button"
          onClick={() => void mutateRun({ action: run.is_paused ? 'resume' : 'pause' }, 'pause-resume')}
          disabled={actionBusy !== null}
          className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {run.is_paused ? 'Resume session' : 'Pause session'}
        </button>
        {!isPlain && (
        <>
        <button
          type="button"
          onClick={() => previousBlock && void mutateRun({ action: 'advance', to_block_id: previousBlock.block_id }, 'advance')}
          disabled={actionBusy !== null || !previousBlock}
          className="btn btn--ghost px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Previous block
        </button>
        <button
          type="button"
          onClick={() => nextBlock && void mutateRun({ action: 'advance', to_block_id: nextBlock.block_id }, 'advance')}
          disabled={actionBusy !== null || !nextBlock}
          className="btn btn--ghost px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          Next block
        </button>
        </>
        )}
      </div>

      {/* The coach's "Show on TV" switch. Off by default on every run: a private
          lesson stays off the gym wall unless the coach puts it up. The button
          sends the value it wants, not "toggle", so a retried tap cannot flip it
          back. The state shown is the server's, from the response. */}
      <div className="mt-[var(--s3)] flex flex-wrap items-center gap-[var(--s3)]">
        {run.show_on_wall ? (
          <span className="badge badge--cleared"><i aria-hidden="true">✓</i>ON THE TV</span>
        ) : (
          <span className="badge badge--filed"><i aria-hidden="true">—</i>NOT ON THE TV</span>
        )}
        <button
          type="button"
          onClick={() => void mutateRun({ action: 'show_on_wall', show: !run.show_on_wall }, 'show-on-wall')}
          disabled={actionBusy !== null}
          className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
        >
          {run.show_on_wall ? 'Take off the TV' : 'Show on TV'}
        </button>
        {/* The switch alone puts nothing on a TV: the coach sends the run from
            Gym TVs on coach home (GymTvPanel), which refuses while it is off. */}
        <p className="t-data text-[color:var(--bone-400)]">
          Switching this on lets you send the session to a gym TV from Gym TVs on your coach home.
        </p>
      </div>

      {/* The round clock (WO-N1-03): its own row and its own route, so a refused timer action never
          reads as a refused session action. */}
      <RoundTimerControls runId={run.run_id} onRunNotLive={() => void resyncAfterNotLive()} />

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
              {blockDetailLines(currentBlock).map((line) => (
                <p key={`${currentBlock.block_id}-${line.label}`} className="t-body mt-[var(--s2)] text-[color:var(--bone-200)]">
                  <span className="t-label">{line.label}: </span>
                  {line.value}
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
                      disabled={actionBusy !== null}
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
            <div className="flex flex-wrap gap-[var(--s3)]">
              <button
                type="button"
                onClick={() => void settle('completed')}
                disabled={actionBusy !== null}
                className="btn disabled:cursor-not-allowed disabled:opacity-60"
              >
                Record as completed
              </button>
              <button
                type="button"
                onClick={() => void settle('abandoned')}
                disabled={actionBusy !== null}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
              >
                Record as abandoned
              </button>
              <button
                type="button"
                onClick={() => { setSettleOpen(false); setSettleFieldError(''); }}
                disabled={actionBusy !== null}
                className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
              >
                Keep delivering
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
