"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

/*
 * TEACH SHADOW: the home.
 *
 * A TEACHING LOOP, NOT A TOOL DIRECTORY. The order of this page is the order
 * of the work -- what does Shadow need, film it, label it, see what the corpus
 * now holds, go round again -- because the owner's instruction is that Shadow
 * is taught the way a boxer is: find the weak area, work it, measure, repeat.
 * A page of links in alphabetical order would be the same tools and none of
 * the method.
 *
 * NOTHING HERE CLAIMS A MODEL EXISTS, and that is the constraint every figure
 * on this page is shaped by. No recognition model has been trained or
 * evaluated -- there is no model, inference or dataset table in the schema at
 * all -- so this surface shows EVIDENCE COUNTS and says so plainly. The
 * heading is "What Shadow needs more of", not "what Shadow is worst at": the
 * first is answerable from governed rows, the second needs a model and a
 * held-out evaluation, and answering it from these numbers would be a guess
 * wearing the clothes of a measurement.
 *
 * NOR DOES IT SHOW 0%, AN EMPTY GAUGE, OR A GREYED-OUT DIAL. Each of those
 * reads as "measured, and bad" rather than "not measured", and a coach who
 * saw one would conclude the recognizer had been tried and had failed.
 */

interface PunchEvidenceCell {
  punch_type: string;
  stance: string | null;
  events: number;
  clips: number;
}

interface DefenseEvidenceCell {
  defense_type: string;
  events: number;
  clips: number;
}

interface HeldFootage {
  video_session_id: string;
  file_name: string;
  take_number: number | null;
  camera_view: string | null;
  status: string;
  scan_state: string;
  releasable: boolean;
  refused_by_scan: boolean;
}

interface ReleasedFootage {
  video_session_id: string;
  file_name: string;
  take_number: number | null;
  camera_view: string | null;
  created_at: string;
  status: string;
  clips_cut: number;
  clips_labelled: number;
  archived: boolean;
  archive_reason: string | null;
}

interface Coverage {
  ontology_version: string;
  capture: {
    recording_sessions: number;
    capture_takes: number;
    captured_files: number;
    takes_with_multiple_files: number;

  };
  labelling: {
    clips_cut: number;
    submitted_sets: number;
    clips_with_two_submitted_sets: number;
    adjudications: number;
    gold_records: number;
    gold_candidates: number;
  };
  punch_evidence: PunchEvidenceCell[];
  defense_evidence: DefenseEvidenceCell[];
  vocabulary: {
    punch_types: string[];
    defense_types: string[];
    stances: string[];
  };
}

/** `lead_straight` as a coach would read it, without inventing a nicer name. */
function readable(term: string): string {
  const spaced = term.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function stanceLabel(stance: string | null): string {
  return stance ? readable(stance) : 'Stance not recorded';
}

export default function TeachShadowHomePage() {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [loaded, setLoaded] = useState(false);

  const [held, setHeld] = useState<HeldFootage[]>([]);
  const [heldLoaded, setHeldLoaded] = useState(false);
  const [heldError, setHeldError] = useState('');
  const [busyVideoId, setBusyVideoId] = useState('');
  /*
   * WHICH FILES THIS PAGE HAS OPENED FOR REVIEW, so Release can be offered.
   *
   * Page memory, and deliberately NOT the authority: the server checks the
   * same thing independently and refuses without it, which is the half that
   * matters. A reload clears this and the coach opens the footage again --
   * annoying, and far better than a button that looks armed and is not.
   */
  const [openedForReview, setOpenedForReview] = useState<Set<string>>(new Set());

  const [released, setReleased] = useState<ReleasedFootage[]>([]);
  const [releasedLoaded, setReleasedLoaded] = useState(false);
  const [releasedError, setReleasedError] = useState('');
  /*
   * WHICH ROW IS BEING ARCHIVED RIGHT NOW, and what has been typed for it.
   *
   * ONE ID AND ONE STRING, not a map keyed by video. Only one row can be
   * mid-archive at a time, and a map would let half-written reasons
   * accumulate against rows nobody went on to archive -- state that then has
   * to be cleaned up on every list re-read, or quietly attaches an old
   * sentence to a later decision.
   */
  const [archivingId, setArchivingId] = useState('');
  const [archiveReason, setArchiveReason] = useState('');

  /*
   * A CALLBACK RATHER THAN AN INLINE EFFECT BODY, because archiving footage
   * changes these figures and the page has to be able to read them again. Same
   * reasoning as loadHeld: whoever acts re-reads, rather than the page editing
   * numbers it did not compute.
   */
  const loadCoverage = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/teach-shadow/coverage`, {
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        coverage?: Coverage;
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || 'The coverage figures could not be read.');
      /*
       * A MISSING PAYLOAD IS AN ERROR, NOT AN EMPTY CORPUS. Treating an
       * unanswered read as zeros would paint a gym that has filmed nothing,
       * which is a specific and wrong claim about their work.
       */
      if (!payload.coverage) throw new Error('The coverage figures could not be read.');
      setCoverage(payload.coverage);
      setErrorMessage('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The coverage figures could not be read.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadCoverage(); })();
  }, [loadCoverage]);

  const loadHeld = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/teach-shadow/held`, {
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        items?: HeldFootage[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || 'Held footage could not be read.');
      if (!payload.items) throw new Error('Held footage could not be read.');
      setHeld(payload.items);
      setHeldError('');
    } catch (error) {
      setHeldError(error instanceof Error ? error.message : 'Held footage could not be read.');
    } finally {
      setHeldLoaded(true);
    }
  }, []);

  /*
   * Wrapped in an async IIFE, matching the coverage read above. Calling the
   * loader directly from the effect body reads to the lint rule as setting
   * state synchronously inside an effect -- the state is only ever set after
   * an await, but the rule cannot see that through the callback.
   */
  useEffect(() => {
    void (async () => { await loadHeld(); })();
  }, [loadHeld]);

  const loadReleased = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/teach-shadow/released`, {
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        items?: ReleasedFootage[];
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || 'Released footage could not be read.');
      // A missing payload is an error, not an empty corpus -- same reason the
      // coverage read above refuses to fall back to zeros.
      if (!payload.items) throw new Error('Released footage could not be read.');
      setReleased(payload.items);
      setReleasedError('');
    } catch (error) {
      setReleasedError(error instanceof Error ? error.message : 'Released footage could not be read.');
    } finally {
      setReleasedLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadReleased(); })();
  }, [loadReleased]);

  /*
   * OPENS THE FOOTAGE IN A NEW TAB, and records that this page asked.
   *
   * The link is a short-lived read-only credential minted by the server. What
   * the server will check at Release is that IT issued this person one for
   * this file against its current scan verdict -- not that anyone watched,
   * which nothing here can observe.
   */
  async function openForReview(videoSessionId: string) {
    /*
     * THE WINDOW OPENS ON THE CLICK, BEFORE ANYTHING IS REQUESTED.
     *
     * Everything above the first await still runs inside the click handler,
     * so the browser's user activation is intact and the popup is allowed.
     * Opening it after the network round trip relied on that activation
     * surviving an async gap, which browsers -- mobile ones especially -- do
     * not guarantee.
     *
     * THE ORDER IS THE POINT, not just reliability. review-link WRITES the
     * video_review_link_issued audit row that the server later accepts as the
     * release prerequisite. Asking for the link first and discovering the
     * popup was blocked afterwards leaves that row already written: the
     * button stays disabled, but a direct POST would satisfy the server with
     * no review window ever opened. A blocked popup must mean no link was
     * ever requested.
     *
     * 'noopener' cannot be used: it makes window.open return null in some
     * browsers, and the handle is needed to navigate this window once the
     * URL arrives. Clearing .opener severs the reference the same way.
     */
    const reviewWindow = window.open('', '_blank');
    if (!reviewWindow) {
      setHeldError(
        'Your browser blocked the review window. Allow pop-ups for this site, then open it again.',
      );
      return;
    }
    try {
      reviewWindow.opener = null;
    } catch {
      // Some browsers refuse the assignment. The window is still ours to
      // navigate, and severing opener is a hardening step, not the control.
    }

    setBusyVideoId(videoSessionId);
    setHeldError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/review-link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_session_id: videoSessionId }),
      });
      const payload = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !payload.url) {
        throw new Error(payload.error || 'That footage could not be opened for review.');
      }
      // replace(), so the blank entry does not become a back-button step.
      reviewWindow.location.replace(payload.url);
      // Armed only once the window is actually showing the footage.
      setOpenedForReview((current) => new Set(current).add(videoSessionId));
    } catch (error) {
      // No URL to show, so the window it opened must not be left stranded.
      reviewWindow.close();
      setHeldError(error instanceof Error ? error.message : 'That footage could not be opened for review.');
    } finally {
      setBusyVideoId('');
    }
  }

  async function releaseHeld(videoSessionId: string) {
    setBusyVideoId(videoSessionId);
    setHeldError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/${videoSessionId}/release`, {
        method: 'POST',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'That footage could not be released.');
      // Re-read rather than patching the row out: the server decides what is
      // still held, and a list this page edited by hand would drift from it.
      await loadHeld();
    } catch (error) {
      setHeldError(error instanceof Error ? error.message : 'That footage could not be released.');
    } finally {
      setBusyVideoId('');
    }
  }

  /*
   * WITHDRAW FOOTAGE FROM THE CORPUS, OR PUT IT BACK.
   *
   * STILL NO CONFIRMATION DIALOG. Archiving now asks for a reason first, and
   * that is NOT a confirmation step wearing a different hat -- the difference
   * is what the extra moment produces. A modal produces a click, which is why
   * people learn to dismiss them. This produces a sentence that lands on the
   * row and stays there for whoever finds the footage missing later.
   *
   * Which is why the reason is OPTIONAL. Blocking a reversible housekeeping
   * action on a text box would turn it into the gate this deliberately is not,
   * and a required field on a reversible action is answered with "x" within a
   * week. Archive proceeds empty; the prompt is an invitation, not a toll.
   *
   * The counts still sit above the button, so the information a confirmation
   * step would have carried is still read before anything happens.
   *
   * RESTORE STAYS ONE CLICK. Putting footage back needs no justification, and
   * a form in front of an undo is friction pointing the wrong way.
   *
   * Re-reads both lists afterwards. Archiving changes the coverage counts as
   * well as this list -- that is the point of it -- so a page that refreshed
   * only the row would leave the figures above stating what was true before
   * the click.
   */
  async function setArchived(videoSessionId: string, action: 'archive' | 'restore', reason?: string) {
    setBusyVideoId(videoSessionId);
    setReleasedError('');
    try {
      const trimmed = reason?.trim();
      const response = await fetch(`${apiBase()}/api/pilot/video/${videoSessionId}/archive`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // An empty box sends NO reason rather than an empty string. The route
        // stores what it is given, and '' on the row would read as "a reason
        // was recorded" to every later reader of scan_detail.
        body: JSON.stringify(trimmed ? { action, reason: trimmed } : { action }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        throw new Error(
          payload.error
          || (action === 'archive' ? 'That footage could not be archived.' : 'That footage could not be restored.'),
        );
      }
      // Closed only on success. A failed archive leaves the prompt open with
      // what was typed in it, so a 409 that says "reload and check" does not
      // also cost the reason somebody just wrote.
      setArchivingId('');
      setArchiveReason('');
      await loadReleased();
      await loadCoverage();
    } catch (error) {
      setReleasedError(
        error instanceof Error
          ? error.message
          : action === 'archive' ? 'That footage could not be archived.' : 'That footage could not be restored.',
      );
    } finally {
      setBusyVideoId('');
    }
  }

  /*
   * THINNEST FIRST, and the stance dimension is kept because it is where the
   * gaps actually are: a gym films its orthodox fighters constantly and its
   * southpaws rarely, and a list that averaged the two would hide exactly the
   * hole somebody needs to go and fill.
   */
  /*
   * CATCH-ALLS ARE NOT GAPS. 'other_punch' and 'unclassifiable_punch' name
   * what an annotator could not classify, so they sit permanently at or near
   * zero and would occupy the top of any thinnest-first list forever --
   * pushing out the cells somebody could actually go and film. Nobody can be
   * sent to the gym to record an unclassifiable punch.
   */
  const FILMABLE = (cell: PunchEvidenceCell) =>
    cell.punch_type !== 'other_punch' && cell.punch_type !== 'unclassifiable_punch';

  const ranked = coverage
    ? [...coverage.punch_evidence].filter(FILMABLE)
      .sort((a, b) => a.events - b.events || a.clips - b.clips)
    : [];
  const thinnest = ranked.slice(0, 8);
  /*
   * Said out loud rather than left to the cut. A list that stops at eight when
   * thirty cells are equally empty reads as "these eight are the gaps", which
   * would send a coach to film a shortlist that is not one.
   */
  const alsoEmpty = ranked.slice(8).filter((cell) => cell.events === 0).length;

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* No room modifier class here. Rooms were retired as a VISUAL concept
          by owner decision: buildingMap.ts still files this door under a room
          as structural metadata, but a screen is no longer required to paint
          it. Until 2026-10-02 legacyVisualVocabulary.test.ts capped that
          retired vocabulary by string occurrences anywhere in the file,
          comments included, which is why this note does not spell the class
          out; the cap is gone (OD-2026-10-02-004). */}
      <main className="min-h-screen">
        <div className="mx-auto w-full max-w-5xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Teach Shadow</p>
            <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
              Teaching Shadow to see boxing
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Shadow learns what a punch looks like the same way a boxer learns to throw one: you find the thing it
              has seen least of, film more of it, label what happened, and check what the corpus now holds. Nothing
              on this page trains or scores an athlete. Footage collected here is teaching evidence and stays
              separate from Film Study.
            </p>
          </header>

          {errorMessage ? (
            <div role="alert" className="alert alert--warning mt-[var(--s5)]">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          ) : null}

          {/* 1. WHAT SHADOW NEEDS */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>What Shadow needs more of</h2>
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              Ranked by how little governed evidence exists, not by how the recognizer performs. There is no
              recognizer yet, so nothing on this list is a statement about what Shadow finds hard &mdash; it is a
              statement about what nobody has filmed and labelled much of.
            </p>
            {!loaded ? (
              <p className="t-body mt-[var(--s3)]">Reading the corpus&hellip;</p>
            ) : thinnest.length === 0 ? (
              <p className="t-body mt-[var(--s3)]">No coverage figures are available.</p>
            ) : (
              <ul className="mt-[var(--s4)] flex flex-col gap-[var(--s2)]">
                {thinnest.map((cell) => (
                  <li key={`${cell.punch_type}-${cell.stance ?? 'none'}`} className="t-body">
                    <span className="t-data uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
                      {readable(cell.punch_type)} &middot; {stanceLabel(cell.stance)}
                    </span>
                    <br />
                    {cell.events === 0
                      ? 'No labelled examples yet'
                      : `${cell.events} labelled example${cell.events === 1 ? '' : 's'} across ${cell.clips} clip${cell.clips === 1 ? '' : 's'}`}
                    {' '}&middot; corpus coverage gap
                  </li>
                ))}
              </ul>
            )}
            {alsoEmpty > 0 ? (
              <p className="t-body mt-[var(--s3)]">
                {alsoEmpty} further combination{alsoEmpty === 1 ? '' : 's'} also {alsoEmpty === 1 ? 'has' : 'have'} no
                labelled examples. The eight above are a place to start, not the whole gap.
              </p>
            ) : null}
          </section>

          {/* 2, 3 and 4. THE WORK, IN THE ORDER IT HAPPENS.
              Three stacked stages rather than a two-card pairing: capture,
              release, label is a DEPENDENCY, and a side-by-side grid with
              release underneath would say "capture and label, then release".
              Footage cannot be labelled until it has been released, so the
              page reads in the order a coach must work. */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">Stage one</p>
            <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Capture examples</h2>
            <p className="t-body mt-[var(--s2)]">
              Film an example for Shadow. Several coaches can join one session from their own phones and record
              the same attempt from different positions. Shadowboxing and heavy bag only, until a take can name
              everyone who appears in it.
            </p>
            {/* A plain anchor, so the recorder is served its own document
                and with it the camera grant. See components/cameraDocuments.ts. */}
            <a href="/teach-shadow/capture" className="btn mt-[var(--s4)] inline-block">
              Capture Examples
            </a>
          </section>

          {/* HELD TEACHING FOOTAGE. Every upload is held until somebody
              releases it, and until then it cannot be cut into a study clip.
              This section exists because separating the Film Study read hid
              teaching footage from the only screen that had a Release control,
              and the footage then sat here forever with nothing to see. */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">Stage two</p>
            <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Held teaching footage</h2>
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              Footage starts held while it is screened. Most clears itself and moves on; what appears here is what
              the screen could not settle on its own, and it stays held until a person opens it for review and
              releases it. Nothing can be labelled, and nothing counts as evidence, until then. You release what you
              filmed; an administrator can release anyone&rsquo;s.
            </p>

            {heldError ? (
              <div role="alert" className="alert alert--warning mt-[var(--s4)]">
                <span className="alert-icon" aria-hidden="true">&#9650;</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{heldError}</p>
                </div>
              </div>
            ) : null}

            {/*
                THREE STATES, AND THE ORDER OF THE TESTS IS THE POINT.
                Rows first: an error from a failed RELEASE or review-link must
                not take the queue off the screen, or "that footage could not be
                released" would be advice about a row that had just vanished.
                Then the error: a READ that did not come back is not an empty
                queue, so the empty state is suppressed rather than merely
                accompanied by the alert. "Nothing is waiting" under a failed
                read tells a coach the footage they uploaded is gone -- and this
                queue exists precisely to stop uploads disappearing silently.
                Same wrong claim the coverage read above refuses to make by
                falling back to zeros.
            */}
            {!heldLoaded ? (
              <p className="t-body mt-[var(--s3)]">Reading held footage&hellip;</p>
            ) : held.length === 0 ? (
              heldError ? null : (
                <p className="t-body mt-[var(--s3)]">
                  Nothing is waiting. Footage the content screen clears on its own never
                  appears here &mdash; only takes it could not decide about.
                </p>
              )
            ) : (
              <ul className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
                {held.map((item) => (
                  <li
                    key={item.video_session_id}
                    className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]"
                  >
                    <p className="t-data uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
                      {item.take_number === null ? 'Take not recorded' : `Take ${item.take_number}`}
                      {' · '}
                      {item.camera_view ?? 'View not described'}
                    </p>
                    <p className="t-body mt-[var(--s2)]">{item.file_name}</p>
                    {/* WHAT IS TRUE OF THIS ROW, not a verdict on the footage.
                        'blocked' and 'infected' are the two a person cannot
                        clear; everything else is waiting on somebody. */}
                    <p className="t-body mt-[var(--s2)]">
                      {/* THREE DIFFERENT OUTCOMES, AND THEY ARE NOT
                          INTERCHANGEABLE. 'infected' came from a real scanner
                          and no human may release it on any surface; 'blocked'
                          is a content-screen judgement an organization admin
                          can still review. Telling a coach to ask an
                          administrator about malware would send them after
                          something nobody can do. */}
                      {item.status === 'infected'
                        ? 'A scanner found malware in this file. It cannot be released by anyone.'
                        : item.refused_by_scan
                          ? 'The content screen refused this file. You cannot release it here — an administrator can review it.'
                          : item.releasable
                            ? 'Ready for you to open and release.'
                            : 'Still waiting on its content scan.'}
                    </p>
                    {item.releasable ? (
                      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                        <button
                          type="button"
                          className="btn btn--ghost"
                          disabled={busyVideoId === item.video_session_id}
                          onClick={() => { void openForReview(item.video_session_id); }}
                        >
                          Open for review
                        </button>
                        <button
                          type="button"
                          className="btn"
                          disabled={!openedForReview.has(item.video_session_id) || busyVideoId === item.video_session_id}
                          onClick={() => { void releaseHeld(item.video_session_id); }}
                        >
                          Release
                        </button>
                      </div>
                    ) : null}
                    {/* SAYS WHAT THE SERVER ACTUALLY REQUIRES. It can tell that
                        a review link was issued to this person for this file;
                        it cannot tell that anybody watched, because the browser
                        fetches the footage straight from storage. The wording
                        never claims otherwise. */}
                    {item.releasable && !openedForReview.has(item.video_session_id) ? (
                      <p className="t-body mt-[var(--s2)]">
                        Open this footage for review before Release becomes available.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* STAGE THREE: CUT. Between release and label because that is the
              order of the work, and because its absence is what broke the
              loop -- footage could be filmed and clips could be labelled, and
              nothing a coach could do joined the two. Cutting was an operator
              script run by hand against a production connection string. */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">Stage three</p>
            <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Cut study clips</h2>
            <p className="t-body mt-[var(--s2)]">
              Watch a released take, find the moment worth labelling, and cut it into a few seconds
              with a code two coaches can say out loud. A clip is the unit everything after this
              measures: two coaches label the same one separately, and where they disagree is the
              finding. Nothing cut here scores an athlete.
            </p>
            <Link href="/teach-shadow/cut" className="btn mt-[var(--s4)] inline-block">
              Cut Study Clips
            </Link>
          </section>

          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">Stage four</p>
            <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Label &amp; verify</h2>
            <p className="t-body mt-[var(--s2)]">
              Label what you saw in a study clip, from the fixed vocabulary. Two coaches label the same clip
              separately and neither sees the other&rsquo;s answers, so disagreement can be measured rather than
              averaged away. Nothing recorded there scores an athlete.
            </p>
            <Link href="/teach-shadow/annotation" className="btn mt-[var(--s4)] inline-block">
              Clip Annotation
            </Link>
          </section>

          {/* STAGE FIVE: MEASURE. The step the loop named and had no screen
              for: once two coaches have labelled the same clips, where they
              differed is the finding. */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">Stage five</p>
            <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Measure</h2>
            <p className="t-body mt-[var(--s2)]">
              See where two coaches labelled the same clip differently. It measures the labelling,
              not a coach and not an athlete.
            </p>
            <Link href="/teach-shadow/agreement" className="btn mt-[var(--s4)] inline-block">
              Label Agreement
            </Link>
          </section>

          {/* 4. CORPUS COVERAGE */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Corpus coverage</h2>
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              Counts of evidence that exists. No readiness score and no percentage: a single number over these
              would need a denominator nobody has set, and inventing one would make the corpus look finished.
              Hours of footage is absent on purpose &mdash; the platform stores no duration, so any figure would be
              made up.
            </p>
            {coverage ? (
              /*
                 ONE FACT PER LINE, because the sentence that reads better is
                 the one that overclaims. "37 files across 19 takes" says the
                 files span the takes; a take where every upload failed holds
                 none, and the sentence would be describing footage that is not
                 there. Each count below is a count of exactly one thing.
              */
              <dl className="mt-[var(--s4)] grid gap-[var(--s3)] sm:grid-cols-2">
                <div>
                  <dt className="t-eyebrow">Files captured</dt>
                  <dd className="t-body">{coverage.capture.captured_files}</dd>
                </div>
                <div>
                  <dt className="t-eyebrow">Takes recorded</dt>
                  <dd className="t-body">
                    {coverage.capture.capture_takes} in {coverage.capture.recording_sessions} session
                    {coverage.capture.recording_sessions === 1 ? '' : 's'}
                  </dd>
                </div>
                <div>
                  {/* Files, not cameras. The platform knows how many uploads
                      arrived against a take; it does not know how many phones
                      were in the room. */}
                  <dt className="t-eyebrow">Takes with more than one file</dt>
                  <dd className="t-body">{coverage.capture.takes_with_multiple_files}</dd>
                </div>
                <div>
                  <dt className="t-eyebrow">Clips cut for labelling</dt>
                  <dd className="t-body">{coverage.labelling.clips_cut}</dd>
                </div>
                <div>
                  <dt className="t-eyebrow">Annotation sets submitted</dt>
                  <dd className="t-body">{coverage.labelling.submitted_sets}</dd>
                </div>
                <div>
                  {/* The only clips agreement can be measured on: one coach
                      labelling alone produces no disagreement to measure. */}
                  <dt className="t-eyebrow">Clips with two submitted sets</dt>
                  <dd className="t-body">{coverage.labelling.clips_with_two_submitted_sets}</dd>
                </div>
                <div>
                  <dt className="t-eyebrow">Adjudications settled</dt>
                  <dd className="t-body">{coverage.labelling.adjudications}</dd>
                </div>
                <div>
                  {/* PROMOTED, not nominated. A record defaults to candidate
                      and can be deliberately excluded, so counting every row
                      would report excluded records as part of the reference
                      set -- the opposite of why somebody excluded them. */}
                  <dt className="t-eyebrow">Gold records promoted</dt>
                  <dd className="t-body">
                    {coverage.labelling.gold_records}
                    {coverage.labelling.gold_candidates > 0
                      ? `, with ${coverage.labelling.gold_candidates} still a candidate`
                      : ''}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="t-body mt-[var(--s3)]">{loaded ? 'No coverage figures are available.' : 'Reading the corpus…'}</p>
            )}
          </section>

          {/* 5. VOCABULARY */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Current vocabulary</h2>
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              The only terms anything may be labelled with. One canonical list, and only an administrator changes
              it. A term being in the list says it is nameable, not that Shadow has been taught it &mdash; the
              counts above say how much evidence stands behind each one.
            </p>
            {coverage ? (
              <>
                <p className="t-data mt-[var(--s3)] uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
                  {coverage.ontology_version}
                </p>
                <div className="mt-[var(--s3)] grid gap-[var(--s4)] sm:grid-cols-2">
                  <div>
                    <h3 className="t-eyebrow">Punches</h3>
                    <ul className="mt-[var(--s2)] flex flex-col gap-[var(--s1)]">
                      {coverage.vocabulary.punch_types.map((term) => (
                        <li key={term} className="t-body">{readable(term)}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h3 className="t-eyebrow">Defense</h3>
                    <ul className="mt-[var(--s2)] flex flex-col gap-[var(--s1)]">
                      {coverage.defense_evidence.map((cell) => (
                        <li key={cell.defense_type} className="t-body">
                          {readable(cell.defense_type)}
                          {' '}&middot;{' '}
                          {cell.events === 0 ? 'no labelled examples' : `${cell.events} labelled`}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            ) : null}
          </section>

          {/* 6. MODEL PERFORMANCE */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Model performance</h2>
            {/* SAID IN WORDS, WITH NO DIAL BESIDE IT. A gauge at zero, a greyed
                meter or an "0%" would all read as "measured, and bad" instead
                of "not measured", and a coach who saw one would conclude the
                recognizer had been tried and had failed. */}
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              No evaluated recognition model yet. Nothing has been trained on this corpus and nothing has been
              measured against held-out footage, so there is no accuracy, no confidence and no score to show. When
              there is one, it will be reported per punch, per stance and per camera position rather than as a
              single number &mdash; one overall figure can hide a recognizer that fails completely on southpaws.
            </p>
          </section>

          {/* 7. FOOTAGE IN THE CORPUS.
              The inventory behind the counts above, and the only place footage
              can be taken back out. Housekeeping rather than a stage of the
              teaching loop, so it sits after the figures rather than inside
              them. Before this existed, released teaching footage appeared on
              no screen at all: the held queue reads quarantined rows only, the
              Film Study list refuses take-backed ones, and coverage counted
              this footage without naming it. The first unwanted capture was
              therefore unremovable through the app. */}
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <h2 className="t-command" style={{ fontSize: 'var(--t-lg)' }}>Footage in the corpus</h2>
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              Every released take, and what has been cut and labelled from it. Archiving one withdraws it: it stops
              being playable, stops being clippable, and its clips and labels stop counting in the figures above.
              Nothing is deleted &mdash; the file stays in storage and the decision can be undone here.
              You archive what you filmed; an administrator can archive anyone&rsquo;s.
            </p>

            {releasedError ? (
              <div role="alert" className="alert alert--warning mt-[var(--s4)]">
                <span className="alert-icon" aria-hidden="true">&#9650;</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{releasedError}</p>
                </div>
              </div>
            ) : null}

            {/*
                THREE STATES, AND THE ORDER OF THE TESTS IS THE POINT.
                Rows first: an error from a failed ARCHIVE must not take the
                footage off the screen, or the refusal "reload and check before
                deciding again" would be advice about a list that had just
                disappeared.
                Then the error: a READ that did not come back is not an empty
                corpus, so the empty state is suppressed rather than merely
                accompanied by the alert. "Nothing released yet" under a failed
                read tells a coach their footage has vanished -- the same wrong
                claim the coverage read refuses to make by falling back to
                zeros.
            */}
            {!releasedLoaded ? (
              <p className="t-body mt-[var(--s3)]">Reading released footage&hellip;</p>
            ) : released.length === 0 ? (
              releasedError ? null : (
                <p className="t-body mt-[var(--s3)]">
                  Nothing released yet. Footage appears here once it has cleared the content screen or
                  been released by hand.
                </p>
              )
            ) : (
              <ul className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
                {released.map((item) => (
                  <li
                    key={item.video_session_id}
                    className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]"
                  >
                    <p className="t-data uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
                      {item.take_number === null ? 'Take not recorded' : `Take ${item.take_number}`}
                      {' · '}
                      {item.camera_view ?? 'View not described'}
                      {item.archived ? ' · Archived' : null}
                    </p>
                    <p className="t-body mt-[var(--s2)]">{item.file_name}</p>
                    {/* WHAT ARCHIVING THIS ROW WOULD COST, stated before the
                        button rather than discovered from a coverage figure
                        that dropped afterwards. Labelled clips are called out
                        separately from clips cut because they represent two
                        coaches' finished work, not just a cut. */}
                    <p className="t-body mt-[var(--s2)]">
                      {item.clips_cut === 0
                        ? 'No study clips cut from this yet.'
                        : item.clips_labelled === 0
                          ? `${item.clips_cut} study ${item.clips_cut === 1 ? 'clip' : 'clips'} cut, none labelled yet.`
                          : `${item.clips_cut} study ${item.clips_cut === 1 ? 'clip' : 'clips'} cut, ${item.clips_labelled} labelled.`}
                    </p>
                    {item.archived ? (
                      <p className="t-body mt-[var(--s2)]">
                        Withdrawn from the corpus. It cannot be played, clipped or labelled, and nothing
                        cut from it counts as evidence.
                        {item.archive_reason ? ` Reason given: ${item.archive_reason}` : null}
                      </p>
                    ) : null}
                    {archivingId === item.video_session_id ? (
                      /* THE PROMPT, IN PLACE OF THE BUTTON rather than beside
                         it. A reason box that sat on every row would be noise
                         on a list nobody is archiving from, and would be left
                         empty by everybody who is. Here it is the only thing
                         to look at, on the row already being acted on.

                         A FORM, so Enter submits. Somebody typing a sentence
                         should not have to reach for the mouse to finish. */
                      <form
                        className="mt-[var(--s3)]"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void setArchived(item.video_session_id, 'archive', archiveReason);
                        }}
                      >
                        <label className="t-eyebrow block" htmlFor={`archive-reason-${item.video_session_id}`}>
                          Why is this being withdrawn? (optional)
                        </label>
                        <input
                          id={`archive-reason-${item.video_session_id}`}
                          className="input mt-[var(--s2)]"
                          type="text"
                          maxLength={2000}
                          autoFocus
                          placeholder="Bad take, wrong subject, test footage&hellip;"
                          value={archiveReason}
                          onChange={(event) => { setArchiveReason(event.target.value); }}
                          disabled={busyVideoId === item.video_session_id}
                        />
                        <p className="t-body mt-[var(--s2)]">
                          Whatever you write here stays on the footage, so the next person to wonder where
                          it went can read it without asking anybody.
                        </p>
                        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                          <button
                            type="submit"
                            className="btn"
                            disabled={busyVideoId === item.video_session_id}
                          >
                            Archive
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busyVideoId === item.video_session_id}
                            onClick={() => { setArchivingId(''); setArchiveReason(''); }}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    ) : (
                      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                        <button
                          type="button"
                          className={item.archived ? 'btn' : 'btn btn--ghost'}
                          disabled={busyVideoId === item.video_session_id}
                          onClick={() => {
                            if (item.archived) {
                              // Restore takes no reason: an undo needs no
                              // justification, and a form in front of one is
                              // friction pointing the wrong way.
                              void setArchived(item.video_session_id, 'restore');
                              return;
                            }
                            setReleasedError('');
                            setArchiveReason('');
                            setArchivingId(item.video_session_id);
                          }}
                        >
                          {item.archived ? 'Restore to the corpus' : 'Archive'}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
