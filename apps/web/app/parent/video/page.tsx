'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

/*
 * A GUARDIAN'S VIEW OF THEIR CHILD'S FILM.
 *
 * The parent branch of /api/pilot/video/list and the parent gate of
 * /api/pilot/video/[videoId] existed with no screen reading them. This is that
 * screen: the child picker every parent surface builds from
 * /api/pilot/athletes/list (the route that runs the guardian link gate), the
 * child's rounds, Play, and the coach's notes on the round that opened
 * (OD-2026-10-06-025 ruling 1: the athlete and their parent can read the
 * notes a coach writes on the athlete's own videos).
 *
 * Read-only. Nothing here uploads, tags, archives or edits.
 */

interface LinkedChild {
  athlete_id: string;
  full_name: string;
}

/* The family shape of a video row (videoFamilyView.ts): metadata only. */
interface VideoSession {
  video_session_id: string;
  title: string;
  file_name: string;
  file_size_bytes: number;
  status: string;
  created_at: string;
}

/* A coach's note as the server signs it for a family: the coach's display
   name, never an account id (OD-2026-10-06-025 ruling 2). */
interface CoachNote {
  text: string;
  coach_name: string;
  noted_at: string;
}

interface ActiveVideo {
  url: string;
  title: string;
  coachNotes: CoachNote[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Same rule as the athlete's film screen: a 409 is a stated consent refusal
 * the route authored a message for, and it reaches the guardian verbatim;
 * retrying will refuse until a guardian's consent changes. The message counts
 * guardians and names none. Every other status keeps the retry text.
 */
async function openVideoRefusal(response: Response): Promise<string> {
  const retry = 'That round would not open. Try it again.';
  if (response.status !== 409) return retry;
  try {
    const payload = (await response.json()) as { error?: unknown };
    return typeof payload.error === 'string' && payload.error ? payload.error : retry;
  } catch {
    return retry;
  }
}

export default function ParentVideoPage() {
  const [children, setChildren] = useState<LinkedChild[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [childrenFailed, setChildrenFailed] = useState(false);
  const [activeChildId, setActiveChildId] = useState<string | null>(null);
  const [videos, setVideos] = useState<VideoSession[]>([]);
  const [videosLoading, setVideosLoading] = useState(false);
  const [videoError, setVideoError] = useState('');
  const [activeVideo, setActiveVideo] = useState<ActiveVideo | null>(null);
  const [loadingVideoId, setLoadingVideoId] = useState<string | null>(null);
  // Read by openVideo after its await, so a late response is dropped when
  // the child changed meanwhile. Written in the child effect below, never
  // during render.
  const activeChildRef = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, {
          credentials: 'include',
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error('linked athletes unavailable');
        const payload = (await response.json()) as { items?: LinkedChild[] };
        const items = payload.items ?? [];
        setChildren(items);
        setActiveChildId(items.length > 0 ? items[0].athlete_id : null);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setChildren([]);
        setChildrenFailed(true);
      } finally {
        if (!controller.signal.aborted) setChildrenLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);

  // One list per selected child. The abort guard keeps a slow first child's
  // rounds from landing under the second child's name after a switch.
  useEffect(() => {
    activeChildRef.current = activeChildId;
    const controller = new AbortController();
    void (async () => {
      setActiveVideo(null);
      setVideoError('');
      if (!activeChildId) {
        setVideos([]);
        return;
      }
      setVideosLoading(true);
      try {
        const res = await fetch(
          `${apiBase()}/api/pilot/video/list?athlete_id=${encodeURIComponent(activeChildId)}`,
          { credentials: 'include', signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (!res.ok) throw new Error('The film did not load. Try again in a minute.');
        const data = (await res.json()) as { items?: VideoSession[] };
        setVideos(data.items ?? []);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        setVideos([]);
        setVideoError(error instanceof Error ? error.message : 'The film did not load. Try again in a minute.');
      } finally {
        if (!controller.signal.aborted) setVideosLoading(false);
      }
    })();
    return () => controller.abort();
  }, [activeChildId]);

  // The child the round was opened for. A guardian who taps Play on one
  // child's round and switches to the other before it lands must not see the
  // first child's round, notes or refusal under the second child's name.
  const openVideo = async (videoId: string, forChildId: string) => {
    setLoadingVideoId(videoId);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/video/${videoId}`, { credentials: 'include' });
      if (!res.ok) throw new Error(await openVideoRefusal(res));
      const data = (await res.json()) as { stream_url: string; title: string; coach_notes?: CoachNote[] };
      if (activeChildRef.current !== forChildId) return;
      setActiveVideo({ url: data.stream_url, title: data.title, coachNotes: data.coach_notes ?? [] });
    } catch (err) {
      if (activeChildRef.current !== forChildId) return;
      setVideoError(err instanceof Error ? err.message : 'That round would not open. Try it again.');
    } finally {
      setLoadingVideoId(null);
    }
  };

  const activeChild = children.find((child) => child.athlete_id === activeChildId);

  return (
    <RoleStandaloneView roleLabel="Parent Hub" routeLabel="/parent/video" allowedRoles={['parent']} showShellHeader={false}>
      {/* Family-facing surface -- warm canvas ground (Law 6), paper panels on it. */}
      <div className="on-canvas min-h-full rounded-[var(--r-lg)] p-[var(--s5)] md:p-[var(--s6)]">
        <div className="mx-auto w-full max-w-[1080px] space-y-[var(--s6)]">
          <header className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-eyebrow">Film</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
              {activeChild ? `${activeChild.full_name || 'Your Athlete'}'s Film` : 'Your Athlete’s Film'}
            </h1>
            <p className="t-body mt-[var(--s3)]">
              Rounds a coach has put up for your child to watch back, and the notes the coach wrote on them.
              This view is read-only.
            </p>
          </header>

          {children.length > 1 ? (
            <nav aria-label="Choose athlete" className="flex flex-wrap gap-[var(--s3)]">
              {children.map((child) => (
                <button
                  key={child.athlete_id}
                  type="button"
                  className={child.athlete_id === activeChildId ? 'btn' : 'btn btn--ghost'}
                  aria-pressed={child.athlete_id === activeChildId}
                  onClick={() => setActiveChildId(child.athlete_id)}
                >
                  {child.full_name || 'Unknown'}
                </button>
              ))}
            </nav>
          ) : null}

          {childrenLoading ? (
            <div className="mat-paper flex justify-center rounded-[var(--r-lg)] py-[var(--s7)]">
              <span className="working">Loading your linked athletes...</span>
            </div>
          ) : childrenFailed ? (
            <div className="mat-paper rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">Could not load your linked athletes</div>
                <p className="empty-msg mx-auto">This is a loading problem, not your account. Reload to try again.</p>
              </div>
            </div>
          ) : children.length === 0 ? (
            <div className="mat-paper rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No linked athletes</div>
                <p className="empty-msg mx-auto">
                  Your account is not linked to an athlete yet. Ask the front desk to connect your family.
                </p>
              </div>
            </div>
          ) : (
            <>
              {activeVideo ? (
                <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s4)]">
                  <div className="flex flex-wrap items-center justify-between gap-[var(--s3)]">
                    <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>{activeVideo.title}</h2>
                    <button onClick={() => setActiveVideo(null)} className="btn btn--ghost min-h-[var(--tap)]">
                      Close
                    </button>
                  </div>
                  <video className="mt-[var(--s4)] max-h-[480px] w-full rounded-[var(--r-md)] bg-[var(--hide-950)]" src={activeVideo.url} controls>
                    <track kind="captions" />
                  </video>
                  {/* Read-only. What a coach wrote on this round, signed with the
                      coach's name and dated (OD-2026-10-06-025 ruling 1). */}
                  <section aria-labelledby="coach-notes-heading" className="mt-[var(--s4)]">
                    <h3 id="coach-notes-heading" className="t-label m-0">Coach notes</h3>
                    {activeVideo.coachNotes.length === 0 ? (
                      <p className="t-muted mt-[var(--s2)]">No coach notes on this round yet.</p>
                    ) : (
                      <ul className="mt-[var(--s2)] list-none space-y-[var(--s3)] p-0">
                        {activeVideo.coachNotes.map((note, index) => (
                          <li key={index} className="mat-paper rounded-[var(--r-md)] p-[var(--s4)]">
                            <p className="t-body whitespace-pre-wrap">{note.text}</p>
                            <p className="t-muted mt-[var(--s2)]">
                              {note.coach_name} · {formatGymStamp(note.noted_at) ?? ''}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </section>
              ) : null}

              <section className="mat-paper rounded-[var(--r-lg)] p-[var(--s5)]">
                <h2 className="t-command m-0" style={{ fontSize: 'var(--t-md)' }}>
                  {activeChild ? `${activeChild.full_name || 'Your athlete'}'s rounds` : 'Rounds'}
                </h2>
                {videoError ? (
                  <div className="alert alert--critical mt-[var(--s4)]" role="alert">
                    <span className="alert-icon" aria-hidden="true">✕</span>
                    <div className="alert-body">
                      <p className="alert-title">Failed</p>
                      <p className="alert-msg">{videoError}</p>
                    </div>
                  </div>
                ) : null}
                {videosLoading ? (
                  <p className="t-muted mt-[var(--s4)]">Loading film...</p>
                ) : !videoError && videos.length === 0 ? (
                  <p className="t-body mt-[var(--s4)]">No film yet. It shows up here when a coach puts some up.</p>
                ) : (
                  <div className="mt-[var(--s4)] space-y-[var(--s3)]">
                    {videos.map((v) => (
                      <div key={v.video_session_id} className="mat-paper flex items-center justify-between gap-[var(--s4)] rounded-[var(--r-md)] p-[var(--s4)]">
                        <div>
                          <p className="t-body font-semibold">{v.title}</p>
                          <p className="t-muted mt-[var(--s1)]">{v.file_name} · {formatBytes(v.file_size_bytes)}</p>
                          <p className="t-data mt-[var(--s1)]" style={{ fontSize: 'var(--t-xs)' }}>{formatGymStamp(v.created_at)}</p>
                        </div>
                        <button
                          onClick={() => { if (activeChildId) void openVideo(v.video_session_id, activeChildId); }}
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
            </>
          )}

          <div className="flex flex-wrap gap-[var(--s4)]">
            <Link href="/parent/dashboard" className="btn btn--ghost min-h-[var(--tap)]">
              Back to your dashboard
            </Link>
          </div>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
