'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import SessionScriptLiveDelivery from '@/components/SessionScriptLiveDelivery';
import { apiBase } from '@/lib/apiBase';
import type { LiveSessionScriptRun } from '@/src/server/pilot/sessionScriptRuns';
import type {
  SessionScriptBlockRow,
  SessionScriptRow,
  SessionScriptWithDetail,
} from '@/src/server/pilot/sessionScripts';

// The session plans the gym actually teaches from, read on the floor.
//
// Until now pilot.session_scripts existed with nothing to open it: the blocks
// were in the database and no coach could see them. This is that surface.
//
// MINUTE OFFSETS ARE SHOWN AS MINUTES, NEVER AS CLOCK TIMES. A script is the
// same script whether the session starts at 4:00 or 6:30, so rendering "4:10pm"
// here would silently bind one night's start time to a plan every night shares.
// Blocks read as "10-25 min", which is what the block actually stores.

// Type-only imports from the server module, so nothing server-side is pulled
// into this client bundle and the shapes cannot drift from the route's own.
type Script = SessionScriptRow;
type ScriptDetail = SessionScriptWithDetail;
type Block = SessionScriptBlockRow;

// The block kinds a coach most wants to pick out of a dense plan at a glance.
// Anything not listed simply renders without a marker rather than being forced
// into a category it does not belong to.
const NOTABLE_KINDS: Record<string, string> = {
  drill_round: 'Drill',
  reset_minute: 'Reset',
  teaching_minute: 'Teaching',
  conditioning: 'Conditioning',
  reflection: 'Reflection',
};

function blockWindow(block: Block): string {
  return `${block.start_offset_min}-${block.end_offset_min} min`;
}

/** The four authored coaching fields, in the order a coach reads them mid-session. */
function blockDetailLines(block: Block): { label: string; value: string }[] {
  return [
    { label: 'Say', value: block.what_to_say ?? '' },
    { label: 'Explain', value: block.what_to_explain ?? '' },
    { label: 'Watch', value: block.what_to_watch ?? '' },
    { label: 'Fix', value: block.what_to_fix ?? '' },
  ].filter((line) => line.value.trim() !== '');
}

function CoachSessionScripts() {
  const [scripts, setScripts] = useState<Script[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [openScriptId, setOpenScriptId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScriptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  // Live delivery. The FIRST question this page asks the server is "does this
  // coach already have a session in progress" -- a reload or a locked phone
  // must restore the running session, never offer to start a second one.
  // 'unavailable' is its own state: if that read fails, the truthful thing to
  // say is "a session may be in progress that is not shown", not "no run".
  const [liveRun, setLiveRun] = useState<LiveSessionScriptRun | null>(null);
  const [liveRunCheck, setLiveRunCheck] = useState<'loading' | 'checked' | 'unavailable'>('loading');
  const [liveNotice, setLiveNotice] = useState('');
  const [startBusyScriptId, setStartBusyScriptId] = useState<string | null>(null);
  const [startError, setStartError] = useState('');

  // No state is set before the first await, matching the drill library: a
  // synchronous setState inside an effect cascades a render before the request
  // has even left.
  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The session scripts could not be loaded.');
      const payload = (await response.json()) as { scripts?: Script[] };
      setScripts(payload.scripts ?? []);
      setLoadError('');
    } catch (error) {
      setScripts([]);
      setLoadError(error instanceof Error ? error.message : 'The session scripts could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const fetchLiveRun = useCallback(async (): Promise<LiveSessionScriptRun | null> => {
    const response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
      method: 'GET',
      credentials: 'include',
    });
    if (!response.ok) throw new Error('live-run');
    const payload = (await response.json()) as { run?: LiveSessionScriptRun | null };
    return payload.run ?? null;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const run = await fetchLiveRun();
        setLiveRun(run);
        setLiveRunCheck('checked');
        if (run) {
          setLiveNotice('A session already in progress was restored -- the clock kept running on the server.');
        }
      } catch {
        setLiveRunCheck('unavailable');
      }
    })();
  }, [fetchLiveRun]);

  const startDelivery = useCallback(async (scriptId: string) => {
    if (startBusyScriptId) return;
    setStartBusyScriptId(scriptId);
    setStartError('');
    setLiveNotice('');
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script_id: scriptId }),
        });
      } catch {
        setStartError('Network error -- no session was started.');
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as {
        run?: LiveSessionScriptRun;
        error?: string;
      };

      if (response.ok && payload.run) {
        setLiveRun(payload.run);
        setLiveRunCheck('checked');
        return;
      }

      // The one-live-per-coach refusal. The honest recovery is to fetch and
      // show the session the server says is already running -- not to retry
      // the start, and not to pretend nothing is live.
      if (payload.error === 'SESSION_RUN_ALREADY_LIVE') {
        try {
          const existing = await fetchLiveRun();
          if (existing) {
            setLiveRun(existing);
            setLiveRunCheck('checked');
            setLiveNotice('You already had a session in progress. It has been restored, not restarted.');
            return;
          }
        } catch {
          // Fall through to the message below.
        }
        setStartError('The server reports a session already in progress, but it could not be loaded. Reload this page to recover it.');
        return;
      }

      if (payload.error === 'SESSION_SCRIPT_HAS_NO_BLOCKS') {
        setStartError('This script has no blocks, so there is nothing to deliver. It stays start-disabled until blocks exist.');
        return;
      }
      if (payload.error === 'SESSION_SCRIPT_NOT_FOUND') {
        setStartError('That script could not be found, so no session was started.');
        return;
      }
      setStartError(`The server refused to start the session${payload.error ? `: ${payload.error}` : '.'}`);
    } finally {
      setStartBusyScriptId(null);
    }
  }, [fetchLiveRun, startBusyScriptId]);

  const openScript = useCallback(async (scriptId: string) => {
    // Clearing the previous script's detail and error together: leaving either
    // in place shows one script's blocks -- or one script's failure -- under
    // another script's name while the new one loads.
    setOpenScriptId(scriptId);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/session-scripts?script_id=${encodeURIComponent(scriptId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('That session script could not be opened.');
      const payload = (await response.json()) as { script?: ScriptDetail };
      setDetail(payload.script ?? null);
    } catch (error) {
      setDetail(null);
      setDetailError(error instanceof Error ? error.message : 'That session script could not be opened.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Session Scripts</h1>
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            The plan for a session, block by block. Times are minutes from the start of the session,
            not clock times -- the same script runs whether the room opens at 4:00 or 6:30.
          </p>
          <Link href="/coach/drills" className="btn btn--ghost mt-[var(--s4)]">
            Back to drill library
          </Link>
        </header>

        {liveRunCheck === 'loading' && (
          <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">
            Checking for a session in progress...
          </p>
        )}

        {liveRunCheck === 'unavailable' && (
          <div className="mt-[var(--s5)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
              Whether you have a session in progress could not be checked. A live session may exist
              that is not shown here -- reload to try again. Starting is disabled until this check
              succeeds, so a second session cannot be opened over a running one blindly.
            </p>
          </div>
        )}

        {liveNotice && (
          <p className="t-body mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.35)] bg-[rgba(0,0,0,.28)] px-[var(--s4)] py-[var(--s3)] text-[color:var(--brass-300)]">
            {liveNotice}
          </p>
        )}

        {liveRun && (
          <div className="mt-[var(--s5)]">
            <SessionScriptLiveDelivery
              key={liveRun.run_id}
              initialRun={liveRun}
              onSettled={(settled) => {
                setLiveRun(null);
                setLiveNotice(
                  `This session was recorded as ${settled.run_state === 'abandoned' ? 'abandoned' : 'completed'}. `
                  + 'It is settled and can no longer be changed from this screen.',
                );
              }}
              onRunGone={(message) => {
                setLiveRun(null);
                setLiveNotice(message);
              }}
            />
          </div>
        )}

        {!liveRun && (<>
        <section className="mt-[var(--s6)]">
          <h2 className="t-command text-[length:var(--t-lg)]">Scripts</h2>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty set of scripts.
              </p>
            </div>
          )}

          {!loading && !loadError && scripts.length === 0 && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              No session scripts yet.
            </p>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {scripts.map((script) => (
              <article key={script.script_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{script.name}</h3>
                  <span className="plaque">{script.authoring_state.replace(/_/g, ' ')}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">
                  {script.discipline}
                  {script.day_of_week ? ` -- ${script.day_of_week}` : ''}
                  {script.total_minutes === null ? '' : ` -- ${script.total_minutes} min`}
                </p>
                {script.theme.trim() !== '' && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{script.theme}</p>
                )}
                <p className="t-body mt-[var(--s2)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                  {script.contact_structure.replace(/_/g, ' ')}
                </p>
                <button
                  type="button"
                  onClick={() => void openScript(script.script_id)}
                  className="btn btn--ghost mt-[var(--s4)]"
                >
                  {openScriptId === script.script_id ? 'Showing plan' : 'Open plan'}
                </button>
              </article>
            ))}
          </div>
        </section>

        {openScriptId !== null && (
          <section className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command text-[length:var(--t-lg)]">
              {detail ? detail.name : 'Session plan'}
            </h2>

            {detailLoading && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the plan...</p>
            )}

            {!detailLoading && detailError && (
              <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
                {detailError}
              </p>
            )}

            {!detailLoading && !detailError && detail && (
              <>
                {detail.reset_protocol.trim() !== '' && (
                  <div className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
                    <p className="t-label">Reset protocol</p>
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{detail.reset_protocol}</p>
                  </div>
                )}

                {detail.coach_priorities.trim() !== '' && (
                  <div className="mt-[var(--s3)]">
                    <p className="t-label">Priorities, in order</p>
                    <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{detail.coach_priorities}</p>
                  </div>
                )}

                {/* Live delivery starts from the plan the coach is looking at.
                    The button only exists when the script has blocks -- the
                    server refuses a blockless start anyway; offering the
                    button just to show its refusal would be a fake control. */}
                {detail.blocks.length > 0 && (
                  <div className="mt-[var(--s4)]">
                    <button
                      type="button"
                      onClick={() => void startDelivery(detail.script_id)}
                      disabled={startBusyScriptId !== null || liveRunCheck !== 'checked'}
                      className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {startBusyScriptId === detail.script_id ? 'Starting...' : 'Start live delivery'}
                    </button>
                  </div>
                )}
                {startError && (
                  <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--locked)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-sm)] font-semibold text-[var(--locked-ink)]">
                    {startError}
                  </p>
                )}

                <h3 className="t-command mt-[var(--s5)] text-[length:var(--t-md)]">The plan</h3>

                {detail.blocks.length === 0 && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                    This script has no blocks yet. It cannot be delivered live until it has blocks.
                  </p>
                )}

                <ol className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
                  {detail.blocks.map((block) => (
                    <li
                      key={block.block_id}
                      className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                    >
                      <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                        <span className="plaque">{blockWindow(block)}</span>
                        <h4 className="t-command text-[length:var(--t-sm)]">{block.block_label}</h4>
                        {NOTABLE_KINDS[block.block_kind] && (
                          <span className="t-label">{NOTABLE_KINDS[block.block_kind]}</span>
                        )}
                        {block.scale_level && (
                          <span className="t-label">Scale {block.scale_level}</span>
                        )}
                      </div>

                      {blockDetailLines(block).map((line) => (
                        <p
                          key={`${block.block_id}-${line.label}`}
                          className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]"
                        >
                          <span className="t-label">{line.label}: </span>
                          {line.value}
                        </p>
                      ))}
                    </li>
                  ))}
                </ol>

                {detail.renderings.length > 0 && (
                  <p className="t-body mt-[var(--s5)] text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
                    Also authored for: {detail.renderings.map((r) => r.format.replace(/_/g, ' ')).join(', ')}.
                  </p>
                )}
              </>
            )}
          </section>
        )}
        </>)}
      </div>
    </main>
  );
}

export default function CoachSessionScriptsPage() {
  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <CoachSessionScripts />
    </RoleSessionGate>
  );
}
