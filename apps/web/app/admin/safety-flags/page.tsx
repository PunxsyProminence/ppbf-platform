'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// The safety-flags board (register module 170): the first consumer of the
// open-flag queue API. Everything here rides the existing route's own
// contract -- coach/admin audience, org-scoped reads, a MANDATORY note on
// every resolution (the false-positive learning signal, not friction), and
// the rule the module enforces server-side is mirrored in what the client
// offers: an external_rule flag cannot be bypassed, only acknowledged.
//
// Honesty rules, same as every safety surface: a failed read admits flags
// may exist; an empty healthy read says a flag would appear here; unknown
// is never rendered as clear.

interface FlagRow {
  flag_id: string;
  athlete_id: string | null;
  flag_class: 'system_guidance' | 'external_rule';
  flag_code: string;
  severity: 'advisory' | 'attention' | 'blocking_display';
  triggered_by: string;
  trigger_detail: string;
  evidence_basis: string;
  created_at: string;
}

const SEVERITY_BADGE: Record<string, { className: string; glyph: string; label: string }> = {
  blocking_display: { className: 'badge badge--locked', glyph: '✕', label: 'blocking' },
  attention: { className: 'badge badge--restricted', glyph: '▲', label: 'attention' },
  advisory: { className: 'badge badge--monitor', glyph: '◉', label: 'advisory' },
};

const RESOLUTIONS = [
  { value: 'acted_on', label: 'Acted on' },
  { value: 'true_but_not_actionable', label: 'True, not actionable' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'acknowledged_external_constraint', label: 'Acknowledged external constraint' },
  { value: 'deferred', label: 'Deferred' },
] as const;

export default function SafetyFlagsBoardPage() {
  const [flags, setFlags] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolveDraft, setResolveDraft] = useState<{ flagId: string; status: string; resolution: string; note: string } | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/safety-flags`, {
      method: 'GET',
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load open safety flags.');
    const payload = (await response.json()) as { flags?: FlagRow[] };
    setFlags(payload.flags ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        await reload(controller.signal);
        setErrorMessage(null);
        setLoading(false);
      } catch (error) {
        // An aborted load is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load open safety flags.');
        setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const handleResolve = async () => {
    if (!resolveDraft) return;
    if (!resolveDraft.note.trim()) {
      setErrorMessage('A note is required on every resolution — it is the learning signal.');
      return;
    }
    setBusyId(resolveDraft.flagId);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/safety-flags`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          flag_id: resolveDraft.flagId,
          status: resolveDraft.status,
          resolution: resolveDraft.resolution,
          coach_note: resolveDraft.note,
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Resolve failed (${response.status})`);
      }
      setResolveDraft(null);
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to resolve the flag.');
    } finally {
      setBusyId(null);
    }
  };

  const counts = {
    blocking_display: flags.filter((flag) => flag.severity === 'blocking_display').length,
    attention: flags.filter((flag) => flag.severity === 'attention').length,
    advisory: flags.filter((flag) => flag.severity === 'advisory').length,
  };

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--clinic min-h-screen p-[var(--s5)]">
        <div className="mx-auto w-full max-w-4xl">
          {/* Room DNA (clinic): the room's own varnished cabinetry under the
              masthead, the green banker's shade the wall's light already
              implies, and the blackletter the design system reserves for the
              clinic masthead -- display size only, per the README. The eyebrow
              states --brass-200 because --brass-400 measures 3.34:1 on
              .mat-wood's lit top edge; see the full note on
              /coach/sports-medicine, which also records that the restatement
              belongs in ppbf.css rather than here. */}
          <i aria-hidden="true" className="lamp lamp--green right-[8%]" />
          <header className="mat-wood mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s5)]">
            <p className="t-eyebrow text-[color:var(--brass-200)]">Safety</p>
            <h1
              className="t-gothic mt-[var(--s3)] text-[color:var(--bone-100)]"
              style={{ fontSize: 'var(--t-2xl)' }}
            >
              Open Safety Flags
            </h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Every open flag in the organization, worst first. Resolving one requires a note —
              that note is how the system learns which flags were real. External-rule flags can be
              acknowledged, never bypassed.
            </p>
          </header>

          {/* Room DNA (clinic): red is --locked, and --locked is a medical or
              safeguarding fact. This banner carries a failed read, a failed
              write, and the client-side "a note is required" rule -- three
              things that are not that. --restricted carries them, with the
              glyph and the uppercase label Law 3 requires still doing the work
              colour must never do alone. */}
          {errorMessage && (
            <div className="alert alert--warning" role="alert">
              <span className="alert-icon" aria-hidden="true">▲</span>
              <div className="alert-body">
                <p className="alert-title">Attention</p>
                <p className="alert-msg">{errorMessage}{errorMessage.includes('load') ? ' Flags may exist that are not shown here.' : ''}</p>
              </div>
            </div>
          )}

          {!loading && !errorMessage && (
            <div className="mb-[var(--s4)] grid gap-[var(--s3)] md:grid-cols-3">
              {(['blocking_display', 'attention', 'advisory'] as const).map((severity) => (
                <article key={severity} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s4)]">
                  <p className="t-eyebrow">{SEVERITY_BADGE[severity].label}</p>
                  <p className="mt-[var(--s2)] text-[length:var(--t-xl)] font-black text-[color:var(--bone-100)]">{counts[severity]}</p>
                </article>
              ))}
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-[var(--s7)]">
              <span className="working">Loading open flags...</span>
            </div>
          ) : !errorMessage && flags.length === 0 ? (
            <div className="mat-leather rounded-[var(--r-lg)]">
              <div className="empty">
                <div className="empty-title">No open safety flags</div>
                <p className="empty-msg mx-auto">A raised flag would appear here until someone resolves it with a note.</p>
              </div>
            </div>
          ) : (
            <ul className="space-y-[var(--s3)]">
              {[...flags]
                .sort((a, b) => {
                  const order = { blocking_display: 0, attention: 1, advisory: 2 } as const;
                  return order[a.severity] - order[b.severity];
                })
                .map((flag) => {
                  const badge = SEVERITY_BADGE[flag.severity] ?? SEVERITY_BADGE.advisory;
                  const resolving = resolveDraft?.flagId === flag.flag_id;
                  return (
                    <li key={flag.flag_id} className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                      <div className="flex flex-wrap items-center gap-[var(--s3)]">
                        <span className="t-body font-semibold text-[color:var(--bone-100)]">{flag.flag_code}</span>
                        <span className={badge.className}><i aria-hidden="true">{badge.glyph}</i>{badge.label}</span>
                        <span className="t-label">{flag.flag_class === 'external_rule' ? 'external rule' : 'system guidance'}</span>
                        {flag.athlete_id ? (
                          <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>Athlete ID {flag.athlete_id}</span>
                        ) : null}
                        <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>raised {flag.created_at.slice(0, 10)} · {flag.triggered_by.replaceAll('_', ' ')}</span>
                      </div>
                      {flag.trigger_detail ? (
                        <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>{flag.trigger_detail}</p>
                      ) : null}

                      {resolving ? (
                        <div className="mt-[var(--s3)] grid gap-[var(--s2)] md:max-w-lg">
                          <div className="field">
                            <label className="t-label" htmlFor={`status-${flag.flag_id}`}>Outcome</label>
                            <select id={`status-${flag.flag_id}`} className="select" value={resolveDraft.status}
                              onChange={(e) => setResolveDraft((d) => d && { ...d, status: e.target.value })}>
                              <option value="acknowledged">Acknowledged</option>
                              {/* The server refuses bypassing an external rule; the client does not offer it. */}
                              {flag.flag_class !== 'external_rule' && <option value="bypassed">Bypassed</option>}
                              <option value="upheld">Upheld</option>
                              <option value="withdrawn">Withdrawn</option>
                            </select>
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`resolution-${flag.flag_id}`}>Resolution</label>
                            <select id={`resolution-${flag.flag_id}`} className="select" value={resolveDraft.resolution}
                              onChange={(e) => setResolveDraft((d) => d && { ...d, resolution: e.target.value })}>
                              {RESOLUTIONS.map((resolution) => (
                                <option key={resolution.value} value={resolution.value}>{resolution.label}</option>
                              ))}
                            </select>
                          </div>
                          <div className="field">
                            <label className="t-label" htmlFor={`note-${flag.flag_id}`}>Note (required)</label>
                            <textarea id={`note-${flag.flag_id}`} className="input" rows={2} value={resolveDraft.note}
                              onChange={(e) => setResolveDraft((d) => d && { ...d, note: e.target.value })} />
                          </div>
                          <div className="flex gap-[var(--s2)]">
                            <button type="button" className="btn" disabled={busyId === flag.flag_id} onClick={() => void handleResolve()}>
                              {busyId === flag.flag_id ? 'Saving…' : 'Resolve flag'}
                            </button>
                            <button type="button" className="btn btn--ghost" onClick={() => setResolveDraft(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-[var(--s3)]">
                          <button type="button" className="btn btn--ghost"
                            onClick={() => setResolveDraft({ flagId: flag.flag_id, status: 'acknowledged', resolution: 'acted_on', note: '' })}>
                            Resolve…
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/admin" className="btn btn--ghost">Back to Admin</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
