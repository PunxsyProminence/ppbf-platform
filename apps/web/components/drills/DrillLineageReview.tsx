'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { gymDayIso } from '@/src/lib/gymTime';
import type { DrillLineageResponse } from '@/app/api/pilot/drills/lineage/route';
import type { DrillChangeProposalListResponse } from '@/app/api/pilot/drills/proposals/route';
import type { DrillChangeProposalReviewResponse } from '@/app/api/pilot/drills/proposals/review/route';
import type { DrillChangeProposalListing, PilotDrillVersionRow } from '@/src/server/pilot/drillVersioning';

// One drill's versions and the change proposals written against them, read from
// the lineage and proposal routes and typed from their own response contracts.
// Adopt and Decline are offered only where the server would take them: to a
// reviewer (canReview), and Adopt only on a proposal the queue says is written
// against the current version of a drill still in use. Reinstate is offered on
// each earlier version of a drill still in use, to the roles the drills route's
// PATCH admits (canReinstate): it brings that version back as the newest.

type Version = PilotDrillVersionRow;
type Proposal = DrillChangeProposalListing;

const FIELDS = [['name', 'Name'], ['category', 'Category'], ['focus', 'What it is for'], ['cues', 'Coaching cues'], ['difficulty', 'Difficulty']] as const;

// The proposer and reviewer are named by role only: an account id is not shown.
const ROLE_LABELS: Record<string, string> = { coach: 'Coach', organization_admin: 'Administrator', admin: 'Administrator' };

// What is known after a refused review, worded as the drill page words it.
const OUTCOMES = {
  refused: 'Nothing was changed.',
  reread: "Nothing was changed. This drill's versions and proposals were read again.",
  rereadFailed: "Nothing was changed, but this drill's versions and proposals could not be read again. Reload the page before trying again.",
  unknown: "It is not known whether this was saved. This drill's versions and proposals were read again; check them before trying again.",
  unknownUnread: "It is not known whether this was saved, and this drill's versions and proposals could not be read again. Reload the page before trying again.",
};

/** The gym's own calendar day for an instant, so a late-evening review is not dated tomorrow. */
function day(iso: string | null): string {
  return gymDayIso(iso) ?? 'a date not recorded';
}

function shown(value: unknown): string {
  if (value === undefined || value === null) return 'Not known';
  return Array.isArray(value) ? value.join('; ') : String(value);
}

interface Result { target: string; notice?: string; error?: string; explanation?: string }

const read = (url: string) => fetch(`${apiBase()}${url}`, { method: 'GET', credentials: 'include' });

export default function DrillLineageReview({ drillId, canReview, canReinstate = false, onClose, onChanged }: {
  /** Any version of the drill: the lineage route resolves the rest. */
  drillId: string;
  /** Whether this session's role is one the review route admits. */
  canReview: boolean;
  /** Whether this session's role is one the drills route admits to reinstate a version. */
  canReinstate?: boolean;
  onClose: () => void;
  /** After a review that may have changed the gym's drills or the queue. */
  onChanged?: () => void;
}) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loadError, setLoadError] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState('');
  const busyRef = useRef(false);
  const [result, setResult] = useState<Result | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.scrollIntoView?.({ block: 'start' });
    headingRef.current?.focus();
  }, [drillId]);

  const reread = useCallback(async (): Promise<boolean> => {
    try {
      const lineageResponse = await read(`/api/pilot/drills/lineage?drill_id=${encodeURIComponent(drillId)}`);
      if (!lineageResponse.ok) throw new Error('lineage');
      const lineage = (await lineageResponse.json()) as Partial<DrillLineageResponse>;
      if (!Array.isArray(lineage.versions)) throw new Error('lineage');
      let items: Proposal[] = [];
      if (lineage.lineage_id) {
        const response = await read(`/api/pilot/drills/proposals?lineage_id=${encodeURIComponent(lineage.lineage_id)}`);
        if (!response.ok) throw new Error('proposals');
        const payload = (await response.json()) as Partial<DrillChangeProposalListResponse>;
        if (!Array.isArray(payload.items)) throw new Error('proposals');
        items = payload.items;
      }
      setVersions(lineage.versions);
      setProposals(items);
      setLoadError('');
      return true;
    } catch {
      setLoadError("This drill's versions and proposals could not be loaded. This is a failure to load, not an empty history.");
      return false;
    }
  }, [drillId]);

  useEffect(() => {
    // Deferred behind an await so no state is set while the effect body runs.
    void (async () => {
      await reread();
    })();
  }, [reread]);

  async function review(proposal: Proposal, action: 'adopt' | 'decline') {
    if (busyRef.current) return;
    const id = proposal.proposal_id;
    const note = (notes[id] ?? '').trim();
    if (action === 'decline' && !note) {
      setResult({ target: id, error: 'Declining needs a review note.', explanation: OUTCOMES.refused });
      return;
    }
    busyRef.current = true;
    setBusyId(id);
    setResult(null);
    let status: number | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills/proposals/review`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: id, action, ...(note ? { review_note: note } : {}) }),
      });
      status = response.status;
      const payload = (await response.json().catch(() => ({}))) as Partial<DrillChangeProposalReviewResponse> & { error?: string };
      if (!response.ok) {
        throw new Error(payload.error || (action === 'adopt' ? 'The proposal could not be adopted.' : 'The proposal could not be declined.'));
      }
      await reread();
      onChanged?.();
      setResult({ target: id, notice: action === 'adopt' ? 'Adopted.' : 'Declined.' });
    } catch (error) {
      setResult({ target: id, error: error instanceof Error ? error.message : 'The review could not be saved.', explanation: await afterFailure(status) });
    } finally {
      busyRef.current = false;
      setBusyId('');
    }
  }

  // A refusal changed nothing. A 409 changed nothing either, but this panel
  // may be out of date; a fault may have landed after the write committed.
  async function afterFailure(status: number | null): Promise<string> {
    const unknown = status === null || status >= 500;
    if (!unknown && status !== 409) return OUTCOMES.refused;
    const readAgain = await reread();
    onChanged?.();
    return unknown
      ? (readAgain ? OUTCOMES.unknown : OUTCOMES.unknownUnread)
      : (readAgain ? OUTCOMES.reread : OUTCOMES.rereadFailed);
  }

  // Bring an earlier version back as the drill's newest (the drills route's PATCH).
  async function reinstate(v: Version) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusyId(v.drill_id);
    setResult(null);
    let status: number | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drills`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drill_id: v.drill_id, reinstate: true }),
      });
      status = response.status;
      const payload = (await response.json().catch(() => ({}))) as { error?: string; drill?: { version?: number } };
      if (!response.ok) throw new Error(payload.error || `Version ${v.version} could not be reinstated.`);
      await reread();
      onChanged?.();
      // A reinstate copies the earlier version into a NEW latest version (#1470), so say which.
      const now = payload.drill?.version;
      setResult({
        target: v.drill_id,
        notice: now
          ? `Reinstated version ${v.version} as version ${now}, now the drill's current version.`
          : `Reinstated version ${v.version} as the drill's new current version.`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : `Version ${v.version} could not be reinstated.`;
      setResult({ target: v.drill_id, error: message, explanation: await afterFailure(status) });
    } finally {
      busyRef.current = false;
      setBusyId('');
    }
  }

  function renderResult(mine: Result | null) {
    return (
      <>
        {mine?.notice && <p role="status" className="t-body mt-[var(--s2)]">{mine.notice}</p>}
        {mine?.error && (
          <div role="alert" className="mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[var(--restricted)] bg-[rgba(0,0,0,.28)] p-[var(--s3)]">
            <p className="text-[length:var(--t-sm)] font-semibold text-[var(--restricted-ink)]">{mine.error}</p>
            <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">{mine.explanation}</p>
          </div>
        )}
      </>
    );
  }

  const all = versions ?? [];
  const retired = all.length > 0 && !all.some((v) => v.active);
  const head = all[all.length - 1];
  const versionOf = (id: string | null) => {
    const found = all.find((v) => v.drill_id === id);
    return found ? `version ${found.version}` : 'a version not in this history';
  };
  const label = (v: Version) => (v.active ? 'Current' : retired && v === head ? 'Retired' : 'Earlier version');

  function renderProposal(p: Proposal) {
    const base = all.find((v) => v.drill_id === p.based_on_drill_id);
    const open = p.review_state === 'proposed' || p.review_state === 'under_review';
    const blocker = p.lineage_retired
      ? 'This drill is retired.'
      : !p.base_is_current
        ? `Written against ${versionOf(p.based_on_drill_id)}. The drill is now at ${versionOf(p.current_drill_id)}.`
        : '';
    const changed = FIELDS.filter(([key]) => Object.prototype.hasOwnProperty.call(p.proposed_change, key));
    const mine = result?.target === p.proposal_id ? result : null;
    const busy = busyId !== '';
    return (
      <li key={p.proposal_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
        <p className="t-label text-[color:var(--bone-300)]">
          Proposed by {ROLE_LABELS[p.proposed_by_role] ?? p.proposed_by_role} on {day(p.created_at)}, against {versionOf(p.based_on_drill_id)}
        </p>
        <table className="mt-[var(--s3)] w-full text-left text-[length:var(--t-sm)]">
          <thead>
            <tr><th scope="col">Field</th><th scope="col">Was</th><th scope="col">Proposed</th></tr>
          </thead>
          <tbody>
            {changed.map(([key, name]) => (
              <tr key={key}>
                <th scope="row">{name}</th>
                <td>{base ? shown(base[key]) : 'Not known'}</td>
                <td>{shown(p.proposed_change[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="t-body mt-[var(--s3)]"><span className="font-semibold">Why:</span> {p.rationale}</p>
        {open && blocker && <p className="t-body mt-[var(--s2)] text-[color:var(--restricted-ink)]">{blocker}</p>}
        {open && !canReview && <p className="t-label mt-[var(--s2)] text-[color:var(--bone-300)]">Waiting for review</p>}
        {open && canReview && (
          <div className="mt-[var(--s3)] space-y-[var(--s3)]">
            <div className="field">
              <label htmlFor={`review-note-${p.proposal_id}`} className="t-label">Review note</label>
              <textarea id={`review-note-${p.proposal_id}`} rows={2} className="textarea" value={notes[p.proposal_id] ?? ''}
                onChange={(event) => setNotes((prev) => ({ ...prev, [p.proposal_id]: event.target.value }))} />
            </div>
            <div className="flex flex-wrap gap-[var(--s3)]">
              {!blocker && (
                <button type="button" className="btn" disabled={busy} onClick={() => void review(p, 'adopt')}
                  aria-label={`Adopt the proposal from ${day(p.created_at)} against ${versionOf(p.based_on_drill_id)}`}>
                  {busyId === p.proposal_id ? 'Saving…' : 'Adopt'}
                </button>
              )}
              <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => void review(p, 'decline')}
                aria-label={`Decline the proposal from ${day(p.created_at)} against ${versionOf(p.based_on_drill_id)}`}>
                Decline
              </button>
            </div>
          </div>
        )}
        {p.review_state === 'adopted' && (
          <p className="t-body mt-[var(--s2)]">Adopted on {day(p.reviewed_at)}. Became {versionOf(p.resulting_drill_id)}.</p>
        )}
        {(p.review_state === 'declined' || p.review_state === 'superseded') && (
          <p className="t-body mt-[var(--s2)]">{p.review_state === 'declined' ? 'Declined' : 'Superseded'} on {day(p.reviewed_at)}.</p>
        )}
        {!open && p.review_note && <p className="t-body mt-[var(--s2)]"><span className="font-semibold">Review note:</span> {p.review_note}</p>}
        {renderResult(mine)}
      </li>
    );
  }

  return (
    <section className="mat-leather mt-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]" aria-labelledby={`lineage-${drillId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
        <h3 id={`lineage-${drillId}`} ref={headingRef} tabIndex={-1} className="t-command text-[length:var(--t-lg)]">
          Versions and proposals{head ? `: ${head.name}` : ''}
        </h3>
        <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busyId !== ''}>Close</button>
      </div>
      {versions === null && !loadError && <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">Loading...</p>}
      {loadError && <p className="t-body mt-[var(--s3)] text-[color:var(--restricted-ink)]">{loadError}</p>}
      {versions && versions.length === 0 && (
        <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No versions of this drill were found in this gym.</p>
      )}
      {all.length > 0 && (
        <>
          <ol className="mt-[var(--s4)] space-y-[var(--s3)]" aria-label="Versions, oldest first">
            {all.map((v) => (
              <li key={v.drill_id} className="mat-leather--raised rounded-[var(--r-lg)] p-[var(--s4)]">
                <div className="flex flex-wrap items-baseline justify-between gap-[var(--s3)]">
                  <p className="t-command text-[length:var(--t-md)]">Version {v.version}: {v.name}</p>
                  <span className="plaque">{label(v)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn--ghost mt-[var(--s2)]"
                  aria-expanded={Boolean(expanded[v.drill_id])}
                  aria-controls={`version-content-${v.drill_id}`}
                  onClick={() => setExpanded((prev) => ({ ...prev, [v.drill_id]: !prev[v.drill_id] }))}
                >
                  {expanded[v.drill_id] ? `Hide version ${v.version}` : `Show version ${v.version}`}
                </button>
                {canReinstate && !retired && v !== head && (
                  <button type="button" className="btn btn--ghost mt-[var(--s2)] ml-[var(--s3)]" disabled={busyId !== ''}
                    onClick={() => void reinstate(v)}>
                    {busyId === v.drill_id ? 'Reinstating...' : `Reinstate version ${v.version}`}
                  </button>
                )}
                {expanded[v.drill_id] && (
                  <dl id={`version-content-${v.drill_id}`} className="t-body mt-[var(--s3)] space-y-[var(--s1)] text-[color:var(--bone-300)]">
                    {FIELDS.filter(([key]) => key !== 'name').map(([key, name]) => (
                      <div key={key}><dt className="t-label inline">{name}: </dt><dd className="inline">{shown(v[key])}</dd></div>
                    ))}
                  </dl>
                )}
                {renderResult(result?.target === v.drill_id ? result : null)}
              </li>
            ))}
          </ol>
          <h4 className="t-command mt-[var(--s5)] text-[length:var(--t-md)]">Proposed changes</h4>
          {proposals.length === 0 && <p className="t-body mt-[var(--s2)] text-[color:var(--bone-300)]">No changes have been proposed for this drill.</p>}
          <ul className="mt-[var(--s3)] space-y-[var(--s3)]">{proposals.map(renderProposal)}</ul>
        </>
      )}
    </section>
  );
}
