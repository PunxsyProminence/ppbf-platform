"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { useCameraRecorder } from '@/components/useCameraRecorder';
import { apiBase } from '@/lib/apiBase';
import { CAPTURE_MAX_BLOB_BYTES } from '@/lib/capturePolicy';

/*
 * TEACH SHADOW: the capture surface.
 *
 * ITS OWN DOCUMENT, NOT A MODAL, and that is forced by the platform rather
 * than chosen for layout. Permissions-Policy is a per-response header, so a
 * page served with camera=() can never open a camera however its buttons are
 * written. next.config.ts grants camera=(self) to this route and to the Film
 * Study recorder, and to nothing else. Moving this UI onto another page would
 * silently break it.
 *
 * WHAT IT IS FOR: several coaches, each on their own phone, filming the same
 * punch from different positions. They coordinate out loud, as they already
 * would. The platform's job is only to remember that the separate files are
 * views of one attempt.
 *
 * WHY IT IS NOT UNDER /coach/. It used to be, at /coach/video-analysis/
 * capture, which put machine teaching inside Film Study's route hierarchy and
 * made one journey look like two halves of another. The owner's ruling is that
 * the two never mix: what is recorded here becomes evidence for teaching the
 * recognizer and CANNOT be moved into Film Study, and what is recorded in Film
 * Study cannot be moved here. There is no promotion path in either direction,
 * which is exactly why the destination is stated above the controls -- the
 * decision has to be made before the bytes exist, not regretted afterwards.
 */

/*
 * ONLY THE CONTEXTS WITH ONE PERSON IN FRAME, and the server refuses the rest
 * independently rather than trusting this list.
 *
 * A capture names one athlete and the scan sweep checks consent for exactly
 * that athlete. Filming sparring would put a second person in frame whom the
 * row never names and nothing ever asks about -- the same defect as an
 * unattributed recording, narrowed from "nobody named" to "one of two". Mitts
 * has a second person for the same reason, and 'other' bounds nothing so it
 * cannot promise a single subject.
 *
 * These come back when a participant model can name everyone in a take.
 */
const TRAINING_CONTEXTS: Array<{ value: string; label: string }> = [
  { value: 'shadowboxing', label: 'Shadowboxing' },
  { value: 'heavy_bag', label: 'Heavy bag' },
];

interface TakeFile {
  videoSessionId: string;
  cameraView: string | null;
  uploadedByAccountId: string;
  status: string;
}

interface CurrentTake {
  capture_take_id: string;
  take_number: number;
  state: string;
  files: TakeFile[];
}

interface SessionState {
  recording_session_id: string;
  join_code: string;
  training_context: string;
  state: string;
  current_take: CurrentTake | null;
}

/**
 * Everything about a recording that is settled when RECORD is pressed.
 *
 * Not just the take. cameraView is here for the same reason: a coach who
 * repositions the phone mid-rep and retypes the field, or types ahead for the
 * next angle, would otherwise have this recording filed under the viewpoint
 * that was in the box when they pressed STOP. The description belongs to the
 * footage that was actually shot.
 */
interface TakeContext {
  captureTakeId: string;
  athleteId: string;
  cameraView: string;
}

export default function TeachShadowCapturePage() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [trainingContext, setTrainingContext] = useState('shadowboxing');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [cameraView, setCameraView] = useState('');
  const [athletes, setAthletes] = useState<Array<{ athlete_id: string; full_name: string }>>([]);
  const [athleteId, setAthleteId] = useState('');
  const [busy, setBusy] = useState(false);
  /*
   * A CHOSEN FILE CAN BE 45 MB ON GYM WIFI. Without this the only sign
   * anything is happening is every control greying out at once, which reads as
   * the page having broken rather than as an upload in flight -- and a coach
   * who concludes that presses the button again.
   */
  const [attaching, setAttaching] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (recordingSessionId: string) => {
    const response = await fetch(
      `${apiBase()}/api/pilot/video/capture-session?recording_session_id=${encodeURIComponent(recordingSessionId)}`,
      { credentials: 'include' },
    );
    const payload = (await response.json().catch(() => ({}))) as { session?: SessionState; error?: string };
    if (!response.ok) throw new Error(payload.error || 'Unable to read the recording session.');
    if (payload.session) setSession(payload.session);
  }, []);

  /*
   * THE TEACH SHADOW UPLOAD ALWAYS CARRIES A TAKE. That is the whole
   * difference from the Film Study recorder, which sends none: a take is what
   * groups the angles of one attempt and what makes this footage part of the
   * recognition corpus at all. Sharing the camera machinery with Film Study is
   * fine; sharing this would erase the separation.
   */
  const recorder = useCameraRecorder<TakeContext>({
    unsupportedFormatMessage:
      'This browser cannot record a format the platform accepts. Use "Add an angle from a file" to attach one to this take instead.',
    onRecorded: async (file, { recordedAt, context }) => {
      const form = new FormData();
      form.append('file', file);
      form.append('capture_take_id', context.captureTakeId);
      form.append('athlete_id', context.athleteId);
      form.append('capture_source', 'in_app_recording');
      if (context.cameraView) form.append('camera_view', context.cameraView);
      form.append('recorded_at', recordedAt);

      const response = await fetch(`${apiBase()}/api/pilot/video/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'The recording could not be uploaded.');

      if (session) await refresh(session.recording_session_id);
    },
  });

  // Destructured rather than read through `recorder.` at each use: the hook
  // hands back a ref among its values, and the lint rule reads a member
  // access on that object as touching a ref during render.
  const { phase, errorMessage, setErrorMessage, videoRef, recordedBytes, stoppedAtLimit, stop } = recorder;

  /*
   * The roster, because a capture MUST name the athlete it is of. That is not
   * a form nicety: the scan sweep only asks for guardian consent when a video
   * carries an athlete_id, so an unattributed recording of a minor would reach
   * the vision screen with that check skipped. The server refuses it too.
   */
  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
        const payload = (await response.json().catch(() => ({}))) as {
          items?: Array<{ athlete_id: string; full_name: string }>;
        };
        setAthletes(payload.items ?? []);
      } catch {
        setErrorMessage('The athlete list could not be loaded, so recording is unavailable.');
      }
    })();
  }, [setErrorMessage]);

  async function post(body: unknown): Promise<Record<string, unknown>> {
    const response = await fetch(`${apiBase()}/api/pilot/video/capture-session`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(payload.error || 'That did not work.');
    return payload as Record<string, unknown>;
  }

  /*
   * Polled while a session is open so each device sees the other angles
   * arriving against the current attempt. Polling rather than a live channel:
   * this is a handful of coaches for a few minutes, and the honest measure of
   * whether the grouping worked is what the server says, not what this tab
   * believes it uploaded.
   */
  useEffect(() => {
    if (!session || session.state !== 'open') return;
    const id = setInterval(() => {
      void refresh(session.recording_session_id).catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [session, refresh]);

  async function guarded(work: () => Promise<void>) {
    setBusy(true);
    setErrorMessage('');
    try {
      await work();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  function record() {
    const currentTake = session?.current_take;
    if (!currentTake) {
      setErrorMessage('Start or join a recording session first.');
      return;
    }
    if (!athleteId) {
      setErrorMessage('Choose which athlete this is of before recording.');
      return;
    }
    void recorder.start({
      captureTakeId: currentTake.capture_take_id,
      athleteId,
      cameraView: cameraView.trim(),
    });
  }

  /*
   * An angle that was shot outside this page. It carries the SAME take, so it
   * groups with the recorded angles -- and it declares capture_source
   * 'file_upload', because calling a file this app never recorded an
   * in-app recording would be a false provenance claim.
   */
  async function uploadExistingFile(chosen: File, captureTakeId: string) {
    setErrorMessage('');
    setAttaching(true);
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', chosen);
      form.append('capture_take_id', captureTakeId);
      form.append('athlete_id', athleteId);
      form.append('capture_source', 'file_upload');
      if (cameraView.trim()) form.append('camera_view', cameraView.trim());

      const response = await fetch(`${apiBase()}/api/pilot/video/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'That file could not be added to this take.');
      if (session) await refresh(session.recording_session_id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'That file could not be added to this take.');
    } finally {
      setAttaching(false);
      setBusy(false);
    }
  }

  const take = session?.current_take ?? null;
  const megabytes = (recordedBytes / (1024 * 1024)).toFixed(1);
  const limitMb = Math.round(CAPTURE_MAX_BLOB_BYTES / (1024 * 1024));

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      {/* No room modifier class here. Rooms were retired as a VISUAL concept
          by owner decision: buildingMap.ts still files this door under a room
          as structural metadata, but a screen is no longer required to paint
          it, and legacyVisualVocabulary.test.ts caps that retired vocabulary
          so it cannot grow back through new work like this. The cap counts
          string occurrences anywhere in the file, comments included, which is
          why this note does not spell the class out. */}
      <main className="min-h-screen">
        <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-wood rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Teach Shadow</p>
            <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
              Capture Examples
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Short teaching captures. Recording stops itself at {limitMb} MB, which is a deliberate margin under
              the upload limit rather than the limit itself, so a take is never lost to a refused upload. Several
              coaches can film the same punch from different positions: one starts a session, the others join it
              with the code, and every phone records its own angle.
            </p>
          </header>

          {/* WHERE THIS FOOTAGE GOES, SAID BEFORE ANY CONTROL APPEARS. There
              is no promotion path in either direction, so the choice has to be
              made before the bytes exist. The failure this prevents is a coach
              filming a genuinely useful teaching sequence on the wrong surface
              and only realising afterwards, when moving it is forbidden. */}
          {/* ON A MATERIAL GROUND, not bare on the page. `.t-body` resolves
              to a light ink (var(--bone-200)) meant for the dark panels the
              rest of this screen is built from; the sheet only darkens it
              under `.on-canvas` and `.mat-paper`. Standing alone on the page
              background it was cream on cream -- unreadable, on the one
              paragraph the owner made an acceptance requirement. */}
          <div className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s4)]">
            <p role="note" className="t-body">
            For teaching Shadow. Media recorded here belongs to the recognition-teaching workflow, not Film Study.
            </p>
          </div>

          {errorMessage ? (
            <div role="alert" className="alert alert--warning mt-[var(--s5)]">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          ) : null}

          {!session ? (
            <section className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
              <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
                <h2 className="t-eyebrow">Start a session</h2>
                <label className="t-eyebrow mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
                  What is being filmed
                  <select className="input" value={trainingContext} onChange={(e) => setTrainingContext(e.target.value)}>
                    {TRAINING_CONTEXTS.map((context) => (
                      <option key={context.value} value={context.value}>{context.label}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="btn mt-[var(--s4)]"
                  disabled={busy}
                  onClick={() => guarded(async () => {
                    const payload = await post({ action: 'create', training_context: trainingContext });
                    setSession(payload.session as SessionState);
                  })}
                >
                  Start recording session
                </button>
              </div>

              <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
                <h2 className="t-eyebrow">Join a session</h2>
                {/* The code says WHICH session, never that this device may
                    join it -- the server checks the signed-in coach and the
                    organization independently. */}
                <p className="t-body mt-[var(--s2)]">
                  Enter the code shown on the phone that started the session. You still need to be signed in.
                </p>
                <label className="t-eyebrow mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
                  Join code
                  <input
                    className="input"
                    value={joinCodeInput}
                    onChange={(e) => setJoinCodeInput(e.target.value)}
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <button
                  type="button"
                  className="btn mt-[var(--s4)]"
                  disabled={busy || !joinCodeInput.trim()}
                  onClick={() => guarded(async () => {
                    const payload = await post({ action: 'join', join_code: joinCodeInput });
                    setSession(payload.session as SessionState);
                  })}
                >
                  Join session
                </button>
              </div>
            </section>
          ) : (
            <section className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
              <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
                <p className="t-eyebrow">Join code</p>
                <p className="t-gothic text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)', letterSpacing: '0.18em' }}>
                  {session.join_code}
                </p>
                <p className="t-body mt-[var(--s2)]">
                  Take {take?.take_number ?? '—'} · {session.training_context.replace('_', ' ')}
                </p>
              </div>

              <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
                {/* REQUIRED, and the server refuses without it. An
                    unattributed recording would reach the vision content
                    screen with the guardian-consent check skipped, because
                    that check only runs for a video that names an athlete. */}
                <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
                  Which athlete is this of
                  <select className="input" value={athleteId} onChange={(e) => setAthleteId(e.target.value)}>
                    <option value="">Choose an athlete…</option>
                    {athletes.map((athlete) => (
                      <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                    ))}
                  </select>
                </label>

                <label className="t-eyebrow mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
                  This camera&rsquo;s view (optional)
                  {/* Free text and allowed to stay empty. Only a human in the
                      gym can say "side on, southpaw side"; the browser knows
                      which lens it used and nothing about where it was aimed. */}
                  <input
                    className="input"
                    value={cameraView}
                    onChange={(e) => setCameraView(e.target.value)}
                    placeholder="front, side, behind"
                  />
                </label>

                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="mt-[var(--s4)] w-full rounded-[var(--r-md)] bg-[color:var(--hide-900)]"
                  style={{ aspectRatio: '16 / 9' }}
                />

                {phase === 'recording' ? (
                  <p role="status" className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">
                    Recording · {megabytes} MB of {limitMb} MB
                  </p>
                ) : null}
                {attaching ? (
                  <p role="status" className="t-body mt-[var(--s3)]">
                    Adding that file to this take&hellip; large files take a while on gym wifi.
                  </p>
                ) : null}
                {stoppedAtLimit && phase !== 'recording' ? (
                  <p role="status" className="t-body mt-[var(--s3)]">
                    Recording stopped at the {limitMb} MB limit and is being kept. Start the next take to carry on.
                  </p>
                ) : null}

                <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                  {phase === 'recording' ? (
                    <button type="button" className="btn" onClick={stop}>Stop</button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={phase !== 'idle' || busy || !take}
                      onClick={record}
                    >
                      {phase === 'uploading' ? 'Uploading…' : phase === 'starting' ? 'Opening camera…' : 'Record Example for Shadow'}
                    </button>
                  )}
                  {/* THE SAME TAKE, FROM A FILE. A browser whose recorder
                      this platform cannot use still has a camera app, and an
                      angle shot outside the page is still an angle of this
                      attempt. Previously the only advice was to go back to the
                      ordinary uploader, which sends no take and would have
                      silently produced an ungrouped video. */}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={phase !== 'idle' || busy || !take || !athleteId}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {attaching ? 'Adding…' : 'Add an angle from a file'}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="video/*"
                    className="hidden"
                    onChange={(event) => {
                      const chosen = event.target.files?.[0];
                      event.target.value = '';
                      if (chosen && take) void uploadExistingFile(chosen, take.capture_take_id);
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy || phase !== 'idle'}
                    onClick={() => guarded(async () => {
                      const payload = await post({ action: 'advance_take', recording_session_id: session.recording_session_id });
                      setSession(payload.session as SessionState);
                      recorder.dismissLimitNotice();
                    })}
                  >
                    Next take
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy || phase !== 'idle'}
                    onClick={() => guarded(async () => {
                      await post({ action: 'close', recording_session_id: session.recording_session_id });
                      setSession(null);
                    })}
                  >
                    Finish session
                  </button>
                </div>
              </div>

              <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
                <h2 className="t-eyebrow">Angles on this take</h2>
                {take && take.files.length > 0 ? (
                  <ul className="mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
                    {take.files.map((takeFile) => (
                      <li key={takeFile.videoSessionId} className="t-body">
                        {takeFile.cameraView ?? 'View not described'} · {takeFile.status}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="t-body mt-[var(--s2)]">
                    Nothing recorded against this take yet. Angles from other phones appear here as they upload.
                  </p>
                )}
              </div>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            {/* Leaving by anchor: a soft navigation would carry
                camera=(self) onto the home page, which was never granted
                it, for as long as the tab lives. */}
            <a href="/teach-shadow" className="btn btn--ghost">Back to Teach Shadow</a>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
