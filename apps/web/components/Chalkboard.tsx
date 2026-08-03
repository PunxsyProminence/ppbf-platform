'use client';

import React, { useCallback, useEffect, useState } from 'react';

import {
  announcementLifecycle,
  announcementReachesPlacement,
  type AnnouncementItem,
  type AnnouncementPlacement,
} from './AnnouncementBanner';
import { usePilotSession, type PilotSessionRole } from './usePilotSession';
import { apiBase } from '@/lib/apiBase';

/**
 * THE CHALKBOARD — the gym's own voice, in somebody's handwriting.
 *
 * The board by the door. One line, written by a person, changed when they feel
 * like it. Not a notification, not a banner, not an alert: nothing about it
 * demands to be acknowledged, nothing counts it as read, and it never says
 * "NEW". It is just there, the way a board on a wall is there.
 *
 * ---------------------------------------------------------------------------
 * IT IS THE EXISTING ANNOUNCEMENTS SYSTEM, NOT A SECOND ONE
 * ---------------------------------------------------------------------------
 *
 * pilot.announcements already carries exactly this: a `kind` of 'motivation'
 * (as against 'notice', the operational line), a `placement` naming which
 * surface it belongs on, an author name and role, a schedule window and a
 * retire flag. wallDisplay.ts's pickNotice() already describes 'motivation' as
 * "what goes up when there is no notice", which is this object.
 *
 * So this component reads that table through the same endpoint every other
 * surface uses, and posts through the same one /notices posts through. NO new
 * table, NO new placement, NO new kind, and therefore NO MIGRATION -- adding a
 * 'chalkboard' placement would have meant altering the check constraint in
 * infra/azure/pilot_slice_postgres_announcement_placements_migration.sql, which
 * is a contested file, for a surface the existing vocabulary already names.
 *
 * What changes is the OBJECT, not the data. The dashboards used to render this
 * exact content as a paper card headed "From the Gym" -- clean UI furniture for
 * a line somebody wrote by hand. It is slate and chalk now, and it renders one
 * line rather than a list, because a chalkboard with four paragraphs on it is
 * not a chalkboard.
 *
 * ---------------------------------------------------------------------------
 * WRITING ON IT IS STAFF-ONLY, AND THE SERVER IS THE ENFORCER
 * ---------------------------------------------------------------------------
 *
 * POST /api/pilot/announcements/post already requires a Microsoft-authenticated
 * principal and derives the author role from the SESSION rather than the body,
 * so a member cannot post whatever this component renders. The composer below
 * is offered only to the roles that would be accepted, on the session type that
 * would be accepted -- offering a button that is guaranteed to 403 is a worse
 * failure than not offering it.
 *
 * Board seats are deliberately not offered here: the post route requires a
 * board principal to name which seat is speaking, and a seat dropdown on a
 * chalkboard is a form. /notices does that job properly.
 */

const CHALK_AUTHOR_ROLES: readonly PilotSessionRole[] = [
  'coach',
  'admin',
  'organization_admin',
  'platform_owner',
];

/** One line on a board. Long enough for a sentence, short enough to stay one. */
export const CHALK_MAX_LENGTH = 180;

export interface ChalkboardProps {
  readonly placement: AnnouncementPlacement;
  readonly className?: string;
}

/** The newest live 'motivation' for this surface, or null. */
export function pickChalkLine(
  items: readonly AnnouncementItem[],
  placement: AnnouncementPlacement,
  now: number = Date.now(),
): AnnouncementItem | null {
  const live = items.filter(
    (item) =>
      item.kind === 'motivation'
      && announcementReachesPlacement(item, placement)
      && announcementLifecycle(item, now) === 'live'
      && item.message.trim().length > 0,
  );

  if (live.length === 0) return null;

  // Newest wins outright. A board holds one line: the previous one was rubbed
  // out when this was written, which is what "changed when they feel like it"
  // means and why there is no list here.
  return live.reduce((newest, item) =>
    Date.parse(item.created_at) > Date.parse(newest.created_at) ? item : newest);
}

/** "Tuesday" reads like a board; a timestamp reads like a log. */
export function chalkDateLabel(value: string, now: Date = new Date()): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return '';
  const then = new Date(parsed);
  const days = Math.floor((now.getTime() - parsed) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) {
    try {
      return then.toLocaleDateString(undefined, { weekday: 'long' });
    } catch {
      return '';
    }
  }
  try {
    return then.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function Chalkboard({ placement, className = '' }: ChalkboardProps) {
  const session = usePilotSession();
  const [line, setLine] = useState<AnnouncementItem | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [composing, setComposing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`${apiBase()}/api/pilot/announcements/get`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placement, kind: 'motivation', limit: 8 }),
        signal,
      });
      if (!response.ok) throw new Error('unavailable');
      const payload = (await response.json()) as { ok?: boolean; announcements?: AnnouncementItem[] };
      if (payload.ok !== true) throw new Error('unavailable');
      return pickChalkLine(payload.announcements ?? [], placement);
    },
    [placement],
  );

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        setLine(await load(controller.signal));
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return;
        // A board that could not be read is a blank board. It does not report
        // its own plumbing on top of the page's real work -- same stance
        // AnnouncementBanner takes.
        setLine(null);
      } finally {
        setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [load, reloadNonce]);

  const mayWrite = CHALK_AUTHOR_ROLES.includes(session.role as PilotSessionRole)
    && session.authProvider === 'microsoft';
  const staffOnPin = CHALK_AUTHOR_ROLES.includes(session.role as PilotSessionRole)
    && session.authProvider !== 'microsoft'
    && !session.loading;

  async function chalkItUp() {
    if (posting) return;
    setPosting(true);
    setPostError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/announcements/post`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: draft.trim(),
          author_name: authorName.trim(),
          // The board IS the motivation kind. Not offered as a choice: a
          // chalkboard that can be switched into posting operational notices is
          // two features sharing one control.
          kind: 'motivation',
          placement,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || 'That did not go up.');
      setDraft('');
      setComposing(false);
      setReloadNonce((value) => value + 1);
    } catch (error) {
      setPostError(error instanceof Error ? error.message : 'That did not go up.');
    } finally {
      setPosting(false);
    }
  }

  const canPost = draft.trim().length > 0 && authorName.trim().length > 0 && draft.trim().length <= CHALK_MAX_LENGTH;
  const byline = line
    ? [line.author_name, chalkDateLabel(line.created_at)].filter(Boolean).join(' · ')
    : '';

  return (
    <section
      className={`chalkboard mat-slate ${className}`.trim()}
      aria-label="The chalkboard"
      data-state={line ? 'written' : 'blank'}
    >
      <div className="chalkboard-face">
        {line ? (
          <p className="chalkboard-line chalk">{line.message.trim()}</p>
        ) : (
          /* A blank board is a real object and the state most gyms are in most
             weeks. No "no announcements" apology, no empty-state illustration,
             no skeleton: an unwritten board, with the chalk sitting on the
             rail. */
          <p className="chalkboard-line chalkboard-line--blank chalk-dim">
            {loaded ? 'Nothing on the board.' : ' '}
          </p>
        )}

        {line && byline ? <p className="chalkboard-by chalk-dim">— {byline}</p> : null}
      </div>

      {mayWrite && (
        <div className="chalkboard-rail">
          {composing ? (
            <div className="chalkboard-compose">
              <label className="sr-only" htmlFor={`chalk-line-${placement}`}>
                What the board should say
              </label>
              <textarea
                id={`chalk-line-${placement}`}
                value={draft}
                maxLength={CHALK_MAX_LENGTH}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="One line. Your words."
                className="chalkboard-input"
              />
              <label className="sr-only" htmlFor={`chalk-author-${placement}`}>
                Your name, as the gym will read it
              </label>
              <input
                id={`chalk-author-${placement}`}
                value={authorName}
                onChange={(event) => setAuthorName(event.target.value)}
                placeholder="Your name"
                className="chalkboard-input chalkboard-input--name"
              />
              <div className="chalkboard-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={!canPost || posting}
                  onClick={() => void chalkItUp()}
                >
                  {posting ? 'Writing...' : 'Put it up'}
                </button>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    setComposing(false);
                    setPostError('');
                  }}
                >
                  Leave it
                </button>
              </div>
              {postError ? (
                <p className="chalkboard-error chalk" role="alert">
                  {postError}
                </p>
              ) : null}
              {/* Said plainly, because it is the one surprising thing about a
                  board: writing on it replaces what was there for everybody. */}
              <p className="chalkboard-hint chalk-dim">
                This replaces whatever is on the board now, for everyone who sees it.
              </p>
            </div>
          ) : (
            <button type="button" className="btn btn--ghost chalkboard-open" onClick={() => setComposing(true)}>
              {line ? 'Rub it out and write' : 'Write on the board'}
            </button>
          )}
        </div>
      )}

      {staffOnPin && (
        <p className="chalkboard-hint chalk-dim">
          Writing on the board needs your Microsoft sign-in, not the gym PIN.
        </p>
      )}
    </section>
  );
}
