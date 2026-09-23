"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import {
  CAPTURE_CHUNK_MS,
  CAPTURE_MAX_BLOB_BYTES,
  CAPTURE_MIME_CANDIDATES,
  captureFileDescriptor,
} from '@/lib/capturePolicy';

/*
 * CAP-VID-01: the capture surface.
 *
 * ITS OWN DOCUMENT, NOT A MODAL, and that is forced by the platform rather
 * than chosen for layout. Permissions-Policy is a per-response header, so a
 * page served with camera=() can never open a camera however its buttons are
 * written. next.config.ts grants camera=(self) to THIS route alone; every
 * other page in the app stays closed. Moving this UI onto another page would
 * silently break it.
 *
 * WHAT IT IS FOR: several coaches, each on their own phone, filming the same
 * punch from different positions. They coordinate out loud, as they already
 * would. The platform's job is only to remember that the separate files are
 * views of one attempt.
 *
 * NO SHARED STREAM. No WebRTC, no central recorder, no clock synchronisation.
 * Each device records locally and uploads its own file. Aligning the actual
 * punches across angles is annotation work later, against the footage itself.
 */

const TRAINING_CONTEXTS: Array<{ value: string; label: string }> = [
  { value: 'shadowboxing', label: 'Shadowboxing' },
  { value: 'heavy_bag', label: 'Heavy bag' },
  { value: 'mitts', label: 'Mitts' },
  { value: 'sparring', label: 'Sparring' },
  { value: 'other', label: 'Other' },
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

type RecorderPhase = 'idle' | 'starting' | 'recording' | 'uploading';

export default function VideoCapturePage() {
  const [session, setSession] = useState<SessionState | null>(null);
  const [trainingContext, setTrainingContext] = useState('shadowboxing');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [cameraView, setCameraView] = useState('');
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [stoppedAtLimit, setStoppedAtLimit] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  const recordedAtRef = useRef<string | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // The camera is released when this page is left. A preview that keeps
  // running after the coach navigates away is a recording light nobody can
  // account for.
  useEffect(() => () => stopStream(), [stopStream]);

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

  async function startRecording() {
    setErrorMessage('');
    setStoppedAtLimit(false);
    const take = session?.current_take;
    if (!take) {
      setErrorMessage('Start or join a recording session first.');
      return;
    }

    setPhase('starting');
    try {
      /*
       * VIDEO ONLY. audio:false is a product decision, not an oversight: the
       * recognizer has to work on silent shadowboxing and in loud gyms, so
       * impact sound would be a shortcut it could lean on instead of learning
       * the movement. It also means this page never asks for a microphone the
       * Permissions-Policy would refuse anyway.
       */
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }

      const mimeType = CAPTURE_MIME_CANDIDATES.find((candidate) =>
        typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate),
      );
      if (!mimeType) {
        throw new Error('This browser cannot record a video format the platform accepts. Use Choose existing video instead.');
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      setRecordedBytes(0);
      recordedAtRef.current = new Date().toISOString();

      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return;
        chunksRef.current.push(event.data);
        bytesRef.current += event.data.size;
        setRecordedBytes(bytesRef.current);
        /*
         * STOPS ITSELF ON BYTES, before the ceiling rather than at it. The
         * alternative -- letting the coach finish and refusing the upload --
         * loses the take and the athlete's rep, and there is no way to get
         * either back.
         */
        if (bytesRef.current >= CAPTURE_MAX_BLOB_BYTES && recorder.state === 'recording') {
          setStoppedAtLimit(true);
          recorder.stop();
        }
      };

      recorder.onstop = () => {
        void finishRecording(mimeType, take.capture_take_id);
      };

      // Timeslice: without it the recorder emits one blob at the end and the
      // accumulated size is unknown until it is too late to stop.
      recorder.start(CAPTURE_CHUNK_MS);
      setPhase('recording');
    } catch (error) {
      stopStream();
      setPhase('idle');
      const message = error instanceof Error ? error.message : 'The camera could not be started.';
      setErrorMessage(
        message.includes('Permission') || message.includes('NotAllowed')
          ? 'The camera was refused. Allow camera access for this site, then try again.'
          : message,
      );
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  async function finishRecording(mimeType: string, captureTakeId: string) {
    setPhase('uploading');
    try {
      const descriptor = captureFileDescriptor(mimeType);
      if (!descriptor) {
        throw new Error('That recording is in a format the platform does not accept.');
      }

      /*
       * The File is constructed with the PLAIN container type. MediaRecorder
       * hands back video/webm;codecs="vp8" and the upload route compares MIME
       * with strict equality, so the parameterised string is refused even
       * though WebM is perfectly acceptable. Normalising the parameters
       * describes the same bytes more plainly; renaming the container would be
       * a lie the server's magic-byte check would catch.
       */
      const blob = new Blob(chunksRef.current, { type: descriptor.contentType });
      const file = new File([blob], `capture${descriptor.extension}`, { type: descriptor.contentType });

      const form = new FormData();
      form.append('file', file);
      form.append('capture_take_id', captureTakeId);
      if (cameraView.trim()) form.append('camera_view', cameraView.trim());
      if (recordedAtRef.current) form.append('recorded_at', recordedAtRef.current);

      const response = await fetch(`${apiBase()}/api/pilot/video/upload`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'The recording could not be uploaded.');

      if (session) await refresh(session.recording_session_id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The recording could not be uploaded.');
    } finally {
      chunksRef.current = [];
      stopStream();
      setPhase('idle');
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
            <p className="t-eyebrow text-[color:var(--brass-200)]">Coach Workspace</p>
            <h1 className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]" style={{ fontSize: 'var(--t-2xl)' }}>
              Record a Punch
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Short learning captures. Recording stops automatically at {limitMb} MB, which is the largest file the
              upload path currently takes. Several coaches can film the same punch from different positions: one
              starts a session, the others join it with the code, and every phone records its own angle.
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
                <label className="t-eyebrow flex flex-col gap-[var(--s2)]">
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
                {stoppedAtLimit && phase !== 'recording' ? (
                  <p role="status" className="t-body mt-[var(--s3)]">
                    Recording stopped at the {limitMb} MB limit and is being kept. Start the next take to carry on.
                  </p>
                ) : null}

                <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                  {phase === 'recording' ? (
                    <button type="button" className="btn" onClick={stopRecording}>Stop</button>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      disabled={phase !== 'idle' || busy || !take}
                      onClick={() => { void startRecording(); }}
                    >
                      {phase === 'uploading' ? 'Uploading…' : phase === 'starting' ? 'Opening camera…' : 'Record'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    disabled={busy || phase !== 'idle'}
                    onClick={() => guarded(async () => {
                      const payload = await post({ action: 'advance_take', recording_session_id: session.recording_session_id });
                      setSession(payload.session as SessionState);
                      setStoppedAtLimit(false);
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
            <Link href="/coach/video-analysis" className="btn btn--ghost">Back to Video Analysis</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
