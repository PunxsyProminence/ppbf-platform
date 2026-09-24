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
}

export function useCameraRecorder<TContext>({
  onRecorded,
  unsupportedFormatMessage,
}: Options<TContext>): CameraRecorder<TContext> {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [stoppedAtLimit, setStoppedAtLimit] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const bytesRef = useRef(0);

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

  const finish = useCallback(async (mimeType: string, recordedAt: string, context: TContext) => {
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

      await onRecordedRef.current(file, { recordedAt, context });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'The recording could not be uploaded.');
    } finally {
      chunksRef.current = [];
      stopStream();
      setPhase('idle');
    }
  }, [stopStream]);

  const start = useCallback(async (context: TContext) => {
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
  };
}
