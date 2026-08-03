'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

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
    <RoleStandaloneView roleLabel="Athlete Workspace" routeLabel="/athlete/video-analysis" allowedRoles={['athlete']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[color:var(--brass-300)]">Film Review</p>
          <h1 className="mt-2 text-3xl font-black text-[color:var(--bone-100)]">Athlete Film Lane</h1>
          <p className="mt-2 text-sm text-[color:var(--bone-300)]">Watch footage your coach has released for your sessions.</p>
        </header>

        {activeVideo ? (
          <section className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-950)] p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">{activeVideo.title}</h2>
              <button onClick={() => setActiveVideo(null)} className="text-xs font-mono text-[color:var(--bone-300)] underline">Close</button>
            </div>
            <video className="mt-3 w-full max-h-[480px] bg-black" src={activeVideo.url} controls>
              <track kind="captions" />
            </video>
          </section>
        ) : null}

        <section className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">Your Film Library</h2>
          {videoError ? <p className="mt-2 text-xs text-[var(--locked-ink)]">{videoError}</p> : null}
          {!videoError && videos.length === 0 ? (
            <p className="mt-3 text-xs text-[color:var(--bone-300)]">No film yet. Footage appears here once your coach releases it.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {videos.map((v) => (
                <div key={v.video_session_id} className="flex items-center justify-between border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
                  <div>
                    <p className="text-sm font-semibold text-[color:var(--bone-200)]">{v.title}</p>
                    <p className="mt-0.5 text-xs text-[color:var(--bone-300)]">{v.file_name} · {formatBytes(v.file_size_bytes)} · {v.status}</p>
                    <p className="mt-0.5 text-xs text-[var(--bone-400)]">{new Date(v.created_at).toLocaleString()}</p>
                  </div>
                  <button onClick={() => { void openVideo(v.video_session_id); }} disabled={loadingVideoId === v.video_session_id} className="ml-4 border border-[color:var(--brass-700)] bg-[var(--hide-800)] px-3 py-1 text-xs font-mono text-[color:var(--brass-300)] disabled:opacity-50">
                    {loadingVideoId === v.video_session_id ? 'Loading...' : 'Play'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-900)] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[color:var(--brass-300)]">SHADOW Signal Stream</h2>
          <div className="mt-3 space-y-2">
            {observationError ? <p className="text-xs text-[var(--locked-ink)]">{observationError}</p> : null}
            {observations.slice(0, 5).map((item) => (
              <article key={item.id} className="border border-[color:var(--hide-600)] bg-[var(--hide-950)] p-3">
                <p className="text-sm font-semibold text-[color:var(--bone-200)]">{item.label}</p>
                <p className="mt-1 text-xs text-[color:var(--bone-300)]">Review State: {item.review_state}</p>
              </article>
            ))}
            {!observationError && observations.length === 0 ? <p className="text-xs text-[color:var(--bone-300)]">No observations available.</p> : null}
          </div>
        </section>

        <section className="border-2 border-[color:var(--hide-600)] bg-[var(--hide-950)] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[var(--bone-400)]">AI/ML Scoring — Planned</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {['Skill Recognition', 'Technique Scoring'].map((p) => (
              <div key={p} className="border border-[color:var(--hide-700)] bg-[var(--hide-950)] p-3">
                <p className="text-xs font-semibold text-[color:var(--bone-400)]">{p}</p>
                <p className="mt-1 text-xs font-mono uppercase tracking-[0.07em] text-[color:var(--bone-400)]">{ML_PLACEHOLDER}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/athlete/dashboard" className="border-2 border-[color:var(--brass-700)] bg-[var(--hide-800)] px-4 py-2 text-xs font-mono text-[color:var(--brass-300)]">
            Back to Athlete Workspace
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
