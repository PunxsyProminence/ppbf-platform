'use client';

import { Suspense, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import RoleSessionGate from '@/components/RoleSessionGate';
import GymTvPanel from '@/components/GymTvPanel';
import { COACH_TILES_REFRESH_MS } from '@/components/CoachLiveTiles';
import PainReportsPanel from '@/components/PainReportsPanel';
import SessionScriptLiveDelivery, { RUN_GONE } from '@/components/SessionScriptLiveDelivery';
import SessionClassPicker, { type ClassChoiceInfo } from '@/components/SessionClassPicker';
import { fetchOwnLiveRun, startClassSession, startRefusalWords } from '@/src/client/startClassSession';
import { defaultClassChoice, type ClassChoice, type TieableClassView } from '@/src/shared/sessionClassChoice';
import type { LiveSessionScriptRun } from '@/src/server/pilot/sessionScriptRuns';
import { painTileRead, usePainReports, type PainReportsRead } from '@/components/usePainReports';

// THE CLASS SCREEN (lane U2-6a; app scrub AS-6; Overwatch GO 6a, Q4 = A, Q5 = A, Q6 = A, Q8 = A).
//
// One screen for running tonight's class on the gym floor tablet:
//   - no live session: today's classes (the picker Session Plans uses) and one Start, which starts
//     a session with no plan, tied to the chosen class or open gym. ?class=<id> chooses that class
//     when it is one of today's free classes. Plans are still started from Session Plans;
//   - a live session: the live console (SessionScriptLiveDelivery, moved here from Session Plans)
//     and Gym TVs (GymTvPanel), so the coach sends the session to a TV from the same screen.
// While a session is live the pain list shows under the console and Gym TVs (lane U2-6b-2;
// QH = B on #2023): one read of the pain feed, every two minutes (6b Q4 = A, on #2005), draws
// the list and the console's pain tile, so the two count the same rows over the same window
// (Overwatch's 6b ruling).
//
// THE SERVER DECIDES. The first question is the same one Session Plans asks: does this coach
// already have a session in progress? A failed read is its own state -- "a session may exist that
// is not shown" -- never "no session", and Start waits for it.

/** Shown when ?class=<id> names a class that is not one of today's free classes (Q4 = A). */
const CLASS_NOT_FREE = "That class is not one of today's free classes.";
/** Session Plans' words for a start that found a session already running (unchanged). */
const RESTORED = 'You already had a session in progress. It has been restored, not restarted.';
/** This screen's TV switch, named for Gym TVs below it (lane U2-6a). */
const CLASS_SCREEN_TV_SWITCH = { name: 'Allow on a TV', place: 'above' } as const;

/** The one pain read, made only while a session is live (it mounts with the console). */
function LiveSessionPainRead({ children }: { children: (read: PainReportsRead) => ReactNode }) {
  const read = usePainReports({ refreshMs: COACH_TILES_REFRESH_MS });
  return <>{children(read)}</>;
}

function ClassScreen() {
  const params = useSearchParams();
  const wantedClass = params.get('class');
  // Session Plans and the coach home send ?restored=1 when the start they made found a session
  // already running: it is that one shown here, and the screen says it was not restarted.
  const restored = params.get('restored') === '1';

  // liveRun is the run this page mounted the console with (it keys the console); reportedRun is
  // the latest the console has told the page, which can differ when the console adopts another
  // live run in place. Gym TVs reads the latest, so it never works from an older copy.
  const [liveRun, setLiveRunState] = useState<LiveSessionScriptRun | null>(null);
  const [reportedRun, setReportedRun] = useState<LiveSessionScriptRun | null>(null);
  const setLiveRun = useCallback((run: LiveSessionScriptRun | null) => {
    setLiveRunState(run);
    setReportedRun(null);
  }, []);
  const shownRun = reportedRun ?? liveRun;
  const [liveRunCheck, setLiveRunCheck] = useState<'loading' | 'checked' | 'unavailable'>('loading');
  const [notice, setNotice] = useState('');
  // Bumped when Gym TVs sends, takes off or changes a TV, so the console reads TV status again
  // (Overwatch Q10 = A: no timer).
  const [tvChanges, setTvChanges] = useState(0);

  const loadLiveRun = useCallback(async () => {
    try {
      const run = await fetchOwnLiveRun();
      setLiveRun(run);
      setLiveRunCheck('checked');
      if (run && restored) setNotice(RESTORED);
    } catch {
      setLiveRunCheck('unavailable');
    }
  }, [restored, setLiveRun]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadLiveRun();
  }, [loadLiveRun]);

  // The class the session is for (D4, OD-2026-10-21-002), as Session Plans keeps it: undefined
  // until chosen when the picker cannot choose; a default is worked out again at Start.
  const [classChoice, setClassChoice] = useState<ClassChoice>(undefined);
  const classPick = useRef<{ picked: boolean; classes: readonly TieableClassView[] }>({ picked: false, classes: [] });
  const [classNote, setClassNote] = useState('');
  // ?class=<id>: applied once, to the first list the picker reads; after that the coach's picks rule.
  const preselect = useRef<'pending' | 'applied' | 'done'>(wantedClass ? 'pending' : 'done');
  const onClassChoice = useCallback((choice: ClassChoice, info: ClassChoiceInfo) => {
    if (!info.picked && preselect.current === 'pending') {
      const named = info.classes.find((item) => item.class_id === wantedClass && !item.held_by_other_session);
      if (named) {
        preselect.current = 'applied';
        classPick.current = { picked: true, classes: info.classes };
        setClassChoice(named.class_id);
        return;
      }
      preselect.current = 'done';
      // With no class today the picker already says so; the note is for a list that has others.
      if (info.classes.length > 0) setClassNote(CLASS_NOT_FREE);
    } else if (!info.picked && preselect.current === 'applied') {
      // The picker's clock default does not replace the class the link named.
      return;
    }
    if (info.picked) preselect.current = 'done';
    classPick.current = info;
    setClassChoice(choice);
  }, [wantedClass]);
  const resetClassChoice = useCallback(() => {
    preselect.current = 'done';
    classPick.current = { picked: false, classes: [] };
    setClassChoice(undefined);
    setClassNote('');
  }, []);

  // Gym TVs was told the session is not live (it ended elsewhere, or was replaced). Ask the server
  // which session is live now. None: the console goes, and the screen says why, in the console's
  // own words. A failed re-read leaves the screen as it was; Gym TVs shows what it was refused.
  const recheckLiveRun = useCallback(async () => {
    let run: LiveSessionScriptRun | null;
    try {
      run = await fetchOwnLiveRun();
    } catch {
      return;
    }
    if (run) {
      setLiveRun(run);
      return;
    }
    setLiveRun(null);
    resetClassChoice();
    setNotice(RUN_GONE);
  }, [resetClassChoice, setLiveRun]);

  // One start per press: the busy state disables the button only after a render, so the in-flight
  // mark is a ref. The start is the shared one (src/client/startClassSession.ts).
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const inFlight = useRef(false);
  const start = useCallback(async () => {
    if (inFlight.current || classChoice === undefined) return;
    if (!classPick.current.picked) {
      const now = defaultClassChoice(classPick.current.classes, Date.now());
      if (now !== classChoice) {
        setClassChoice(now);
        setStartError('The class under way has changed since this page opened. Check the class above, then start again.');
        return;
      }
    }
    inFlight.current = true;
    setStarting(true);
    setStartError('');
    setNotice('');
    try {
      const outcome = await startClassSession({ scriptId: null, classId: classChoice });
      if ((outcome.kind === 'started' || outcome.kind === 'already_live') && outcome.run) {
        setLiveRun(outcome.run);
        setLiveRunCheck('checked');
        if (outcome.kind === 'already_live') setNotice(RESTORED);
        return;
      }
      setStartError(startRefusalWords(outcome));
    } finally {
      inFlight.current = false;
      setStarting(false);
    }
  }, [classChoice, setLiveRun]);

  return (
    <main className="room room--floor min-h-screen bg-[var(--hide-950)] px-[var(--s5)] py-[var(--s6)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-5xl">
        <header className="border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
          <p className="t-eyebrow">Coach Workspace</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-2xl)]">Class screen</h1>
        </header>

        {liveRunCheck === 'loading' && (
          <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">Checking for a session in progress...</p>
        )}

        {liveRunCheck === 'unavailable' && (
          <div role="alert" className="mt-[var(--s5)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
            <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
              Whether you have a session in progress could not be checked. A live session may exist
              that is not shown here -- reload to try again. Starting is disabled until this check
              succeeds, so a second session cannot be opened over a running one blindly.
            </p>
          </div>
        )}

        {notice && (
          <p role="status" className="t-body mt-[var(--s5)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.35)] bg-[rgba(0,0,0,.28)] px-[var(--s4)] py-[var(--s3)] text-[color:var(--brass-300)]">
            {notice}
          </p>
        )}

        {liveRun && (
          <LiveSessionPainRead>
            {(painRead) => (
              <>
                <div className="mt-[var(--s5)]">
                  <SessionScriptLiveDelivery
                    key={liveRun.run_id}
                    initialRun={liveRun}
                    painFeed={painTileRead(painRead)}
                    tvStatusRefresh={tvChanges}
                    // Every run the console adopts is the page's too, so Gym TVs below never works
                    // from an older copy of the switch or of which run is live.
                    onRunChange={setReportedRun}
                    onSettled={(settled) => {
                      setLiveRun(null);
                      resetClassChoice();
                      setNotice(
                        `This session was recorded as ${settled.run_state === 'abandoned' ? 'abandoned' : 'completed'}. `
                        + 'It is settled and can no longer be changed from this screen.',
                      );
                    }}
                    onRunGone={(message) => {
                      setLiveRun(null);
                      resetClassChoice();
                      setNotice(message);
                    }}
                  />
                </div>
                <div className="mt-[var(--s6)]">
                  <GymTvPanel
                    liveRun={{ run_id: (shownRun ?? liveRun).run_id, show_on_wall: (shownRun ?? liveRun).show_on_wall }}
                    liveRunKnown
                    // The live run read is the coach's own (getLiveRunForCoach), so this is the
                    // signed-in coach: "your session" is said honestly.
                    coachAccountId={(shownRun ?? liveRun).delivered_by_account_id}
                    onRunStale={recheckLiveRun}
                    onTvsChanged={() => setTvChanges((count) => count + 1)}
                    tvSwitch={CLASS_SCREEN_TV_SWITCH}
                  />
                </div>
                {/* Under Gym TVs (QH = B on #2023): the top row's tile already shows the count, so up
                    to 50 cards never push the TV controls off screen. No floor board on this screen:
                    "Record What You Did" is the panel's link. The read is every two minutes
                    (COACH_TILES_REFRESH_MS), which the panel's line under an empty list says. */}
                <div className="mt-[var(--s6)]">
                  <PainReportsPanel read={painRead} boardShown={false} readsEveryTwoMinutes />
                </div>
              </>
            )}
          </LiveSessionPainRead>
        )}

        {/* With the live-session check failed, Start shows but stays off, as the alert above says. */}
        {!liveRun && liveRunCheck !== 'loading' && (
          <section aria-label="Start a session" className="mt-[var(--s6)]">
            <SessionClassPicker value={classChoice} onChange={onClassChoice} />
            {classNote && <p role="status" className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{classNote}</p>}
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || liveRunCheck !== 'checked' || classChoice === undefined}
              className="btn mt-[var(--s4)] px-[var(--s5)] py-[var(--s4)] text-[length:var(--t-md)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {starting ? 'Starting...' : 'Start'}
            </button>
            {startError && (
              <p role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                {startError}
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

export default function CoachClassPage() {
  return (
    // Overwatch Q8 = A: a new gate on a new page, copied from Session Plans.
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* useSearchParams needs a Suspense boundary to prerender (as app/admin/calibration/review). */}
      <Suspense fallback={null}>
        <ClassScreen />
      </Suspense>
    </RoleSessionGate>
  );
}
