'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

interface VideoPublication {
  publication_id: string;
  video_session_id: string;
  athlete_id: string;
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
  athlete_id: string;
  created_at: string;
}

export default function CoachVideoPublicationsPage() {
  const [publications, setPublications] = useState<VideoPublication[]>([]);
  const [videos, setVideos] = useState<VideoSession[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState('');
  const [formData, setFormData] = useState({
    title: '',
    description: '',
    publication_type: 'research_library',
    tags: '',
  });

  // Load publications and videos
  useEffect(() => {
    void (async () => {
      try {
        const [pubRes, vidRes] = await Promise.all([
          fetch(`${apiBase()}/api/pilot/publications/create`),
          fetch(`${apiBase()}/api/pilot/video/list`),
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

  const handleCreatePublication = async () => {
    if (!selectedVideo || !formData.title) {
      setErrorMessage('Please select video and enter title');
      return;
    }

    try {
      const res = await fetch(`${apiBase()}/api/pilot/publications/create`, {
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

      if (!res.ok) throw new Error('Failed to create publication');

      setShowCreateForm(false);
      setFormData({ title: '', description: '', publication_type: 'research_library', tags: '' });
      setSelectedVideo('');

      // Reload publications
      const reloadRes = await fetch(`${apiBase()}/api/pilot/publications/create`);
      if (reloadRes.ok) {
        const data = (await reloadRes.json()) as { items?: VideoPublication[] };
        setPublications(data.items ?? []);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to create publication');
    }
  };

  const handlePublish = async (publicationId: string, videoSessionId: string) => {
    try {
      const res = await fetch(`${apiBase()}/api/pilot/publications/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publication_id: publicationId,
          video_session_id: videoSessionId,
        }),
      });

      if (!res.ok) throw new Error('Failed to publish');

      // Reload publications
      const reloadRes = await fetch(`${apiBase()}/api/pilot/publications/create`);
      if (reloadRes.ok) {
        const data = (await reloadRes.json()) as { items?: VideoPublication[] };
        setPublications(data.items ?? []);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to publish');
    }
  };

  return (
    <RoleStandaloneView roleLabel="Coach Workspace" routeLabel="/coach/video-publications" allowedRoles={['coach']} showShellHeader={false}>
      <div className="space-y-6">
        <header className="border-2 border-[#8b4444] bg-[#111111] p-5">
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[#d4a574]">Video Management</p>
          <h1 className="mt-2 text-3xl font-black text-[#f2e7da]">Publication Workflow</h1>
          <p className="mt-2 text-sm text-[#cfbfae]">
            Publish coaching videos to research library with compliance checks and access controls.
          </p>
          {errorMessage ? <p className="mt-2 text-xs text-[#f0c4c4]">{errorMessage}</p> : null}
        </header>

        {/* Create Publication Form */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-[#f2e7da]">Create Publication</h2>
            <button
              onClick={() => setShowCreateForm(!showCreateForm)}
              className="border-2 border-[#8b4444] bg-[#2a1a1a] px-3 py-1 text-xs font-bold text-[#d4a574]"
            >
              {showCreateForm ? 'Cancel' : '+ New Publication'}
            </button>
          </div>

          {showCreateForm && (
            <div className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4 space-y-3">
              <div>
                <label className="block text-xs font-bold uppercase text-[#d4a574]">Select Video</label>
                <select
                  value={selectedVideo}
                  onChange={(e) => setSelectedVideo(e.target.value)}
                  className="mt-1 w-full border border-[#5a4a3a] bg-[#101010] p-2 text-[#e8d7c6]"
                >
                  <option value="">-- Choose Video --</option>
                  {videos.map((v) => (
                    <option key={v.video_session_id} value={v.video_session_id}>
                      {v.title} ({v.athlete_id})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[#d4a574]">Title</label>
                <input
                  type="text"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Publication title..."
                  className="mt-1 w-full border border-[#5a4a3a] bg-[#101010] p-2 text-[#e8d7c6]"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[#d4a574]">Description</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                  placeholder="Publication description..."
                  className="mt-1 w-full border border-[#5a4a3a] bg-[#101010] p-2 text-[#e8d7c6]"
                  rows={3}
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[#d4a574]">Publication Type</label>
                <select
                  value={formData.publication_type}
                  onChange={(e) => setFormData({ ...formData, publication_type: e.target.value })}
                  className="mt-1 w-full border border-[#5a4a3a] bg-[#101010] p-2 text-[#e8d7c6]"
                >
                  <option value="research_library">Research Library</option>
                  <option value="public_coaching">Public Coaching</option>
                  <option value="private_archive">Private Archive</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-bold uppercase text-[#d4a574]">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={formData.tags}
                  onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                  placeholder="technique, footwork, defense"
                  className="mt-1 w-full border border-[#5a4a3a] bg-[#101010] p-2 text-[#e8d7c6]"
                />
              </div>
              <button
                onClick={handleCreatePublication}
                className="w-full border-2 border-[#8b4444] bg-[#2a1a1a] py-2 text-xs font-bold uppercase text-[#d4a574]"
              >
                Create Publication
              </button>
            </div>
          )}
        </div>

        {/* Publications List */}
        <section>
          <h2 className="mb-4 text-lg font-bold text-[#f2e7da]">Publications ({publications.length})</h2>
          <div className="space-y-3">
            {publications.length === 0 ? (
              <p className="text-sm text-[#9a8a7a]">No publications yet.</p>
            ) : (
              publications.map((pub) => (
                <div key={pub.publication_id} className="border-2 border-[#8b4444] bg-[#1a1a1a] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <p className="font-semibold text-[#e8d7c6]">{pub.title}</p>
                      <p className="text-xs text-[#cfbfae]">{pub.description}</p>
                      <div className="mt-2 flex gap-2">
                        <span className="text-xs font-mono px-2 py-1 border border-[#5a4a3a] text-[#d4a574]">
                          {pub.status}
                        </span>
                        <span className="text-xs font-mono px-2 py-1 border border-[#5a4a3a] text-[#d4a574]">
                          {pub.compliance_check_status}
                        </span>
                      </div>
                    </div>
                    {pub.status === 'approved' && (
                      <button
                        onClick={() => handlePublish(pub.publication_id, pub.video_session_id)}
                        className="border-2 border-[#8b4444] bg-[#2a1a1a] px-3 py-2 text-xs font-bold text-[#d4a574]"
                      >
                        Publish
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>

        <div className="flex flex-wrap gap-3">
          <Link href="/coach/video-analysis" className="border-2 border-[#8b4444] bg-[#2a1a1a] px-4 py-2 text-xs font-mono text-[#d4a574]">
            Back to Video Analysis
          </Link>
        </div>
      </div>
    </RoleStandaloneView>
  );
}
