'use client';

import { useCallback, useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
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

/** The four authored coaching fields, omitting the ones the author left empty. */
function blockDetailLines(block: Block): { label: string; value: string }[] {
  return [
    { label: 'Say', value: block.what_to_say ?? '' },
    { label: 'Explain', value: block.what_to_explain ?? '' },
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

// Known refusal codes, translated for a coach mid-class. The raw code is kept
// in the sentence so what the server actually said is never hidden.
function describeRunError(code: unknown): string {
  if (code === 'SESSION_RUN_BLOCK_NOT_IN_SCRIPT') {
    return 'The server refused the move: that block is not part of this session\'s script. (SESSION_RUN_BLOCK_NOT_IN_SCRIPT)';
  }
  if (typeof code === 'string' && code.trim() !== '') {
    return `The server refused: ${code}`;
  }
  return 'The server refused the request.';
}

interface SessionScriptLiveDeliveryProps {
  readonly initialRun: LiveSessionScriptRun;
  /** The run settled (completed or abandoned) -- the server's settled row. */
  readonly onSettled: (run: SessionScriptRunRow) => void;
  /** The run is no longer live server-side and no live run replaced it. */
  readonly onRunGone: (message: string) => void;
}

export default function SessionScriptLiveDelivery({
  initialRun,
  onSettled,
  onRunGone,
}: SessionScriptLiveDeliveryProps) {
  const [run, setRun] = useState<LiveSessionScriptRun>(initialRun);
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

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  // A run can stop being live underneath this screen (finished on another
  // device, or settled by a race). The recovery is always the same: ask the
  // server what is live now, and either show that or hand control back.
  const resyncAfterNotLive = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('resync');
      const payload = (await response.json()) as { run?: LiveSessionScriptRun | null };
      if (payload.run) {
        applyServerRun(payload.run);
        setActionError('The session shown was out of date and has been reloaded from the server.');
        return;
      }
      onRunGone('This session is no longer live on the server. Nothing further can be recorded through this screen.');
    } catch {
      setActionError('This session may no longer be live, and the server could not be reached to confirm. Reload to recover the real state.');
    }
  }, [applyServerRun, onRunGone]);

  const mutateRun = useCallback(
    async (body: Record<string, unknown>, busyKey: string): Promise<void> => {
      // One mutation at a time: a double-tapped control must not race itself.
      // (Pause/resume are additionally idempotent server-side.)
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
          setActionError('Network error -- nothing was changed on the server.');
          return;
        }

        const payload = (await response.json().catch(() => ({}))) as {
          run?: LiveSessionScriptRun | SessionScriptRunRow;
          error?: string;
        };

        if (!response.ok) {
          if (payload.error === 'SESSION_RUN_NOT_LIVE' || payload.error === 'SESSION_RUN_NOT_FOUND') {
            await resyncAfterNotLive();
            return;
          }
          setActionError(describeRunError(payload.error));
          return;
        }

        if (body.action === 'finish' && payload.run) {
          onSettled(payload.run as SessionScriptRunRow);
          return;
        }
        if (payload.run) {
          applyServerRun(payload.run as LiveSessionScriptRun);
        }
      } finally {
        setActionBusy(null);
      }
    },
    [actionBusy, applyServerRun, onSettled, resyncAfterNotLive, run.run_id],
  );

  // ---- Finish / abandon -------------------------------------------------
  // Two steps on purpose: "End session" only opens the settle panel, and the
  // panel's own buttons name the outcome they record. A stray tap on the floor
  // must never settle a session.
  const [settleOpen, setSettleOpen] = useState(false);
  const [blocksCompleted, setBlocksCompleted] = useState('');
  const [athletesPresent, setAthletesPresent] = useState('');
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
    <section aria-label="Live session delivery" className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
        <div>
          <p className="t-eyebrow">Delivering now</p>
          <h2 className="t-command mt-[var(--s2)] text-[length:var(--t-xl)]">
            {detail ? detail.name : 'Session in progress'}
          </h2>
          <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
            Pinned at version {run.script_version} when this session started.
          </p>
          {detail && detail.version !== run.script_version && (
            <p className="t-data mt-[var(--s2)] text-[var(--restricted-ink)]">
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
      </div>

      {actionError && (
        <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
          {actionError}
        </p>
      )}

      {/* The plan, current block first-class. */}
      {detailState === 'loading' && (
        <p className="t-body mt-[var(--s4)] text-[color:var(--bone-300)]">Loading the plan...</p>
      )}

      {detailState === 'unavailable' && (
        <div className="mt-[var(--s4)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
          <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
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

      {detailState === 'loaded' && (
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
            </div>
          ) : (
            <p className="t-body mt-[var(--s4)] text-[var(--restricted-ink)]">
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
                      ? 'border-[color:var(--brass-700)] bg-[rgba(212,175,74,.10)]'
                      : 'border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)]'
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

      {/* Ending the session. */}
      <div className="mt-[var(--s6)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s4)]">
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
              <label className="field">
                <span className="t-label">Blocks completed</span>
                <input
                  value={blocksCompleted}
                  onChange={(event) => setBlocksCompleted(event.target.value)}
                  inputMode="numeric"
                  className="input"
                />
              </label>
              <label className="field">
                <span className="t-label">Athletes present</span>
                <input
                  value={athletesPresent}
                  onChange={(event) => setAthletesPresent(event.target.value)}
                  inputMode="numeric"
                  className="input"
                />
              </label>
            </div>
            <label className="flex items-center gap-[var(--s2)]">
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
              <p role="alert" className="t-data text-[var(--locked-ink)]">{settleFieldError}</p>
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
