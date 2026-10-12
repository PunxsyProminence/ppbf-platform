'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import { formatGymDay } from '@/src/lib/gymTime';

/*
 * The published video library, read-only (work order N7-02).
 *
 * Gym-wide by owner ruling (OD-2026-10-08-004: "everyone signed in at the gym
 * can browse every published clip, as built"). The audience is the route's
 * own: GET /api/pilot/publications/library admits coach, organization admin
 * and athlete, so this page lists exactly those roles and no others.
 *
 * WHAT A CARD SHOWS. Title, description, tags and the date it was published.
 * Nothing else the route returns is rendered: the publication and video ids
 * are internal, and view_count is never incremented by anything today
 * (trackLibraryView has no callers), so showing it would be a false count.
 * There is no playback control: the route hands back no media link, and no
 * playback link goes out without the consent it depends on (OD-2026-10-05-016).
 *
 * WHAT IS ON THE SHELF is decided by the server: retracted and
 * consent-suppressed entries (suppressed_at), archived ones and a deleted
 * athlete's footage never come back from getResearchLibrary. This page renders
 * what it is given.
 *
 * PAGING. The route returns no total. Each page asks for one row more than it
 * shows, and "Next" appears only when that extra row came back.
 */

interface LibraryItem {
  library_id: string;
  title: string;
  description: string | null;
  tags: string[] | null;
  published_at: string | null;
}

const PAGE_SIZE = 20;

type LoadState = 'loading' | 'loaded' | 'refused' | 'unavailable';

export default function VideoLibraryPage() {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [tag, setTag] = useState('');
  const [state, setState] = useState<LoadState>('loading');
  // Tags seen on any page loaded so far: the route has no tag list of its own.
  const [knownTags, setKnownTags] = useState<string[]>([]);

  // The request whose answer may be shown. An answer to an earlier request
  // (a slow page the reader has already moved past) is dropped.
  const latest = useRef('');

  const load = useCallback(async (nextOffset: number, nextTag: string) => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE + 1), offset: String(nextOffset) });
    if (nextTag) params.set('tags', nextTag);
    const key = params.toString();
    latest.current = key;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/publications/library?${key}`, {
        method: 'GET',
        credentials: 'include',
      });
      if (latest.current !== key) return;
      if (response.status === 403) {
        setItems([]);
        setHasMore(false);
        setState('refused');
        return;
      }
      if (!response.ok) throw new Error('library');
      const payload = (await response.json()) as { items?: LibraryItem[] };
      if (latest.current !== key) return;
      const rows = payload.items ?? [];
      setItems(rows.slice(0, PAGE_SIZE));
      setHasMore(rows.length > PAGE_SIZE);
      setKnownTags((prev) => {
        const all = new Set(prev);
        for (const row of rows.slice(0, PAGE_SIZE)) for (const t of row.tags ?? []) if (t) all.add(t);
        return Array.from(all).sort((a, b) => a.localeCompare(b));
      });
      setState('loaded');
    } catch {
      if (latest.current !== key) return;
      setItems([]);
      setHasMore(false);
      setState('unavailable');
    }
  }, []);

  // The first page. Later pages and filters are loaded from the control that
  // asks for them (go, below), which also shows the loading line.
  useEffect(() => {
    void Promise.resolve().then(() => load(0, ''));
  }, [load]);

  function go(nextOffset: number, nextTag: string) {
    setOffset(nextOffset);
    setTag(nextTag);
    setState('loading');
    void load(nextOffset, nextTag);
  }

  return (
    <RoleStandaloneView
      roleLabel="Video Library"
      routeLabel="/coach/video-publications/library"
      allowedRoles={['coach', 'admin', 'athlete']}
      room="floor"
      showShellHeader={false}
    >
      <div className="space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)]">
          <p className="t-eyebrow">Video Library</p>
          <h1 className="t-command mt-[var(--s3)] text-[length:var(--t-xl)]">Published Clips</h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            Every clip published to the gym&apos;s library, newest first.
          </p>
        </header>

        <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s5)] space-y-[var(--s4)]">
          <div className="field">
            <label htmlFor="libraryTag" className="t-label">Tag</label>
            <select
              id="libraryTag"
              value={tag}
              onChange={(event) => go(0, event.target.value)}
              className="select"
            >
              <option value="">All tags</option>
              {knownTags.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {state === 'loading' && <p className="t-body">Loading…</p>}
          {state === 'refused' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              The video library is not available to your account.
            </p>
          )}
          {state === 'unavailable' && (
            <p role="alert" className="t-body text-[color:var(--restricted-ink)]">
              The library could not be loaded. Reload and try again.
            </p>
          )}
          {state === 'loaded' && items.length === 0 && (
            <p className="t-body text-[color:var(--bone-300)]">
              {offset > 0 ? 'No more clips.' : tag ? 'No published clips with this tag.' : 'No published clips yet.'}
            </p>
          )}
          {state === 'loaded' && items.length > 0 && (
            <ul className="space-y-[var(--s3)]">
              {items.map((item) => (
                <li key={item.library_id} className="border-b border-[color:var(--hide-700)] pb-[var(--s3)]">
                  <h2 className="font-semibold text-[length:var(--t-md)]">{item.title}</h2>
                  {item.description ? <p className="t-body mt-[var(--s1)]">{item.description}</p> : null}
                  <p className="mt-[var(--s1)] text-[length:var(--t-sm)] text-[color:var(--bone-300)]">
                    {item.published_at ? `Published ${formatGymDay(item.published_at) ?? item.published_at}` : 'Publish date not recorded'}
                    {item.tags && item.tags.length > 0 ? ` · ${item.tags.join(', ')}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-[var(--s3)]">
            {offset > 0 && (
              <button
                type="button"
                className="btn btn--ghost"
                disabled={state === 'loading'}
                onClick={() => go(Math.max(offset - PAGE_SIZE, 0), tag)}
              >
                Previous
              </button>
            )}
            {state === 'loaded' && hasMore && (
              <button type="button" className="btn btn--ghost" onClick={() => go(offset + PAGE_SIZE, tag)}>
                Next
              </button>
            )}
          </div>
        </section>
      </div>
    </RoleStandaloneView>
  );
}
