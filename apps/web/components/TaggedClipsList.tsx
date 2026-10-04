'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { formatGymStamp } from '@/src/lib/gymTime';

import { clipTagRefusal, type ClipAthleteOption } from './ClipTagsPanel';

/**
 * Tagged sparring and bout clips for review, through /api/pilot/video/clips.
 * Staff only. The server scopes the list -- a coach gets tags on athletes who
 * are theirs, and clips a consent block stops are left out (OD-2026-10-04-009)
 * -- so this list renders what it is sent and says plainly when it could not
 * read.
 */

// Mirrors TaggedClipRow in src/server/pilot/videoClipTags.ts, trimmed.
interface TaggedClip {
  tag_id: string;
  video_session_id: string;
  athlete_id: string;
  event_kind: 'sparring' | 'competition';
  competition_id: string | null;
  note: string;
  title: string;
  recorded_at: string;
}

export default function TaggedClipsList({ athletes }: { readonly athletes: readonly ClipAthleteOption[] }) {
  const [athleteId, setAthleteId] = useState('');
  const [clips, setClips] = useState<TaggedClip[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const query = athleteId ? `?athlete_id=${encodeURIComponent(athleteId)}` : '';
    void (async () => {
      try {
        const res = await fetch(`${apiBase()}/api/pilot/video/clips${query}`, { credentials: 'include' });
        if (res.status === 403) {
          if (live) setError('You can list clips only for athletes you coach.');
          return;
        }
        if (!res.ok) {
          const text = res.status === 400 ? await clipTagRefusal(res, 'add') : null;
          if (live) setError(text ?? 'Tagged clips could not be read right now.');
          return;
        }
        const payload = (await res.json().catch(() => null)) as { items?: unknown } | null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('unreadable');
        if (live) setClips(payload.items as TaggedClip[]);
      } catch {
        if (live) setError('Tagged clips could not be read right now.');
      }
    })();
    return () => {
      live = false;
    };
  }, [athleteId]);

  const nameOf = (id: string) => athletes.find((a) => a.athlete_id === id)?.full_name ?? id;

  return (
    <section aria-label="Tagged clips" className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
      <h2 className="t-eyebrow">Tagged Clips</h2>
      <div className="field mt-[var(--s3)]">
        <label htmlFor="tagged-clips-athlete" className="t-label">Show clips for</label>
        <select id="tagged-clips-athlete" className="select" value={athleteId} onChange={(e) => { setClips(null); setError(null); setAthleteId(e.target.value); }}>
          <option value="">All my athletes</option>
          {athletes.map((a) => (
            <option key={a.athlete_id} value={a.athlete_id}>{a.full_name}</option>
          ))}
        </select>
      </div>
      {error ? (
        <p role="alert" className="mt-[var(--s3)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{error}</p>
      ) : clips === null ? (
        <p className="t-muted mt-[var(--s3)] text-[color:var(--bone-300)]">Loading clips...</p>
      ) : clips.length === 0 ? (
        <p className="t-muted mt-[var(--s3)] text-[color:var(--bone-300)]">No tagged clips yet.</p>
      ) : (
        <ul className="mt-[var(--s3)] space-y-[var(--s2)]">
          {clips.map((clip) => (
            <li key={clip.tag_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)]">
              <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">{clip.title}</p>
              <p className="t-data mt-[var(--s1)] text-[color:var(--bone-300)]">
                {nameOf(clip.athlete_id)} · {clip.event_kind === 'competition' ? 'Competition' : 'Sparring'}
                {clip.competition_id ? ` · ${clip.competition_id}` : ''} · {formatGymStamp(clip.recorded_at)}
              </p>
              {clip.note ? <p className="t-muted mt-[var(--s1)] text-[color:var(--bone-300)]">{clip.note}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
