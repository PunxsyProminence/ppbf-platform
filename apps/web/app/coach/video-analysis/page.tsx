'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
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
  const [videos, setVideos] = useState<VideoSession[]>([]);
  const [videoError, setVideoError] = useState('');
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [observationError, setObservationError] = useState('');

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
        const res = await fetch(`${apiBase()}/api/pilot/video/list`);
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
      const res = await fetch(`${apiBase()}/api/pilot/video/upload`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Upload failed (${res.status})`);
      }
      setUploadStatus('Upload accepted and quarantined for security review.');
      setUploadTitle(''); setUploadNotes(''); setUploadAthleteId('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadVideos();
    } catch (err) {
      setUploadStatus(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const openVideo = async (videoId: string) => {
    setLoadingVideoId(videoId);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/video/${videoId}`);
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
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/video-analysis" allowedRoles={['coach']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--gray-dark)]">Video Analysis</p>
          <h1 className="mt-2 text-3xl font-black text-[var(--black)]">Coach Video Console</h1>
          <p className="mt-2 text-sm leading-6 text-[var(--gray-dark)]">
            Upload session footage and review athlete film. AI/ML scoring features are planned and not yet active.
          </p>
        </header>

        {activeVideo ? (
          <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">{activeVideo.title}</h2>
              <button onClick={() => setActiveVideo(null)} className="text-xs font-mono text-[var(--gray-dark)] underline">Close</button>
            </div>
            <video className="mt-3 w-full max-h-[480px] bg-black" src={activeVideo.url} controls>
              <track kind="captions" />
            </video>
          </section>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Upload Session Footage</h2>
            <form onSubmit={(e) => { void handleUpload(e); }} className="mt-3 space-y-3">
              <div>
                <label htmlFor="video-file" className="block text-xs font-mono uppercase text-[var(--gray-dark)]">Video File (MP4, MOV, AVI, WebM, MPEG — interim max 50 MB)</label>
                <input id="video-file" ref={fileInputRef} type="file" accept="video/*" className="mt-1 tactical-input text-xs file:border-0 file:bg-[var(--canvas-tan-dark)] file:text-[var(--black)] file:font-mono file:text-xs" />
              </div>
              <div>
                <label htmlFor="upload-title" className="block text-xs font-mono uppercase text-[var(--gray-dark)]">Title</label>
                <input id="upload-title" type="text" value={uploadTitle} onChange={(e) => setUploadTitle(e.target.value)} placeholder="e.g. Sparring Round 3 — July 16" className="mt-1 tactical-input text-xs placeholder-[var(--gray-dark)]" />
              </div>
              <div>
                <label htmlFor="upload-athlete" className="block text-xs font-mono uppercase text-[var(--gray-dark)]">Athlete ID (optional)</label>
                <input id="upload-athlete" type="text" value={uploadAthleteId} onChange={(e) => setUploadAthleteId(e.target.value)} placeholder="Link to specific athlete" className="mt-1 tactical-input text-xs placeholder-[var(--gray-dark)]" />
              </div>
              <div>
                <label htmlFor="upload-notes" className="block text-xs font-mono uppercase text-[var(--gray-dark)]">Notes</label>
                <textarea id="upload-notes" value={uploadNotes} onChange={(e) => setUploadNotes(e.target.value)} rows={2} placeholder="Coaching context, drill type, focus area..." className="mt-1 tactical-input text-xs placeholder-[var(--gray-dark)]" />
              </div>
              <button type="submit" disabled={uploading} className="tactical-btn">
                {uploading ? 'Uploading...' : 'Upload Video'}
              </button>
              {uploadStatus ? <p className="text-xs font-mono text-[var(--gray-dark)]">{uploadStatus}</p> : null}
            </form>
          </section>

          <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <h2 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">SHADOW Observation Stream</h2>
            <div className="mt-3 space-y-2 max-h-72 overflow-y-auto">
              {observationError ? <p className="text-xs text-[var(--red-primary)]">{observationError}</p> : null}
              {!observationError && observations.length === 0 ? <p className="text-xs text-[var(--gray-dark)]">No observations available.</p> : null}
              {observations.slice(0, 8).map((item) => (
                <div key={item.id} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-2">
                  <p className="text-xs font-semibold text-[var(--black)]">{item.label}</p>
                  <p className="text-xs text-[var(--gray-dark)]">Source: {item.source} · {item.review_state}</p>
                </div>
              ))}
            </div>
          </section>
        </div>

        <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[var(--red-primary)]">Video Library</h2>
          {videoError ? <p className="mt-2 text-xs text-[var(--red-primary)]">{videoError}</p> : null}
          {!videoError && videos.length === 0 ? (
            <p className="mt-3 text-xs text-[var(--gray-dark)]">No videos uploaded yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {videos.map((v) => (
                <div key={v.video_session_id} className="flex items-center justify-between border border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                  <div>
                    <p className="text-sm font-semibold text-[var(--black)]">{v.title}</p>
                    <p className="mt-0.5 text-xs text-[var(--gray-dark)]">
                      {v.file_name} · {formatBytes(v.file_size_bytes)} · {v.status}
                      {v.athlete_id ? ` · Athlete: ${v.athlete_id}` : ''}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--gray-dark)]">{new Date(v.created_at).toLocaleString()}</p>
                  </div>
                  <button onClick={() => { void openVideo(v.video_session_id); }} disabled={v.status !== 'ready' || loadingVideoId === v.video_session_id} className="tactical-btn ml-4">
                    {v.status !== 'ready' ? 'Security review' : loadingVideoId === v.video_session_id ? 'Loading...' : 'Play'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[var(--gray-dark)]">AI/ML Analysis — Planned Features</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {mlPanels.map((p) => (
              <div key={p.title} className="border border-[var(--black)] bg-[var(--canvas-tan-light)] p-3">
                <p className="text-xs font-semibold text-[var(--gray-dark)]">{p.title}</p>
                <p className="mt-1 text-xs font-mono uppercase tracking-[0.07em] text-[var(--gray-dark)]">{p.detail}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/review-queue" className="tactical-btn">
            Back to Coach Workspace
          </Link>
          <Link href="/operations" className="tactical-btn tactical-btn-ghost border-2 border-[var(--black)]">
            Mission Control
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
