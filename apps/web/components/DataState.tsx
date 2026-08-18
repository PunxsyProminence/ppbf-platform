'use client';

import type { ReactNode } from 'react';

/**
 * DATA STATE -- one shape for the four things a card or panel can be showing:
 * loading, errored, genuinely empty, or its real content.
 *
 * Nothing here is new CSS. ppbf.css already drew every piece this needs:
 * `.working` is the mandatory text cue for "in progress" (Law 3 forbids a
 * bare spinner/skeleton -- see the IN PROGRESS block in ppbf.css and
 * foundations/motion.html), `.alert--critical` is the failure card, and
 * `.empty`/`.empty-title`/`.empty-msg` is "nothing here yet". `.empty`'s
 * sibling doctrine -- stated beside `.photo-slot-mount-empty` in
 * globals.css -- is the reason this component exists at all: an empty state
 * has to read as a deliberately built object, never as something failed,
 * because a coach or parent looking at a blank card cannot otherwise tell
 * "nothing to show" from "the page is broken".
 *
 * The bug this closes is not a missing class, it is a missing gate. Three
 * pages (cue library, data quality, community service) already hand-wrote
 * the correct three-way branch: show `.empty` only when NOT loading AND NOT
 * errored. Two others forgot the `!error` half -- /evidence and the
 * wrestling-league season list left their list state at its initial `[]`
 * when the fetch failed, so the empty-state copy ("No seasons on record")
 * rendered directly under the failure banner ("Failed: Unable to load
 * league seasons.") for the same panel at the same time. A third
 * (performance analytics) reset its rows to `[]` inside the catch block,
 * which produces the identical result. Every one of those is the same typo
 * waiting to happen: an empty check that does not ask whether the load
 * actually succeeded. Encoding the four states as one enum and one switch
 * makes that typo structurally impossible instead of relying on every
 * author remembering the guard.
 *
 * `dataStatus()` fixes the priority order (loading beats error beats empty)
 * so callers do not re-derive it by hand at each call site either.
 */

export type DataStateStatus = 'loading' | 'error' | 'empty' | 'ready';

export function dataStatus(args: {
  readonly loading: boolean;
  readonly error: boolean;
  readonly empty: boolean;
}): DataStateStatus {
  if (args.loading) return 'loading';
  if (args.error) return 'error';
  if (args.empty) return 'empty';
  return 'ready';
}

interface DataStateProps {
  readonly status: DataStateStatus;
  /** The text cue beside/instead of the sweep. Required -- Law 3 bans a
   * loading state with no words in it. */
  readonly loadingLabel: string;
  /** Shown only when status === 'error'. */
  readonly errorMessage?: string | null;
  readonly errorTitle?: string;
  /** A single emoji/glyph, aria-hidden. Optional -- most of the app's
   * existing `.empty` blocks skip it and go straight to the title. */
  readonly emptyGlyph?: string;
  readonly emptyTitle: string;
  readonly emptyMessage: ReactNode;
  readonly emptyActions?: ReactNode;
  /** Wraps the loading/empty card in the `mat-leather` mount most call sites
   * already use around `.empty`. Set false if the caller supplies its own
   * frame (e.g. a table's containing panel). */
  readonly framed?: boolean;
  /** The real content, rendered only when status === 'ready'. */
  readonly children: ReactNode;
}

export default function DataState({
  status,
  loadingLabel,
  errorMessage,
  errorTitle = 'Failed',
  emptyGlyph,
  emptyTitle,
  emptyMessage,
  emptyActions,
  framed = true,
  children,
}: DataStateProps) {
  if (status === 'loading') {
    // aria-busy on the region itself (not just a .btn, which is the only
    // element ppbf.css styles from this attribute today): the accessibility
    // tree says "in flux" for exactly as long as the pixels do.
    return (
      <div className="flex justify-center py-[var(--s7)]" aria-live="polite" aria-busy="true">
        <span className="working">{loadingLabel}</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="alert alert--critical" role="alert">
        <span className="alert-icon" aria-hidden="true">✕</span>
        <div className="alert-body">
          <p className="alert-title">{errorTitle}</p>
          <p className="alert-msg">{errorMessage}</p>
        </div>
      </div>
    );
  }

  if (status === 'empty') {
    const body = (
      <div className="empty">
        {emptyGlyph ? <div className="empty-glyph" aria-hidden="true">{emptyGlyph}</div> : null}
        <div className="empty-title">{emptyTitle}</div>
        <p className="empty-msg mx-auto">{emptyMessage}</p>
        {emptyActions ? <div className="empty-action">{emptyActions}</div> : null}
      </div>
    );
    return framed ? <div className="mat-leather rounded-[var(--r-lg)]">{body}</div> : body;
  }

  return <>{children}</>;
}
