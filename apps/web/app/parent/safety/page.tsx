"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

type TrainingHoldScope = 'all_training' | 'contact_only' | 'conditioning_only';

interface AthleteFacingHold {
  scope: TrainingHoldScope;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
}

interface GateSummaryRow {
  gate_key: string;
  name: string;
  category: string;
  outcome: 'passed' | 'blocked' | 'flagged' | 'not_evaluated';
  evaluated_at: string | null;
}

interface AthleteSafety {
  athlete_id: string;
  athlete_name: string | null;
  hold: AthleteFacingHold | null;
  gates: GateSummaryRow[];
}

// Same headline copy TrainingHoldBanner.tsx already uses for the athlete
// themselves -- a guardian reads the identical, non-punitive framing.
const SCOPE_HEADLINE: Record<TrainingHoldScope, string> = {
  all_training: 'Training is paused right now',
  contact_only: 'Contact work is paused right now',
  conditioning_only: 'Conditioning is paused right now',
};

const GATE_OUTCOME_LABEL: Record<GateSummaryRow['outcome'], string> = {
  passed: 'Clear',
  blocked: 'Not clear',
  flagged: 'Needs a look',
  not_evaluated: 'Not yet checked',
};

const GATE_OUTCOME_BADGE: Record<GateSummaryRow['outcome'], string> = {
  passed: 'badge--cleared',
  blocked: 'badge--restricted',
  flagged: 'badge--restricted',
  not_evaluated: 'badge--monitor',
};

export default function GuardianSafetyPage() {
  const [items, setItems] = useState<AthleteSafety[] | null>(null);
  const [errorMessage, setErrorMessage] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/parent/safety`, { credentials: 'include' });
      const payload = (await response.json().catch(() => ({}))) as { items?: AthleteSafety[]; error?: string };
      if (!response.ok) {
        throw new Error(payload.error || 'Unable to load safety status.');
      }
      setItems(payload.items ?? []);
      setErrorMessage('');
    } catch (error) {
      setItems([]);
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load safety status.');
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const isLoading = items === null;

  return (
    <RoleSessionGate allowedRoles={['parent']}>
      <main className="room--office min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Guardian</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Safety Status</h1>
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Whether your child&rsquo;s training is currently paused for any reason, and their standing against
              the gym&rsquo;s safety checks. This shows the same information your child can see about themselves
              -- nothing more.
            </p>
            {errorMessage ? (
              <p role="alert" className="alert alert--critical mt-[var(--s3)]">
                <span className="alert-icon">✕</span>
                <span className="alert-msg">{errorMessage}</span>
              </p>
            ) : null}
          </header>

          {isLoading ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">Loading…</div>
            </div>
          ) : errorMessage ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">✕</div>
              <div className="empty-title">Safety status could not be loaded</div>
              <div className="empty-msg">Reload to retry.</div>
            </div>
          ) : items.length === 0 ? (
            <div className="empty mt-[var(--s5)]">
              <div className="empty-glyph" aria-hidden="true">◌</div>
              <div className="empty-title">No linked children found</div>
              <div className="empty-msg">Contact the gym if this doesn&rsquo;t look right.</div>
            </div>
          ) : (
            <section className="mt-[var(--s5)] flex flex-col gap-[var(--s5)]">
              {items.map((item) => (
                <article
                  key={item.athlete_id}
                  className="mat-leather rounded-[var(--r-lg)] border border-[color:rgba(212,175,74,.14)] p-[var(--s5)]"
                >
                  <p className="t-eyebrow">{item.athlete_name ?? item.athlete_id}</p>

                  {item.hold ? (
                    <div
                      role="status"
                      className="mat-paper mt-[var(--s3)] rounded-[var(--r-md)] border-2 border-[color:var(--brass-700)] p-[var(--s4)] space-y-[var(--s2)]"
                    >
                      <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                        {SCOPE_HEADLINE[item.hold.scope] ?? SCOPE_HEADLINE.all_training}
                      </h2>
                      <p className="t-body leading-relaxed">{item.hold.athlete_explanation}</p>
                      {item.hold.lift_condition_text ? (
                        <p className="t-body leading-relaxed">
                          <span className="font-bold">The way back: </span>
                          {item.hold.lift_condition_text}
                        </p>
                      ) : null}
                      <p className="t-body leading-relaxed opacity-80">
                        This is not a punishment -- it is your child&rsquo;s coaches looking out for them. Talk to
                        the coach or gym admin if anything about it is unclear.
                      </p>
                    </div>
                  ) : (
                    <p className="t-body mt-[var(--s3)] text-[color:var(--bone-400)]">No training pause on file right now.</p>
                  )}

                  {item.gates.length > 0 ? (
                    <div className="mt-[var(--s4)]">
                      <p className="t-label">Safety checks</p>
                      <div className="mt-[var(--s2)] flex flex-col gap-[var(--s2)]">
                        {item.gates.map((gate) => (
                          <div key={gate.gate_key} className="flex items-center justify-between gap-[var(--s3)] text-[length:var(--t-sm)]">
                            <span>{gate.name}</span>
                            <span className={`badge ${GATE_OUTCOME_BADGE[gate.outcome]}`}>
                              {GATE_OUTCOME_LABEL[gate.outcome]}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </article>
              ))}
            </section>
          )}

          <div className="mt-[var(--s6)] flex flex-wrap gap-[var(--s3)]">
            <Link href="/parent/consent" className="btn btn--ghost">
              Photo &amp; Video Consent
            </Link>
            <Link href="/parent/dashboard" className="btn btn--ghost">
              Back to Parent Hub
            </Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
