'use client';

import { useEffect, useState } from 'react';

import { apiBase } from '@/lib/apiBase';

/**
 * Who is in a sparring or bout clip, for staff (coach + organization admin;
 * owner 2026-10-03). Reads, adds and removes tags through
 * /api/pilot/video/[videoId]/tags; the server decides every permission and
 * this panel only says plainly what it refused.
 *
 * Owner, Jason 2026-10-04 (OD-2026-10-04-003/-009): any tagged athlete's
 * consent block stops the clip for everyone, and on a blocked clip no note is
 * shown -- a note may name the child whose guardian refused. The server blanks
 * the notes; this panel also never renders one while consent_blocked is set.
 */

// Mirrors ClipTagRow in src/server/pilot/videoClipTags.ts (that module imports
// ./db, so it is not imported into a client component).
export interface ClipTag {
  tag_id: string;
  athlete_id: string;
  event_kind: 'sparring' | 'competition';
  competition_id: string | null;
  note: string;
  created_at: string;
}

export interface ClipAthleteOption {
  athlete_id: string;
  full_name: string;
}

const EVENT_LABEL: Record<ClipTag['event_kind'], string> = { sparring: 'Sparring', competition: 'Competition' };

/** Plain words for a refused tag request. Server-authored messages are shown as sent. */
export async function clipTagRefusal(res: Response, action: 'add' | 'remove'): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  const serverText = typeof body?.error === 'string' && body.error.trim() ? body.error : null;
  if (body?.code === 'CLIP_TAG_REMOVAL_NEEDS_ADMIN' && serverText) return serverText;
  if (res.status === 403) {
    return action === 'add'
      ? 'You can tag only athletes you coach. Ask an organization admin to tag this athlete.'
      : 'You can remove tags only for athletes you coach. Ask an organization admin.';
  }
  if (res.status === 404) return 'This video or tag is no longer available to you. Refresh the page.';
  if ((res.status === 400 || res.status === 409) && serverText) return serverText;
  return action === 'add' ? 'The tag could not be saved right now. Try again.' : 'The tag could not be removed right now. Try again.';
}

export default function ClipTagsPanel({
  videoId,
  athletes,
}: {
  readonly videoId: string;
  readonly athletes: readonly ClipAthleteOption[];
}) {
  const [tags, setTags] = useState<ClipTag[] | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [athleteId, setAthleteId] = useState('');
  const [eventKind, setEventKind] = useState<ClipTag['event_kind']>('sparring');
  const [competitionId, setCompetitionId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const url = `${apiBase()}/api/pilot/video/${encodeURIComponent(videoId)}/tags`;
  const nameOf = (id: string) => athletes.find((a) => a.athlete_id === id)?.full_name ?? id;

  // Bumped after a tag is added or removed, to read the list again.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      let failure = "This clip's tags could not be read right now.";
      try {
        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 404) failure = 'This video is not available to you.';
        const payload = res.ok ? ((await res.json()) as { items?: unknown; consent_blocked?: unknown } | null) : null;
        if (!payload || !Array.isArray(payload.items)) throw new Error('unreadable');
        if (!live) return;
        setTags(payload.items as ClipTag[]);
        setBlocked(payload.consent_blocked === true);
        setLoadError(null);
      } catch {
        if (live) setLoadError(failure);
      }
    })();
    return () => {
      live = false;
    };
  }, [url, version]);
  const load = () => setVersion((n) => n + 1);

  async function addTag() {
    if (!athleteId) {
      setMessage('Choose the athlete to tag.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athlete_id: athleteId,
          event_kind: eventKind,
          competition_id: eventKind === 'competition' && competitionId.trim() ? competitionId.trim() : null,
          note: note.trim(),
        }),
      });
      if (!res.ok) {
        setMessage(await clipTagRefusal(res, 'add'));
        return;
      }
      setAthleteId('');
      setCompetitionId('');
      setNote('');
      setMessage(`Tagged ${nameOf(athleteId)}.`);
      load();
    } catch {
      setMessage('The tag could not be saved right now. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function removeTag(tag: ClipTag) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`${url}?tag_id=${encodeURIComponent(tag.tag_id)}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) {
        setMessage(await clipTagRefusal(res, 'remove'));
        return;
      }
      setMessage(`Removed the tag for ${nameOf(tag.athlete_id)}.`);
      load();
    } catch {
      setMessage('The tag could not be removed right now. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div aria-label="Clip tags" className="mt-[var(--s3)] w-full rounded-[var(--r-md)] p-[var(--s3)]">
      <p className="t-label">Who is in this clip</p>
      {loadError ? (
        <p role="alert" className="mt-[var(--s2)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">{loadError}</p>
      ) : tags === null ? (
        <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">Loading tags...</p>
      ) : (
        <>
          {blocked ? (
            <p role="status" className="mt-[var(--s2)] text-[length:var(--t-xs)] text-[var(--locked-ink)]">
              Consent blocked: a tagged athlete&apos;s media consent does not allow video, so no one can play this clip.
              Notes are hidden. Only an organization admin can remove the tag that blocks it.
            </p>
          ) : null}
          {tags.length === 0 ? (
            <p className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">No athletes tagged on this clip yet.</p>
          ) : (
            <ul className="mt-[var(--s2)] space-y-[var(--s2)]">
              {tags.map((tag) => (
                <li key={tag.tag_id} className="flex flex-wrap items-center justify-between gap-[var(--s2)]">
                  <span className="t-data text-[color:var(--bone-100)]">
                    {nameOf(tag.athlete_id)} · {EVENT_LABEL[tag.event_kind] ?? tag.event_kind}
                    {tag.competition_id ? ` · ${tag.competition_id}` : ''}
                    {!blocked && tag.note ? ` · ${tag.note}` : ''}
                  </span>
                  <button type="button" onClick={() => { void removeTag(tag); }} disabled={busy} className="btn btn--ghost disabled:opacity-50">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-[var(--s3)] flex flex-wrap items-end gap-[var(--s2)]">
            <label className="t-label">
              Athlete to tag
              <select value={athleteId} onChange={(e) => setAthleteId(e.target.value)} className="select mt-[var(--s1)] block">
                <option value="">Choose athlete</option>
                {athletes.map((a) => (
                  <option key={a.athlete_id} value={a.athlete_id}>{a.full_name}</option>
                ))}
              </select>
            </label>
            <label className="t-label">
              Event
              <select value={eventKind} onChange={(e) => setEventKind(e.target.value as ClipTag['event_kind'])} className="select mt-[var(--s1)] block">
                <option value="sparring">Sparring</option>
                <option value="competition">Competition</option>
              </select>
            </label>
            {eventKind === 'competition' ? (
              <label className="t-label">
                Competition (optional)
                <input value={competitionId} onChange={(e) => setCompetitionId(e.target.value)} className="input mt-[var(--s1)] block" />
              </label>
            ) : null}
            <label className="t-label">
              Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} className="input mt-[var(--s1)] block" />
            </label>
            <button type="button" onClick={() => { void addTag(); }} disabled={busy} className="btn disabled:opacity-50">
              {busy ? 'Saving...' : 'Tag athlete'}
            </button>
          </div>
        </>
      )}
      {message ? <p role="status" className="t-muted mt-[var(--s2)] text-[color:var(--bone-300)]">{message}</p> : null}
    </div>
  );
}
