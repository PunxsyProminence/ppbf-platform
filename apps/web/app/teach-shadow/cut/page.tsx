"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import {
  formatDurationMs,
  formatMediaOffset,
  mediaSecondsFromMs,
  msFromMediaSeconds,
  STEP_MS,
} from '@/src/lib/clipTime';
import { CLIP_SAMPLING_REASONS } from '@/src/server/pilot/calibration/ontology';

/*
 * CUT A STUDY CLIP.
 *
 * THE STEP THE LOOP WAS MISSING. Teach Shadow's home page describes the work
 * as: find the thinnest area, film it, label it, measure, go again. Every one
 * of those had a screen except this one. Turning footage into clips was
 * `scripts/pilot-bootstrap-calibration-clip.ts`, run by hand with a production
 * connection string -- so a coach could film, and could open the labelling
 * page, and nothing they were able to do joined the two.
 *
 * AND THE FOOTAGE COULD NOT BE WATCHED AT ALL. Two rules landed a day apart:
 * only take-backed footage may be cut into a clip (2026-09-24), and the Film
 * Study video route refuses take-backed footage (2026-09-25). Each was right;
 * together they meant every clip that could legally exist had a source the
 * only playback route 404'd. This page plays footage through
 * /api/pilot/teach-shadow/footage/[videoId]/stream, teaching's own door, gated
 * by assertVideoClippable -- the same question the cut itself asks.
 *
 * NO ATHLETE NAME APPEARS HERE. Teaching media names nobody (TS-ANON-01), so
 * footage is identified by take, camera view and file name, exactly as the
 * held queue and the released list identify it.
 *
 * MILLISECONDS, NEVER FRAMES. The platform stores no frame rate and the
 * browser exposes no reliable frame index, so no control here is labelled with
 * a frame number and the step ladder is round milliseconds a person can reason
 * about. src/lib/clipTime.ts has the long version.
 */

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
}

interface CalibrationProject {
  calibration_project_id: string;
  name: string;
  ontology_version: string;
  status: string;
}

function readable(term: string): string {
  const words = term.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export default function CutStudyClipPage() {
  const [footage, setFootage] = useState<ReleasedFootage[]>([]);
  const [projects, setProjects] = useState<CalibrationProject[]>([]);
  const [supportedOntology, setSupportedOntology] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [projectId, setProjectId] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [videoSessionId, setVideoSessionId] = useState('');
  const [streamUrl, setStreamUrl] = useState('');
  const [streamNotice, setStreamNotice] = useState('');

  const [currentMs, setCurrentMs] = useState(0);
  const [startMs, setStartMs] = useState<number | null>(null);
  const [endMs, setEndMs] = useState<number | null>(null);
  const [clipCode, setClipCode] = useState('');
  const [samplingReason, setSamplingReason] = useState<string>(CLIP_SAMPLING_REASONS[0]);

  const videoRef = useRef<HTMLVideoElement>(null);

  const loadLists = useCallback(async () => {
    try {
      const [footageResponse, projectsResponse] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/teach-shadow/released`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/calibration/projects`, { credentials: 'include' }),
      ]);

      const footagePayload = (await footageResponse.json().catch(() => ({}))) as {
        items?: ReleasedFootage[]; error?: string;
      };
      const projectsPayload = (await projectsResponse.json().catch(() => ({}))) as {
        projects?: CalibrationProject[]; supported_ontology_version?: string; error?: string;
      };

      if (!footageResponse.ok) throw new Error(footagePayload.error || 'Released footage could not be read.');
      if (!projectsResponse.ok) throw new Error(projectsPayload.error || 'The studies could not be read.');
      /*
       * A MISSING PAYLOAD IS AN ERROR, NOT AN EMPTY GYM. Falling back to []
       * would tell a coach they have filmed nothing, which is a specific and
       * wrong claim about their work -- the same rule the coverage read holds.
       */
      if (!footagePayload.items || !projectsPayload.projects) {
        throw new Error('This page could not be loaded.');
      }

      // Archived footage is withdrawn from the corpus, so it cannot be cut.
      // Filtered here rather than shown greyed out: this is a picker, and an
      // option that can only be refused is not an option.
      setFootage(footagePayload.items.filter((item) => !item.archived));
      setProjects(projectsPayload.projects);
      setSupportedOntology(projectsPayload.supported_ontology_version ?? '');
      setError('');
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'This page could not be loaded.');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void (async () => { await loadLists(); })();
  }, [loadLists]);

  /*
   * TEACHING FOOTAGE HAS ITS OWN PLAYBACK DOOR, and this page must never
   * borrow the safeguarding review link to get a stream: that exists so a
   * designated reviewer can look at QUARANTINED footage to decide about it,
   * and using it here would turn a narrow exception into a general way to
   * watch unscanned video. Same rule the annotation page states for itself.
   */
  const loadStream = useCallback(async (nextVideoSessionId: string) => {
    setStreamNotice('');
    setStreamUrl('');
    const response = await fetch(
      `${apiBase()}/api/pilot/teach-shadow/footage/${encodeURIComponent(nextVideoSessionId)}/stream`,
      { credentials: 'include', cache: 'no-store' },
    );
    const payload = (await response.json().catch(() => ({}))) as { stream_url?: string; error?: string };
    if (!response.ok) {
      setStreamNotice(payload.error || 'That footage could not be opened.');
      return;
    }
    setStreamUrl(payload.stream_url ?? '');
  }, []);

  function chooseFootage(nextVideoSessionId: string) {
    setVideoSessionId(nextVideoSessionId);
    // In and out belong to the footage they were marked against. Carrying them
    // to a different take would offer a span that means nothing there.
    setStartMs(null);
    setEndMs(null);
    setCurrentMs(0);
    setNotice('');
    void loadStream(nextVideoSessionId);
  }

  function seekBy(deltaMs: number) {
    const element = videoRef.current;
    if (!element) return;
    const target = Math.max(0, msFromMediaSeconds(element.currentTime) + deltaMs);
    element.currentTime = mediaSecondsFromMs(target);
    setCurrentMs(target);
  }

  async function startStudy() {
    const name = newProjectName.trim();
    if (!name) {
      setError('A study needs a name people can find it by.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/projects`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        project?: CalibrationProject; error?: string;
      };
      if (!response.ok) throw new Error(payload.error || 'That study could not be started.');
      await loadLists();
      if (payload.project) setProjectId(payload.project.calibration_project_id);
      setNewProjectName('');
      setNotice(`Study "${name}" started. Clips you cut now go into it.`);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'That study could not be started.');
    } finally {
      setBusy(false);
    }
  }

  async function cutClip() {
    if (!projectId || !videoSessionId || startMs === null || endMs === null) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/clips`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          calibration_project_id: projectId,
          video_session_id: videoSessionId,
          clip_code: clipCode.trim(),
          start_ms: startMs,
          end_ms: endMs,
          primary_sampling_reason: samplingReason,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'That clip could not be cut.');

      setNotice(
        `Clip "${clipCode.trim()}" cut, ${formatDurationMs(endMs - startMs)} long. `
        + 'It is in the study and ready to label.',
      );
      // The span and the code are cleared; the footage and the study are not,
      // because the next clip is nearly always from the same take.
      setStartMs(null);
      setEndMs(null);
      setClipCode('');
      // The clip counts on the footage list have changed.
      await loadLists();
    } catch (cutError) {
      setError(cutError instanceof Error ? cutError.message : 'That clip could not be cut.');
    } finally {
      setBusy(false);
    }
  }

  const spanIsUsable = startMs !== null && endMs !== null && endMs > startMs;
  const canCut = Boolean(projectId) && Boolean(videoSessionId) && spanIsUsable && clipCode.trim().length > 0;

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="mx-auto w-full max-w-5xl px-[var(--s4)] py-[var(--s5)]">
        <p className="t-eyebrow">Teach Shadow</p>
        <h1 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-2xl)' }}>Cut a study clip</h1>
        <p className="t-body mt-[var(--s3)] max-w-3xl">
          A study clip is a few seconds of footage that two coaches will label separately, so their
          disagreement can be measured. Pick the take, find the moment, mark where it starts and ends,
          and give it a code you can say out loud. Nothing here scores an athlete.
        </p>

        {error ? (
          <div role="alert" className="alert alert--warning mt-[var(--s4)]">
            <span className="alert-icon" aria-hidden="true">&#9650;</span>
            <div className="alert-body">
              <p className="alert-title">Attention</p>
              <p className="alert-msg">{error}</p>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div role="status" className="alert mt-[var(--s4)]">
            <div className="alert-body">
              <p className="alert-msg">{notice}</p>
            </div>
          </div>
        ) : null}

        {/* 1. THE STUDY. First because a clip cannot exist outside one, and
            because a coach asked to cut clips has usually been told which
            study to put them in. */}
        <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
          <p className="t-eyebrow">Step one</p>
          <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Which study</h2>
          <p className="t-body mt-[var(--s2)] max-w-3xl">
            A study groups the clips that get labelled together and measured against each other.
            Use the one you were asked to work on, or start a new one.
          </p>

          {!loaded ? (
            <p className="t-body mt-[var(--s3)]">Reading studies&hellip;</p>
          ) : (
            <>
              <label className="t-eyebrow mt-[var(--s4)] block" htmlFor="study">Study</label>
              <select
                id="study"
                className="input mt-[var(--s2)]"
                value={projectId}
                onChange={(event) => { setProjectId(event.target.value); }}
              >
                <option value="">Choose a study&hellip;</option>
                {projects.map((project) => (
                  <option
                    key={project.calibration_project_id}
                    value={project.calibration_project_id}
                    /* A study stamped with a vocabulary this build does not
                       implement cannot be labelled here, so it cannot honestly
                       be cut into either. */
                    disabled={Boolean(supportedOntology) && project.ontology_version !== supportedOntology}
                  >
                    {project.name}
                    {supportedOntology && project.ontology_version !== supportedOntology
                      ? ` — ${project.ontology_version}, which this page cannot label`
                      : ''}
                  </option>
                ))}
              </select>

              <div className="mt-[var(--s4)] flex flex-wrap items-end gap-[var(--s3)]">
                <div className="grow">
                  <label className="t-eyebrow block" htmlFor="new-study">Or start a new study</label>
                  <input
                    id="new-study"
                    className="input mt-[var(--s2)]"
                    type="text"
                    placeholder="Calibration round 2"
                    value={newProjectName}
                    onChange={(event) => { setNewProjectName(event.target.value); }}
                    disabled={busy}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={busy || newProjectName.trim().length === 0}
                  onClick={() => { void startStudy(); }}
                >
                  Start study
                </button>
              </div>
            </>
          )}
        </section>

        {/* 2. THE FOOTAGE. */}
        <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
          <p className="t-eyebrow">Step two</p>
          <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Which footage</h2>
          <p className="t-body mt-[var(--s2)] max-w-3xl">
            Released teaching footage only. Anything still held is waiting on its content screen, and
            anything archived has been withdrawn from the corpus &mdash; neither can be cut.
          </p>

          {!loaded ? (
            <p className="t-body mt-[var(--s3)]">Reading footage&hellip;</p>
          ) : footage.length === 0 ? (
            error ? null : (
              <p className="t-body mt-[var(--s3)]">
                Nothing to cut yet. Footage appears here once it has cleared the content screen or been
                released by hand.
              </p>
            )
          ) : (
            <ul className="mt-[var(--s4)] flex flex-col gap-[var(--s3)]">
              {footage.map((item) => (
                <li
                  key={item.video_session_id}
                  className="rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s4)]"
                >
                  <p className="t-data uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
                    {item.take_number === null ? 'Take not recorded' : `Take ${item.take_number}`}
                    {' · '}
                    {item.camera_view ?? 'View not described'}
                    {videoSessionId === item.video_session_id ? ' · Open' : ''}
                  </p>
                  <p className="t-body mt-[var(--s2)]">{item.file_name}</p>
                  <p className="t-body mt-[var(--s2)]">
                    {item.clips_cut === 0
                      ? 'No clips cut from this yet.'
                      : `${item.clips_cut} ${item.clips_cut === 1 ? 'clip' : 'clips'} already cut.`}
                  </p>
                  <div className="mt-[var(--s3)]">
                    <button
                      type="button"
                      className={videoSessionId === item.video_session_id ? 'btn' : 'btn btn--ghost'}
                      disabled={busy}
                      onClick={() => { chooseFootage(item.video_session_id); }}
                    >
                      {videoSessionId === item.video_session_id ? 'Open again' : 'Open this take'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* 3. THE CUT. */}
        {videoSessionId ? (
          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
            <p className="t-eyebrow">Step three</p>
            <h2 className="t-command mt-[var(--s2)]" style={{ fontSize: 'var(--t-lg)' }}>Mark the moment</h2>

            {streamNotice ? (
              <div role="alert" className="alert alert--warning mt-[var(--s4)]">
                <span className="alert-icon" aria-hidden="true">&#9650;</span>
                <div className="alert-body">
                  <p className="alert-title">Attention</p>
                  <p className="alert-msg">{streamNotice}</p>
                </div>
              </div>
            ) : null}

            {streamUrl ? (
              <video
                ref={videoRef}
                data-testid="cutter-player"
                className="mt-[var(--s3)] w-full max-h-[440px] rounded-[var(--r-sm)] bg-[var(--hide-950)]"
                src={streamUrl}
                preload="metadata"
                onTimeUpdate={(event) => {
                  setCurrentMs(msFromMediaSeconds(event.currentTarget.currentTime));
                }}
                onError={() => setStreamNotice(
                  'The footage stopped loading. Playback links last 60 minutes and this platform does '
                  + 'not refresh them, so an expired link is the usual reason. Open the take again to '
                  + 'carry on.',
                )}
              >
                <track kind="captions" />
              </video>
            ) : null}

            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.12em] text-[color:var(--brass-300)]">
              At {formatMediaOffset(currentMs)}
            </p>

            {/* NUDGE CONTROLS IN MILLISECONDS, never frames. See clipTime.ts. */}
            <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
              {[-STEP_MS.large, -STEP_MS.small, -STEP_MS.fine, STEP_MS.fine, STEP_MS.small, STEP_MS.large].map((step) => (
                <button
                  key={step}
                  type="button"
                  className="btn btn--ghost"
                  disabled={!streamUrl}
                  onClick={() => { seekBy(step); }}
                >
                  {step > 0 ? `+${step}ms` : `${step}ms`}
                </button>
              ))}
            </div>

            <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!streamUrl}
                onClick={() => { setStartMs(currentMs); }}
              >
                Mark start here
              </button>
              <button
                type="button"
                className="btn btn--ghost"
                disabled={!streamUrl}
                onClick={() => { setEndMs(currentMs); }}
              >
                Mark end here
              </button>
            </div>

            <p className="t-body mt-[var(--s3)]">
              {startMs === null ? 'Start not marked.' : `Starts at ${formatMediaOffset(startMs)}.`}
              {' '}
              {endMs === null ? 'End not marked.' : `Ends at ${formatMediaOffset(endMs)}.`}
              {/* SAID IN WORDS RATHER THAN DISABLING SILENTLY. A Cut button
                  that is simply dead tells somebody nothing about why. */}
              {startMs !== null && endMs !== null && endMs <= startMs
                ? ' The end must come after the start — mark them again.'
                : spanIsUsable
                  ? ` That is ${formatDurationMs(endMs! - startMs!)} of footage.`
                  : ''}
            </p>

            <div className="mt-[var(--s4)] grid gap-[var(--s4)] sm:grid-cols-2">
              <div>
                <label className="t-eyebrow block" htmlFor="clip-code">Clip code</label>
                <input
                  id="clip-code"
                  className="input mt-[var(--s2)]"
                  type="text"
                  placeholder="C-01"
                  value={clipCode}
                  onChange={(event) => { setClipCode(event.target.value); }}
                  disabled={busy}
                />
                <p className="t-body mt-[var(--s2)]">
                  How two coaches refer to this clip out loud. Unique within the study.
                </p>
              </div>
              <div>
                <label className="t-eyebrow block" htmlFor="sampling-reason">Why this moment</label>
                <select
                  id="sampling-reason"
                  className="input mt-[var(--s2)]"
                  value={samplingReason}
                  onChange={(event) => { setSamplingReason(event.target.value); }}
                  disabled={busy}
                >
                  {CLIP_SAMPLING_REASONS.map((reason) => (
                    <option key={reason} value={reason}>{readable(reason)}</option>
                  ))}
                </select>
                <p className="t-body mt-[var(--s2)]">
                  What made this worth labelling. It is how the corpus is shown to be sampled on purpose
                  rather than by whatever was easy to find.
                </p>
              </div>
            </div>

            <div className="mt-[var(--s4)]">
              <button
                type="button"
                className="btn"
                disabled={busy || !canCut}
                onClick={() => { void cutClip(); }}
              >
                Cut this clip
              </button>
            </div>
          </section>
        ) : null}

        <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
          <Link href="/teach-shadow" className="btn btn--ghost">Back to Teach Shadow</Link>
          <Link href="/teach-shadow/annotation" className="btn btn--ghost">Go and label</Link>
        </div>
      </main>
    </RoleSessionGate>
  );
}
