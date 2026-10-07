"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CAPTURE_CHUNK_MS,
  CAPTURE_MAX_BLOB_BYTES,
  CAPTURE_MIME_CANDIDATES,
  captureFileDescriptor,
} from '@/lib/capturePolicy';

/*
 * THE CAMERA MACHINERY, OWNED IN ONE PLACE BECAUSE TWO PAGES NOW RECORD.
 *
 * The app records for two purposes the owner has ruled must never mix: Film
 * Study footage a coach reviews with an athlete, and Teach Shadow footage
 * collected to teach the recognizer. Permissions-Policy is a per-response
 * header, so each purpose has to be its own document -- which would otherwise
 * mean two copies of getUserMedia, two byte ceilings, two MIME negotiations
 * and two cleanup paths, drifting apart on whichever one somebody edits next.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: upload. The two pages send different
 * things -- a Teach Shadow recording carries the take it belongs to, a Film
 * Study recording carries no take at all, and that difference is the whole
 * separation. Sharing the upload would be sharing the one piece that must stay
 * different, so the hook hands the finished File back and the page decides
 * what it is.
 *
 * WHY A CONTEXT VALUE RATHER THAN A CLOSURE. What a recording belongs to is
 * fixed when RECORD is pressed, not when STOP is. A coach who presses "Next
 * take" while the camera is running would otherwise have the footage filed
 * against the take that exists at stop time -- the wrong one, silently, and
 * only discoverable later in the data. The caller passes what it needs at
 * start and gets exactly that value back.
 */

export type RecorderPhase = 'idle' | 'starting' | 'recording' | 'uploading';

interface Options<TContext> {
  /*
   * Called once with the finished recording. The hook stays in 'uploading'
   * until this settles, so the page does not have to model that phase itself.
   * Throwing here surfaces as the recorder's error message.
   */
  onRecorded: (file: File, meta: { recordedAt: string; context: TContext }) => Promise<void>;
  /*
   * Shown when no container this platform accepts can be recorded. The advice
   * differs per page -- one offers to attach an angle to the current take, the
   * other simply to choose a file -- so the sentence belongs to the caller.
   */
  unsupportedFormatMessage: string;
  /*
   * OFF unless the page asks. When on, a recording whose upload fails is HELD in
   * memory instead of discarded, and the page is handed retry, save-to-phone and
   * discard. It is opt-in because the two pages that record decide for
   * themselves what a lost upload means, and a page that does not render the
   * held recording would be holding footage nobody can reach.
   */
  keepFailedRecording?: boolean;
}

/** A finished recording whose upload failed, kept exactly as it was recorded. */
export interface HeldRecording<TContext> {
  file: File;
  recordedAt: string;
  /** What it belongs to, fixed when RECORD was pressed -- a retry sends the same. */
  context: TContext;
}

export interface CameraRecorder<TContext> {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  phase: RecorderPhase;
  recordedBytes: number;
  /** True when the byte ceiling ended the take rather than the coach. */
  stoppedAtLimit: boolean;
  /*
   * Clears that notice. The banner tells the coach to start the next take, so
   * it has to stop saying so once they have -- and only the page knows what
   * "carrying on" means for its own workflow.
   */
  dismissLimitNotice: () => void;
  errorMessage: string;
  setErrorMessage: (message: string) => void;
  start: (context: TContext) => Promise<void>;
  stop: () => void;
  /** Present only with keepFailedRecording, after an upload failed. */
  held: HeldRecording<TContext> | null;
  /** Sends the held recording again -- the same bytes, against the same context. */
  retryHeld: () => Promise<void>;
  /** Hands the held recording to the phone as a file download. Keeps it held. */
  saveHeld: () => void;
  /** The ONLY way a held recording is dropped. The person chooses it. */
  discardHeld: () => void;
}

export function useCameraRecorder<TContext>({
  onRecorded,
  unsupportedFormatMessage,
  keepFailedRecording = false,
}: Options<TContext>): CameraRecorder<TContext> {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [stoppedAtLimit, setStoppedAtLimit] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [held, setHeld] = useState<HeldRecording<TContext> | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);
  // Read synchronously by start(), which must not wait for a render to learn
  // that a recording is still being kept.
  const heldRef = useRef<HeldRecording<TContext> | null>(null);

  const holdRecording = useCallback((recording: HeldRecording<TContext> | null) => {
    heldRef.current = recording;
    setHeld(recording);
  }, []);

  /*
   * The recorder's onstop fires long after the render that created it, so it
   * must not close over a stale callback. This ref carries the CURRENT one.
   *
   * Assigned in an effect rather than during render, which is not a formality:
   * React may render a component and throw the result away, and a ref written
   * on that pass would be left holding a callback from a render that never
   * committed. The effect runs only after a commit, and onstop cannot fire
   * before the page has been shown, so there is no window where it is stale.
   */
  const onRecordedRef = useRef(onRecorded);
  useEffect(() => {
    onRecordedRef.current = onRecorded;
  });

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // The camera is released when the page is left. A preview that keeps running
  // after the coach navigates away is a recording light nobody can account for.
  useEffect(() => () => stopStream(), [stopStream]);

  /*
   * ASK BEFORE THROWING AWAY A TAKE THAT IS STILL UPLOADING.
   *
   * The recording lives in page memory until the POST that stores it finishes,
   * and that POST dies with the document. This did not matter while every
   * control in the session bar was a soft navigation: the page unmounted, the
   * fetch carried on, and the footage arrived. Making the exits from a camera
   * document a real page load -- which they have to be, or the recorder cannot
   * open a camera at all -- turned every one of those controls into a way to
   * silently discard the rep that was just filmed. keepalive does not help
   * here the way it does for the logout POST beside it: it is bounded to
   * 64 KiB and this body is a video.
   *
   * So the browser asks. A coach who means to leave loses nothing they did not
   * choose to lose, and one who clicked the wrong thing keeps the take. The
   * listener exists ONLY while an upload is in flight, so ordinary navigation
   * away from an idle recorder is never interrupted.
   *
   * Modern browsers show their own wording and ignore any message set here,
   * which is why none is set.
   */
  useEffect(() => {
    if (phase !== 'uploading') return;
    const hold = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Still required by some browsers to trigger the prompt at all.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, [phase]);

  /*
   * THE SAME ASK FOR A RECORDING WE ARE KEEPING. A held recording exists only
   * in this page's memory, so a reload or a tap on a link would lose it as
   * surely as one that was still uploading. Present only while one is held.
   */
  const isHolding = held !== null;
  useEffect(() => {
    if (!isHolding) return;
    const hold = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', hold);
    return () => window.removeEventListener('beforeunload', hold);
  }, [isHolding]);

  const finish = useCallback(async (mimeType: string, recordedAt: string, context: TContext) => {
    setPhase('uploading');
    let file: File | null = null;
    try {
      const descriptor = captureFileDescriptor(mimeType);
      if (!descriptor) {
        /*
         * Held under the type the recorder reported, unrenamed: the person can
         * still save these bytes to the phone even though the platform will not
         * take them, and describing them as something else would be a lie.
         */
        if (keepFailedRecording) {
          file = new File([new Blob(chunksRef.current, { type: mimeType })], 'capture', { type: mimeType });
        }
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
      file = new File([blob], `capture${descriptor.extension}`, { type: descriptor.contentType });

      await onRecordedRef.current(file, { recordedAt, context });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The recording could not be uploaded.');
      // The bytes are the one thing that cannot be re-shot, so they outlive the
      // failure. chunksRef is still cleared below; the File holds a copy.
      if (keepFailedRecording && file) holdRecording({ file, recordedAt, context });
    } finally {
      chunksRef.current = [];
      stopStream();
      setPhase('idle');
    }
  }, [stopStream, keepFailedRecording, holdRecording]);

  const retryHeld = useCallback(async () => {
    const recording = heldRef.current;
    if (!recording) return;
    setErrorMessage('');
    setPhase('uploading');
    try {
      await onRecordedRef.current(recording.file, {
        recordedAt: recording.recordedAt,
        context: recording.context,
      });
      holdRecording(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The recording could not be uploaded.');
    } finally {
      setPhase('idle');
    }
  }, [holdRecording]);

  const saveHeld = useCallback(() => {
    const recording = heldRef.current;
    if (!recording) return;
    const url = URL.createObjectURL(recording.file);
    const link = document.createElement('a');
    link.href = url;
    link.download = `shadow-capture-${recording.recordedAt.replace(/[:.]/g, '-')}${
      recording.file.name.includes('.') ? recording.file.name.slice(recording.file.name.lastIndexOf('.')) : ''
    }`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Not revoked at once: some mobile browsers start the save after the click returns.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  const discardHeld = useCallback(() => holdRecording(null), [holdRecording]);

  const start = useCallback(async (context: TContext) => {
    /*
     * A NEW RECORDING NEVER REPLACES ONE WE ARE STILL KEEPING. Without this the
     * next failed upload would overwrite the held file, and the earlier rep
     * would be gone without anyone having chosen that.
     */
    if (heldRef.current) {
      setErrorMessage('A recording that did not upload is still being kept. Try it again, save it to this phone, or discard it before recording another.');
      return;
    }
    setErrorMessage('');
    setStoppedAtLimit(false);
    setPhase('starting');
    try {
      /*
       * VIDEO ONLY. audio:false is a product decision, not an oversight: the
       * recognizer has to work on silent shadowboxing and in loud gyms, so
       * impact sound would be a shortcut it could lean on instead of learning
       * the movement. It also means these pages never ask for a microphone the
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
        throw new Error(unsupportedFormatMessage);
      }

      const recorder = new MediaRecorder(stream, { mimeType });
      recorderRef.current = recorder;
      chunksRef.current = [];
      bytesRef.current = 0;
      setRecordedBytes(0);
      const recordedAt = new Date().toISOString();

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
        void finish(mimeType, recordedAt, context);
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
  }, [finish, stopStream, unsupportedFormatMessage]);

  const dismissLimitNotice = useCallback(() => setStoppedAtLimit(false), []);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder && recorder.state === 'recording') recorder.stop();
  }, []);

  return {
    videoRef,
    phase,
    recordedBytes,
    stoppedAtLimit,
    dismissLimitNotice,
    errorMessage,
    setErrorMessage,
    start,
    stop,
    held,
    retryHeld,
    saveHeld,
    discardHeld,
  };
}
