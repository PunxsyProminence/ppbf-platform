'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';

interface VideoPublication {
  publication_id: string;
  video_session_id: string;
  athlete_id: string;
  submitted_by_account_id: string;
  publication_type: string;
  title: string;
  description: string;
  status: 'draft' | 'pending_review' | 'approved' | 'published' | 'rejected' | 'archived';
  compliance_check_status: string;
  created_at: string;
}

interface VideoSession {
  video_session_id: string;
  title: string;
  athlete_id: string | null;
  status: string;
  created_at: string;
}

/* Publication lifecycle states are queue outcomes, so they wear the design
   system's four-rung badge ladder with a glyph + uppercase label, never colour
   alone (Laws 2 + 3). */
type BadgeTone = 'cleared' | 'monitor' | 'restricted' | 'locked';

const STATUS_GLYPH: Record<BadgeTone, string> = {
  cleared: '✓',
  monitor: '◉',
  restricted: '▲',
  locked: '✕',
};

function statusTone(status: VideoPublication['status']): BadgeTone {
  if (status === 'published' || status === 'approved') return 'cleared';
  if (status === 'rejected') return 'locked';
  if (status === 'pending_review') return 'restricted';
  return 'monitor'; // draft, archived: in-process / dormant, not an outcome
}

function complianceTone(check: string): BadgeTone {
  if (check === 'passed') return 'cleared';
  if (check === 'failed') return 'locked';
  if (check === 'manual_review') return 'restricted';
  return 'monitor';
}

// The one place the workflow is described to the coach. Each publication shows
// where it stands and who has to act next, so an item that cannot be published
// says why instead of simply omitting the button.
function nextStep(pub: VideoPublication): string {
  if (pub.status === 'published') {
    return 'Published to the research library.';
  }
  if (pub.status === 'rejected' || pub.compliance_check_status === 'failed') {
    return 'A compliance check failed. This cannot be published; create a new publication once the issue is resolved.';
  }
  if (pub.status === 'archived') {
    return 'Archived.';
  }
  if (pub.compliance_check_status === 'manual_review') {
    return 'An organization admin has sent this to manual review.';
  }
  if (pub.status === 'approved' && pub.compliance_check_status === 'passed') {
    return 'Compliance checks passed. Ready for you to publish.';
  }
  return 'Waiting on an organization admin to record a compliance check.';
}

export default function CoachVideoPublicationsPage() {
  const session = usePilotSession();
  const [publications, setPublications] = useState<VideoPublication[]>([]);
  const [videos, setVideos] = useState<VideoSession[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState('');
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    publication_type: 'research_library',
    tags: '',
  });

  const loadPublications = async () => {
    const res = await fetch(`${apiBase()}/api/pilot/publications/create`, { credentials: 'include' });
    if (res.ok) {
      const data = (await res.json()) as { items?: VideoPublication[] };
      setPublications(data.items ?? []);
    }
  };

  // Load publications and videos
  useEffect(() => {
    void (async () => {
      try {
        const [pubRes, vidRes] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/publications/create`, { credentials: 'include' }),
          fetch(`${apiBase()}/api/pilot/video/list`, { credentials: 'include' }),
        ]);

        if (pubRes.ok) {
          const pubData = (await pubRes.json()) as { items?: VideoPublication[] };
          setPublications(pubData.items ?? []);
        }

        if (vidRes.ok) {
          const vidData = (await vidRes.json()) as { items?: VideoSession[] };
          setVideos(vidData.items ?? []);
        }

        setErrorMessage('');
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load data.');
      }
    })();
  }, []);

  // A publication carries one named athlete's footage, so a session with no
  // athlete on it cannot be published. Nor can one that has not been released
  // for playback -- the create endpoint refuses both, and offering them here
  // would only produce a rejection the coach cannot act on from this screen.
  const publishableVideos = videos.filter((v) => v.athlete_id && v.status === 'ready');

  const handleCreatePublication = async () => {
    if (!selectedVideo || !formData.title) {
      setErrorMessage('Please select video and enter title');
      return;
    }

    try {
      const res = await fetch(`${apiBase()}/api/pilot/publications/create`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_session_id: selectedVideo,
          athlete_id: videos.find((v) => v.video_session_id === selectedVideo)?.athlete_id,
          publication_type: formData.publication_type,
          title: formData.title,
          description: formData.description,
          tags: formData.tags.split(',').filter((t) => t.trim()),
        }),
      });

      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Failed to create publication (${res.status})`);
      }

      setShowCreateForm(false);
      setFormData({ title: '', description: '', publication_type: 'research_library', tags: '' });
      setSelectedVideo('');
      setErrorMessage('');

      await loadPublications();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create publication');
    }
  };

  const handlePublish = async (publicationId: string, videoSessionId: string) => {
    setPublishingId(publicationId);
    try {
      const res = await fetch(`${apiBase()}/api/pilot/publications/publish`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publication_id: publicationId,
          video_session_id: videoSessionId,
        }),
      });

      // The server names the reason a publish was refused -- ownership,
      // clearance, or a mismatched video. Showing it is the only way the coach
      // learns what has to happen next.
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `Failed to publish (${res.status})`);
      }

      setErrorMessage('');
      await loadPublications();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to publish');
    } finally {
      setPublishingId(null);
    }
  };

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/video-publications" allowedRoles={['coach']} room="floor" showShellHeader={false}>
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Video Management</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Publication Workflow</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Publish coaching videos to the research library. You create the publication, an organization admin records a
            compliance check, and a passing check clears it for you to publish.
          </p>
          <ol className="mt-[var(--s3)] space-y-1 text-[length:var(--t-xs)] text-[color:var(--bone-300)]">
            <li>1. You create the publication from a released video. It starts as a draft.</li>
            <li>2. An organization admin records a compliance check against it.</li>
            <li>3. A passing check approves it; a failing check rejects it.</li>
            <li>4. You publish an approved publication to the research library.</li>
          </ol>
          {errorMessage ? <p className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{errorMessage}</p> : null}
        </header>

        {/* Create Publication Form */}
        <div>
          <div className="flex items-center justify-between gap-[var(--s3)] mb-[var(--s4)]">
            <h2 className="t-command text-[length:var(--t-lg)]">Create Publication</h2>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="btn btn--ghost"
            >
              {showCreateForm ? 'Cancel' : '+ New Publication'}
            </button>
          </div>

          {showCreateForm && (
            <div className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] space-y-[var(--s3)]">
              <div className="field">
                <label className="t-label">Select Video</label>
                <select
                  value={selectedVideo}
                  onChange={(e) => setSelectedVideo(e.target.value)}
                  className="select"
                >
                  <option value="">-- Choose Video --</option>
                  {publishableVideos.map((v) => (
                    <option key={v.video_session_id} value={v.video_session_id}>
                      {v.title} ({v.athlete_id}) — {v.status}
                    </option>
                  ))}
                </select>
                {publishableVideos.length === 0 ? (
                  <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                    No videos linked to an athlete yet. Upload footage with an athlete on it from Video Analysis.
                  </p>
                ) : null}
              </div>
              <div className="field">
                <label className="t-label">Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Publication title..."
                  className="input"
                />
              </div>
              <div className="field">
                <label className="t-label">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Publication description..."
                  className="textarea"
                  rows={3}
                />
              </div>
              <div className="field">
                <label className="t-label">Publication Type</label>
                <select
                  value={formData.publication_type}
                  onChange={(e) => setFormData({ ...formData, publication_type: e.target.value })}
                  className="select"
                >
                  <option value="research_library">Research Library</option>
                  <option value="public_coaching">Public Coaching</option>
                  <option value="private_archive">Private Archive</option>
                </select>
              </div>
              <div className="field">
                <label className="t-label">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  placeholder="technique, footwork, defense"
                  className="input"
                />
              </div>
              <button
                onClick={handleCreatePublication}
                className="btn w-full"
              >
                Create Publication
              </button>
            </div>
          )}
        </div>

        {/* Publications List */}
        <section>
          <h2 className="t-command mb-[var(--s4)] text-[length:var(--t-lg)]">Publications ({publications.length})</h2>
          <div className="space-y-[var(--s3)]">
            {publications.length === 0 ? (
              <p className="t-body text-[color:var(--bone-300)]">No publications yet.</p>
            ) : (
              publications.map((pub) => {
                const cleared = pub.status === 'approved' && pub.compliance_check_status === 'passed';
                const isSubmitter = session.accountId !== null && pub.submitted_by_account_id === session.accountId;

                return (
                  <div key={pub.publication_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                    <div className="flex items-start justify-between gap-[var(--s4)]">
                      <div className="flex-1">
                        <p className="font-semibold text-[color:var(--bone-100)]">{pub.title}</p>
                        <p className="t-muted text-[color:var(--bone-300)]">{pub.description}</p>
                        <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                          <span className={`badge badge--${statusTone(pub.status)}`}>
                            <i>{STATUS_GLYPH[statusTone(pub.status)]}</i>
                            {pub.status}
                          </span>
                          <span className={`badge badge--${complianceTone(pub.compliance_check_status)}`}>
                            <i>{STATUS_GLYPH[complianceTone(pub.compliance_check_status)]}</i>
                            checks: {pub.compliance_check_status}
                          </span>
                        </div>
                        <p className="t-muted mt-[var(--s3)] text-[color:var(--bone-300)]">{nextStep(pub)}</p>
                        {cleared && !isSubmitter ? (
                          <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">
                            Another coach submitted this one, so only they or an organization admin can publish it.
                          </p>
                        ) : null}
                      </div>
                      {cleared && isSubmitter ? (
                        <button
                          onClick={() => { void handlePublish(pub.publication_id, pub.video_session_id); }}
                          disabled={publishingId === pub.publication_id}
                          className="btn disabled:opacity-50"
                        >
                          {publishingId === pub.publication_id ? 'Publishing...' : 'Publish'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <div className="flex flex-wrap gap-[var(--s3)]">
          <Link href="/coach/video-analysis" className="btn btn--ghost">
            Back to Video Analysis
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
