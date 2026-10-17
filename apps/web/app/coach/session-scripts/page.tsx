'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import WorkAxis from '@/components/WorkAxis';
import SessionScriptLiveDelivery from '@/components/SessionScriptLiveDelivery';
import FinishedSessions from '@/components/FinishedSessions';
import { apiBase } from '@/lib/apiBase';
import { authoringStateWords, explainLine } from '@/src/lib/sessionScriptWords';
import SessionScriptEditor, { type SessionScriptEditOutcome } from './SessionScriptEditor';
import type { LiveSessionScriptRun, SessionScriptRunRow } from '@/src/server/pilot/sessionScriptRuns';
import type {
  SessionScriptBlockRow,
  SessionScriptRow,
  SessionScriptWithDetail,
} from '@/src/server/pilot/sessionScripts';
import ClusterNav from '@/components/ClusterNav';

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
// The busy marker of the plain-session start button; no script_id can equal it.
const PLAIN_START = '__plain_session__';

const NOTABLE_KINDS: Record<string, string> = {
  drill_round: 'Drill',
  reset_minute: 'Reset',
  teaching_minute: 'Teaching',
  conditioning: 'Conditioning',
  reflection: 'Reflection',
};

// RETIRING A PLAN, AND BRINGING ONE BACK (lane L1, item H). What the PATCH
// answers when it refuses before or inside its transaction; any other status
// says nothing about whether the plan was changed (the rule the editor keeps).
const RETIRE_REFUSAL_STATUSES: readonly number[] = [400, 401, 403, 404, 409, 422];

const RETIRE_REFUSALS: Readonly<Record<string, string>> = {
  // Not "another coach": it may be this coach's own earlier try, whose answer was lost.
  SESSION_SCRIPT_CHANGED:
    'This plan was saved after you opened it, so it was not changed. Open the plan again to see how it stands, then try again.',
  SESSION_SCRIPT_SUPERSEDED:
    'This plan has been replaced by a newer version, so it was not changed. Reload the list and open the current version.',
  SESSION_SCRIPT_NOT_FOUND: 'This plan could not be found, so nothing was changed.',
};

const RETIRE_REFUSALS_BY_STATUS: Readonly<Record<number, string>> = {
  401: 'You are signed out, so the plan was not changed. Sign in and open the plan again.',
  403: 'Your account may not retire session scripts, so the plan was not changed.',
};

// MARKING A PLAN REVIEWED (F-092): the coach's word that a draft is fit to run.
// The same refusals as retiring, worded for this press.
const REVIEW_REFUSALS: Readonly<Record<string, string>> = {
  ...RETIRE_REFUSALS,
  SESSION_SCRIPT_RETIRED: 'This plan is retired, so it was not marked reviewed. Bring it back first.',
};

const REVIEW_REFUSALS_BY_STATUS: Readonly<Record<number, string>> = {
  ...RETIRE_REFUSALS_BY_STATUS,
  403: 'Your account may not mark session scripts reviewed, so the plan was not changed.',
};

// An ordinary message, so not the medical-stop colour (--locked means a
// medical stop and nothing else: AGENT_KERNEL.md, OD-2026-09-29-001).
const PLAIN_ALERT = 'rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

function blockWindow(block: Block): string {
  return `${block.start_offset_min}-${block.end_offset_min} min`;
}

/** The four authored coaching fields, in the order a coach reads them mid-session. */
function blockDetailLines(block: Block): { label: string; value: string }[] {
  return [
    { label: 'Say', value: block.what_to_say ?? '' },
    // Template facts are labelled as the template's, and stored codes read as words (F-078).
    explainLine(block.what_to_explain ?? ''),
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

  // What has actually been delivered from the open plan: the settled runs,
  // with the summary the coach recorded at finish. 'unavailable' is distinct
  // from an empty list -- a failed read must never render as "never delivered".
  const [deliveries, setDeliveries] = useState<SessionScriptRunRow[]>([]);
  const [deliveriesState, setDeliveriesState] = useState<'loading' | 'loaded' | 'unavailable'>('loading');

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
  // Which start the error belongs to: a script's id, or PLAIN_START. The error is shown beside the
  // button that was pressed, so a failed plain start is never silent (review 2 of #1523 PR 2).
  const [startErrorFor, setStartErrorFor] = useState<string | null>(null);

  // Changing the open plan (lane L1): its name, block titles and minutes. The
  // notice says what the save did, in the server's terms -- changed where it
  // was, or kept as a new version because the plan had been delivered.
  const [editing, setEditing] = useState(false);
  const [editNotice, setEditNotice] = useState('');
  // True while a save is running. Opening another plan or starting a session
  // would take the form off the screen, and a save whose form is gone answers
  // to nobody (the rule the workout templates page keeps for an issue).
  const [saving, setSaving] = useState(false);

  // A retired plan is kept and left out of the list. This asks for them too,
  // so a coach can find one and bring it back.
  const [showRetired, setShowRetired] = useState(false);
  const [retireError, setRetireError] = useState('');

  // No state is set before the first await, matching the drill library: a
  // synchronous setState inside an effect cascades a render before the request
  // has even left.
  //
  // Only the LATEST list read may set the list. Two reads can overlap (the
  // retired toggle pressed twice, or pressed right after a retire), and a late
  // answer to the earlier one would otherwise show a list that contradicts
  // the toggle.
  const listRead = useRef(0);
  const load = useCallback(async () => {
    const read = ++listRead.current;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/session-scripts${showRetired ? '?include_retired=true' : ''}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!response.ok) throw new Error('The session scripts could not be loaded.');
      const payload = (await response.json()) as { scripts?: Script[] };
      if (read !== listRead.current) return;
      setScripts(payload.scripts ?? []);
      setLoadError('');
    } catch (error) {
      if (read !== listRead.current) return;
      setScripts([]);
      setLoadError(error instanceof Error ? error.message : 'The session scripts could not be loaded.');
    } finally {
      if (read === listRead.current) setLoading(false);
    }
  }, [showRetired]);

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
          setEditing(false);
          setLiveNotice('A session already in progress was restored -- the clock kept running on the server.');
        }
      } catch {
        setLiveRunCheck('unavailable');
      }
    })();
  }, [fetchLiveRun]);

  // scriptId null starts a PLAIN session (Jason 2026-10-12, issue #1523): no plan, the clock,
  // pause, TV and finish only. Its busy marker is PLAIN_START so no script's button reads busy.
  // One start per press: the busy state disables the buttons only after a render, so two taps
  // landing before it would both start; the in-flight mark is a ref.
  const startInFlight = useRef(false);
  const startDelivery = useCallback(async (scriptId: string | null) => {
    if (startBusyScriptId || startInFlight.current) return;
    startInFlight.current = true;
    setStartBusyScriptId(scriptId ?? PLAIN_START);
    setStartErrorFor(scriptId ?? PLAIN_START);
    setStartError('');
    setLiveNotice('');
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts/runs`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(scriptId ? { script_id: scriptId } : {}),
        });
      } catch {
        setStartError('Network error -- no session was started.');
        return;
      }

      const payload = (await response.json().catch(() => ({}))) as {
        run?: LiveSessionScriptRun;
        error?: string;
        message?: string;
      };

      if (response.ok && payload.run) {
        setLiveRun(payload.run);
        setLiveRunCheck('checked');
        // The live surface replaces the plan; it is not left in edit mode behind it.
        setEditing(false);
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
            setEditing(false);
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
      // A newer version of this plan loaded after the list was read. The route words this one
      // itself (session-scripts/runs/route.ts), so its text is shown rather than a second copy here.
      if (payload.error === 'SESSION_SCRIPT_SUPERSEDED') {
        setStartError(payload.message ?? 'This plan has been replaced by a newer version, so no session was started.');
        return;
      }
      setStartError(`The server refused to start the session${payload.error ? `: ${payload.error}` : '.'}`);
    } finally {
      startInFlight.current = false;
      setStartBusyScriptId(null);
    }
  }, [fetchLiveRun, startBusyScriptId]);

  const loadDeliveries = useCallback(async (scriptId: string) => {
    setDeliveries([]);
    setDeliveriesState('loading');
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/session-scripts/runs?script_id=${encodeURIComponent(scriptId)}`,
        { method: 'GET', credentials: 'include' },
      );
      if (!response.ok) throw new Error('history');
      const payload = (await response.json()) as { runs?: SessionScriptRunRow[] };
      setDeliveries(payload.runs ?? []);
      setDeliveriesState('loaded');
    } catch {
      setDeliveries([]);
      setDeliveriesState('unavailable');
    }
  }, []);

  const openScript = useCallback(async (scriptId: string) => {
    // Clearing the previous script's detail and error together: leaving either
    // in place shows one script's blocks -- or one script's failure -- under
    // another script's name while the new one loads. The delivery history is
    // cleared on the same principle.
    setOpenScriptId(scriptId);
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    setEditing(false);
    setEditNotice('');
    setRetireError('');
    // "X is retired" must not sit above X once it is opened and brought back.
    setLiveNotice('');
    setDeliveries([]);
    setDeliveriesState('loading');

    const detailRead = (async () => {
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
    })();

    const historyRead = loadDeliveries(scriptId);

    await Promise.all([detailRead, historyRead]);
  }, [loadDeliveries]);

  // A link from the workout templates page names the script it just made
  // (?script=...), so the coach lands on that plan rather than on the list.
  // The name is used once and taken out of the address: an edit can replace
  // that script with a newer version, and a reload must not reopen the old one.
  useEffect(() => {
    void (async () => {
      const scriptId = await Promise.resolve(new URLSearchParams(window.location.search).get('script'));
      if (!scriptId) return;
      window.history.replaceState(window.history.state, '', window.location.pathname);
      await openScript(scriptId);
    })();
  }, [openScript]);

  const planSaved = useCallback((outcome: SessionScriptEditOutcome | null, saved: ScriptDetail | null) => {
    setEditing(false);
    if (outcome === null || saved === null) {
      // Saved, but what was saved did not arrive. The plan on screen is the one
      // from before the save, so it is closed rather than shown as current.
      setOpenScriptId(null);
      setDetail(null);
      setLiveNotice('The plan was saved, but the answer could not be read here. Open it from the list to see it.');
      void load();
      return;
    }
    // A new version is a new row with its own id: the open plan becomes it.
    setDetail(saved);
    setOpenScriptId(saved.script_id);
    if (outcome === 'unchanged') {
      setEditNotice('Nothing was changed, so nothing was saved.');
      return;
    }
    setEditNotice(
      outcome === 'new_version'
        ? `This plan has been delivered before, so your changes were saved as version ${saved.version}. `
          + 'The sessions already delivered keep the version they ran.'
        : 'Saved.',
    );
    void load();
    if (outcome === 'new_version') void loadDeliveries(saved.script_id);
  }, [load, loadDeliveries]);

  // Retire the open plan, or bring a retired one back. The plan is kept either
  // way: retired only leaves it out of the list. Sent in the state this screen
  // read, so a plan another coach has saved since is refused, not changed.
  const retireInFlight = useRef(false);
  const setPlanRetired = useCallback(async (plan: ScriptDetail, retired: boolean) => {
    if (retireInFlight.current) return;
    retireInFlight.current = true;
    setSaving(true);
    setRetireError('');
    setEditNotice('');
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script_id: plan.script_id, expected_updated_at: plan.updated_at, retired }),
        });
      } catch {
        setRetireError('No answer arrived, so it is not known whether the plan was changed. Reload the list to see which.');
        return;
      }
      const payload = (await response.json().catch(() => null)) as { script?: ScriptDetail | null; error?: unknown } | null;
      if (response.ok) {
        void load();
        if (!retired && payload?.script) {
          setDetail(payload.script);
          setLiveNotice('');
          setEditNotice('This plan is back in the list.');
          return;
        }
        // Retired, or brought back with an answer that cannot be shown: the
        // plan on screen is the one from before, so it is closed.
        setOpenScriptId(null);
        setDetail(null);
        setLiveNotice(retired
          ? `${plan.name} is retired. It is kept, and is left out of the list unless retired plans are shown.`
          : 'The plan was brought back, but the answer could not be read here. Open it from the list to see it.');
        return;
      }
      if (RETIRE_REFUSAL_STATUSES.includes(response.status)) {
        const code = typeof payload?.error === 'string' ? payload.error : '';
        setRetireError(RETIRE_REFUSALS[code] ?? RETIRE_REFUSALS_BY_STATUS[response.status] ?? 'The server refused, so the plan was not changed.');
        return;
      }
      setRetireError('The server did not answer properly, so it is not known whether the plan was changed. Reload the list to see which.');
    } finally {
      retireInFlight.current = false;
      setSaving(false);
    }
  }, [load]);

  // Mark the open draft reviewed. Shares the retire guard: both change where
  // the plan stands, and one press at a time.
  const markPlanReviewed = useCallback(async (plan: ScriptDetail) => {
    if (retireInFlight.current) return;
    retireInFlight.current = true;
    setSaving(true);
    setRetireError('');
    setEditNotice('');
    try {
      let response: Response;
      try {
        response = await fetch(`${apiBase()}/api/pilot/session-scripts`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ script_id: plan.script_id, expected_updated_at: plan.updated_at, reviewed: true }),
        });
      } catch {
        setRetireError('No answer arrived, so it is not known whether the plan was marked reviewed. Reload the list to see which.');
        return;
      }
      const payload = (await response.json().catch(() => null)) as { script?: ScriptDetail | null; error?: unknown } | null;
      if (response.ok) {
        void load();
        if (payload?.script) {
          setDetail(payload.script);
          setLiveNotice('');
          setEditNotice(`${plan.name} is marked coach reviewed.`);
          return;
        }
        setOpenScriptId(null);
        setDetail(null);
        setLiveNotice('The plan was marked reviewed, but the answer could not be read here. Open it from the list to see it.');
        return;
      }
      if (RETIRE_REFUSAL_STATUSES.includes(response.status)) {
        const code = typeof payload?.error === 'string' ? payload.error : '';
        setRetireError(REVIEW_REFUSALS[code] ?? REVIEW_REFUSALS_BY_STATUS[response.status] ?? 'The server refused, so the plan was not changed.');
        return;
      }
      setRetireError('The server did not answer properly, so it is not known whether the plan was marked reviewed. Reload the list to see which.');
    } finally {
      retireInFlight.current = false;
      setSaving(false);
    }
  }, [load]);

  return (
    /* data-surface="kiosk" -- Law 5, the app's one-attribute device for a
       gym-floor surface (as on /coach/floor-groups and /coach/recognition): a
       coach reads this at arm's length, so controls take the 55px tap floor
       and voices the 19.1px type floor. It is set on THIS PAGE'S OWN PARTS --
       the header, the notices, the script list, the plan and (since screen
       3b, with its own rendered check) the live run's wrapper -- rather than
       on <main>, so each part was raised when it had been looked at. */
    <main className="ge-scripts room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header data-surface="kiosk" className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach Workspace</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Session Scripts</h1>
          <ClusterNav cluster="planning" />
          <p className="t-body mt-[var(--s3)] max-w-3xl text-[color:var(--bone-300)]">
            The plan for a session, block by block. Times are minutes from the start of the session,
            not clock times -- the same script runs whether the room opens at 4:00 or 6:30.
          </p>
          <Link href="/coach/drills" className="btn btn--ghost mt-[var(--s4)]">
            Back to drill library
          </Link>
        </header>

        <div data-surface="kiosk">
        {liveRunCheck === 'loading' && (
          <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">
            Checking for a session in progress...
          </p>
        )}

        {liveRunCheck === 'unavailable' && (
          <div className="mt-[var(--s5)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
              Whether you have a session in progress could not be checked. A live session may exist
              that is not shown here -- reload to try again. Starting is disabled until this check
              succeeds, so a second session cannot be opened over a running one blindly.
            </p>
          </div>
        )}

        {liveNotice && (
          <p role="status" className="t-body mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] bg-[rgba(0,0,0,.28)] px-[var(--s4)] py-[var(--s3)] text-[color:var(--brass-300)]">
            {liveNotice}
          </p>
        )}
        </div>

        {liveRun && (
          <div data-surface="kiosk" className="mt-[var(--s5)]">
            <SessionScriptLiveDelivery
              key={liveRun.run_id}
              initialRun={liveRun}
              onSettled={(settled) => {
                setLiveRun(null);
                if (settled.script_id && openScriptId === settled.script_id) {
                  void loadDeliveries(settled.script_id);
                }
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
        {/* A session does not need a plan (issue #1523): roster, check-in, notes and the TV all
            work for a plain one. Offered whether or not the gym has scripts. */}
        <section data-surface="kiosk" className="mt-[var(--s6)]">
          <button
            type="button"
            onClick={() => void startDelivery(null)}
            disabled={startBusyScriptId !== null || liveRunCheck !== 'checked' || saving}
            className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {startBusyScriptId === PLAIN_START ? 'Starting...' : 'Start a plain session'}
          </button>
          {startError && startErrorFor === PLAIN_START && (
            <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
              {startError}
            </p>
          )}
        </section>

        <section data-surface="kiosk" className="mt-[var(--s6)]">
          <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
            <h2 className="t-command text-[length:var(--t-lg)]">Scripts</h2>
            <button
              type="button"
              onClick={() => setShowRetired((shown) => !shown)}
              disabled={saving}
              className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
            >
              {showRetired ? 'Hide retired plans' : 'Show retired plans'}
            </button>
          </div>

          {loading && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}

          {!loading && loadError && (
            <div className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
              <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{loadError}</p>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                This is a failure to load, not an empty set of scripts.
              </p>
            </div>
          )}

          {!loading && !loadError && scripts.length === 0 && (
            <div className="mt-[var(--s3)]">
              <p className="t-body text-[color:var(--bone-300)]">
                {showRetired ? 'No session scripts yet.' : 'No session scripts in the list.'}
              </p>
              {!showRetired && (
                <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                  Retired plans are kept and are not shown here. Show retired plans lists them.
                </p>
              )}
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                A workout template can be made into one: open the template and choose Make a session script.
              </p>
              <Link href="/coach/workout-templates" className="btn btn--ghost mt-[var(--s3)]">
                Workout templates
              </Link>
            </div>
          )}

          <div className="mt-[var(--s4)] grid gap-[var(--s4)] md:grid-cols-2">
            {scripts.map((script) => (
              <article key={script.script_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex items-baseline justify-between gap-[var(--s3)]">
                  <h3 className="t-command text-[length:var(--t-md)]">{script.name}</h3>
                  <span className="plaque">{authoringStateWords(script.authoring_state)}</span>
                </div>
                <p className="t-label mt-[var(--s2)]">
                  {script.discipline}
                  {script.day_of_week ? ` -- ${script.day_of_week}` : ''}
                  {script.total_minutes === null ? '' : ` -- ${script.total_minutes} min`}
                </p>
                {script.theme.trim() !== '' && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">{script.theme}</p>
                )}
                <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                  {script.contact_structure.replace(/_/g, ' ')}
                </p>
                <button
                  type="button"
                  onClick={() => void openScript(script.script_id)}
                  disabled={saving}
                  className="btn btn--ghost mt-[var(--s4)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {openScriptId === script.script_id ? 'Showing plan' : 'Open plan'}
                </button>
              </article>
            ))}
          </div>
        </section>

        {openScriptId !== null && (
          <section data-surface="kiosk" className="mat-leather mt-[var(--s6)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <h2 className="t-command text-[length:var(--t-lg)]">
              {detail ? detail.name : 'Session plan'}
            </h2>

            {detailLoading && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading the plan...</p>
            )}

            {!detailLoading && detailError && (
              <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                {detailError}
              </p>
            )}

            {!detailLoading && !detailError && detail && (
              <>
                {detail.reset_protocol.trim() !== '' && (
                  <div className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
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
                {editNotice && (
                  <p role="status" className="t-body mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] bg-[rgba(0,0,0,.28)] px-[var(--s4)] py-[var(--s3)] text-[color:var(--brass-300)]">
                    {editNotice}
                  </p>
                )}

                {/* While the plan is being edited the start button is put
                    away: what it would start is the stored plan, not the one
                    on screen. */}
                {/* A retired plan is kept and can be read here. It offers one
                    thing: bringing it back. Start and Edit return with it. */}
                {detail.authoring_state === 'retired' && (
                  <div className="mt-[var(--s4)]">
                    <p className="t-body text-[color:var(--bone-300)]">
                      This plan is retired. It is kept, and is left out of the list unless retired plans are shown.
                    </p>
                    <button
                      type="button"
                      onClick={() => void setPlanRetired(detail, false)}
                      disabled={saving}
                      className="btn mt-[var(--s3)] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Bring this plan back
                    </button>
                  </div>
                )}

                {!editing && detail.authoring_state !== 'retired' && (
                  <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                    {detail.blocks.length > 0 && (
                      <button
                        type="button"
                        onClick={() => void startDelivery(detail.script_id)}
                        disabled={startBusyScriptId !== null || liveRunCheck !== 'checked' || saving}
                        className="btn px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {startBusyScriptId === detail.script_id ? 'Starting...' : 'Start live delivery'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => { setEditing(true); setEditNotice(''); }}
                      disabled={startBusyScriptId !== null || saving}
                      className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Edit minutes and titles
                    </button>
                    {detail.authoring_state === 'draft' && (
                      <button
                        type="button"
                        onClick={() => void markPlanReviewed(detail)}
                        disabled={startBusyScriptId !== null || saving}
                        className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        Mark reviewed
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void setPlanRetired(detail, true)}
                      disabled={startBusyScriptId !== null || saving}
                      className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Retire this plan
                    </button>
                  </div>
                )}
                {retireError && (
                  <p role="alert" className={`mt-[var(--s3)] ${PLAIN_ALERT}`}>{retireError}</p>
                )}
                {!editing && startError && startErrorFor === detail.script_id && (
                  <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                    {startError}
                  </p>
                )}

                <h3 className="t-command mt-[var(--s5)] text-[length:var(--t-md)]">The plan</h3>

                {editing && (
                  <SessionScriptEditor
                    key={detail.script_id}
                    script={detail}
                    onSaved={planSaved}
                    onCancel={() => setEditing(false)}
                    onBusyChange={setSaving}
                  />
                )}

                {!editing && detail.blocks.length === 0 && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                    This script has no blocks yet. It cannot be delivered live until it has blocks.
                  </p>
                )}

                {/* Named, because this page now holds more than one list and
                    an unlabelled one is indistinguishable to a screen reader
                    (and to a test) from any other. The name also states the
                    ordering the list actually carries: block_order, which is
                    the sequence a coach runs, NOT start offset -- two blocks
                    legitimately share an offset. */}
                {!editing && (
                <ol
                  aria-label="Session blocks, in the order they run"
                  className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]"
                >
                  {detail.blocks.map((block) => (
                    <li
                      key={block.block_id}
                      className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                    >
                      <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                        <span className="plaque">{blockWindow(block)}</span>
                        <h4 className="t-command text-[length:var(--t-md)]">{block.block_label}</h4>
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
                )}

                {detail.renderings.length > 0 && (
                  <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">
                    Also authored for: {detail.renderings.map((r) => r.format.replace(/_/g, ' ')).join(', ')}.
                  </p>
                )}
              </>
            )}

            {/* What actually happened to this plan: the settled runs and the
                summary the coach recorded at finish. Deliberately outside the
                detail conditional -- the history read is its own request, and
                a failed plan read must not hide a history that loaded. */}
            <h3 className="t-command mt-[var(--s6)] text-[length:var(--t-md)]">Past deliveries</h3>

            {deliveriesState === 'loading' && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading past deliveries...</p>
            )}

            {deliveriesState === 'unavailable' && (
              <p className="t-body mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                The delivery history could not be loaded. Deliveries may exist that are not shown --
                this is a failed read, not an empty history.
              </p>
            )}

            {deliveriesState === 'loaded' && deliveries.length === 0 && (
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                No deliveries recorded for this plan yet. A session delivered live appears here once
                it is ended.
              </p>
            )}

            {deliveriesState === 'loaded' && deliveries.length > 0 && (
              <ul className="mt-[var(--s3)] flex flex-col gap-[var(--s3)]">
                {deliveries.map((run) => (
                  <li
                    key={run.run_id}
                    className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]"
                  >
                    <div className="flex flex-wrap items-baseline gap-[var(--s3)]">
                      <span className="plaque">{typeof run.delivered_on === 'string' ? run.delivered_on.slice(0, 10) : run.delivered_on}</span>
                      <span className="t-label">
                        {run.run_state === 'completed' && 'Completed'}
                        {run.run_state === 'abandoned' && 'Abandoned'}
                        {run.run_state === null && 'Recorded before live delivery tracking'}
                      </span>
                      <span className="t-label text-[color:var(--bone-400)]">Plan version {run.script_version}</span>
                    </div>
                    {/* Only what the coach actually recorded. A null count is
                        "not stated", never rendered as zero. */}
                    {(run.blocks_completed !== null || run.athletes_present !== null || run.reset_protocol_used) && (
                      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-300)]">
                        {run.blocks_completed !== null && `${run.blocks_completed} blocks completed. `}
                        {run.athletes_present !== null && `${run.athletes_present} athletes present. `}
                        {run.reset_protocol_used && 'Reset protocol used.'}
                      </p>
                    )}
                    {(run.deviation_note ?? '').trim() !== '' && (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                        <span className="t-label">Deviation: </span>{run.deviation_note}
                      </p>
                    )}
                    {(run.what_worked ?? '').trim() !== '' && (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                        <span className="t-label">Worked: </span>{run.what_worked}
                      </p>
                    )}
                    {(run.what_did_not ?? '').trim() !== '' && (
                      <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
                        <span className="t-label">Did not: </span>{run.what_did_not}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* Every session the gym has ended, plain ones included (F-067). It is not shown over a
            live session, so it is mounted, and reads, again once a session ends here. */}
        <FinishedSessions />
        </>)}

      {/* The four words, at the foot of the page — the same foot the
          approved boards put under every full screen. See WorkAxis. */}
      <WorkAxis />
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
