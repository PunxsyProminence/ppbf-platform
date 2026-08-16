'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

const ML_PLACEHOLDER = 'PLANNED | ML REQUIRED | NOT YET AUTOMATED';

interface VideoSession {
  video_session_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
  created_at: string;
}

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

// Mirrors VideoAnalysisResponse in app/api/pilot/shadow/video-analysis/route.ts.
type FilmStudyJobStatus = 'requesting' | 'queued' | 'processing' | 'completed' | 'failed' | 'unavailable';

interface FilmStudyJobState {
  status: FilmStudyJobStatus;
  jobId?: string;
  message: string;
}

// Mirrors FilmStudyProposalRow in src/server/pilot/shadowFilmStudyProposals.ts,
// trimmed to what this page renders.
interface FilmStudyProposal {
  proposal_id: string;
  athlete_id: string;
  video_session_id: string;
  observation_text: string;
  model_deployment: string;
  frames_analyzed: number;
  review_state: 'pending_review' | 'accepted' | 'rejected';
  created_at: string;
}

/**
 * The shape GET /api/pilot/shadow/film-study/validation returns.
 *
 * Declared here rather than imported from filmStudyValidation.ts, matching the
 * other interfaces on this page: that module imports ./db, and importing it as
 * a VALUE from a 'use client' component would pull the Postgres driver into
 * the browser bundle.
 *
 * `acceptRate` is null on purpose whenever the sample is below
 * `minimumReviewed` -- the server withholds it rather than computing a
 * percentage from a handful of reviews, and the UI must render that absence as
 * an absence.
 */
interface FilmStudyDeploymentAcceptance {
  modelDeployment: string;
  status: 'available' | 'insufficient_data';
  reviewedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  pendingCount: number;
  acceptRate: number | null;
  meanFramesAnalyzed: number | null;
}

interface FilmStudyValidationReport {
  organizationId: string;
  minimumReviewed: number;
  overall: {
    status: 'available' | 'insufficient_data';
    reviewedCount: number;
    acceptedCount: number;
    rejectedCount: number;
    pendingCount: number;
    acceptRate: number | null;
  };
  byDeployment: FilmStudyDeploymentAcceptance[];
}

const mlPanels = [
  { title: 'Skill Recognition', detail: ML_PLACEHOLDER },
  { title: 'Punch Detection', detail: ML_PLACEHOLDER },
  { title: 'Footwork Analysis', detail: ML_PLACEHOLDER },
  { title: 'Technique Scoring', detail: ML_PLACEHOLDER },
  { title: 'Movement Analysis', detail: ML_PLACEHOLDER },
];

// Film Study jobs are enqueued but nothing here forces the SHADOW worker to be
// running (the route enqueues unconditionally -- see PR discussion on
// PPBF_SHADOW_WORKER_ENABLED). Polling stops rather than spinning forever, and
// says so honestly instead of pretending the job failed.
const FILM_STUDY_POLL_FAST_MS = 3_000;
const FILM_STUDY_POLL_FAST_ATTEMPTS = 20; // ~1 minute
const FILM_STUDY_POLL_SLOW_MS = 15_000;
const FILM_STUDY_POLL_SLOW_ATTEMPTS = 20; // ~5 more minutes
const FILM_STUDY_STILL_PROCESSING_MESSAGE =
  'Still processing. This page stopped checking, but the job continues -- '
  + 'reopen this page to see the result, or check the review queue below once it lands. '
  + 'If this never resolves, background jobs may not be enabled for this environment.';

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function CoachVideoAnalysisPage() {
  const session = usePilotSession();
  const [videos, setVideos] = useState<VideoSession[]>([]);
  const [videoError, setVideoError] = useState('');
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [observationError, setObservationError] = useState('');
  const [releasingVideoId, setReleasingVideoId] = useState<string | null>(null);
  const [previewingVideoId, setPreviewingVideoId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadTitle, setUploadTitle] = useState('');
  const [uploadNotes, setUploadNotes] = useState('');
  const [uploadAthleteId, setUploadAthleteId] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState('');

  const [activeVideo, setActiveVideo] = useState<{ url: string; title: string } | null>(null);
  const [loadingVideoId, setLoadingVideoId] = useState<string | null>(null);

  const [filmStudyJobs, setFilmStudyJobs] = useState<Record<string, FilmStudyJobState>>({});
  const [proposals, setProposals] = useState<FilmStudyProposal[]>([]);
  const [proposalsError, setProposalsError] = useState('');
  const [resolvingProposalId, setResolvingProposalId] = useState<string | null>(null);

  const [validation, setValidation] = useState<FilmStudyValidationReport | null>(null);
  const [validationSummary, setValidationSummary] = useState('');
  const [validationError, setValidationError] = useState('');

  // Reloaded alongside the queue, and again after every verdict: settling a
  // proposal changes the very number this panel reports, so a stale figure
  // above a queue the coach just worked would be the wrong kind of wrong.
  const loadValidation = () => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/shadow/film-study/validation`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Unable to load the model accuracy measurement');
        const data = (await res.json()) as {
          validation?: FilmStudyValidationReport;
          summary?: string;
        };
        if (!data.validation) throw new Error('Unable to load the model accuracy measurement');
        setValidation(data.validation);
        setValidationSummary(data.summary ?? '');
        setValidationError('');
      } catch (err) {
        setValidation(null);
        setValidationError(err instanceof Error ? err.message : 'Unable to load the model accuracy measurement');
      }
    })();
  };

  const loadProposals = () => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/shadow/film-study/proposals?state=pending`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error('Unable to load the Film Study review queue');
        const data = (await res.json()) as { proposals?: FilmStudyProposal[] };
        setProposals(data.proposals ?? []);
        setProposalsError('');
      } catch (err) {
        setProposalsError(err instanceof Error ? err.message : 'Unable to load the Film Study review queue');
      }
    })();
  };

  const pollFilmStudyJob = (videoSessionId: string, jobId: string, attempt: number) => {
    const isFastPhase = attempt < FILM_STUDY_POLL_FAST_ATTEMPTS;
    const attemptsRemainingInPhase = isFastPhase
      ? FILM_STUDY_POLL_FAST_ATTEMPTS - attempt
      : FILM_STUDY_POLL_FAST_ATTEMPTS + FILM_STUDY_POLL_SLOW_ATTEMPTS - attempt;
    const delayMs = isFastPhase ? FILM_STUDY_POLL_FAST_MS : FILM_STUDY_POLL_SLOW_MS;

    if (attemptsRemainingInPhase <= 0) {
      setFilmStudyJobs((current) => ({
        ...current,
        [videoSessionId]: { status: 'processing', jobId, message: FILM_STUDY_STILL_PROCESSING_MESSAGE },
      }));
      return;
    }

    setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `${apiBase()}/api/pilot/shadow/video-analysis?jobId=${encodeURIComponent(jobId)}`,
            { credentials: 'include' },
          );
          const data = (await res.json().catch(() => ({}))) as {
            status?: FilmStudyJobStatus;
            message?: string;
          };
          const status = data.status ?? 'failed';
          const message = data.message ?? 'Film Study job status unavailable.';

          setFilmStudyJobs((current) => ({ ...current, [videoSessionId]: { status, jobId, message } }));

          if (status === 'completed') {
            loadProposals();
            return;
          }
          if (status === 'failed' || status === 'unavailable') {
            return;
          }
          pollFilmStudyJob(videoSessionId, jobId, attempt + 1);
        } catch {
          // A transient network error while polling is not the job failing --
          // keep trying on the same schedule rather than reporting failure for
          // a fetch that simply didn't land.
          pollFilmStudyJob(videoSessionId, jobId, attempt + 1);
        }
      })();
    }, delayMs);
  };

  const requestFilmStudy = async (videoSessionId: string) => {
    setFilmStudyJobs((current) => ({
      ...current,
      [videoSessionId]: { status: 'requesting', message: 'Requesting Film Study analysis...' },
    }));

    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/video-analysis`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoSessionId }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        status?: FilmStudyJobStatus;
        jobId?: string;
        message?: string;
      };
      const status = data.status ?? 'failed';
      const message = data.message ?? `Request failed (${res.status}).`;

      setFilmStudyJobs((current) => ({
        ...current,
        [videoSessionId]: { status, jobId: data.jobId, message },
      }));

      if (status === 'queued' && data.jobId) {
        pollFilmStudyJob(videoSessionId, data.jobId, 0);
      }
    } catch (err) {
      setFilmStudyJobs((current) => ({
        ...current,
        [videoSessionId]: {
          status: 'failed',
          message: err instanceof Error ? err.message : 'Request failed.',
        },
      }));
    }
  };

  const resolveProposal = async (proposal: FilmStudyProposal, verdict: 'accepted' | 'rejected') => {
    setResolvingProposalId(proposal.proposal_id);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/shadow/film-study/proposals`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: proposal.proposal_id, verdict }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Could not record verdict (${res.status}).`);
      }
      // The settled proposal leaves the pending queue either way -- accepting
      // and rejecting are both an exit, not just accepting.
      setProposals((current) => current.filter((p) => p.proposal_id !== proposal.proposal_id));
      setProposalsError('');
      // This verdict IS one more data point in the measurement above, so the
      // panel is re-read rather than left showing the figure from before the
      // coach acted.
      loadValidation();
    } catch (err) {
      setProposalsError(err instanceof Error ? err.message : 'Could not record verdict.');
    } finally {
      setResolvingProposalId(null);
    }
  };

  const loadVideos = () => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/video/list`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load video library');
        const data = (await res.json()) as { items: VideoSession[] };
        setVideos(data.items ?? []);
        setVideoError('');
      } catch (err) {
        setVideoError(err instanceof Error ? err.message : 'Failed to load video library');
      }
    })();
  };

  useEffect(() => {
    loadVideos();
    loadProposals();
    loadValidation();
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
        credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 30 }),
        });
        if (!res.ok) throw new Error('Unable to load SHADOW observations');
        const data = (await res.json()) as { items?: ShadowObservationItem[] };
        setObservations(data.items ?? []);
      } catch (err) {
        setObservationError(err instanceof Error ? err.message : 'Unable to load SHADOW observations');
      }
    })();
  }, []);

  const handleUpload = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = fileInputRef.current?.files?.[0];
    if (!file) { setUploadStatus('Select a video file first.'); return; }
    setUploading(true);
    setUploadStatus('Uploading...');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('title', uploadTitle || file.name);
      form.append('notes', uploadNotes);
      if (uploadAthleteId.trim()) form.append('athlete_id', uploadAthleteId.trim());
      const res = await fetch(`${apiBase()}/api/pilot/video/upload`, {
        credentials: 'include', method: 'POST', body: form });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Upload failed (${res.status})`);
      }
      setUploadStatus('Upload accepted and held for review. Release it in the library below to make it playable.');
      setUploadTitle(''); setUploadNotes(''); setUploadAthleteId('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadVideos();
    } catch (err) {
      setUploadStatus(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  // The uploading coach is the person who can attest that the footage is what
  // it claims to be, so only they -- and organization admins -- are offered
  // the control. The API enforces the same boundary.
  const canRelease = (video: VideoSession): boolean => {
    if (video.status !== 'quarantined') return false;
    if (isOrganizationAdminSessionRole(session.role)) return true;
    return session.accountId !== null && video.uploaded_by_account_id === session.accountId;
  };

  // Watch a video BEFORE releasing it. The ordinary read path refuses
  // anything that is not 'ready', so until this existed the Release button
  // was a click made blind -- a release that cannot see the footage is the
  // rubber stamp intake/document-link already warned about for documents.
  // The link is a 15-minute SAS and every issuance is audited.
  const previewForRelease = async (videoId: string, title: string) => {
    setPreviewingVideoId(videoId);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/video/review-link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_session_id: videoId }),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; title?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? `Could not open video (${res.status})`);
      setActiveVideo({ url: data.url, title: data.title ?? title });
      setVideoError('');
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : 'Failed to open video for review');
    } finally {
      setPreviewingVideoId(null);
    }
  };

  const releaseVideo = async (videoId: string) => {
    setReleasingVideoId(videoId);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/video/${videoId}/release`, {
        credentials: 'include',
        method: 'POST',
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Release failed (${res.status})`);
      }
      setVideoError('');
      loadVideos();
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : 'Release failed.');
    } finally {
      setReleasingVideoId(null);
    }
  };

  const openVideo = async (videoId: string) => {
    setLoadingVideoId(videoId);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/video/${videoId}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Could not load video');
      const data = (await res.json()) as { stream_url: string; title: string };
      setActiveVideo({ url: data.stream_url, title: data.title });
    } catch (err) {
      setVideoError(err instanceof Error ? err.message : 'Failed to open video');
    } finally {
      setLoadingVideoId(null);
    }
  };

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/video-analysis" allowedRoles={['coach', 'admin']} showShellHeader={false} room="floor">
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Video Analysis</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Coach Video Console</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Upload session footage and review athlete film. An upload is held until you release it, and only then can it
            be played. A released video can be sent for Film Study -- a vision-based observation that waits for your
            review below before it touches any athlete record. Per-skill scoring (punch detection, footwork, and the
            rest) remains planned and is not yet active.
          </p>
        </header>

        {activeVideo ? (
          <section className="frame">
            <div className="rivet rivet--tl" />
            <div className="rivet rivet--tr" />
            <div className="rivet rivet--bl" />
            <div className="rivet rivet--br" />
            <div className="frame-in mat-leather p-[var(--s4)]">
              <div className="flex items-center justify-between gap-[var(--s3)]">
                <h2 className="t-eyebrow">{activeVideo.title}</h2>
                <button onClick={() => setActiveVideo(null)} className="btn btn--ghost">Close</button>
              </div>
              <video className="mt-[var(--s3)] w-full max-h-[480px] rounded-[var(--r-sm)] bg-[var(--hide-950)]" src={activeVideo.url} controls>
                <track kind="captions" />
              </video>
            </div>
          </section>
        ) : null}

        <div className="grid gap-[var(--s5)] lg:grid-cols-2">
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-eyebrow">Upload Session Footage</h2>
            <form onSubmit={(e) => { void handleUpload(e); }} className="mt-[var(--s3)] space-y-[var(--s3)]">
              <div className="field">
                <label htmlFor="video-file" className="t-label">Video File (MP4, MOV, AVI, WebM, MPEG — interim max 50 MB)</label>
                <input id="video-file" ref={fileInputRef} type="file" accept="video/*" className="input file:border-0 file:rounded-[var(--r-sm)] file:bg-[var(--hide-700)] file:text-[color:var(--brass-300)] file:font-mono file:text-[length:var(--t-xs)]" />
              </div>
              <div className="field">
                <label htmlFor="upload-title" className="t-label">Title</label>
                <input id="upload-title" type="text" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="e.g. Sparring Round 3 — July 16" className="input" />
              </div>
              <div className="field">
                <label htmlFor="upload-athlete" className="t-label">Athlete ID (optional)</label>
                <input id="upload-athlete" type="text" value={uploadAthleteId} onChange={(e) => setUploadAthleteId(e.target.value)} placeholder="Link to specific athlete" className="input" />
              </div>
              <div className="field">
                <label htmlFor="upload-notes" className="t-label">Notes</label>
                <textarea id="upload-notes" value={uploadNotes} onChange={(e) => setUploadNotes(e.target.value)} rows={2} placeholder="Coaching context, drill type, focus area..." className="textarea" />
              </div>
              <button type="submit" disabled={uploading} className="btn disabled:opacity-50">
                {uploading ? 'Uploading...' : 'Upload Video'}
              </button>
              {uploadStatus ? <p className="t-data text-[color:var(--bone-300)]">{uploadStatus}</p> : null}
            </form>
          </section>

          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-eyebrow">SHADOW Observation Stream</h2>
            <div className="mt-[var(--s3)] space-y-[var(--s3)] max-h-72 overflow-y-auto">
              {observationError ? <p className="text-[length:var(--t-xs)] text-[var(--locked-ink)]">{observationError}</p> : null}
              {!observationError && observations.length === 0 ? <p className="t-muted text-[color:var(--bone-300)]">No observations available.</p> : null}
              {observations.slice(0, 8).map((item) => (
                <div key={item.id} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                  <p className="text-[length:var(--t-xs)] font-semibold text-[color:var(--bone-200)]">{item.label}</p>
                  <p className="text-[length:var(--t-xs)] text-[color:var(--bone-300)]">Source: {item.source} · {item.review_state}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <h2 className="t-eyebrow">Video Library</h2>
          {videoError ? <p className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{videoError}</p> : null}
          {!videoError && videos.length === 0 ? (
            <p className="t-muted mt-[var(--s3)] text-[color:var(--bone-300)]">No videos uploaded yet.</p>
          ) : (
            <div className="mt-[var(--s3)] space-y-[var(--s3)]">
              {videos.map((v) => (
                <div key={v.video_session_id} className="mat-leather--raised flex flex-wrap items-center justify-between gap-[var(--s3)] rounded-[var(--r-md)] p-[var(--s3)]">
                  <div>
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{v.title}</p>
                      {v.status === 'quarantined' ? (
                        <span className="badge badge--restricted"><i>▲</i>Held for review</span>
                      ) : v.status === 'ready' ? (
                        <span className="badge badge--cleared"><i>✓</i>Released</span>
                      ) : (
                        <span className="badge badge--monitor"><i>◉</i>{v.status}</span>
                      )}
                    </div>
                    <p className="t-data mt-[var(--s2)] text-[color:var(--bone-300)]">
                      {v.file_name} · {formatBytes(v.file_size_bytes)}
                      {v.athlete_id ? ` · Athlete: ${v.athlete_id}` : ''}
                    </p>
                    <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">{formatGymStamp(v.created_at)}</p>
                    {v.status === 'quarantined' ? (
                      <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                        {canRelease(v)
                          ? 'Held for review. Release it to make it playable for the athlete and their guardians.'
                          : 'Held for review by the coach who uploaded it.'}
                      </p>
                    ) : null}
                    {filmStudyJobs[v.video_session_id] ? (
                      <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]" data-testid={`film-study-status-${v.video_session_id}`}>
                        Film Study: {filmStudyJobs[v.video_session_id].message}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-[var(--s3)]">
                    {canRelease(v) ? (
                      <>
                        <button onClick={() => { void previewForRelease(v.video_session_id, v.title); }} disabled={previewingVideoId === v.video_session_id} className="btn btn--ghost disabled:opacity-50">
                          {previewingVideoId === v.video_session_id ? 'Opening...' : 'Watch first'}
                        </button>
                        <button onClick={() => { void releaseVideo(v.video_session_id); }} disabled={releasingVideoId === v.video_session_id} className="btn disabled:opacity-50">
                          {releasingVideoId === v.video_session_id ? 'Releasing...' : 'Release'}
                        </button>
                      </>
                    ) : null}
                    <button onClick={() => { void openVideo(v.video_session_id); }} disabled={v.status !== 'ready' || loadingVideoId === v.video_session_id} className="btn btn--ghost disabled:opacity-50">
                      {v.status !== 'ready' ? 'Not released' : loadingVideoId === v.video_session_id ? 'Loading...' : 'Play'}
                    </button>
                    {v.status === 'ready' ? (
                      <button
                        onClick={() => { void requestFilmStudy(v.video_session_id); }}
                        disabled={['requesting', 'queued', 'processing'].includes(filmStudyJobs[v.video_session_id]?.status ?? '')}
                        className="btn btn--ghost disabled:opacity-50"
                      >
                        {filmStudyJobs[v.video_session_id]?.status === 'requesting'
                          ? 'Requesting...'
                          : ['queued', 'processing'].includes(filmStudyJobs[v.video_session_id]?.status ?? '')
                            ? 'Analyzing...'
                            : 'Request Film Study'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* How often this gym's coaches have accepted what the model proposed.
            Sits ABOVE the queue on purpose: a coach about to spend twenty
            minutes clearing proposals should know first whether the last
            hundred were worth clearing. Every figure comes from verdicts
            coaches already gave -- nothing here is a benchmark borrowed from
            somebody else's gym, and nothing here says anything about an
            athlete. It measures the model. */}
        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <h2 className="t-eyebrow">How Often This Model Is Right</h2>
          {validationError ? (
            <p className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{validationError}</p>
          ) : validation === null ? (
            <p className="t-muted mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>
          ) : (
            <>
              <p className="t-body mt-[var(--s2)] text-[color:var(--bone-100)]" data-testid="film-study-validation-summary">
                {validationSummary}
              </p>
              <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-400)]">
                Measured from this gym&apos;s own accept/reject verdicts, not from a published benchmark. It rates the
                model, never an athlete.
              </p>

              {validation.byDeployment.length > 0 && (
                <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
                  {validation.byDeployment.map((d) => (
                    <li
                      key={d.modelDeployment}
                      className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]"
                    >
                      <p className="t-data text-[color:var(--bone-300)]">{d.modelDeployment}</p>
                      <p className="mt-[var(--s1)] text-[length:var(--t-sm)] text-[color:var(--bone-100)]">
                        {/* The rate never appears without the sample it came
                            from, and is withheld entirely below the floor
                            rather than computed from a handful of reviews. */}
                        {d.acceptRate === null
                          ? `${d.acceptedCount} accepted of ${d.reviewedCount} reviewed — too few to state a rate (${validation.minimumReviewed} needed).`
                          : `${Math.round(d.acceptRate * 100)}% accepted (${d.acceptedCount} of ${d.reviewedCount} reviewed)`}
                        {d.meanFramesAnalyzed === null ? '' : ` · ${d.meanFramesAnalyzed} frames avg`}
                      </p>
                      {d.pendingCount > 0 && (
                        <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                          {d.pendingCount} still waiting on a coach
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <h2 className="t-eyebrow">Film Study Review Queue</h2>
          <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">
            A vision observation about an athlete never touches their record on its own -- it lands here first, and
            only a human verdict settles it.
          </p>
          {proposalsError ? <p className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{proposalsError}</p> : null}
          {!proposalsError && proposals.length === 0 ? (
            <p className="t-muted mt-[var(--s3)] text-[color:var(--bone-300)]">No Film Study observations awaiting review.</p>
          ) : (
            <div className="mt-[var(--s3)] space-y-[var(--s3)]">
              {proposals.map((p) => (
                <div key={p.proposal_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]">
                  <p className="t-data text-[color:var(--bone-300)]">
                    Athlete: {p.athlete_id} · {p.frames_analyzed} frame(s) · {p.model_deployment}
                  </p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--bone-100)]">{p.observation_text}</p>
                  <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">{formatGymStamp(p.created_at)}</p>
                  <div className="mt-[var(--s3)] flex gap-[var(--s3)]">
                    <button
                      onClick={() => { void resolveProposal(p, 'accepted'); }}
                      disabled={resolvingProposalId === p.proposal_id}
                      className="btn disabled:opacity-50"
                    >
                      {resolvingProposalId === p.proposal_id ? 'Recording...' : 'Accept'}
                    </button>
                    <button
                      onClick={() => { void resolveProposal(p, 'rejected'); }}
                      disabled={resolvingProposalId === p.proposal_id}
                      className="btn btn--ghost disabled:opacity-50"
                    >
                      {resolvingProposalId === p.proposal_id ? 'Recording...' : 'Reject'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
          <h2 className="t-eyebrow">AI/ML Analysis — Planned Features</h2>
          <p className="mt-[var(--s3)]"><span className="stamp stamp--brass stamp--flat">Planned — Not Yet Implemented</span></p>
          <div className="mt-[var(--s3)] grid gap-[var(--s3)] sm:grid-cols-2 lg:grid-cols-3">
            {mlPanels.map((p) => (
              <div key={p.title} className="rounded-[var(--r-sm)] border border-[color:rgba(212,175,74,.18)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
                <p className="text-[length:var(--t-xs)] font-semibold text-[color:var(--bone-300)]">{p.title}</p>
                <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">{p.detail}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/environment/intake-router" className="btn btn--ghost">
            Back to Coach Workspace
          </Link>
          <Link href="/operations" className="btn btn--ghost">
            Mission Control
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
