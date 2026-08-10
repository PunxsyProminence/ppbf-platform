'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

interface QuarantinedVideoItem {
  video_session_id: string;
  title: string;
  notes: string;
  file_name: string;
  file_size_bytes: number;
  mime_type: string;
  status: string;
  scan_state: string;
  athlete_id: string | null;
  uploaded_by_account_id: string;
  created_at: string;
}

interface ActiveReviewLinkState {
  videoSessionId: string;
  url: string;
  scanDetail?: string;
  expiresInMinutes?: number;
}

function VideoReviewConsoleContent() {
  const [videos, setVideos] = useState<QuarantinedVideoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeReviewLink, setActiveReviewLink] = useState<ActiveReviewLinkState | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [decisionNotes, setDecisionNotes] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState('');

  const loadQuarantinedVideos = useCallback(async () => {
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/list`, {
        method: 'GET',
        credentials: 'include',
      });

      const payload = (await response.json().catch(() => ({}))) as {
        items?: QuarantinedVideoItem[];
        error?: string;
      };

      if (!response.ok || !Array.isArray(payload.items)) {
        throw new Error(payload.error || 'Unable to load videos for review');
      }

      // Quarantined escalation filter: videos that are quarantined or flagged for human review
      const quarantined = payload.items.filter(
        (item) =>
          item.status === 'quarantined'
          || item.scan_state === 'needs_human_review'
          || item.scan_state === 'blocked',
      );

      setVideos(quarantined);
    } catch (loadErr) {
      setError(loadErr instanceof Error ? loadErr.message : 'Unable to load videos for review');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadQuarantinedVideos();
  }, [loadQuarantinedVideos]);

  async function openReviewLink(videoSessionId: string) {
    setError('');
    setLinkLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/review-link`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_session_id: videoSessionId }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        url?: string;
        scan_detail?: string;
        expires_in_minutes?: number;
        error?: string;
      };

      if (!response.ok || !payload.ok || !payload.url) {
        throw new Error(payload.error || 'Could not generate review link');
      }

      setActiveReviewLink({
        videoSessionId,
        url: payload.url,
        scanDetail: payload.scan_detail,
        expiresInMinutes: payload.expires_in_minutes,
      });
    } catch (linkErr) {
      setError(linkErr instanceof Error ? linkErr.message : 'Could not generate review link');
    } finally {
      setLinkLoading(false);
    }
  }

  async function handleDecision(videoSessionId: string, decision: 'approve' | 'block') {
    setError('');
    setActionNotice('');
    setSubmittingId(videoSessionId);

    const notes = decisionNotes[videoSessionId] || '';

    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/scan-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_session_id: videoSessionId,
          decision,
          notes,
        }),
      });

      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
      };

      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Failed to submit review decision');
      }

      setActionNotice(
        decision === 'approve'
          ? `Video "${videoSessionId}" approved — status updated to ready.`
          : `Video "${videoSessionId}" blocked — status remains quarantined.`,
      );

      if (activeReviewLink?.videoSessionId === videoSessionId) {
        setActiveReviewLink(null);
      }

      setLoading(true);
      await loadQuarantinedVideos();
    } catch (decisionErr) {
      setError(decisionErr instanceof Error ? decisionErr.message : 'Failed to submit review decision');
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s5)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-4xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Gym Admin Safeguarding Control</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Quarantined Video Review Escalation
          </h1>
          <p className="t-body mt-[var(--s3)]">
            Review quarantined video uploads. Inspect the footage using a secure temporary link and record an explicit human attestation to approve or block the video.
          </p>
        </header>

        {error && (
          <div
            className="rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--locked-ink)]"
            role="alert"
          >
            {error}
          </div>
        )}

        {actionNotice && (
          <div className="rounded-[var(--r-md)] border border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_16%,var(--hide-950))] px-[var(--s4)] py-[var(--s3)] text-[length:var(--t-sm)] text-[color:var(--cleared-ink)]">
            ✓ {actionNotice}
          </div>
        )}

        <section className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather p-[var(--s4)]">
            <h2 className="t-eyebrow">Quarantined Videos ({videos.length})</h2>

            {loading ? (
              <p className="t-body mt-[var(--s4)]">Loading quarantined videos...</p>
            ) : (
              <ul className="mt-[var(--s3)] space-y-[var(--s4)]">
                {videos.map((video) => {
                  const isLinkActive = activeReviewLink?.videoSessionId === video.video_session_id;
                  const isBusy = submittingId === video.video_session_id;

                  return (
                    <li
                      key={video.video_session_id}
                      className="mat-leather rounded-[var(--r-md)] border border-[color:var(--hide-700)] p-[var(--s4)] space-y-[var(--s3)]"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-[var(--s2)]">
                        <div>
                          <h3 className="text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
                            {video.title || video.file_name}
                          </h3>
                          <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                            ID: {video.video_session_id}
                          </p>
                          <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                            Athlete: {video.athlete_id ?? 'Unassigned'} | Filmed by: {video.uploaded_by_account_id}
                          </p>
                          <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                            Uploaded: {formatGymStamp(video.created_at)}
                          </p>
                        </div>
                        <span className="badge badge--restricted">
                          <i>▲</i>
                          {video.scan_state || video.status}
                        </span>
                      </div>

                      {/* Video Inspection Panel */}
                      {isLinkActive && activeReviewLink ? (
                        <div className="rounded-[var(--r-md)] border border-[color:rgba(212,175,74,.3)] bg-[var(--hide-950)] p-[var(--s4)] space-y-[var(--s3)]">
                          <p className="t-label text-[color:var(--brass-500)]">Temporary Inspection Link Active (15m TTL)</p>
                          {activeReviewLink.scanDetail && (
                            <p className="t-data text-[color:var(--bone-300)]">
                              Automated Scanner Detail: {activeReviewLink.scanDetail}
                            </p>
                          )}
                          <div className="aspect-video w-full rounded border border-[color:var(--hide-700)] bg-black flex items-center justify-center">
                            <video
                              src={activeReviewLink.url}
                              controls
                              className="h-full w-full max-h-[360px]"
                            >
                              Your browser does not support video playback.
                            </video>
                          </div>
                          <a
                            href={activeReviewLink.url}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn--ghost text-[length:var(--t-xs)]"
                          >
                            Open raw video stream in new tab ↗
                          </a>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openReviewLink(video.video_session_id)}
                          disabled={linkLoading}
                          className="btn btn--ghost text-[length:var(--t-sm)]"
                        >
                          {linkLoading ? 'Generating link...' : 'Inspect / Watch Video'}
                        </button>
                      )}

                      {/* Decision Form */}
                      <div className="space-y-[var(--s2)] border-t border-[color:var(--hide-700)] pt-[var(--s3)]">
                        <div className="field">
                          <label htmlFor={`notes-${video.video_session_id}`} className="t-label">
                            Reviewer Notes (Optional)
                          </label>
                          <input
                            id={`notes-${video.video_session_id}`}
                            type="text"
                            value={decisionNotes[video.video_session_id] || ''}
                            onChange={(event) =>
                              setDecisionNotes((prev) => ({
                                ...prev,
                                [video.video_session_id]: event.target.value,
                              }))
                            }
                            placeholder="Reason for decision..."
                            className="input font-mono text-[length:var(--t-sm)]"
                          />
                        </div>

                        <div className="flex flex-wrap gap-[var(--s3)] pt-[var(--s2)]">
                          <button
                            type="button"
                            onClick={() => handleDecision(video.video_session_id, 'approve')}
                            disabled={isBusy}
                            className="btn disabled:opacity-50"
                          >
                            {isBusy ? 'Submitting...' : 'Approve Video (Set Ready)'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDecision(video.video_session_id, 'block')}
                            disabled={isBusy}
                            className="btn btn--ghost disabled:opacity-50 text-[color:var(--brass-400)]"
                          >
                            {isBusy ? 'Submitting...' : 'Block Video (Keep Quarantined)'}
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}

                {videos.length === 0 && (
                  <li className="t-body mt-[var(--s2)]">
                    No quarantined videos requiring admin review at this time.
                  </li>
                )}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function WrongRoleNotice() {
  return (
    <main className="room--office grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-xl space-y-[var(--s5)] text-center">
        <p className="t-eyebrow">Different Console</p>
        <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>
          Video review escalation is managed per gym
        </h1>
        <p className="t-body">
          This console allows organization administrators to review quarantined video footage. As platform owner you manage organizations and platform settings.
        </p>
        <Link href="/admin/platform" className="btn btn--ghost">
          Platform console
        </Link>
      </div>
    </main>
  );
}

function VideoReviewRoleSwitch({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = getRoleSessionSnapshot();

  if (session?.role === 'platform_owner') {
    return <WrongRoleNotice />;
  }

  return <>{children}</>;
}

export default function VideoReviewManagementPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <VideoReviewRoleSwitch>
        <VideoReviewConsoleContent />
      </VideoReviewRoleSwitch>
    </RoleSessionGate>
  );
}
