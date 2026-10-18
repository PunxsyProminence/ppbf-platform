'use client';

import Link from 'next/link';
import React, { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/* PARENT RESOURCES for one child's family (#1593, PH-11): what the gym has
   published, from /api/pilot/parent/resources. The server picks them (every
   family's, plus the child's active programs') and keeps internal links to
   pages a parent can open; this draws them.

   An internal resource opens its page in the app; an external one opens in a
   new tab, with no referrer and no handle back to this page. Mounted per child
   (key = the child's id). A read that did not answer says so; it is never
   "nothing published". */

export interface ParentResourceItem {
  resource_id: string;
  title: string;
  summary: string;
  resource_type: 'guide' | 'checklist' | 'video' | 'policy';
  destination_kind: 'internal' | 'external';
  destination: string;
}

const TYPE_LABEL: Record<ParentResourceItem['resource_type'], string> = {
  guide: 'Guide',
  checklist: 'Checklist',
  video: 'Video',
  policy: 'Policy',
};

const ACTION_LABEL: Record<ParentResourceItem['resource_type'], string> = {
  guide: 'Read the guide',
  checklist: 'Open the checklist',
  video: 'Watch the video',
  policy: 'Read the policy',
};

type ReadState = { state: 'loading' } | { state: 'failed' } | { state: 'loaded'; items: ParentResourceItem[] };

export default function ParentResources({ athleteId }: Readonly<{ athleteId: string }>) {
  const [read, setRead] = useState<ReadState>({ state: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/parent/resources?athlete_id=${encodeURIComponent(athleteId)}`, {
          credentials: 'include',
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => ({}))) as { items?: unknown };
        if (controller.signal.aborted) return;
        setRead(response.ok && Array.isArray(payload.items)
          ? { state: 'loaded', items: payload.items as ParentResourceItem[] }
          : { state: 'failed' });
      } catch {
        if (!controller.signal.aborted) setRead({ state: 'failed' });
      }
    })();
    return () => controller.abort();
  }, [athleteId]);

  if (read.state === 'loading') return <p className="t-muted">Loading…</p>;
  if (read.state === 'failed') {
    return <p role="alert" className="t-body">Resources could not be loaded. This is not a statement that none have been published.</p>;
  }
  if (read.items.length === 0) {
    return <p className="t-muted">No resources have been published for your family yet.</p>;
  }

  return (
    <ul className="space-y-[var(--s3)]" aria-label="Resources">
      {read.items.map((resource) => (
        <li key={resource.resource_id} className="rounded-[var(--r-md)] border border-[color:rgba(0,0,0,.14)] bg-[var(--paper-2)] p-[var(--s4)]">
          <p className="t-body font-semibold">{resource.title}</p>
          <p className="t-muted mt-[var(--s2)]">{TYPE_LABEL[resource.resource_type]}</p>
          <p className="t-body mt-[var(--s2)]">{resource.summary}</p>
          {/* The accessible name carries the title, so a list of "Read the
              guide" links is told apart by ear; an external one also says
              it opens a new tab (the name replaces the visible words). */}
          {resource.destination_kind === 'internal' ? (
            <Link href={resource.destination} className="btn mt-[var(--s3)] inline-block"
              aria-label={`${ACTION_LABEL[resource.resource_type]}: ${resource.title}`}>
              {ACTION_LABEL[resource.resource_type]}
            </Link>
          ) : (
            <a href={resource.destination} target="_blank" rel="noopener noreferrer" className="btn mt-[var(--s3)] inline-block"
              aria-label={`${ACTION_LABEL[resource.resource_type]}: ${resource.title} (opens in a new tab)`}>
              {ACTION_LABEL[resource.resource_type]}
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
