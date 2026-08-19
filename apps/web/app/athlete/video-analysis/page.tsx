'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

// capabilityStatus constant available for future use in capability assessment framework
  // const capabilityStatus = 'PLANNED | FRONT-END PLACEHOLDER | NOT YET AUTOMATED | BACKEND REQUIRED | HUMAN REVIEW REQUIRED';

interface ShadowObservationItem {
  id: string;
  source: 'event' | 'telemetry';
  label: string;
  entity_type: string | null;
  entity_id: string | null;
  review_state: 'pending_review' | 'approved' | 'rejected' | 'promoted' | 'unknown';
  created_at: string;
}

const ML_PLACEHOLDER = 'PLANNED | ML REQUIRED | NOT YET AUTOMATED';

interface VideoSession {
  video_session_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  status: string;
  uploaded_by_account_id: string;
  created_at: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AthleteVideoAnalysisPage() {
  const [videos, setVideos] = useState<VideoSession[]>([]);
  const [videoError, setVideoError] = useState('');
  const [observations, setObservations] = useState<ShadowObservationItem[]>([]);
  const [observationError, setObservationError] = useState('');
  const [activeVideo, setActiveVideo] = useState<{ url: string; title: string } | null>(null);
  const [loadingVideoId, setLoadingVideoId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/video/list`, { credentials: 'include' });
        if (!res.ok) throw new Error('Failed to load film library');
        const data = (await res.json()) as { items: VideoSession[] };
        setVideos(data.items ?? []);
      } catch (err) {
        setVideoError(err instanceof Error ? err.message : 'Failed to load film library');
      }
    })();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/observation-projection`, {
        credentials: 'include',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 30 }),
        });
        if (!response.ok) throw new Error('Unable to load SHADOW observation projection.');
        const payload = (await response.json()) as { items?: ShadowObservationItem[] };
        setObservations(payload.items ?? []);
      } catch {
        setObservationError('Unable to load SHADOW observation projection.');
      }
    })();
  }, []);

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
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/video-analysis" allowedRoles={['athlete']} showShellHeader={false} room="floor">
      {/* Athlete-facing floor surface: the ink ground and the floor room's
          brick wall come from the shell above (room="floor"), and the kiosk
          sizing on every control the athlete taps is Law 5. This box used to
          re-declare room--floor on top of the shell's, which painted the wall
          twice -- one screen, one room. */}
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Film Review</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Athlete Film Lane</h1>
          <p className="mt-[var(--s3)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
            Watch footage your coach has released for your sessions.
          </p>
        </header>

        {activeVideo ? (
          <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
            <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
              <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>{activeVideo.title}</h2>
              <button onClick={() => setActiveVideo(null)} className="btn btn--ghost min-h-[var(--tap)]">
                Close
              </button>
            </div>
            <video className="mt-[var(--s4)] max-h-[480px] w-full rounded-[var(--r-md)] bg-[var(--hide-950)]" src={activeVideo.url} controls>
              <track kind="captions" />
            </video>
          </section>
        ) : null}

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>Your Film Library</h2>
          {videoError ? (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{videoError}</p>
              </div>
            </div>
          ) : null}
          {!videoError && videos.length === 0 ? (
            <p className="mt-[var(--s4)] text-[length:var(--t-md)] leading-relaxed text-[color:var(--bone-300)]">
              No film yet. Footage appears here once your coach releases it.
            </p>
          ) : (
            <div className="mt-[var(--s4)] space-y-[var(--s3)]">
              {videos.map((v) => (
                <div key={v.video_session_id} className="mat-leather--raised flex items-center justify-between gap-[var(--s4)] rounded-[var(--r-md)] p-[var(--s4)]">
                  <div>
                    <p className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{v.title}</p>
                    <p className="t-muted mt-[var(--s1)]">{v.file_name} · {formatBytes(v.file_size_bytes)} · {v.status}</p>
                    <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>{formatGymStamp(v.created_at)}</p>
                  </div>
                  <button
                    onClick={() => { void openVideo(v.video_session_id); }}
                    disabled={loadingVideoId === v.video_session_id}
                    className="btn min-h-[var(--tap)] disabled:opacity-50 disabled:grayscale"
                  >
                    {loadingVideoId === v.video_session_id ? 'Loading...' : 'Play'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>SHADOW Signal Stream</h2>
          <div className="mt-[var(--s4)] space-y-[var(--s3)]">
            {observationError ? (
              <div className="alert alert--critical" role="alert">
                <span className="alert-icon" aria-hidden="true">✕</span>
                <div className="alert-body">
                  <p className="alert-title">Failed</p>
                  <p className="alert-msg">{observationError}</p>
                </div>
              </div>
            ) : null}
            {observations.slice(0, 5).map((item) => (
              <article key={item.id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{item.label}</p>
                <p className="t-muted mt-[var(--s2)]">Review State: {item.review_state}</p>
              </article>
            ))}
            {!observationError && observations.length === 0 ? (
              <p className="t-muted">No observations available.</p>
            ) : null}
          </div>
        </section>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <h2 className="t-label m-0">AI/ML Scoring — Planned</h2>
          <div className="mt-[var(--s3)] grid gap-[var(--s3)] sm:grid-cols-2">
            {['Skill Recognition', 'Technique Scoring'].map((p) => (
              <div key={p} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-300)]">{p}</p>
                <p className="t-label mt-[var(--s2)]">{ML_PLACEHOLDER}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-[var(--s4)]">
          <Link href="/athlete/dashboard" className="btn btn--ghost min-h-[var(--tap)]">
            Back to Athlete Workspace
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
