"use client";

import { useEffect, useRef, useState } from 'react';
import RoleSessionGate from '@/components/RoleSessionGate';
import { useCameraRecorder } from '@/components/useCameraRecorder';
import { apiBase } from '@/lib/apiBase';
import { CAPTURE_MAX_BLOB_BYTES } from '@/lib/capturePolicy';

/*
 * FILM STUDY: the recorder.
 *
 * ITS OWN DOCUMENT, NOT A MODAL, and that is forced by the platform rather
 * than chosen for layout. Permissions-Policy is a per-response header, so a
 * page served with camera=() can never open a camera however its buttons are
 * written. next.config.ts grants camera=(self) to this route and to the Teach
 * Shadow recorder, and to nothing else.
 *
 * WHAT MAKES IT FILM STUDY IS WHAT IT DOES NOT SEND. There is no recording
 * session here, no join code, no take, and no "next take" -- and that absence
 * is the product contract, not a missing feature. A take is what groups the
 * angles of one attempt and what makes footage part of the recognition corpus;
 * an upload with no take cannot join one, so nothing recorded here can ever
 * become teaching evidence. The owner ruled there is no promotion path, and
 * this is where that ruling is enforced rather than merely stated.
 *
 * IT STILL NAMES ITS ATHLETE, and the server refuses it otherwise. The
 * guardian-consent check in the scan sweep only runs for a video that carries
 * an athlete_id, so an unattributed recording of a minor would reach the
 * vision screen with that check skipped. That refusal is keyed on
 * capture_source rather than on take-presence for exactly this page's sake.
 */

export default function FilmStudyCapturePage() {
  const [athletes, setAthletes] = useState<Array<{ athlete_id: string; full_name: string }>>([]);
  const [athleteId, setAthleteId] = useState('');
  const [title, setTitle] = useState('');
  const [uploaded, setUploaded] = useState(0);
  const [busy, setBusy] = useState(false);
  // See the note on the Teach Shadow recorder: a chosen file can be large, and
  // controls greying out with no other sign reads as a broken page.
  const [attaching, setAttaching] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function sendToFilmStudy(file: File, subjectAthleteId: string, recordedAt: string | null, source: string) {
    const form = new FormData();
    form.append('file', file);
    form.append('athlete_id', subjectAthleteId);
    form.append('capture_source', source);
    if (title.trim()) form.append('title', title.trim());
    if (recordedAt) form.append('recorded_at', recordedAt);
    // No capture_take_id, deliberately. See the note at the top of this file.

    const response = await fetch(`${apiBase()}/api/pilot/video/upload`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(payload.error || 'The recording could not be uploaded.');
    setUploaded((count) => count + 1);
  }

  const recorder = useCameraRecorder<{ athleteId: string }>({
    unsupportedFormatMessage:
      'This browser cannot record a format the platform accepts. Use "Choose a file instead" to upload footage shot elsewhere.',
    onRecorded: async (file, { recordedAt, context }) => {
      await sendToFilmStudy(file, context.athleteId, recordedAt, 'in_app_recording');
    },
  });

  // Destructured rather than read through `recorder.` at each use: the hook
  // hands back a ref among its values, and the lint rule reads a member
  // access on that object as touching a ref during render.
  const { phase, errorMessage, setErrorMessage, videoRef, recordedBytes, stoppedAtLimit, stop } = recorder;

  /*
   * The roster, because this recording MUST name the athlete it is of -- both
   * because Film Study footage is reviewed with a named athlete and because
   * the server will not store an in-app recording without one.
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

  function record() {
    if (!athleteId) {
      setErrorMessage('Choose which athlete this is of before recording.');
      return;
    }
    void recorder.start({ athleteId });
  }

  async function uploadExistingFile(chosen: File) {
    setErrorMessage('');
    setAttaching(true);
    setBusy(true);
    try {
      // capture_source says a file was chosen, not recorded. Calling a file
      // this app never recorded an in-app recording would be a false
      // provenance claim on somebody else's bytes.
      await sendToFilmStudy(chosen, athleteId, null, 'file_upload');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'That file could not be uploaded.');
    } finally {
      setAttaching(false);
      setBusy(false);
    }
  }

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
              Record for Film Study
            </h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Film an athlete to review with them. Recording stops itself at {limitMb} MB, which is a deliberate
              margin under the upload limit rather than the limit itself, so a take is never lost to a refused
              upload. The footage lands in the athlete&rsquo;s video library once it has been scanned.
            </p>
          </header>

          {/* WHERE THIS FOOTAGE GOES, SAID BEFORE ANY CONTROL APPEARS. There
              is no promotion path in either direction, so the choice has to be
              made before the bytes exist. The failure this prevents is a coach
              filming a genuinely useful teaching sequence here and only
              realising afterwards, when moving it is forbidden. */}
          {/* ON A MATERIAL GROUND, not bare on the page. `.t-body` resolves
              to a light ink (var(--bone-200)) meant for the dark panels the
              rest of this screen is built from; the sheet only darkens it
              under `.on-canvas` and `.mat-paper`. Standing alone on the page
              background it was cream on cream -- unreadable, on the one
              paragraph the owner made an acceptance requirement. */}
          <div className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s4)]">
            <p role="note" className="t-body">
            For coaching review of an athlete. Media recorded here stays in Film Study and cannot be moved into
            Teach Shadow.{' '}
            {/* Both ends of this are camera documents; a soft navigation
                between them would leave the second one running inside the
                first one’s policy. */}
            <a href="/teach-shadow/capture" className="underline">
              Recording an example to teach Shadow instead?
            </a>
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

          <section className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
            <div className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]">
              {/* REQUIRED, and the server refuses without it. An unattributed
                  recording would reach the vision content screen with the
                  guardian-consent check skipped, because that check only runs
                  for a video that names an athlete. */}
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
                What this is (optional)
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Southpaw counter work"
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
                  Uploading that file&hellip; large files take a while on gym wifi.
                </p>
              ) : null}
              {stoppedAtLimit && phase !== 'recording' ? (
                <p role="status" className="t-body mt-[var(--s3)]">
                  Recording stopped at the {limitMb} MB limit and is being kept. Record again to carry on.
                </p>
              ) : null}
              {uploaded > 0 && phase === 'idle' ? (
                <p role="status" className="t-body mt-[var(--s3)]">
                  {uploaded === 1 ? 'One recording has' : `${uploaded} recordings have`} been sent to Film Study.
                  Each one is scanned before it can be played.
                </p>
              ) : null}

              <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                {phase === 'recording' ? (
                  <button type="button" className="btn" onClick={stop}>Stop</button>
                ) : (
                  <button
                    type="button"
                    className="btn"
                    disabled={phase !== 'idle' || busy}
                    onClick={record}
                  >
                    {phase === 'uploading' ? 'Uploading…' : phase === 'starting' ? 'Opening camera…' : 'Record for Film Study'}
                  </button>
                )}
                {/* A browser whose recorder this platform cannot use still has
                    a camera app, and footage shot on it is still Film Study
                    footage. It goes to the same place by the same route, and
                    declares that it was chosen rather than recorded here. */}
                <button
                  type="button"
                  className="btn btn--ghost"
                  disabled={phase !== 'idle' || busy || !athleteId}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {attaching ? 'Uploading…' : 'Choose a file instead'}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  className="hidden"
                  onChange={(event) => {
                    const chosen = event.target.files?.[0];
                    event.target.value = '';
                    if (chosen) void uploadExistingFile(chosen);
                  }}
                />
              </div>
            </div>
          </section>

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            {/* Leaving by anchor too: a soft navigation would carry
                camera=(self) onto a page that was never granted it, for as
                long as the tab lives. */}
            <a href="/coach/video-analysis" className="btn btn--ghost">Back to Video Analysis</a>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
