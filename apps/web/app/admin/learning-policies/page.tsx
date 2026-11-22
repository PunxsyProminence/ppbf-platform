'use client';

import { useEffect, useState } from 'react';

import BackHome from '@/components/BackHome';
import RoleSessionGate from '@/components/RoleSessionGate';
import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import { formatGymDateTime } from '@/src/lib/gymTime';
import {
  APPROVED_ATHLETE_LESSON_V1,
  APPROVED_CITATIONS_V1,
  APPROVED_OBSERVER_CALIBRATION_V1,
  APPROVED_PATTERN_FORMATION_V1,
} from '@/src/server/pilot/learningPolicyApprovedV1';

// PATTERN-1c (PunxsyProminence/ppbf-platform#2082): the learning bars the gym
// owner approved (OD-2026-10-17-027), with the sources each one rests on, and
// which are in force. Staff read them (the route's read roles: coach and
// admin). Only the gym's organization admin on a Microsoft sign-in is offered
// "Put in force" (OD-2026-10-18-003); the route refuses anyone else, and only
// the approved bar can be put in force, so the page sends it as approved.

type Kind = 'pattern_formation' | 'athlete_lesson' | 'observer_calibration';

interface PolicyRow {
  readonly policy_kind: Kind;
  readonly version: number;
  readonly status: 'active' | 'superseded';
  readonly ratified_at: string;
}

const pct = (share: number) => `${Math.round(share * 100)}%`;
const tier = APPROVED_PATTERN_FORMATION_V1.tiers;
const lesson = APPROVED_ATHLETE_LESSON_V1;
const calibration = APPROVED_OBSERVER_CALIBRATION_V1;

const BARS: readonly { kind: Kind; title: string; parameters: unknown; lines: readonly string[] }[] = [
  {
    kind: 'pattern_formation',
    title: 'Pattern labels',
    parameters: APPROVED_PATTERN_FORMATION_V1,
    lines: (['emerging', 'pattern', 'established'] as const).map((name) => {
      const t = tier[name];
      return `${name[0].toUpperCase()}${name.slice(1)}: ${t.minimumSessions} sessions, ${pct(t.minimumShare)} of at least `
        + `${t.minimumCodedChances} chances, ${t.minimumContexts}+ settings, ${t.minimumSpanDays}+ days; `
        + `lapses after ${t.lapseAfterMisses} misses in a row.`;
    }).concat(`Only the last ${APPROVED_PATTERN_FORMATION_V1.currentWithinDays} days count.`),
  },
  {
    kind: 'athlete_lesson',
    title: 'Lesson results',
    parameters: APPROVED_ATHLETE_LESSON_V1,
    lines: [
      `${lesson.baselinePoints} points before a lesson and ${lesson.afterPoints} after.`,
      `Improved after lesson: ${lesson.labels.improved_after.demonstrations} before/after.`,
      `Likely worked: ${lesson.labels.likely_worked.demonstrations}, staggered, with a delayed re-check.`,
      `Worked, replicated: ${lesson.labels.worked_replicated.demonstrations}, staggered, with a delayed re-check.`,
    ],
  },
  {
    kind: 'observer_calibration',
    title: 'Coach calibration',
    parameters: APPROVED_OBSERVER_CALIBRATION_V1,
    lines: [
      `A coach pair agrees on ${pct(calibration.minimumAgreement)} (kappa ${calibration.minimumKappa}) `
        + `over ${calibration.minimumPairedJudgments} paired judgments.`,
      `${pct(calibration.ongoingDoubleCodedShare)} of sessions double-coded in every phase.`,
      'Until a pair is calibrated, its notes are shown as unverified and count toward nothing.',
    ],
  },
];

const ENDPOINT = '/api/pilot/admin/learning-policies';

function LearningBars() {
  const session = usePilotSession();
  const [policies, setPolicies] = useState<readonly PolicyRow[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Kind | null>(null);
  const [saving, setSaving] = useState<Kind | null>(null);
  const [saveError, setSaveError] = useState<{ kind: Kind; message: string } | null>(null);
  // Bumped after a save, to read the list again.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}${ENDPOINT}`, { credentials: 'include', signal: controller.signal });
        const body = (await response.json()) as { ok?: boolean; policies?: PolicyRow[]; error?: string };
        if (controller.signal.aborted) return;
        if (!response.ok || !Array.isArray(body.policies)) {
          setPolicies(null);
          setReadError(body.error ?? 'The bars could not be read.');
          return;
        }
        setPolicies(body.policies);
        setReadError(null);
      } catch (error) {
        // An aborted read is the page unmounting, not a failure to report.
        if (controller.signal.aborted) return;
        setPolicies(null);
        setReadError(error instanceof Error ? error.message : 'The bars could not be read.');
      }
    })();
    return () => controller.abort();
  }, [reloadKey]);

  // The route's own rule, exactly: the organization admin role (not the legacy
  // admin alias) on a Microsoft-authenticated session.
  const mayRatify = session.role === 'organization_admin' && session.authProvider === 'microsoft';

  async function putInForce(bar: (typeof BARS)[number]) {
    setSaving(bar.kind);
    setSaveError(null);
    try {
      const response = await fetch(`${apiBase()}${ENDPOINT}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: bar.kind, parameters: bar.parameters, citations: APPROVED_CITATIONS_V1[bar.kind] }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setSaveError({ kind: bar.kind, message: body.error ?? 'The bar was not put in force.' });
        return;
      }
      setConfirming(null);
      setReloadKey((key) => key + 1);
    } catch (error) {
      setSaveError({ kind: bar.kind, message: error instanceof Error ? error.message : 'The bar was not put in force.' });
    } finally {
      setSaving(null);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-[var(--s5)]">
          <p className="t-eyebrow">Front Office · Coaching patterns</p>
          <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>
            Learning Bars
          </h1>
          <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
            The numbers the app uses before it calls something a pattern, a lesson that worked, or a coach pair that
            agrees, as the owner approved them, with the sources each rests on. A bar does nothing until it is put in
            force.
          </p>
          {!mayRatify && !session.loading && (
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              Only the gym&apos;s organization admin, signed in with Microsoft, can put a bar in force.
            </p>
          )}
        </header>

        {readError && (
          <div className="alert alert--warning" role="alert">
            <span className="alert-icon" aria-hidden="true">▲</span>
            <span>The bars could not be read, so what is in force is not known: {readError}</span>
          </div>
        )}

        {BARS.map((bar) => {
          const inForce = policies?.find((row) => row.policy_kind === bar.kind && row.status === 'active') ?? null;
          const headingId = `bar-${bar.kind}`;
          return (
            <section key={bar.kind} aria-labelledby={headingId} className="mt-[var(--s5)] border border-[var(--hide-700)] bg-[var(--hide-900)] p-[var(--s4)]">
              <h2 id={headingId} className="t-title" style={{ fontSize: 'var(--t-lg)' }}>{bar.title}</h2>
              {policies && (
                <p className="t-body mt-[var(--s2)]">
                  {inForce
                    ? `In force: version ${inForce.version}, since ${formatGymDateTime(inForce.ratified_at) ?? inForce.ratified_at}`
                    : 'Not in force'}
                </p>
              )}
              <ul className="t-body mt-[var(--s3)] list-disc pl-[var(--s5)] text-[color:var(--bone-300)]">
                {bar.lines.map((line) => <li key={line}>{line}</li>)}
              </ul>
              <h3 className="t-eyebrow mt-[var(--s4)]">Sources</h3>
              <ul className="t-body mt-[var(--s2)] list-disc pl-[var(--s5)] text-[color:var(--bone-300)]">
                {APPROVED_CITATIONS_V1[bar.kind].map((citation) => (
                  <li key={citation.source}>
                    <span>{citation.source}</span>
                    {citation.note && <span> ({citation.note})</span>}
                  </li>
                ))}
              </ul>
              {mayRatify && policies && !inForce && (
                <div className="mt-[var(--s4)] flex flex-wrap gap-[var(--s3)]">
                  {confirming === bar.kind ? (
                    <>
                      <button
                        type="button"
                        className="btn btn--ghost min-h-[var(--tap)] disabled:opacity-50"
                        disabled={saving === bar.kind}
                        onClick={() => void putInForce(bar)}
                      >
                        {`Yes, put ${bar.title} in force`}
                      </button>
                      <button type="button" className="btn btn--ghost min-h-[var(--tap)]" onClick={() => setConfirming(null)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" className="btn btn--ghost min-h-[var(--tap)]" onClick={() => setConfirming(bar.kind)}>
                      Put in force
                    </button>
                  )}
                </div>
              )}
              {saveError?.kind === bar.kind && (
                <div className="alert alert--warning mt-[var(--s3)]" role="alert">
                  <span className="alert-icon" aria-hidden="true">▲</span>
                  <span>{saveError.message}</span>
                </div>
              )}
            </section>
          );
        })}

        <div className="mt-[var(--s6)]">
          <BackHome />
        </div>
      </div>
    </main>
  );
}

export default function LearningBarsPage() {
  return (
    <RoleSessionGate allowedRoles={['admin', 'coach']}>
      <LearningBars />
    </RoleSessionGate>
  );
}
