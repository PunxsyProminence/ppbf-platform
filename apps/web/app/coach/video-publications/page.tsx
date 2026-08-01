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
      <div className="space-y-6">
        <header className="border-2 border-[var(--patina-700)] bg-[var(--hide-950)] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--brass-300)]">Video Management</p>
          <h1 className="mt-2 text-3xl font-black text-[var(--bone-100)]">Publication Workflow</h1>
          <p className="mt-2 text-sm text-[var(--bone-300)]">
            Publish coaching videos to the research library. You create the publication, an organization admin records a
            compliance check, and a passing check clears it for you to publish.
          </p>
          <ol className="mt-3 space-y-1 text-xs text-[var(--bone-300)]">
            <li>1. You create the publication from a released video. It starts as a draft.</li>
            <li>2. An organization admin records a compliance check against it.</li>
            <li>3. A passing check approves it; a failing check rejects it.</li>
            <li>4. You publish an approved publication to the research library.</li>
          </ol>
          {errorMessage ? <p className="mt-3 text-xs text-[var(--locked-ink)]">{errorMessage}</p> : null}
        </header>

        {/* Create Publication Form */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-[var(--bone-100)]">Create Publication</h2>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-3 py-1 text-xs font-bold text-[var(--brass-300)]"
            >
              {showCreateForm ? 'Cancel' : '+ New Publication'}
            </button>
          </div>

          {showCreateForm && (
            <div className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)] p-4 space-y-3">
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--brass-300)]">Select Video</label>
                <select
                  value={selectedVideo}
                  onChange={(e) => setSelectedVideo(e.target.value)}
                  className="mt-1 w-full border border-[var(--hide-500)] bg-[var(--hide-950)] p-2 text-[var(--bone-200)]"
                >
                  <option value="">-- Choose Video --</option>
                  {publishableVideos.map((v) => (
                    <option key={v.video_session_id} value={v.video_session_id}>
                      {v.title} ({v.athlete_id}) — {v.status}
                    </option>
                  ))}
                </select>
                {publishableVideos.length === 0 ? (
                  <p className="mt-1 text-xs text-[var(--bone-300)]">
                    No videos linked to an athlete yet. Upload footage with an athlete on it from Video Analysis.
                  </p>
                ) : null}
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--brass-300)]">Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Publication title..."
                  className="mt-1 w-full border border-[var(--hide-500)] bg-[var(--hide-950)] p-2 text-[var(--bone-200)]"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--brass-300)]">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Publication description..."
                  className="mt-1 w-full border border-[var(--hide-500)] bg-[var(--hide-950)] p-2 text-[var(--bone-200)]"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--brass-300)]">Publication Type</label>
                <select
                  value={formData.publication_type}
                  onChange={(e) => setFormData({ ...formData, publication_type: e.target.value })}
                  className="mt-1 w-full border border-[var(--hide-500)] bg-[var(--hide-950)] p-2 text-[var(--bone-200)]"
                >
                  <option value="research_library">Research Library</option>
                  <option value="public_coaching">Public Coaching</option>
                  <option value="private_archive">Private Archive</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[var(--brass-300)]">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  placeholder="technique, footwork, defense"
                  className="mt-1 w-full border border-[var(--hide-500)] bg-[var(--hide-950)] p-2 text-[var(--bone-200)]"
                />
              </div>
              <button
                onClick={handleCreatePublication}
                className="w-full border-2 border-[var(--patina-700)] bg-[var(--rust-900)] py-2 text-xs font-bold uppercase text-[var(--brass-300)]"
              >
                Create Publication
              </button>
            </div>
          )}
        </div>

        {/* Publications List */}
        <section>
          <h2 className="mb-4 text-lg font-bold text-[var(--bone-100)]">Publications ({publications.length})</h2>
          <div className="space-y-3">
            {publications.length === 0 ? (
              <p className="text-sm text-[var(--bone-400)]">No publications yet.</p>
            ) : (
              publications.map((pub) => {
                const cleared = pub.status === 'approved' && pub.compliance_check_status === 'passed';
                const isSubmitter = session.accountId !== null && pub.submitted_by_account_id === session.accountId;

                return (
                  <div key={pub.publication_id} className="border-2 border-[var(--patina-700)] bg-[var(--hide-900)] p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <p className="font-semibold text-[var(--bone-200)]">{pub.title}</p>
                        <p className="text-xs text-[var(--bone-300)]">{pub.description}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <span className="text-xs font-mono px-2 py-1 border border-[var(--hide-500)] text-[var(--brass-300)]">
                            status: {pub.status}
                          </span>
                          <span className="text-xs font-mono px-2 py-1 border border-[var(--hide-500)] text-[var(--brass-300)]">
                            checks: {pub.compliance_check_status}
                          </span>
                        </div>
                        <p className="mt-2 text-xs text-[var(--bone-300)]">{nextStep(pub)}</p>
                        {cleared && !isSubmitter ? (
                          <p className="mt-1 text-xs text-[var(--bone-300)]">
                            Another coach submitted this one, so only they or an organization admin can publish it.
                          </p>
                        ) : null}
                      </div>
                      {cleared && isSubmitter ? (
                        <button
                          onClick={() => { void handlePublish(pub.publication_id, pub.video_session_id); }}
                          disabled={publishingId === pub.publication_id}
                          className="border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-3 py-2 text-xs font-bold text-[var(--brass-300)] disabled:opacity-50"
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

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/video-analysis" className="border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-4 py-2 text-xs font-mono text-[var(--brass-300)]">
            Back to Video Analysis
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
