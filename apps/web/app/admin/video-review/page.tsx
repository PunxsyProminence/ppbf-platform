'use client';

// The administrator surface for quarantined video, and the last missing piece
// of the escalation path #149 promised in a refusal message.
//
// The chain, as it stood before this page: the scan sweep quarantines a clip;
// video/[videoId]/release lets the coach who filmed it release footage the
// scanner merely deferred, and deliberately refuses 'blocked' -- a content
// screen declining footage of a minor is not something the person who shot it
// gets to overturn. That refusal tells the coach to "ask an administrator to
// review it". POST /api/pilot/video/scan-review is that administrator review,
// and it is a real, well-built route. Nothing in the app called it. An admin
// acting on that message had to hand-craft an HTTP POST, which in practice
// means 'blocked' had no exit at all.
//
// This page is that call site and nothing more. It adds no server behavior:
// the queue comes from video/list, watching comes from video/review-link, and
// the verdict goes to video/scan-review exactly as those routes already
// define them.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import RoleSessionGate from '@/components/RoleSessionGate';
import { getRoleSessionSnapshot } from '@/components/roleSession';
import { apiBase } from '@/lib/apiBase';

interface VideoListItem {
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

interface ReviewLink {
  url: string;
  expires_in_minutes: number;
  scan_detail: string | null;
}

type RowMessage = { kind: 'ok' | 'error'; text: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Render the calendar day out of the ISO string rather than through `new
 * Date(...).toLocaleDateString()`. The same off-by-one that made a drill due
 * date show a day early for every reader west of Greenwich applies here, and
 * a reviewer comparing "which clip is this" against a coach's account of
 * Tuesday's session should not be handed Monday.
 */
function formatDay(iso: string): string {
  const day = String(iso).slice(0, 10);
  const [year, month, date] = day.split('-');
  const monthIndex = Number(month) - 1;
  if (!year || !MONTHS[monthIndex] || !date) {
    return day || 'Unknown date';
  }
  return `${MONTHS[monthIndex]} ${Number(date)}, ${year}`;
}

/**
 * What the machine concluded, in the reviewer's words rather than the
 * column's. The distinction that matters on this screen is whether a person
 * is being asked to override a verdict or merely waiting on one, so the label
 * says which.
 */
function scanStateLabel(scanState: string): { text: string; badge: string; glyph: string; awaitingHuman: boolean } {
  switch (scanState) {
    case 'blocked':
      return { text: 'Content screen refused it', badge: 'badge--locked', glyph: '✕', awaitingHuman: true };
    case 'needs_human_review':
      return { text: 'Scanner deferred to a person', badge: 'badge--restricted', glyph: '▲', awaitingHuman: true };
    case 'unconfigured':
      return { text: 'No scanner configured', badge: 'badge--restricted', glyph: '▲', awaitingHuman: true };
    case 'pending':
    case 'scanning':
      return { text: 'Scan still running', badge: 'badge--monitor', glyph: '◷', awaitingHuman: false };
    default:
      return { text: scanState || 'Unknown', badge: 'badge--filed', glyph: '•', awaitingHuman: true };
  }
}

function VideoReviewConsoleContent() {
  const [items, setItems] = useState<VideoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [links, setLinks] = useState<Record<string, ReviewLink>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [messages, setMessages] = useState<Record<string, RowMessage>>({});
  const [busyVideoId, setBusyVideoId] = useState('');

  const loadQueue = useCallback(async () => {
    setLoadError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/list?limit=100`, {
        method: 'GET',
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => ({}))) as {
        items?: VideoListItem[];
        error?: string;
      };

      if (!response.ok || !Array.isArray(payload.items)) {
        throw new Error(payload.error || 'Unable to load the review queue');
      }

      // 'infected' is deliberately absent: authorizeVideoScanReview refuses it
      // on every surface, because a malware verdict came from a real scanner
      // rather than a judgment call. Listing those rows here would offer a
      // decision the server will always refuse.
      setItems(payload.items.filter((item) => item.status === 'quarantined'));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Unable to load the review queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  // Clips a person actually has to settle sort above ones the scanner has not
  // finished with, so a queue that is mostly in-flight does not bury the two
  // rows somebody is waiting on.
  const ordered = useMemo(() => {
    return [...items].sort((left, right) => {
      const leftAwaiting = scanStateLabel(left.scan_state).awaitingHuman ? 0 : 1;
      const rightAwaiting = scanStateLabel(right.scan_state).awaitingHuman ? 0 : 1;
      if (leftAwaiting !== rightAwaiting) {
        return leftAwaiting - rightAwaiting;
      }
      return String(right.created_at).localeCompare(String(left.created_at));
    });
  }, [items]);

  async function watchFirst(videoSessionId: string) {
    setBusyVideoId(videoSessionId);
    setMessages((previous) => ({ ...previous, [videoSessionId]: { kind: 'ok', text: 'Requesting a playback link...' } }));
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
        expires_in_minutes?: number;
        scan_detail?: string | null;
        error?: string;
      };

      if (!response.ok || !payload.ok || !payload.url) {
        throw new Error(payload.error || 'Unable to open this video');
      }

      setLinks((previous) => ({
        ...previous,
        [videoSessionId]: {
          url: payload.url as string,
          expires_in_minutes: payload.expires_in_minutes ?? 0,
          scan_detail: payload.scan_detail ?? null,
        },
      }));
      setMessages((previous) => ({
        ...previous,
        [videoSessionId]: { kind: 'ok', text: 'Playback link ready. Watch the clip, then record your decision.' },
      }));
    } catch (error) {
      setMessages((previous) => ({
        ...previous,
        [videoSessionId]: { kind: 'error', text: error instanceof Error ? error.message : 'Unable to open this video' },
      }));
    } finally {
      setBusyVideoId('');
    }
  }

  async function decide(videoSessionId: string, decision: 'approve' | 'block') {
    setBusyVideoId(videoSessionId);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/video/scan-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_session_id: videoSessionId,
          decision,
          notes: notes[videoSessionId] || undefined,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        status?: string;
        error?: string;
        reason?: string;
      };

      if (!response.ok || !payload.ok) {
        // The route's 409: somebody else settled this row, or an operator
        // archived it, between the page load and this click. Reporting success
        // would tell this reviewer their decision stuck when it did not, so
        // the queue is reloaded underneath the message.
        if (payload.reason === 'VIDEO_SESSION_CHANGED') {
          setMessages((previous) => ({
            ...previous,
            [videoSessionId]: { kind: 'error', text: payload.error || 'This video changed state while you were reviewing it.' },
          }));
          await loadQueue();
          return;
        }
        throw new Error(payload.error || 'The decision was not recorded');
      }

      setMessages((previous) => ({
        ...previous,
        [videoSessionId]: {
          kind: 'ok',
          text:
            decision === 'approve'
              ? 'Approved. The video is now released and can be watched by the people who could already see this athlete’s footage.'
              : 'Blocked. The video stays quarantined — nothing widened, and nobody gained access as a result of this decision.',
        },
      }));
      await loadQueue();
    } catch (error) {
      setMessages((previous) => ({
        ...previous,
        [videoSessionId]: { kind: 'error', text: error instanceof Error ? error.message : 'The decision was not recorded' },
      }));
    } finally {
      setBusyVideoId('');
    }
  }

  return (
    <main className="room--office min-h-screen bg-[var(--hide-950)] px-[var(--s4)] py-[var(--s5)] text-[color:var(--bone-200)] sm:px-[var(--s5)]">
      <div className="mx-auto w-full max-w-4xl space-y-[var(--s5)]">
        <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
          <p className="t-eyebrow">Gym Admin Safeguarding</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Quarantined Video Review</h1>
          <p className="t-body mt-[var(--s3)]">
            Footage the scanner would not clear on its own. Open the clip, watch it, then record a decision.
            Approving releases the video; blocking leaves it quarantined and widens nothing.
          </p>
        </header>

        <section className="frame">
          <span className="rivet rivet--tl" />
          <span className="rivet rivet--tr" />
          <span className="rivet rivet--bl" />
          <span className="rivet rivet--br" />
          <div className="frame-in mat-leather p-[var(--s4)]">
            <h2 className="t-eyebrow">Awaiting Review</h2>

            {loading && <p className="t-body mt-[var(--s4)]">Loading the review queue...</p>}

            {/* An empty queue and a queue that failed to load are the same
                picture and must never read the same way. "Nothing to review"
                on a failed request tells an administrator that footage of a
                minor is settled when it is still sitting in quarantine. */}
            {!loading && loadError && (
              <p
                className="mt-[var(--s4)] rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--locked-ink)]"
                role="alert"
              >
                {loadError}
              </p>
            )}

            {!loading && !loadError && ordered.length === 0 && (
              <p className="t-body mt-[var(--s4)]">No videos are waiting for review.</p>
            )}

            {!loading && !loadError && ordered.length > 0 && (
              <ul className="mt-[var(--s3)] space-y-[var(--s3)]">
                {ordered.map((item) => {
                  const state = scanStateLabel(item.scan_state);
                  const link = links[item.video_session_id];
                  const message = messages[item.video_session_id];
                  const busy = busyVideoId === item.video_session_id;

                  return (
                    <li
                      key={item.video_session_id}
                      className="mat-leather--raised rounded-[var(--r-md)] border border-[color:var(--hide-700)] p-[var(--s4)]"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-[var(--s3)]">
                        <div>
                          <p className="text-[length:var(--t-sm)] font-semibold text-[color:var(--bone-100)]">
                            {item.title || item.file_name}
                          </p>
                          <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">File: {item.file_name}</p>
                          <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                            Athlete: {item.athlete_id ?? 'Unattributed team video'}
                          </p>
                          <p className="t-data mt-[var(--s1)] text-[color:var(--bone-400)]">
                            Uploaded {formatDay(item.created_at)} by {item.uploaded_by_account_id}
                          </p>
                        </div>
                        <span className={`badge ${state.badge}`}>
                          <i>{state.glyph}</i>
                          {state.text}
                        </span>
                      </div>

                      {item.notes && <p className="t-body mt-[var(--s3)]">{item.notes}</p>}

                      {/* What the machine actually said, so the reviewer knows
                          what they are being asked to override rather than
                          judging blind. review-link is the only source of it. */}
                      {link?.scan_detail && (
                        <p className="t-data mt-[var(--s3)] text-[color:var(--bone-400)]">
                          Scanner detail: {link.scan_detail}
                        </p>
                      )}

                      {link && (
                        <p className="mt-[var(--s3)]">
                          <a href={link.url} target="_blank" rel="noreferrer" className="btn btn--ghost">
                            Open clip in a new tab
                          </a>
                          <span className="t-data ml-[var(--s3)] text-[color:var(--bone-400)]">
                            Link expires in {link.expires_in_minutes} minutes
                          </span>
                        </p>
                      )}

                      <div className="field mt-[var(--s3)]">
                        <label htmlFor={`notes-${item.video_session_id}`} className="t-label">
                          Reviewer notes (optional)
                        </label>
                        <textarea
                          id={`notes-${item.video_session_id}`}
                          value={notes[item.video_session_id] ?? ''}
                          onChange={(event) =>
                            setNotes((previous) => ({ ...previous, [item.video_session_id]: event.target.value }))
                          }
                          className="input"
                          rows={2}
                          placeholder="What you saw, and why you decided this way."
                        />
                      </div>

                      {message && (
                        <p
                          className={
                            message.kind === 'error'
                              ? 'mt-[var(--s3)] rounded-[var(--r-md)] border border-[color:var(--brass-700)] bg-[var(--rust-900)] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--locked-ink)]'
                              : 'mt-[var(--s3)] rounded-[var(--r-md)] border border-[color:var(--cleared)] bg-[color-mix(in_srgb,var(--cleared)_16%,var(--hide-950))] px-[var(--s3)] py-[var(--s2)] text-[length:var(--t-sm)] text-[color:var(--cleared-ink)]'
                          }
                          role={message.kind === 'error' ? 'alert' : undefined}
                        >
                          {message.text}
                        </p>
                      )}

                      <div className="mt-[var(--s3)] flex flex-wrap gap-[var(--s3)]">
                        <button
                          type="button"
                          onClick={() => { void watchFirst(item.video_session_id); }}
                          disabled={busy}
                          className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {busy ? 'Working...' : link ? 'Refresh playback link' : 'Watch first'}
                        </button>

                        {/* Approve is the only control here that widens access,
                            so it stays disabled until this reviewer has asked
                            for the clip. Releasing without looking is the rubber
                            stamp the whole review path exists to avoid, and the
                            ticket's own flow is watch-then-decide.

                            This is an affordance, not a security control: the
                            server does not require a review-link call before
                            scan-review, and this page must not be described as
                            if it does. Block is never gated -- refusing footage
                            without watching it is always safe. */}
                        <button
                          type="button"
                          onClick={() => { void decide(item.video_session_id, 'approve'); }}
                          disabled={busy || !link}
                          className="btn disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Approve and release
                        </button>

                        <button
                          type="button"
                          onClick={() => { void decide(item.video_session_id, 'block'); }}
                          disabled={busy}
                          className="btn btn--ghost disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Block
                        </button>
                      </div>

                      {!link && (
                        <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                          Watch the clip before approving it.
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

/**
 * Shown to a platform owner who reaches this console. VIDEO_REVIEW_DECIDE_ROLES
 * in videoScanReview.ts is organization_admin alone, and platform_owner is
 * absent from it on purpose: releasing one athlete's footage is depth, and
 * Omega is broader in breadth but strictly narrower in depth. Without this they
 * would meet a console whose every request failed -- the pattern this codebase
 * keeps having to remove.
 */
function WrongRoleNotice() {
  return (
    <main className="room--office grid min-h-screen place-items-center bg-[var(--hide-950)] px-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto max-w-xl space-y-[var(--s5)] text-center">
        <p className="t-eyebrow">Different Console</p>
        <h1 className="t-command" style={{ fontSize: 'var(--t-xl)' }}>Quarantined video is reviewed by the gym</h1>
        <p className="t-body">
          Deciding whether a clip of a child may be released belongs to that gym&apos;s own administrator.
          As platform owner you create organizations and appoint their admins.
        </p>
        <Link href="/admin/platform" className="btn btn--ghost">
          Platform console
        </Link>
      </div>
    </main>
  );
}

// RoleSessionGate admits both admin flavours; this narrows to the one whose
// APIs will actually answer.
function VideoReviewRoleSwitch({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = getRoleSessionSnapshot();

  if (session?.role === 'platform_owner') {
    return <WrongRoleNotice />;
  }

  return <>{children}</>;
}

export default function VideoReviewPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'platform_owner']}>
      <VideoReviewRoleSwitch>
        <VideoReviewConsoleContent />
      </VideoReviewRoleSwitch>
    </RoleSessionGate>
  );
}
