"use client";

import { Fragment, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTimeShort } from '@/src/lib/gymTime';

interface PendingPortrait {
  account_id: string;
  full_name: string;
  athlete_id: string | null;
  uploaded_at: string;
}

type Decision = 'approve' | 'reject';

function formatDate(value: string): string {
  return formatGymDateTimeShort(value) ?? value;
}

/**
 * Where the portrait under review comes from.
 *
 * Deliberately NOT profileClient.ts's portraitUrl(): that points at the normal
 * read path, which runs decidePortrait() and answers 404 for anything that is
 * not 'released' -- so it returns nothing at all for the pending portraits this
 * console exists to decide. This is the review-only route beside it
 * (app/api/pilot/admin/portrait-review/photo/[accountId]), which serves
 * pending_review portraits to an organization admin, audits the view, and
 * refuses every other state. Same shape as the video pipeline's split between
 * video/[videoId] and video/review-link.
 */
function reviewPortraitUrl(accountId: string): string {
  return `${apiBase()}/api/pilot/admin/portrait-review/photo/${encodeURIComponent(accountId)}`;
}

/**
 * What "you have looked at it" is keyed on.
 *
 * video-review keys its inspected set by video_session_id, which is safe there
 * because a video session is immutable -- the bytes behind an id never change.
 * A portrait is not: it is a mutable slot on the account row, and a member can
 * replace a pending photo with a different one while the reviewer has the queue
 * open. Keyed by account alone, the reviewer's look at the FIRST photograph
 * would silently authorise approving the SECOND one, which is exactly the
 * failure this whole change exists to prevent. photo_uploaded_at moves with
 * every upload, so the pair identifies the actual photograph that was seen.
 */
function portraitKey(item: PendingPortrait): string {
  return `${item.account_id}::${item.uploaded_at}`;
}

export default function PortraitReviewPage() {
  const [items, setItems] = useState<PendingPortrait[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  // A set, not a single id -- an admin can start a decision on one row while
  // another row's request is still in flight, and each row's own button must
  // only re-enable when THAT row's request resolves.
  const [pendingAccountIds, setPendingAccountIds] = useState<Set<string>>(new Set());
  // Which row's portrait is on screen right now. One slot: a wall of children's
  // faces is not a review screen, and a reviewer deciding one photograph should
  // have one photograph in front of them. Nothing is fetched until they ask.
  const [shownAccountId, setShownAccountId] = useState<string | null>(null);
  // Which portraits this reviewer has actually SEEN. Separate from the slot
  // above, and for the reason video-review's own comment gives: the slot holds
  // one row and is cleared after a decision, so it can only answer "is a
  // photograph on screen now" -- not "did you ever look at this one", which is
  // the question the Approve gate has to ask.
  const [inspectedPortraitKeys, setInspectedPortraitKeys] = useState<Set<string>>(new Set());
  // A portrait the browser asked for and could not render. Tracked separately
  // so the row can say so, and so it can never be mistaken for an inspection.
  const [unavailablePortraitKeys, setUnavailablePortraitKeys] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/portrait-review`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { portraits?: PendingPortrait[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load the portrait review queue.');
      }
      setItems(payload.portraits ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the portrait review queue.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  async function decide(item: PendingPortrait, decision: Decision) {
    const accountId = item.account_id;
    const key = portraitKey(item);

    // THE GATE, in the function that actually sends the request.
    //
    // The Approve button for an unseen portrait is already disabled and the row
    // already carries the NOT VIEWED stamp, so in normal use this is
    // unreachable. It is here because the disabled attribute is a property of
    // one button in one render, and this is the only place a release is ever
    // spoken -- a future refactor that adds a keyboard shortcut, a bulk action
    // or a second Approve control must not be able to get past it by accident.
    // Nothing is announced: the stamp explaining the refusal is already on the
    // row, and Law 7 puts a refusal in ink rather than in a toast.
    if (decision === 'approve' && !inspectedPortraitKeys.has(key)) {
      return;
    }

    if (decision === 'approve') {
      // Worded to say what actually happens, and to whom. Same pattern as
      // admin/video-review's approve confirm: the irreversible, releasing
      // direction is the one that gets the friction.
      const confirmed = window.confirm(
        `Approve this portrait of ${item.full_name}? It is released under the platform’s visibility rules — for a child, to their own coaches and guardians. You are attesting that you have looked at the photograph above and that it is an appropriate photograph of this member.`,
      );
      if (!confirmed) return;
    }
    // A reject deletes the photo bytes -- the review row stays for the audit
    // trail, but the confirm is here because that half is not reversible.
    if (decision === 'reject') {
      const confirmed = window.confirm(
        'Reject this portrait? The photo is deleted; a record of the decision stays in the audit trail.',
      );
      if (!confirmed) return;
    }
    setPendingAccountIds((prev) => new Set(prev).add(accountId));
    try {
      const response = await fetch(`${apiBase()}/api/pilot/admin/portrait-review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, decision }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || 'Unable to record the decision.');
      }
      setActionMessage(decision === 'approve' ? 'Portrait approved.' : 'Portrait rejected.');
      // The decision is made, so the face comes off the screen. A refused
      // decision deliberately leaves it up: the reviewer is still working on it.
      setShownAccountId((current) => (current === accountId ? null : current));
      await load();
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'Unable to record the decision.');
    } finally {
      setPendingAccountIds((prev) => {
        const next = new Set(prev);
        next.delete(accountId);
        return next;
      });
    }
  }

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['admin']}>
      <main className="room room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Admin Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Portrait Review</h1>
            <p className="t-data mt-[var(--s3)] uppercase tracking-[0.14em] text-[color:var(--brass-300)]">LIVE | pilot.account_profiles</p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Every uploaded photo starts here and is visible to nobody but its uploader until an admin decides.
              Approving releases it under the platform&rsquo;s usual visibility rules; rejecting deletes the photo and
              keeps the record for the audit trail.
            </p>
            <p className="t-body mt-[var(--s3)] max-w-4xl">
              Approving is an attestation about a photograph of a member, and most members here are children. What you
              are attesting is that you have looked at that photograph and that it is an appropriate one: show the
              portrait, look at it, then decide. Rejecting asks nothing of you first &mdash; refusing a photograph is the
              safe direction and is never slowed down. Every portrait you open is recorded against your account.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
            {actionMessage ? <p className="t-body mt-[var(--s3)] font-semibold text-[color:var(--brass-300)]">{actionMessage}</p> : null}
          </header>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading the review queue…</div>
            </div>
          ) : errorMessage ? (
            // A failed load must not wear the empty state's clothes: "Nothing
            // pending" is a claim about the data, and after an error there is
            // no data to make claims about.
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">The queue could not be loaded</div>
              <div className="empty-msg">The list above is unavailable, not empty. Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Nothing pending</div>
              <div className="empty-msg">No portraits are waiting for review right now.</div>
            </div>
          ) : (
            /* A ruled sheet on the desk, with the photograph pinned to the
                same sheet. .ledger is the office's own record furniture --
                rules, head rule, and the mono voice Law 4 gives anything
                auditable -- so the hand-rolled px/py/border on every row is
                gone with it. */
            <section className="mat-paper mt-[var(--s5)] overflow-x-auto rounded-[var(--r-lg)] p-[var(--s5)]">
              <table className="ledger">
                <caption className="text-left">Portraits awaiting review</caption>
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Uploaded</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const key = portraitKey(item);
                    const isShown = shownAccountId === item.account_id;
                    const isInspected = inspectedPortraitKeys.has(key);
                    const isUnavailable = unavailablePortraitKeys.has(key);
                    const isBusy = pendingAccountIds.has(item.account_id);

                    return (
                      <Fragment key={item.account_id}>
                        <tr>
                          <td>{item.full_name}</td>
                          <td>{formatDate(item.uploaded_at)}</td>
                          <td>
                            <div className="flex flex-col gap-[var(--s2)]">
                              {/* .btn--ghost is bone text on a translucent black
                                  wash: it was tuned against leather and goes
                                  grey-on-grey on a light ground, which is what
                                  the sheet now is. A lever carries its own dark
                                  surface, and the two decisions beside it are
                                  already levers. */}
                              <button
                                type="button"
                                onClick={() => setShownAccountId(isShown ? null : item.account_id)}
                                className="btn--lever min-h-[44px]"
                              >
                                {isShown ? 'Hide portrait' : 'Show portrait'}
                              </button>
                              {isInspected ? null : (
                                <>
                                  {/* Law 7: the refusal is ink on the row, not a
                                      toast that scrolls away. And Law 3's
                                      corollary that a greyed control must say
                                      why -- a disabled button on its own leaves
                                      the reviewer guessing. */}
                                  <span className="stamp stamp--sm stamp--flat">Not viewed</span>
                                  <p className="t-body max-w-[34ch]" data-testid={`approve-gate-${item.account_id}`}>
                                    Look at this portrait before approving it. Rejecting does not require it.
                                  </p>
                                </>
                              )}
                              <button
                                type="button"
                                disabled={isBusy || !isInspected}
                                onClick={() => void decide(item, 'approve')}
                                className="btn--lever min-h-[44px] disabled:opacity-50"
                              >
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void decide(item, 'reject')}
                                className="btn--lever min-h-[44px] disabled:opacity-50"
                              >
                                Reject
                              </button>
                            </div>
                          </td>
                        </tr>
                        {isShown ? (
                          // A full-width row rather than a thumbnail in the
                          // Actions cell: this is the object under review, and a
                          // face too small to judge is the same rubber stamp
                          // with a picture next to it.
                          <tr>
                            <td colSpan={3}>
                              {/* The photograph is pinned to the same sheet as
                                  the row it belongs to. It used to sit in a
                                  near-black box; on paper that box would have
                                  taken .mat-paper's dark inks for .t-label and
                                  .t-body and printed them on ink. */}
                              <div className="rounded-[var(--r-md)] border border-[color:rgba(107,78,18,.28)] p-[var(--s4)]">
                                <p className="t-label">
                                  Portrait under review — {item.full_name}
                                </p>
                                {/* A bare <img>, not next/image, for the reason
                                    ProfilePortrait.tsx writes out: the optimizer
                                    fetches the source itself and caches the
                                    result server-side, and this route answers
                                    differently depending on who is asking AND on
                                    a review state that changes the moment a
                                    decision lands. A copy of an undecided
                                    child's face in a shared cache would outlive
                                    both gates. */}
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img
                                  src={reviewPortraitUrl(item.account_id)}
                                  alt={`Portrait submitted for ${item.full_name}, awaiting review`}
                                  decoding="async"
                                  className="mt-[var(--s3)] block max-h-[420px] w-auto rounded-[var(--r-sm)] border border-[color:var(--hide-700)]"
                                  // The inspection is recorded when the browser
                                  // has actually decoded and painted the bytes.
                                  // Not on the click, not on the request: a
                                  // request that 404s or a file that will not
                                  // decode is not a look at a photograph, and
                                  // must not unlock Approve.
                                  onLoad={() => {
                                    setInspectedPortraitKeys((prev) => new Set(prev).add(key));
                                    setUnavailablePortraitKeys((prev) => {
                                      const next = new Set(prev);
                                      next.delete(key);
                                      return next;
                                    });
                                  }}
                                  onError={() => {
                                    setUnavailablePortraitKeys((prev) => new Set(prev).add(key));
                                  }}
                                />
                                {isUnavailable ? (
                                  <div className="mt-[var(--s3)] flex flex-col gap-[var(--s2)]">
                                    <span className="stamp stamp--sm stamp--flat">Portrait unavailable</span>
                                    <p className="t-body max-w-[60ch]">
                                      This photograph could not be loaded, so it cannot be approved. It may already
                                      have been decided by another reviewer. Reload the queue; if the row is still
                                      here, reject it rather than releasing a photograph nobody has seen.
                                    </p>
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/operations" className="btn btn--ghost">
              Back to Mission Control
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
