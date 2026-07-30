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
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Film Review</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Athlete Film Lane</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">Watch footage your coach has uploaded for your sessions.</p>
        </header>

        {activeVideo ? (
          <section className="border-2 border-[#8b4444] bg-[#0d0d0d] p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">{activeVideo.title}</h2>
              <button onClick={() => setActiveVideo(null)} className="text-xs font-mono text-[#cfbfae] underline">Close</button>
            </div>
            <video className="mt-3 w-full max-h-[480px] bg-black" src={activeVideo.url} controls>
              <track kind="captions" />
            </video>
          </section>
        ) : null}

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">Your Film Library</h2>
          {videoError ? <p className="mt-2 text-xs text-[#f0c4c4]">{videoError}</p> : null}
          {!videoError && videos.length === 0 ? (
            <p className="mt-3 text-xs text-[#cfbfae]">No videos have been shared with you yet.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {videos.map((v) => (
                <div key={v.video_session_id} className="flex items-center justify-between border border-[#5a4a3a] bg-[#101010] p-3">
                  <div>
                    <p className="text-sm font-semibold text-[#e8d7c6]">{v.title}</p>
                    <p className="mt-0.5 text-xs text-[#cfbfae]">{v.file_name} · {formatBytes(v.file_size_bytes)} · {v.status}</p>
                    <p className="mt-0.5 text-xs text-[#7a6a5a]">{new Date(v.created_at).toLocaleString()}</p>
                  </div>
                  <button onClick={() => { void openVideo(v.video_session_id); }} disabled={loadingVideoId === v.video_session_id} className="ml-4 border border-[#8b4444] bg-[#2a1a1a] px-3 py-1 text-xs font-mono text-[#d4a574] disabled:opacity-50">
                    {loadingVideoId === v.video_session_id ? 'Loading...' : 'Play'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#d4a574]">SHADOW Signal Stream</h2>
          <div className="mt-3 space-y-2">
            {observationError ? <p className="text-xs text-[#f0c4c4]">{observationError}</p> : null}
            {observations.slice(0, 5).map((item) => (
              <article key={item.id} className="border border-[#5a4a3a] bg-[#101010] p-3">
                <p className="text-sm font-semibold text-[#e8d7c6]">{item.label}</p>
                <p className="mt-1 text-xs text-[#cfbfae]">Review State: {item.review_state}</p>
              </article>
            ))}
            {!observationError && observations.length === 0 ? <p className="text-xs text-[#cfbfae]">No observations available.</p> : null}
          </div>
        </section>

        <section className="border-2 border-[#4a4a4a] bg-[#141414] p-4">
          <h2 className="font-mono text-sm font-bold uppercase text-[#7a7a7a]">AI/ML Scoring — Planned</h2>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {['Skill Recognition', 'Technique Scoring'].map((p) => (
              <div key={p} className="border border-[#3a3a3a] bg-[#0d0d0d] p-3">
                <p className="text-xs font-semibold text-[#8a8a8a]">{p}</p>
                <p className="mt-1 text-xs font-mono uppercase tracking-[0.07em] text-[#5a5a5a]">{ML_PLACEHOLDER}</p>
              </div>
            ))}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/athlete/dashboard" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Athlete Workspace
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
