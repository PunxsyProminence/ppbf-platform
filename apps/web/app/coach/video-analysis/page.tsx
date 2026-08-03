'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { isOrganizationAdminSessionRole, usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';

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

const mlPanels = [
  { title: 'Skill Recognition', detail: ML_PLACEHOLDER },
  { title: 'Punch Detection', detail: ML_PLACEHOLDER },
  { title: 'Footwork Analysis', detail: ML_PLACEHOLDER },
  { title: 'Technique Scoring', detail: ML_PLACEHOLDER },
  { title: 'Movement Analysis', detail: ML_PLACEHOLDER },
];

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
            be played. AI/ML scoring features are planned and not yet active.
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
                    <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">{new Date(v.created_at).toLocaleString()}</p>
                    {v.status === 'quarantined' ? (
                      <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                        {canRelease(v)
                          ? 'Held for review. Release it to make it playable for the athlete and their guardians.'
                          : 'Held for review by the coach who uploaded it.'}
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
          <Link href="/coach/review-queue" className="btn btn--ghost">
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
