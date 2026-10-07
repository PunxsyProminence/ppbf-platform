'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import BodyPointCanvas from '@/components/BodyPointCanvas';
import BodyPointMomentPanel from '@/components/BodyPointMomentPanel';
import BodyPointProgress from '@/components/BodyPointProgress';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import {
  ANNOTATION_CERTAINTIES,
  BODY_POINT_EDGES_0_4,
  BODY_POINT_ONTOLOGY_VERSIONS,
  BOXING_ONTOLOGY_VERSION_0_4,
  CONTACT_RESULTS,
  CONTACT_RESULTS_WITH_CONTACT,
  CONTACT_ZONES,
  DEFENSE_TYPES,
  HAND_ROLES,
  PHYSICAL_HANDS,
  PUNCH_TYPES,
  STANCES,
  TARGET_ZONES,
  VISIBILITIES,
  isInVocabulary,
} from '@/src/server/pilot/calibration/ontology';
import {
  STEP_MS,
  clampMsToClip,
  formatDurationMs,
  formatMediaOffset,
  isSpanWithinClip,
  mediaSecondsFromMs,
  msFromMediaSeconds,
} from '@/src/lib/clipTime';

/**
 * THE ANNOTATION BENCH -- one coach, one clip, one independent reading.
 *
 * WHAT THIS SCREEN IS FOR. Two coaches watch the same six seconds of this
 * gym's own footage and label what they saw, from a fixed vocabulary, without
 * seeing each other's answers. The output is not a scoring of an athlete. Its
 * event labels are a measurement of where trained humans disagree, which is
 * the number PPBF needs before it can say what any automated observation
 * would be worth; its body-point marks (sets of a body-point version) are the
 * hand-made marks PPBF's own pose model will be taught from, with no borrowed
 * tool placing anything first (OD-2026-10-02-011 sections 2 and 3a).
 *
 * FOUR THINGS THIS PAGE IS NOT ALLOWED TO DO, each of which it would be easy
 * to add and each of which would quietly wreck the study:
 *
 *   1. SHOW THE OTHER ANNOTATOR'S WORK. Not their events, not their count, not
 *      "someone else has started". This page asks for the caller's own set and
 *      the server refuses to answer with anybody else's. Independence is the
 *      whole measurement.
 *   2. LET AN ANNOTATOR WANDER OUTSIDE THE CLIP. Every seek, step, scrub and
 *      captured timestamp goes through clampMsToClip. A clip is a sampling
 *      decision about which seconds the study is about, and it is also the
 *      only span of a minor's footage this task justifies watching.
 *   3. EDIT A SUBMITTED SET. Submission is a one-way door enforced by a
 *      database trigger; this page's read-only mode exists so a coach is told
 *      that plainly rather than typing into controls whose saves will bounce.
 *   4. CLAIM FRAME PRECISION. Every offset here is milliseconds. The platform
 *      stores no frame rate and the browser exposes no reliable frame index,
 *      so no control on this page is labelled with a frame number -- see
 *      src/lib/clipTime.ts for the long version.
 *
 * WHERE THE STREAM COMES FROM, AND WHY IT IS NOT THE FILM STUDY ROUTE. The
 * stream comes from /api/pilot/teach-shadow/footage/[videoId]/stream,
 * teaching's own door, gated by requireAnnotator and assertVideoClippable --
 * the same question the cut asks, so footage that stops being clippable gets
 * no new stream link here. (A link already minted lasts until it expires.)
 *
 * This page used to fetch the Film Study video route, the one the coach video
 * console uses. That route refuses take-backed footage (2026-09-25) and only
 * take-backed footage may be cut into a clip (2026-09-24), so every clip this
 * page was allowed to show had a source it could not play. #1018 built the
 * teaching door and wired the cutter to it; this page was left on the old
 * route until TEACH-DATA-01. teachingFootagePlayableContract.test.ts now holds
 * both pages to the teaching door.
 *
 * The safeguarding review link is NOT used and must never be: it exists to
 * let a designated reviewer look at QUARANTINED footage in order to decide
 * about it, and borrowing it for annotation would turn a narrow safeguarding
 * exception into a general way to watch unscanned video of children.
 */

/* ------------------------------------------------------------------ *
 * Wire shapes. Declared here rather than imported from the calibration
 * modules because those import ./db, and importing one as a VALUE from a
 * 'use client' component would pull the Postgres driver into the browser
 * bundle. The ontology module is the exception and is imported directly: it
 * has no imports at all, and a vocabulary retyped into <option> tags is a
 * vocabulary that drifts the moment a second surface renders it.
 * ------------------------------------------------------------------ */

interface CalibrationProject {
  calibration_project_id: string;
  name: string;
  ontology_version: string;
  status: string;
}

interface CalibrationClip {
  calibration_clip_id: string;
  calibration_project_id: string;
  video_session_id: string;
  athlete_id: string | null;
  clip_code: string;
  start_ms: number;
  end_ms: number;
  primary_sampling_reason: string;
  playable?: boolean;
}

interface AnnotationSet {
  annotation_set_id: string;
  calibration_clip_id: string;
  annotator_account_id: string;
  ontology_version: string;
  status: string;
  submitted_at: string | null;
}

interface AnnotationEvent {
  event_id: string;
  event_class: string;
  actor_track: string;
  opponent_track: string | null;
  start_ms: number;
  end_ms: number;
  contact_ms: number | null;
  peak_ms: number | null;
  physical_hand: string | null;
  hand_role: string | null;
  stance: string | null;
  punch_type: string | null;
  target_zone: string | null;
  contact_result: string | null;
  contact_zone: string | null;
  defense_type: string | null;
  visibility: string;
  certainty: string;
  combination_group: string | null;
  sequence_order: number | null;
  counter_against_event_id: string | null;
  defends_against_event_id: string | null;
}

/* Body points, as GET /api/pilot/calibration/body-points returns them for a
   set whose version holds them (BODY_POINT_ONTOLOGY_VERSIONS). A 0.1 set is
   never asked: it has no body points, and the page must not change for it. */
interface BodyPoint {
  body_point_id: string;
  point_code: string;
  state: string;
  x_norm: number | null;
  y_norm: number | null;
}

interface BodyMoment {
  body_moment_id: string;
  event_id: string;
  moment_slot: string;
  moment_kind: string;
  observation_ms: number;
  event_start_ms: number;
  event_end_ms: number;
  lead_side: string | null;
  guard_type: string | null;
  source_frame_width_px: number | null;
  source_frame_height_px: number | null;
  points: BodyPoint[];
}

interface BodyData {
  /** The set this was read for. The page shows it only beside that set: a
   * reply that lands after the coach has moved to another clip is not that
   * clip's progress. */
  annotation_set_id: string;
  expected_points: string[] | null;
  moments: BodyMoment[];
  stance_labels: { event_id: string; stance_type: string }[];
  /** What submission would refuse on, in the server's words; [] = would pass. */
  missing: string[];
}

/**
 * The playback link is a 60-minute Azure SAS and NOTHING IN THIS PLATFORM
 * REFRESHES IT. There is no refresh endpoint, no silent re-mint, no retry
 * behind the scenes -- a long annotation session will simply reach the end of
 * the window and the video element will stop being able to fetch.
 *
 * So the page says so, before it happens, and offers the only honest remedy:
 * fetch a new link. Warning five minutes early is the difference between "the
 * player broke" and "the link is about to run out, here is the button". A
 * silent auto-refetch was rejected: it would re-mint a bearer credential for a
 * minor's footage on a timer, for a tab that might be sitting unattended.
 */
const SAS_LIFETIME_MS = 60 * 60 * 1000;
const SAS_WARNING_MS = SAS_LIFETIME_MS - 5 * 60 * 1000;

const PLAYBACK_RATES = [0.25, 0.5, 1, 1.5, 2] as const;

/** An empty option label that reads as a choice not yet made, never as a value. */
const CHOOSE = '— choose —';

interface EventDraft {
  /** The event being replaced, or null for a new one. */
  replacingEventId: string | null;
  eventClass: 'punch' | 'defense';
  actorTrack: string;
  opponentTrack: string;
  startMs: number;
  endMs: number;
  contactMs: string;
  peakMs: string;
  physicalHand: string;
  handRole: string;
  stance: string;
  punchType: string;
  targetZone: string;
  contactResult: string;
  contactZone: string;
  defenseType: string;
  visibility: string;
  certainty: string;
  combinationGroup: string;
  sequenceOrder: string;
  counterAgainstEventId: string;
  defendsAgainstEventId: string;
}

/**
 * A blank event, positioned at the playhead.
 *
 * visibility and certainty start EMPTY and are never pre-filled. They are
 * required on every event, and a default would be answered by the form rather
 * than by the annotator -- which is exactly the fabricated observation the
 * ontology's "reject, never coerce" rule exists to prevent. They are also the
 * two fields that make a disagreement interpretable ("was that a vocabulary
 * problem or a camera angle?"), so a defaulted value would not be a small lie.
 */
function blankDraft(eventClass: 'punch' | 'defense', atMs: number, clip: CalibrationClip): EventDraft {
  const startMs = clampMsToClip(atMs, clip.start_ms, clip.end_ms);
  return {
    replacingEventId: null,
    eventClass,
    actorTrack: '',
    opponentTrack: '',
    startMs,
    // A half-second default span, clamped -- a starting point the annotator
    // adjusts with Mark start / Mark end, not a measurement.
    endMs: clampMsToClip(startMs + 500, clip.start_ms, clip.end_ms),
    contactMs: '',
    peakMs: '',
    physicalHand: '',
    handRole: '',
    stance: '',
    punchType: '',
    targetZone: '',
    contactResult: '',
    contactZone: '',
    defenseType: '',
    visibility: '',
    certainty: '',
    combinationGroup: '',
    sequenceOrder: '',
    counterAgainstEventId: '',
    defendsAgainstEventId: '',
  };
}

function draftFromEvent(event: AnnotationEvent): EventDraft {
  return {
    replacingEventId: event.event_id,
    eventClass: event.event_class === 'defense' ? 'defense' : 'punch',
    actorTrack: event.actor_track,
    opponentTrack: event.opponent_track ?? '',
    startMs: event.start_ms,
    endMs: event.end_ms,
    contactMs: event.contact_ms === null ? '' : String(event.contact_ms),
    peakMs: event.peak_ms === null ? '' : String(event.peak_ms),
    physicalHand: event.physical_hand ?? '',
    handRole: event.hand_role ?? '',
    stance: event.stance ?? '',
    punchType: event.punch_type ?? '',
    targetZone: event.target_zone ?? '',
    contactResult: event.contact_result ?? '',
    contactZone: event.contact_zone ?? '',
    defenseType: event.defense_type ?? '',
    visibility: event.visibility,
    certainty: event.certainty,
    combinationGroup: event.combination_group ?? '',
    sequenceOrder: event.sequence_order === null ? '' : String(event.sequence_order),
    counterAgainstEventId: event.counter_against_event_id ?? '',
    defendsAgainstEventId: event.defends_against_event_id ?? '',
  };
}

/** Vocabulary tokens are stored lower_snake; this is display only. */
function label(token: string): string {
  return token.replace(/_/g, ' ');
}

function describeEvent(event: AnnotationEvent): string {
  if (event.event_class === 'punch') {
    const parts = [
      label(event.punch_type ?? ''),
      `${label(event.physical_hand ?? '')} hand / ${label(event.hand_role ?? '')}`,
      `at ${label(event.target_zone ?? '')}`,
      label(event.contact_result ?? ''),
    ];
    if (event.contact_zone) parts.push(`reached ${label(event.contact_zone)}`);
    return parts.join(' · ');
  }
  return label(event.defense_type ?? '');
}

/** A refusal's message and its machine code, where the route gave one. */
async function readRefusal(response: Response): Promise<{ message: string; code: string | null }> {
  try {
    const payload = (await response.json()) as { error?: string; code?: string };
    return {
      message: payload.error ?? `Request refused (${response.status}).`,
      code: typeof payload.code === 'string' ? payload.code : null,
    };
  } catch {
    return { message: `Request refused (${response.status}).`, code: null };
  }
}

async function readError(response: Response): Promise<string> {
  return (await readRefusal(response)).message;
}

/** One placement the coach can take back: what the point was before. */
interface Placement {
  body_moment_id: string;
  point_code: string;
  previous: BodyPoint | null;
}

export default function CoachCalibrationPage() {
  const [projects, setProjects] = useState<CalibrationProject[]>([]);
  const [projectId, setProjectId] = useState('');
  const [clips, setClips] = useState<CalibrationClip[]>([]);
  const [clipId, setClipId] = useState('');

  const [clip, setClip] = useState<CalibrationClip | null>(null);
  const [project, setProject] = useState<CalibrationProject | null>(null);
  const [annotationSet, setAnnotationSet] = useState<AnnotationSet | null>(null);
  const [events, setEvents] = useState<AnnotationEvent[]>([]);
  const [bodyData, setBodyData] = useState<BodyData | null>(null);
  const [bodyNotice, setBodyNotice] = useState('');

  const [streamUrl, setStreamUrl] = useState('');
  const [streamNotice, setStreamNotice] = useState('');
  const [refusal, setRefusal] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [currentMs, setCurrentMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [draft, setDraft] = useState<EventDraft | null>(null);
  const [confirmingSubmit, setConfirmingSubmit] = useState(false);

  /* Body-point marking: which moment is open on the picture, which point the
     next tap is for, and the placements the coach can take back (local, per
     open moment; cleared when the moment changes). */
  const [activeMomentId, setActiveMomentId] = useState<string | null>(null);
  const [activePointCode, setActivePointCode] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<Placement[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  /* Which body-points read is the current one. A slow reply from an earlier
     read (another clip, or the same set before an event write) is dropped on
     arrival rather than overwriting what a later read put on screen. */
  const bodyReadToken = useRef(0);

  /* The set is read-only unless it is open and belongs to this session's
     annotator. `null` (no set opened yet) is also read-only -- there is
     nothing to write to -- which is why this is not `status === 'submitted'`.
     Written this way round so a status this build has never heard of fails
     CLOSED rather than open. */
  const canEdit = annotationSet !== null && annotationSet.status === 'in_progress';

  /* A set whose version holds body points. Everything below that marks a
     point is behind this; a 0.1 set never sees it. */
  const isBodyPointSet = annotationSet !== null
    && isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, annotationSet.ontology_version);
  const bodyDataForSet = annotationSet && bodyData && bodyData.annotation_set_id === annotationSet.annotation_set_id
    ? bodyData
    : null;
  const activeMoment = bodyDataForSet?.moments.find((row) => row.body_moment_id === activeMomentId) ?? null;
  /* Skeleton lines are defined for 0.4 only (ontology.ts); other versions
     draw dots alone. */
  const skeletonEdges = annotationSet?.ontology_version === BOXING_ONTOLOGY_VERSION_0_4 ? BODY_POINT_EDGES_0_4 : [];

  /* ------------------------------------------------------------------ *
   * Loading
   * ------------------------------------------------------------------ */

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/calibration/projects`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setRefusal(await readError(response));
          return;
        }
        const payload = (await response.json()) as { projects?: CalibrationProject[] };
        setProjects(payload.projects ?? []);
      } catch {
        // Aborted or offline. The picker degrades to empty rather than
        // asserting that this gym runs no calibration studies.
      }
    })();
    return () => controller.abort();
  }, []);

  const loadClips = useCallback(async (nextProjectId: string) => {
    setClips([]);
    setClipId('');
    if (!nextProjectId) return;
    const response = await fetch(
      `${apiBase()}/api/pilot/calibration/clips?calibration_project_id=${encodeURIComponent(nextProjectId)}`,
      { credentials: 'include' },
    );
    if (!response.ok) {
      setRefusal(await readError(response));
      return;
    }
    const payload = (await response.json()) as { clips?: CalibrationClip[] };
    setClips(payload.clips ?? []);
  }, []);

  /**
   * The stream, from teaching's own playback door -- never the Film Study
   * video route, which refuses every clip this page can legally show.
   *
   * Called on clip open and again whenever the annotator asks for a fresh
   * link. Nothing else calls it: there is no timer that re-mints, because
   * re-minting a bearer credential for a minor's footage on a schedule is not
   * a thing a page should do while nobody is looking at it.
   */
  const loadStream = useCallback(async (videoSessionId: string) => {
    setStreamNotice('');
    setStreamUrl('');
    const response = await fetch(
      `${apiBase()}/api/pilot/teach-shadow/footage/${encodeURIComponent(videoSessionId)}/stream`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) {
      // The teaching door answers 404 for "not there", "not yours" and "no
      // longer clippable" alike, on purpose. Reported as-is rather than
      // guessed at.
      setStreamNotice(await readError(response));
      return;
    }
    const payload = (await response.json()) as { stream_url?: string };
    setStreamUrl(payload.stream_url ?? '');
  }, []);

  /**
   * The set's body-point marks and the server's own list of what is still
   * missing. Asked ONLY for a set whose version holds body points: a 0.1 set
   * has none, and asking would be a new call on a page that must behave for
   * 0.1 exactly as it did before body points existed. Re-read after every
   * event write, because replacing or deleting an event takes its moments,
   * points and stance type with it, and the progress shown must be the
   * database's, never the page's memory of it.
   *
   * A failure here is shown beside the body-point section, not as the page's
   * refusal: the events, the player and the forms are unaffected by it.
   */
  const loadBodyData = useCallback(async (set: AnnotationSet | null, options: { keep?: boolean } = {}) => {
    const token = bodyReadToken.current + 1;
    bodyReadToken.current = token;
    // Cleared first, not replaced on arrival, after an event write: between
    // the write and the re-read, the old marks would sit beside the new event
    // list and the totals would be wrong. An empty panel for one round trip
    // is honest. A re-read that follows a body-point write (`keep`) leaves
    // the marks on screen instead: the event list did not change, and
    // unmounting the panel and the picture for every lead-side pick would
    // throw the coach's scroll and focus away.
    if (!options.keep) setBodyData(null);
    setBodyNotice('');
    if (!set || !isInVocabulary(BODY_POINT_ONTOLOGY_VERSIONS, set.ontology_version)) {
      return;
    }
    try {
      const response = await fetch(
        `${apiBase()}/api/pilot/calibration/body-points?annotation_set_id=${encodeURIComponent(set.annotation_set_id)}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (bodyReadToken.current !== token) return;
      if (!response.ok) {
        setBodyNotice(await readError(response));
        return;
      }
      const payload = (await response.json()) as Partial<BodyData>;
      if (bodyReadToken.current !== token) return;
      setBodyData({
        annotation_set_id: set.annotation_set_id,
        expected_points: payload.expected_points ?? null,
        moments: payload.moments ?? [],
        stance_labels: payload.stance_labels ?? [],
        missing: payload.missing ?? [],
      });
    } catch {
      // Offline, aborted, or a body that was not JSON. The events and the
      // player are unaffected; the panel says the marks could not be read.
      if (bodyReadToken.current !== token) return;
      setBodyNotice('The body-point marks could not be read. Reload the clip to try again.');
    }
  }, []);

  const loadWorkspace = useCallback(async (nextClipId: string) => {
    setRefusal('');
    setNotice('');
    setDraft(null);
    setConfirmingSubmit(false);
    setAnnotationSet(null);
    setEvents([]);
    setBodyData(null);
    setBodyNotice('');
    setClip(null);
    setStreamUrl('');
    setStreamNotice('');
    if (!nextClipId) return;

    const response = await fetch(
      `${apiBase()}/api/pilot/calibration/annotation-set?calibration_clip_id=${encodeURIComponent(nextClipId)}`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) {
      setRefusal(await readError(response));
      return;
    }
    const payload = (await response.json()) as {
      project?: CalibrationProject | null;
      clip?: CalibrationClip;
      set?: AnnotationSet | null;
      events?: AnnotationEvent[];
    };
    if (!payload.clip) {
      setRefusal('The workspace came back without a clip.');
      return;
    }
    setProject(payload.project ?? null);
    setClip(payload.clip);
    setAnnotationSet(payload.set ?? null);
    setEvents(payload.events ?? []);
    setCurrentMs(payload.clip.start_ms);
    await loadStream(payload.clip.video_session_id);
    await loadBodyData(payload.set ?? null);
  }, [loadBodyData, loadStream]);

  const reloadEvents = useCallback(async (currentClipId: string) => {
    const response = await fetch(
      `${apiBase()}/api/pilot/calibration/annotation-set?calibration_clip_id=${encodeURIComponent(currentClipId)}`,
      { credentials: 'include', cache: 'no-store' },
    );
    if (!response.ok) {
      setRefusal(await readError(response));
      return;
    }
    const payload = (await response.json()) as {
      set?: AnnotationSet | null;
      events?: AnnotationEvent[];
    };
    setAnnotationSet(payload.set ?? null);
    setEvents(payload.events ?? []);
    await loadBodyData(payload.set ?? null);
  }, [loadBodyData]);

  /* ------------------------------------------------------------------ *
   * Transport. Every position that reaches the media element or a form
   * field has been through clampMsToClip first.
   * ------------------------------------------------------------------ */

  const seekTo = useCallback((ms: number) => {
    const activeClip = clip;
    if (!activeClip) return;
    const target = clampMsToClip(ms, activeClip.start_ms, activeClip.end_ms);
    setCurrentMs(target);
    const element = videoRef.current;
    if (element) {
      try {
        element.currentTime = mediaSecondsFromMs(target);
      } catch {
        // Some environments refuse a seek before metadata has loaded. The
        // page's own notion of the playhead is already correct, and the
        // loadedmetadata handler seeks again.
      }
    }
  }, [clip]);

  const handleTimeUpdate = useCallback(() => {
    const element = videoRef.current;
    const activeClip = clip;
    if (!element || !activeClip) return;
    const ms = msFromMediaSeconds(element.currentTime);

    /* THE FENCE. Playback that has run past the clip's end is stopped and
       pulled back, rather than allowed to continue into footage this study
       never sampled. Checked on every timeupdate rather than trusting the
       initial seek, because the native controls, a keyboard scrub and a
       loop can all move the element without going through seekTo. */
    if (ms > activeClip.end_ms) {
      try {
        element.pause();
      } catch {
        // Environments without media support: the seek below still fences.
      }
      setPlaying(false);
      seekTo(activeClip.end_ms);
      return;
    }
    if (ms < activeClip.start_ms) {
      seekTo(activeClip.start_ms);
      return;
    }
    setCurrentMs(ms);
  }, [clip, seekTo]);

  const togglePlay = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    try {
      if (playing) {
        element.pause();
        setPlaying(false);
      } else {
        const started = element.play() as unknown as Promise<void> | undefined;
        if (started && typeof started.catch === 'function') {
          started.catch(() => setPlaying(false));
        }
        setPlaying(true);
      }
    } catch {
      setPlaying(false);
    }
  }, [playing]);

  /**
   * Playback speed, only where the browser actually has it.
   *
   * `playbackRate` is settable on every current browser but the property is
   * not guaranteed by the platform the way currentTime is, and a select that
   * silently does nothing is worse than no select. The control is rendered
   * only when the element has the property, and the write is guarded because
   * some pipelines throw rather than ignore an unsupported rate.
   */
  const applyRate = useCallback((next: number) => {
    setRate(next);
    const element = videoRef.current;
    if (!element || !('playbackRate' in element)) return;
    try {
      element.playbackRate = next;
    } catch {
      setStreamNotice('This browser refused that playback speed. Playing at normal speed.');
      setRate(1);
    }
  }, []);

  /* ------------------------------------------------------------------ *
   * Writes
   * ------------------------------------------------------------------ */

  const startSet = useCallback(async () => {
    if (!clip) return;
    setBusy(true);
    setRefusal('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/annotation-set`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calibration_clip_id: clip.calibration_clip_id }),
      });
      if (!response.ok) {
        setRefusal(await readError(response));
        return;
      }
      const payload = (await response.json()) as { set?: AnnotationSet };
      setAnnotationSet(payload.set ?? null);
      setNotice('Your annotation set is open. Nobody else can see it until you submit.');
      await loadBodyData(payload.set ?? null);
    } finally {
      setBusy(false);
    }
  }, [clip, loadBodyData]);

  const saveDraft = useCallback(async () => {
    if (!draft || !annotationSet || !clip) return;
    setRefusal('');
    setNotice('');

    /* Refused here as well as server-side so the annotator is told at the
       moment they press Save, with the marks still on screen. The server and
       the CHECK constraint below it refuse the same span; this is not the
       enforcement. */
    if (!isSpanWithinClip(draft.startMs, draft.endMs, clip.start_ms, clip.end_ms)) {
      setRefusal(
        `An event must run forward and stay inside the clip (${formatMediaOffset(clip.start_ms)} to ${formatMediaOffset(clip.end_ms)}).`,
      );
      return;
    }

    /* On a body-point set a punch that made contact must carry its contact
       time: the middle moment is marked AT contact (OD-2026-10-02-011 3a)
       and the database refuses the event without it. Told here, with the
       form still on screen; the server refuses the same thing. */
    if (
      isBodyPointSet
      && draft.eventClass === 'punch'
      && isInVocabulary(CONTACT_RESULTS_WITH_CONTACT, draft.contactResult)
      && draft.contactMs.trim() === ''
    ) {
      setRefusal('A punch that made contact needs its contact time (ms, video time): the middle moment is marked at contact.');
      return;
    }

    const body = {
      annotation_set_id: annotationSet.annotation_set_id,
      event_id: draft.replacingEventId ?? undefined,
      event_class: draft.eventClass,
      actor_track: draft.actorTrack,
      opponent_track: draft.opponentTrack,
      start_ms: draft.startMs,
      end_ms: draft.endMs,
      contact_ms: draft.contactMs,
      // Stance and peak are 0.1 fields; a body-point set records the lead
      // side per moment and has no peak, and the database refuses either.
      peak_ms: isBodyPointSet ? '' : draft.peakMs,
      physical_hand: draft.physicalHand,
      hand_role: draft.handRole,
      stance: isBodyPointSet ? '' : draft.stance,
      punch_type: draft.eventClass === 'punch' ? draft.punchType : '',
      target_zone: draft.eventClass === 'punch' ? draft.targetZone : '',
      contact_result: draft.eventClass === 'punch' ? draft.contactResult : '',
      contact_zone: draft.eventClass === 'punch' ? draft.contactZone : '',
      defense_type: draft.eventClass === 'defense' ? draft.defenseType : '',
      visibility: draft.visibility,
      certainty: draft.certainty,
      combination_group: draft.eventClass === 'punch' ? draft.combinationGroup : '',
      sequence_order: draft.eventClass === 'punch' ? draft.sequenceOrder : '',
      counter_against_event_id: draft.eventClass === 'punch' ? draft.counterAgainstEventId : '',
      defends_against_event_id: draft.eventClass === 'defense' ? draft.defendsAgainstEventId : '',
    };

    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/events`, {
        method: draft.replacingEventId ? 'PUT' : 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        setRefusal(await readError(response));
        return;
      }
      setDraft(null);
      setNotice(draft.replacingEventId ? 'Event replaced.' : 'Event recorded.');
      await reloadEvents(clip.calibration_clip_id);
    } finally {
      setBusy(false);
    }
  }, [annotationSet, clip, draft, isBodyPointSet, reloadEvents]);

  const removeEvent = useCallback(async (eventId: string) => {
    if (!annotationSet || !clip) return;
    setBusy(true);
    setRefusal('');
    setNotice('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/events`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotation_set_id: annotationSet.annotation_set_id,
          event_id: eventId,
        }),
      });
      if (!response.ok) {
        setRefusal(await readError(response));
        return;
      }
      setNotice('Event removed.');
      await reloadEvents(clip.calibration_clip_id);
    } finally {
      setBusy(false);
    }
  }, [annotationSet, clip, reloadEvents]);

  /* ------------------------------------------------------------------ *
   * Body-point writes. Each goes to its own route; the response is folded
   * into the page's copy of the set's marks so a tap does not cost a full
   * re-read, and a full re-read happens whenever a moment is opened, closed
   * or removed and whenever the server says the event under it changed.
   * The server, and the database under it, refuse everything these send
   * wrongly; nothing here is the enforcement.
   * ------------------------------------------------------------------ */

  /** The next point in marking order that has no mark on this moment. */
  const nextUnmarked = useCallback((moment: BodyMoment, expected: readonly string[]): string | null => {
    const marked = new Set(moment.points.map((point) => point.point_code));
    return expected.find((code) => !marked.has(code)) ?? null;
  }, []);

  const replaceMoment = useCallback((updated: BodyMoment) => {
    setBodyData((current) => current && ({
      ...current,
      moments: current.moments.map((row) => (row.body_moment_id === updated.body_moment_id ? updated : row)),
    }));
  }, []);

  const bodyWrite = useCallback(async (
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    body: Record<string, unknown>,
  ): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; code: string | null; message: string }> => {
    if (!annotationSet) return { ok: false, code: null, message: 'No set is open.' };
    const send = () => fetch(`${apiBase()}/api/pilot/calibration/body-points${path}`, {
      method,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotation_set_id: annotationSet.annotation_set_id, ...body }),
    });
    let response = await send();
    if (!response.ok) {
      let refusal = await readRefusal(response);
      // Two writes crossed on the server: the second is sent once more.
      if (refusal.code === 'CALIBRATION_BODY_POINTS_WRITE_RACE') {
        response = await send();
        if (response.ok) return { ok: true, payload: (await response.json()) as Record<string, unknown> };
        refusal = await readRefusal(response);
      }
      if (refusal.code === 'CALIBRATION_BODY_MOMENT_EVENT_CHANGED' && clip) {
        // The event under the moment was replaced or removed (another tab):
        // what the page shows is no longer there. Reload everything.
        setActiveMomentId(null);
        setUndoStack([]);
        setNotice('That event changed since this page was loaded. Reloaded.');
        await reloadEvents(clip.calibration_clip_id);
      }
      return { ok: false, code: refusal.code, message: refusal.message };
    }
    return { ok: true, payload: (await response.json()) as Record<string, unknown> };
  }, [annotationSet, clip, reloadEvents]);

  /** Pause on the moment's time: the picture the coach marks. The browser
   * shows its nearest frame to that time; the stored time is the moment's. */
  const holdOnMoment = useCallback((observationMs: number) => {
    try {
      videoRef.current?.pause();
    } catch {
      // No media support: the seek below still positions the page's playhead.
    }
    setPlaying(false);
    seekTo(observationMs);
  }, [seekTo]);

  /** Opens the picture on a moment: marks are read fresh first, so the panel
   * starts from the database's points, not the page's memory of them; then
   * the video is held on the moment's time. */
  const selectMoment = useCallback(async (moment: Pick<BodyMoment, 'body_moment_id' | 'observation_ms'>) => {
    if (!annotationSet) return;
    await loadBodyData(annotationSet, { keep: true });
    setActiveMomentId(moment.body_moment_id);
    setUndoStack([]);
    setActivePointCode(null);
    holdOnMoment(moment.observation_ms);
  }, [annotationSet, holdOnMoment, loadBodyData]);

  /* THE HOLD. A tap is a mark AT THE MOMENT (OD-2026-10-02-011 3a), so the
     picture must be the moment's. "Held" means paused with the playhead on
     the moment's time, within one fine step: the browser seeks to its
     nearest frame and reports that time back, which is tens of milliseconds
     off the whole-number moment on some files, and a hold that demanded
     equality would never be satisfied there. A scrub or a step away from the
     moment, even paused, lifts the hold and taps place nothing until the
     coach goes back. */
  const heldOnMoment = activeMoment !== null
    && !playing
    && Math.abs(currentMs - activeMoment.observation_ms) <= STEP_MS.fine;

  /* The point the next tap is for: the coach's own pick when they made one
     (and it is still on this moment), otherwise the first unmarked point in
     marking order. Derived, not stored, so it is never stale after a mark. */
  const pointToPlace = activeMoment && bodyDataForSet?.expected_points
    ? (activePointCode && bodyDataForSet.expected_points.includes(activePointCode)
      ? activePointCode
      : nextUnmarked(activeMoment, bodyDataForSet.expected_points))
    : null;

  const openMoment = useCallback(async (event: AnnotationEvent, slot: string) => {
    if (!annotationSet) return;
    setBusy(true);
    setRefusal('');
    setNotice('');
    try {
      const body: Record<string, unknown> = { event_id: event.event_id, moment_slot: slot };
      // Only a middle moment of an event with no contact time takes a time:
      // the coach's playhead, held inside the event. Every other moment's
      // time is the server's (resolveMomentTiming in bodyPoints.ts).
      if (slot === 'middle' && event.contact_ms === null) {
        body.observation_ms = Math.round(Math.min(Math.max(currentMs, event.start_ms), event.end_ms));
      }
      const element = videoRef.current;
      if (element && element.videoWidth > 0 && element.videoHeight > 0) {
        body.source_frame_width_px = element.videoWidth;
        body.source_frame_height_px = element.videoHeight;
      }
      const result = await bodyWrite('/moments', 'POST', body);
      if (!result.ok) {
        if (result.code === 'CALIBRATION_BODY_MOMENT_SLOT_TAKEN') {
          // Already open (a second tab, or a lost reply): read it back and
          // mark on it rather than telling the coach no.
          await loadBodyData(annotationSet);
          setNotice('That moment was already open. Showing it.');
          return;
        }
        setRefusal(result.message);
        return;
      }
      const moment = result.payload.moment as BodyMoment | undefined;
      if (moment) await selectMoment(moment);
    } finally {
      setBusy(false);
    }
  }, [annotationSet, bodyWrite, currentMs, loadBodyData, selectMoment]);

  const closeMoment = useCallback(async () => {
    if (busy) return;
    setActiveMomentId(null);
    setActivePointCode(null);
    setUndoStack([]);
    if (annotationSet) await loadBodyData(annotationSet, { keep: true });
  }, [annotationSet, busy, loadBodyData]);

  const removeMoment = useCallback(async (momentId: string) => {
    if (!annotationSet) return;
    setBusy(true);
    setRefusal('');
    try {
      const result = await bodyWrite('/moments', 'DELETE', { body_moment_id: momentId });
      // A second DELETE is a 404: the moment is gone either way.
      if (!result.ok && !result.message.startsWith('Not found')) {
        setRefusal(result.message);
        return;
      }
      if (activeMomentId === momentId) {
        setActiveMomentId(null);
        setActivePointCode(null);
        setUndoStack([]);
      }
      setNotice('Moment removed, with its points.');
      await loadBodyData(annotationSet, { keep: true });
    } finally {
      setBusy(false);
    }
  }, [activeMomentId, annotationSet, bodyWrite, loadBodyData]);

  /** One point, one request: placed with its picture fraction, or not
   * visible with none. The server answers with every point on the moment.
   * Returns whether the write landed, so an undo pops its entry only then. */
  const markPoint = useCallback(async (
    pointCode: string,
    mark: { state: 'placed'; x_norm: number; y_norm: number } | { state: 'not_visible' },
    recordUndo: boolean,
  ): Promise<boolean> => {
    if (!activeMoment) return false;
    setBusy(true);
    setRefusal('');
    try {
      const previous = activeMoment.points.find((p) => p.point_code === pointCode) ?? null;
      const result = await bodyWrite('/points', 'PUT', {
        body_moment_id: activeMoment.body_moment_id,
        points: [{ point_code: pointCode, ...mark }],
      });
      if (!result.ok) {
        setRefusal(result.message);
        return false;
      }
      const points = (result.payload.points as BodyPoint[] | undefined) ?? [];
      const updated = { ...activeMoment, points };
      replaceMoment(updated);
      if (recordUndo) {
        setUndoStack((stack) => [...stack, { body_moment_id: activeMoment.body_moment_id, point_code: pointCode, previous }]);
      }
      // Back to "the next unmarked point": when every point is marked the
      // panel says so and the coach sets the lead side and guard.
      setActivePointCode(null);
      return true;
    } finally {
      setBusy(false);
    }
  }, [activeMoment, bodyWrite, replaceMoment]);

  /** Unmarks a point. On the undo stack like a placement, so that undoing
   * after a Clear puts the mark back rather than resurrecting an older one. */
  const clearPoint = useCallback(async (pointCode: string, recordUndo: boolean): Promise<boolean> => {
    if (!activeMoment) return false;
    setBusy(true);
    setRefusal('');
    try {
      const previous = activeMoment.points.find((p) => p.point_code === pointCode) ?? null;
      const result = await bodyWrite('/points', 'DELETE', {
        body_moment_id: activeMoment.body_moment_id,
        point_code: pointCode,
      });
      if (!result.ok && !result.message.startsWith('Not found')) {
        setRefusal(result.message);
        return false;
      }
      const updated = { ...activeMoment, points: activeMoment.points.filter((p) => p.point_code !== pointCode) };
      replaceMoment(updated);
      if (recordUndo && previous) {
        setUndoStack((stack) => [...stack, { body_moment_id: activeMoment.body_moment_id, point_code: pointCode, previous }]);
      }
      setActivePointCode(pointCode);
      return true;
    } finally {
      setBusy(false);
    }
  }, [activeMoment, bodyWrite, replaceMoment]);

  /** Takes back the last change to a point on this moment: the point goes
   * back to what it was before (its earlier mark, or no mark at all). The
   * entry leaves the stack only once the write has landed, so a failed undo
   * can be tried again. */
  const undoPlacement = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last || !activeMoment || busy || last.body_moment_id !== activeMoment.body_moment_id) return;
    let landed: boolean;
    if (last.previous === null) {
      landed = await clearPoint(last.point_code, false);
    } else {
      const previous = last.previous;
      landed = await markPoint(
        last.point_code,
        previous.state === 'placed' && previous.x_norm !== null && previous.y_norm !== null
          ? { state: 'placed', x_norm: previous.x_norm, y_norm: previous.y_norm }
          : { state: 'not_visible' },
        false,
      );
    }
    if (landed) setUndoStack((stack) => stack.slice(0, -1));
  }, [activeMoment, busy, clearPoint, markPoint, undoStack]);

  const relabelMoment = useCallback(async (field: 'lead_side' | 'guard_type', value: string) => {
    if (!activeMoment) return;
    setBusy(true);
    setRefusal('');
    try {
      const result = await bodyWrite('/moments', 'PUT', { body_moment_id: activeMoment.body_moment_id, [field]: value });
      if (!result.ok) {
        setRefusal(result.message);
        return;
      }
      const moment = result.payload.moment as BodyMoment | undefined;
      if (moment) replaceMoment({ ...moment, points: activeMoment.points });
    } finally {
      setBusy(false);
    }
  }, [activeMoment, bodyWrite, replaceMoment]);

  const setStanceType = useCallback(async (eventId: string, stanceType: string) => {
    if (!annotationSet) return;
    setBusy(true);
    setRefusal('');
    try {
      const result = stanceType
        ? await bodyWrite('/stance', 'PUT', { event_id: eventId, stance_type: stanceType })
        : await bodyWrite('/stance', 'DELETE', { event_id: eventId });
      if (!result.ok && !(stanceType === '' && result.message.startsWith('Not found'))) {
        setRefusal(result.message);
        return;
      }
      await loadBodyData(annotationSet, { keep: true });
    } finally {
      setBusy(false);
    }
  }, [annotationSet, bodyWrite, loadBodyData]);

  const submitSet = useCallback(async () => {
    if (!annotationSet || !clip) return;
    setBusy(true);
    setRefusal('');
    setNotice('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/calibration/annotation-set/submit`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ annotation_set_id: annotationSet.annotation_set_id }),
      });
      if (!response.ok) {
        setRefusal(await readError(response));
        // A body-point set refused as incomplete: re-read the marks so the
        // panel shows what the server named, not what it showed before a
        // write from another tab or a lost reply.
        await loadBodyData(annotationSet);
        return;
      }
      const payload = (await response.json()) as { set?: AnnotationSet };
      setAnnotationSet(payload.set ?? null);
      setDraft(null);
      setConfirmingSubmit(false);
      setNotice('Submitted. This set is now read-only and cannot be reopened.');
      // The body-points read works on a submitted set; this is the read-only view.
      await loadBodyData(payload.set ?? null);
    } finally {
      setBusy(false);
    }
  }, [annotationSet, clip, loadBodyData]);

  /* The SAS warning. One timer per minted link, cleared on replacement. */
  useEffect(() => {
    if (!streamUrl) return undefined;
    const timer = setTimeout(() => {
      setStreamNotice(
        'This footage link is about to expire. Playback links last 60 minutes and nothing '
        + 'refreshes them -- load fresh footage to keep working. Your saved events are not affected.',
      );
    }, SAS_WARNING_MS);
    return () => clearTimeout(timer);
  }, [streamUrl]);

  const selectedClipRow = clips.find((row) => row.calibration_clip_id === clipId) ?? null;

  return (
    /* The gym-floor shell, not a hand-rolled <main>. It supplies the room --
       ground, lamp and plate layer -- from the `room` prop, which is also what
       buildingMapRooms.test.ts used to read to check this page against its door
       (removed 2026-10-02, OD-2026-10-02-004). A page that painted the room
       classes itself would be a second answer to "what room is this", and
       would add another use of the retired visual vocabulary. */
    <RoleStandaloneView
      roleLabel="Coach Workspace"
      routeLabel="/teach-shadow/annotation"
      allowedRoles={['coach', 'admin']}
      showShellHeader={false}
    >
      <div className="mx-auto w-full max-w-5xl space-y-[var(--s5)] p-[var(--s5)]">
          <header>
            <p className="t-eyebrow">Teach Shadow</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
              Clip Annotation
            </h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Watch the clip and label what you saw, from the fixed vocabulary. Two coaches label
              the same clip separately, and neither sees the other&apos;s answers -- the point is to
              measure where trained people disagree, not to grade a boxer. Nothing recorded here
              scores an athlete or changes their record. Every timestamp is milliseconds; this
              platform stores no frame rate, so nothing here is frame-accurate and no control
              claims to be.
            </p>
            <p className="t-muted mt-[var(--s3)]">
              <Link href="/coach/video-analysis" className="btn btn--ghost">Coach video console</Link>
            </p>
          </header>

          {refusal ? (
            <div className="alert alert--warning" role="alert">
              <div className="alert-body">
                <p className="alert-title">Refused</p>
                <p className="t-body">{refusal}</p>
              </div>
            </div>
          ) : null}

          {notice ? (
            <div className="alert alert--info" role="status">
              <div className="alert-body">
                <p className="t-body">{notice}</p>
              </div>
            </div>
          ) : null}

          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-eyebrow">Study and clip</h2>
            <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field">
                <label htmlFor="calibration-project" className="t-label">Calibration project</label>
                <select
                  id="calibration-project"
                  className="select"
                  value={projectId}
                  onChange={(e) => {
                    const next = e.target.value;
                    setProjectId(next);
                    setClip(null);
                    setAnnotationSet(null);
                    setEvents([]);
                    void loadClips(next);
                  }}
                >
                  <option value="">{CHOOSE}</option>
                  {projects.map((row) => (
                    <option key={row.calibration_project_id} value={row.calibration_project_id}>
                      {row.name} ({label(row.status)})
                    </option>
                  ))}
                </select>
              </div>

              <div className="field">
                <label htmlFor="calibration-clip" className="t-label">Clip</label>
                <select
                  id="calibration-clip"
                  className="select"
                  value={clipId}
                  disabled={clips.length === 0}
                  onChange={(e) => {
                    const next = e.target.value;
                    setClipId(next);
                    void loadWorkspace(next);
                  }}
                >
                  <option value="">{CHOOSE}</option>
                  {clips.map((row) => (
                    <option
                      key={row.calibration_clip_id}
                      value={row.calibration_clip_id}
                      disabled={row.playable === false}
                    >
                      {row.clip_code} · {label(row.primary_sampling_reason)} ·{' '}
                      {formatDurationMs(row.end_ms - row.start_ms)}
                      {row.playable === false ? ' · footage unavailable' : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {selectedClipRow?.playable === false ? (
              <p className="t-muted mt-[var(--s3)]">
                This clip&apos;s footage is not available for annotation right now. That check runs
                again on every read and every save, so a clip can become unavailable mid-study.
              </p>
            ) : null}

            {project ? (
              <p className="t-data mt-[var(--s3)]">
                Vocabulary {project.ontology_version} · study status {label(project.status)}
              </p>
            ) : null}
          </section>

          {clip ? (
            <section className="frame">
              <div className="rivet rivet--tl" />
              <div className="rivet rivet--tr" />
              <div className="rivet rivet--bl" />
              <div className="rivet rivet--br" />
              <div className="frame-in mat-leather p-[var(--s4)]">
                <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                  <h2 className="t-eyebrow">
                    Clip {clip.clip_code} · {formatMediaOffset(clip.start_ms)} to{' '}
                    {formatMediaOffset(clip.end_ms)}
                  </h2>
                  {annotationSet ? (
                    <span className={canEdit ? 'badge badge--monitor' : 'badge badge--cleared'}>
                      {canEdit ? 'In progress' : 'Submitted · read-only'}
                    </span>
                  ) : null}
                </div>

                {streamNotice ? (
                  <div className="alert alert--warning mt-[var(--s3)]" role="alert">
                    <div className="alert-body">
                      <p className="t-body">{streamNotice}</p>
                      <button
                        type="button"
                        className="btn btn--ghost mt-[var(--s2)]"
                        onClick={() => { void loadStream(clip.video_session_id); }}
                      >
                        Load fresh footage
                      </button>
                    </div>
                  </div>
                ) : null}

                {streamUrl ? (
                  /* The wrapper is the tap layer's frame: it hugs the video
                     (inline-block, no margin of its own) so the overlay's
                     picture offsets are measured from the video's own box. */
                  <div className="relative mt-[var(--s3)] inline-block w-full">
                    <video
                      ref={videoRef}
                      data-testid="calibration-player"
                      className="block w-full max-h-[440px] rounded-[var(--r-sm)] bg-[var(--hide-950)]"
                      src={streamUrl}
                      preload="metadata"
                      onLoadedMetadata={() => seekTo(clip.start_ms)}
                      onTimeUpdate={handleTimeUpdate}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onError={() => setStreamNotice(
                        'The footage stopped loading. Playback links last 60 minutes and this '
                        + 'platform does not refresh them, so an expired link is the usual reason. '
                        + 'Load fresh footage to carry on -- your saved events are not affected.',
                      )}
                    >
                      <track kind="captions" />
                    </video>
                    {activeMoment && bodyDataForSet?.expected_points ? (
                      <BodyPointCanvas
                        videoRef={videoRef}
                        bindKey={streamUrl}
                        points={activeMoment.points}
                        edges={skeletonEdges}
                        activePointCode={canEdit ? pointToPlace : null}
                        disabled={!canEdit || busy || !heldOnMoment}
                        onPlace={(at) => {
                          if (pointToPlace) void markPoint(pointToPlace, { state: 'placed', ...at }, true);
                        }}
                        onTapOutsidePicture={() => setNotice('That tap was outside the picture. Nothing was placed.')}
                      />
                    ) : null}
                  </div>
                ) : null}

                <p className="t-data mt-[var(--s3)]" data-testid="playhead">
                  Playhead {formatMediaOffset(currentMs)} (video time) ·{' '}
                  {formatMediaOffset(currentMs - clip.start_ms)} into the clip
                </p>

                <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                  <button type="button" className="btn" onClick={togglePlay}>
                    {playing ? 'Pause' : 'Play'}
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(clip.start_ms)}>
                    Clip start
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(currentMs - STEP_MS.large)}>
                    -{STEP_MS.large}ms
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(currentMs - STEP_MS.small)}>
                    -{STEP_MS.small}ms
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(currentMs - STEP_MS.fine)}>
                    -{STEP_MS.fine}ms
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(currentMs + STEP_MS.fine)}>
                    +{STEP_MS.fine}ms
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(currentMs + STEP_MS.small)}>
                    +{STEP_MS.small}ms
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => seekTo(currentMs + STEP_MS.large)}>
                    +{STEP_MS.large}ms
                  </button>
                </div>

                <div className="field mt-[var(--s3)]">
                  <label htmlFor="clip-scrub" className="t-label">Seek within the clip</label>
                  <input
                    id="clip-scrub"
                    type="range"
                    className="range--kiosk"
                    min={clip.start_ms}
                    max={clip.end_ms}
                    step={10}
                    value={currentMs}
                    onChange={(e) => seekTo(Number(e.target.value))}
                  />
                </div>

                <div className="field mt-[var(--s3)] max-w-[220px]">
                  <label htmlFor="playback-rate" className="t-label">Playback speed</label>
                  <select
                    id="playback-rate"
                    className="select"
                    value={String(rate)}
                    onChange={(e) => applyRate(Number(e.target.value))}
                  >
                    {PLAYBACK_RATES.map((value) => (
                      <option key={value} value={String(value)}>{value}x</option>
                    ))}
                  </select>
                </div>
              </div>
            </section>
          ) : null}

          {clip && !annotationSet ? (
            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-eyebrow">Your pass</h2>
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                You have not opened a set for this clip. Opening one records that this reading is
                yours; it is not visible to the other annotator, and it can be submitted only once.
              </p>
              <button type="button" className="btn mt-[var(--s3)]" disabled={busy} onClick={() => { void startSet(); }}>
                Open my annotation set
              </button>
            </section>
          ) : null}

          {annotationSet ? (
            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
              <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                <h2 className="t-eyebrow">What you saw ({events.length})</h2>
                {canEdit ? (
                  <div className="flex gap-[var(--s2)]">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => clip && setDraft(blankDraft('punch', currentMs, clip))}
                    >
                      Add punch
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => clip && setDraft(blankDraft('defense', currentMs, clip))}
                    >
                      Add defense
                    </button>
                  </div>
                ) : null}
              </div>

              {!canEdit ? (
                <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                  This set was submitted{annotationSet.submitted_at ? '' : ''} and is read-only. It
                  cannot be reopened, here or anywhere else -- a pass that could be revised after
                  seeing the other annotator&apos;s work would not be an independent reading. A
                  genuine re-annotation is a new set.
                </p>
              ) : null}

              {events.length === 0 ? (
                <p className="t-muted mt-[var(--s3)]">
                  No events recorded yet. An empty set is a real reading -- &quot;I watched this and
                  saw nothing to label&quot; -- and may be submitted as one.
                </p>
              ) : (
                <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                  {events.map((event) => (
                    <li
                      key={event.event_id}
                      data-testid="annotation-event"
                      className="rounded-[var(--r-sm)] border border-[color:rgba(255,255,255,.12)] p-[var(--s3)]"
                    >
                      <p className="t-data">
                        {label(event.event_class)} · {formatMediaOffset(event.start_ms)} to{' '}
                        {formatMediaOffset(event.end_ms)} · {event.actor_track}
                      </p>
                      <p className="t-body mt-[var(--s2)]">{describeEvent(event)}</p>
                      <p className="t-muted mt-[var(--s2)]">
                        visibility {label(event.visibility)} · certainty {label(event.certainty)}
                      </p>
                      {canEdit ? (
                        <div className="mt-[var(--s2)] flex gap-[var(--s2)]">
                          <button
                            type="button"
                            className="btn btn--ghost"
                            onClick={() => setDraft(draftFromEvent(event))}
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            className="btn btn--ghost"
                            disabled={busy}
                            onClick={() => { void removeEvent(event.event_id); }}
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {annotationSet && bodyNotice ? (
            <div className="alert alert--warning" role="alert">
              <div className="alert-body">
                <p className="alert-title">Body points could not be read</p>
                <p className="t-body">{bodyNotice}</p>
              </div>
            </div>
          ) : null}

          {bodyDataForSet ? (
            <BodyPointProgress
              events={events}
              expectedPoints={bodyDataForSet.expected_points}
              moments={bodyDataForSet.moments}
              stanceLabels={bodyDataForSet.stance_labels}
              missing={bodyDataForSet.missing}
              controls={canEdit ? {
                busy,
                activeMomentId,
                onOpenMoment: (event, slot) => {
                  const row = events.find((e) => e.event_id === event.event_id);
                  if (row) void openMoment(row, slot);
                },
                onSelectMoment: (momentId) => {
                  const moment = bodyDataForSet.moments.find((row) => row.body_moment_id === momentId);
                  if (moment) void selectMoment(moment);
                },
                onRemoveMoment: (momentId) => { void removeMoment(momentId); },
                onSetStance: (eventId, stanceType) => { void setStanceType(eventId, stanceType); },
              } : undefined}
            />
          ) : null}

          {activeMoment && bodyDataForSet?.expected_points ? (
            <BodyPointMomentPanel
              moment={activeMoment}
              actorTrack={events.find((row) => row.event_id === activeMoment.event_id)?.actor_track ?? ''}
              expectedPoints={bodyDataForSet.expected_points}
              activePointCode={canEdit ? pointToPlace : null}
              disabled={!canEdit || busy}
              canUndo={undoStack.length > 0}
              awayFromMoment={!heldOnMoment}
              onSelectPoint={(code) => { if (!busy) setActivePointCode(code); }}
              onNotVisible={(code) => { void markPoint(code, { state: 'not_visible' }, true); }}
              onClearPoint={(code) => { void clearPoint(code, true); }}
              onUndo={() => { void undoPlacement(); }}
              onSetLeadSide={(value) => { void relabelMoment('lead_side', value); }}
              onSetGuard={(value) => { void relabelMoment('guard_type', value); }}
              onGoToMoment={() => holdOnMoment(activeMoment.observation_ms)}
              onClose={() => { void closeMoment(); }}
            />
          ) : null}

          {draft && clip && canEdit ? (
            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-eyebrow">
                {draft.replacingEventId ? 'Replace event' : `New ${draft.eventClass}`}
              </h2>
              {draft.replacingEventId ? (
                <p className="t-muted mt-[var(--s2)]">
                  Saving writes a replacement and removes the original. Any counter or defends link
                  another event pointed at this one is cleared -- re-assert it yourself rather than
                  having the platform re-assert it for you.
                </p>
              ) : null}

              <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                <div className="field">
                  <label htmlFor="draft-actor" className="t-label">Actor (which fighter)</label>
                  <input
                    id="draft-actor"
                    className="input"
                    value={draft.actorTrack}
                    onChange={(e) => setDraft({ ...draft, actorTrack: e.target.value })}
                  />
                </div>
                <div className="field">
                  <label htmlFor="draft-opponent" className="t-label">Opponent (optional)</label>
                  <input
                    id="draft-opponent"
                    className="input"
                    value={draft.opponentTrack}
                    onChange={(e) => setDraft({ ...draft, opponentTrack: e.target.value })}
                  />
                </div>

                <div className="field">
                  <label htmlFor="draft-start" className="t-label">Start (ms, video time)</label>
                  <input
                    id="draft-start"
                    className="input"
                    inputMode="numeric"
                    value={String(draft.startMs)}
                    onChange={(e) => setDraft({
                      ...draft,
                      startMs: clampMsToClip(Number(e.target.value), clip.start_ms, clip.end_ms),
                    })}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost mt-[var(--s2)]"
                    onClick={() => setDraft({
                      ...draft,
                      startMs: clampMsToClip(currentMs, clip.start_ms, clip.end_ms),
                    })}
                  >
                    Mark start at playhead
                  </button>
                </div>

                <div className="field">
                  <label htmlFor="draft-end" className="t-label">End (ms, video time)</label>
                  <input
                    id="draft-end"
                    className="input"
                    inputMode="numeric"
                    value={String(draft.endMs)}
                    onChange={(e) => setDraft({
                      ...draft,
                      endMs: clampMsToClip(Number(e.target.value), clip.start_ms, clip.end_ms),
                    })}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost mt-[var(--s2)]"
                    onClick={() => setDraft({
                      ...draft,
                      endMs: clampMsToClip(currentMs, clip.start_ms, clip.end_ms),
                    })}
                  >
                    Mark end at playhead
                  </button>
                </div>

                {draft.eventClass === 'punch' ? (
                  <>
                    <div className="field">
                      <label htmlFor="draft-punch-type" className="t-label">Punch type</label>
                      <select
                        id="draft-punch-type"
                        className="select"
                        value={draft.punchType}
                        onChange={(e) => setDraft({ ...draft, punchType: e.target.value })}
                      >
                        <option value="">{CHOOSE}</option>
                        {PUNCH_TYPES.map((value) => (
                          <option key={value} value={value}>{label(value)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="draft-physical-hand" className="t-label">Physical hand</label>
                      <select
                        id="draft-physical-hand"
                        className="select"
                        value={draft.physicalHand}
                        onChange={(e) => setDraft({ ...draft, physicalHand: e.target.value })}
                      >
                        <option value="">{CHOOSE}</option>
                        {PHYSICAL_HANDS.map((value) => (
                          <option key={value} value={value}>{label(value)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="draft-hand-role" className="t-label">Hand role</label>
                      <select
                        id="draft-hand-role"
                        className="select"
                        value={draft.handRole}
                        onChange={(e) => setDraft({ ...draft, handRole: e.target.value })}
                      >
                        <option value="">{CHOOSE}</option>
                        {HAND_ROLES.map((value) => (
                          <option key={value} value={value}>{label(value)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="draft-target-zone" className="t-label">Target zone (aimed at)</label>
                      <select
                        id="draft-target-zone"
                        className="select"
                        value={draft.targetZone}
                        onChange={(e) => setDraft({ ...draft, targetZone: e.target.value })}
                      >
                        <option value="">{CHOOSE}</option>
                        {TARGET_ZONES.map((value) => (
                          <option key={value} value={value}>{label(value)}</option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="draft-contact-result" className="t-label">Contact result</label>
                      <select
                        id="draft-contact-result"
                        className="select"
                        value={draft.contactResult}
                        onChange={(e) => setDraft({ ...draft, contactResult: e.target.value })}
                      >
                        <option value="">{CHOOSE}</option>
                        {CONTACT_RESULTS.map((value) => (
                          <option key={value} value={value}>{label(value)}</option>
                        ))}
                      </select>
                    </div>
                  </>
                ) : (
                  <div className="field">
                    <label htmlFor="draft-defense-type" className="t-label">Defense type</label>
                    <select
                      id="draft-defense-type"
                      className="select"
                      value={draft.defenseType}
                      onChange={(e) => setDraft({ ...draft, defenseType: e.target.value })}
                    >
                      <option value="">{CHOOSE}</option>
                      {DEFENSE_TYPES.map((value) => (
                        <option key={value} value={value}>{label(value)}</option>
                      ))}
                    </select>
                  </div>
                )}

                {/* NEVER BEHIND PROGRESSIVE DISCLOSURE. visibility is a
                    property of the footage and certainty a property of the
                    annotator; between them they are what makes a disagreement
                    interpretable rather than just a number. Both are required
                    on every event, and both start unset. */}
                <div className="field">
                  <label htmlFor="draft-visibility" className="t-label">Visibility (of the footage)</label>
                  <select
                    id="draft-visibility"
                    className="select"
                    value={draft.visibility}
                    onChange={(e) => setDraft({ ...draft, visibility: e.target.value })}
                  >
                    <option value="">{CHOOSE}</option>
                    {VISIBILITIES.map((value) => (
                      <option key={value} value={value}>{label(value)}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="draft-certainty" className="t-label">Certainty (yours)</label>
                  <select
                    id="draft-certainty"
                    className="select"
                    value={draft.certainty}
                    onChange={(e) => setDraft({ ...draft, certainty: e.target.value })}
                  >
                    <option value="">{CHOOSE}</option>
                    {ANNOTATION_CERTAINTIES.map((value) => (
                      <option key={value} value={value}>{label(value)}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* ON A BODY-POINT SET the contact time is not optional detail:
                  a punch that made contact is marked AT contact
                  (OD-2026-10-02-011 3a), so the database requires contact_ms
                  on a contact result and the field is asked in the open. */}
              {isBodyPointSet && draft.eventClass === 'punch' ? (
                <div className="field mt-[var(--s3)] md:max-w-[50%]">
                  <label htmlFor="draft-contact-ms" className="t-label">
                    Contact (ms, video time) — required when the punch made contact
                  </label>
                  <input
                    id="draft-contact-ms"
                    className="input"
                    inputMode="numeric"
                    value={draft.contactMs}
                    onChange={(e) => setDraft({ ...draft, contactMs: e.target.value })}
                  />
                  <button
                    type="button"
                    className="btn btn--ghost mt-[var(--s2)]"
                    onClick={() => setDraft({
                      ...draft,
                      contactMs: String(clampMsToClip(currentMs, clip.start_ms, clip.end_ms)),
                    })}
                  >
                    Mark contact at playhead
                  </button>
                </div>
              ) : null}

              <details className="mt-[var(--s3)]">
                <summary className="t-label">Optional detail</summary>
                <div className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                  {/* Stance and peak are 0.1's. On a body-point set the lead
                      side is recorded at each marked moment instead, and
                      there is no peak (OD-2026-10-02-008 3A); the database
                      refuses either on such a set, so neither is asked. */}
                  {!isBodyPointSet ? (
                    <div className="field">
                      <label htmlFor="draft-stance" className="t-label">Stance</label>
                      <select
                        id="draft-stance"
                        className="select"
                        value={draft.stance}
                        onChange={(e) => setDraft({ ...draft, stance: e.target.value })}
                      >
                        <option value="">{CHOOSE}</option>
                        {STANCES.map((value) => (
                          <option key={value} value={value}>{label(value)}</option>
                        ))}
                      </select>
                    </div>
                  ) : null}

                  {draft.eventClass === 'punch' ? (
                    <>
                      {!isBodyPointSet ? (
                        <>
                          <div className="field">
                            <label htmlFor="draft-contact-ms" className="t-label">Contact (ms, video time)</label>
                            <input
                              id="draft-contact-ms"
                              className="input"
                              inputMode="numeric"
                              value={draft.contactMs}
                              onChange={(e) => setDraft({ ...draft, contactMs: e.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label htmlFor="draft-peak-ms" className="t-label">Peak (ms, video time)</label>
                            <input
                              id="draft-peak-ms"
                              className="input"
                              inputMode="numeric"
                              value={draft.peakMs}
                              onChange={(e) => setDraft({ ...draft, peakMs: e.target.value })}
                            />
                          </div>
                        </>
                      ) : null}
                      <div className="field">
                        <label htmlFor="draft-contact-zone" className="t-label">Contact zone (what it reached)</label>
                        <select
                          id="draft-contact-zone"
                          className="select"
                          value={draft.contactZone}
                          onChange={(e) => setDraft({ ...draft, contactZone: e.target.value })}
                        >
                          <option value="">{CHOOSE}</option>
                          {CONTACT_ZONES.map((value) => (
                            <option key={value} value={value}>{label(value)}</option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label htmlFor="draft-combination" className="t-label">Combination group</label>
                        <input
                          id="draft-combination"
                          className="input"
                          value={draft.combinationGroup}
                          onChange={(e) => setDraft({ ...draft, combinationGroup: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="draft-sequence" className="t-label">Position in the combination</label>
                        <input
                          id="draft-sequence"
                          className="input"
                          inputMode="numeric"
                          value={draft.sequenceOrder}
                          onChange={(e) => setDraft({ ...draft, sequenceOrder: e.target.value })}
                        />
                      </div>
                      <div className="field">
                        <label htmlFor="draft-counter" className="t-label">Counter against</label>
                        <select
                          id="draft-counter"
                          className="select"
                          value={draft.counterAgainstEventId}
                          onChange={(e) => setDraft({ ...draft, counterAgainstEventId: e.target.value })}
                        >
                          <option value="">not a counter</option>
                          {events
                            .filter((row) => row.event_id !== draft.replacingEventId)
                            .map((row) => (
                              <option key={row.event_id} value={row.event_id}>
                                {label(row.event_class)} at {formatMediaOffset(row.start_ms)}
                              </option>
                            ))}
                        </select>
                      </div>
                    </>
                  ) : (
                    <div className="field">
                      <label htmlFor="draft-defends" className="t-label">Defends against</label>
                      <select
                        id="draft-defends"
                        className="select"
                        value={draft.defendsAgainstEventId}
                        onChange={(e) => setDraft({ ...draft, defendsAgainstEventId: e.target.value })}
                      >
                        <option value="">not tied to one punch</option>
                        {events
                          .filter((row) => row.event_class === 'punch' && row.event_id !== draft.replacingEventId)
                          .map((row) => (
                            <option key={row.event_id} value={row.event_id}>
                              punch at {formatMediaOffset(row.start_ms)}
                            </option>
                          ))}
                      </select>
                    </div>
                  )}
                </div>
              </details>

              <div className="mt-[var(--s4)] flex gap-[var(--s2)]">
                <button type="button" className="btn" disabled={busy} onClick={() => { void saveDraft(); }}>
                  {draft.replacingEventId ? 'Save replacement' : 'Save event'}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </section>
          ) : null}

          {annotationSet && canEdit ? (
            <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
              <h2 className="t-eyebrow">Submit</h2>
              <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
                Submitting closes this pass for good. You will not be able to add, change or remove
                an event afterwards, and there is no un-submit anywhere in the platform.
              </p>
              {confirmingSubmit ? (
                <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s2)]">
                  <button type="button" className="btn" disabled={busy} onClick={() => { void submitSet(); }}>
                    Yes, submit {events.length} event{events.length === 1 ? '' : 's'} and lock this set
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => setConfirmingSubmit(false)}>
                    Keep working
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn mt-[var(--s3)]"
                  onClick={() => setConfirmingSubmit(true)}
                >
                  Submit annotation set
                </button>
              )}
            </section>
          ) : null}
      </div>
    </RoleStandaloneView>
  );
}
