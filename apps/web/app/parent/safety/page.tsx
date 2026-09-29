"use client";

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';
import RefusalStamp from '@/components/RefusalStamp';

type TrainingHoldScope = 'all_training' | 'contact_only' | 'conditioning_only';

interface AthleteFacingHold {
  scope: TrainingHoldScope;
  athlete_explanation: string;
  lift_condition_text: string;
  placed_at: string;
  expires_at: string | null;
  placed_by_name: string;
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
  /* Every tracked waiver type's status, returned by the route since #799
     (api/pilot/parent/safety/route.ts, `waivers`). Typed loosely on purpose:
     the page renders whatever actually arrives, and anything outside the
     vocabulary below reads Unknown -- never Signed, never Missing. */
  waivers?: Record<string, unknown> | null;
}

/* The four types the route reads (TRACKED_WAIVER_TYPES in
   src/server/pilot/waiverCompliance.ts, which imports the database client and
   so cannot be imported into this client page). Listed here so a type the
   response leaves out still gets a row, reading Unknown, rather than silently
   dropping off a list a guardian would take as complete. */
const TRACKED_WAIVER_TYPES = ['general', 'medical_release', 'photo_media', 'travel'] as const;
type TrackedWaiverType = (typeof TRACKED_WAIVER_TYPES)[number];

// Same labels /admin/waiver-status uses for the same four types.
const WAIVER_TYPE_LABEL: Record<TrackedWaiverType, string> = {
  general: 'General',
  medical_release: 'Medical release',
  photo_media: 'Photo & media',
  travel: 'Travel',
};

const WAIVER_STATUSES = ['signed', 'declined', 'withdrawn', 'missing'] as const;
type WaiverStatus = (typeof WAIVER_STATUSES)[number];

interface WaiverStatusDisplay {
  label: string;
  glyph: string;
  badge: string;
}

/* Glyph + uppercase label (.badge sets text-transform), never colour alone
   (design-system README, Law 3). Signed/other split and glyphs match
   /admin/waiver-status for the same statuses; Unknown uses the ◌ / --filed
   mark other pages use for an unknown state. */
const WAIVER_STATUS_DISPLAY: Record<WaiverStatus, WaiverStatusDisplay> = {
  signed: { label: 'Signed', glyph: '✓', badge: 'badge--cleared' },
  declined: { label: 'Declined', glyph: '▲', badge: 'badge--restricted' },
  withdrawn: { label: 'Withdrawn', glyph: '▲', badge: 'badge--restricted' },
  missing: { label: 'Missing', glyph: '▲', badge: 'badge--restricted' },
};

const UNKNOWN_WAIVER_STATUS: WaiverStatusDisplay = { label: 'Unknown', glyph: '◌', badge: 'badge--filed' };

function isTrackedWaiverType(type: string): type is TrackedWaiverType {
  return (TRACKED_WAIVER_TYPES as readonly string[]).includes(type);
}

function waiverTypeLabel(type: string): string {
  return isTrackedWaiverType(type) ? WAIVER_TYPE_LABEL[type] : type.replace(/_/g, ' ');
}

function waiverStatusDisplay(raw: unknown): WaiverStatusDisplay {
  return typeof raw === 'string' && (WAIVER_STATUSES as readonly string[]).includes(raw)
    ? WAIVER_STATUS_DISPLAY[raw as WaiverStatus]
    : UNKNOWN_WAIVER_STATUS;
}

/** The four tracked types in a fixed order, then any other type the route
 *  returned, so nothing it sends is hidden. */
function waiverRows(waivers: AthleteSafety['waivers']): Array<{ type: string; status: unknown }> {
  const source: Record<string, unknown> =
    waivers && typeof waivers === 'object' && !Array.isArray(waivers) ? waivers : {};
  const others = Object.keys(source).filter((type) => !isTrackedWaiverType(type));
  return [...TRACKED_WAIVER_TYPES, ...others].map((type) => ({ type, status: source[type] }));
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
      {/* T7 (Plate Set v1): a family surface takes the warm ground or none --
          never another room's wall. This route is gated to `parent`, which
          roleGround.ts calls family, so the office room it used to declare
          would have put a plank-wall plate behind a safety page written for a
          parent. The room is dropped rather than swapped for .on-canvas:
          this page's type is still tuned for ink, and moving the ground
          without converting the content is the readability trap roleGround.ts
          warns about. Converting it is its own slice. */}
      <main className="min-h-screen bg-[var(--hide-950)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl px-[var(--s5)] py-[var(--s6)] lg:px-[var(--s6)]">
          <header className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s5)]">
            <p className="t-eyebrow">Guardian</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Safety Status</h1>
            {/* The "same information your child can see" claim covers the hold
                and the checks only: no athlete screen shows waivers. And the
                waiver list is the four tracked types, not every waiver on file
                (the route reads those four only), so the copy names them. */}
            <p className="t-body mt-[var(--s3)] max-w-3xl">
              Whether your child&rsquo;s training is currently paused for any reason, and their standing
              against the gym&rsquo;s safety checks -- the same information your child can see about
              themselves, nothing more.
            </p>
            <p className="t-body mt-[var(--s2)] max-w-3xl">
              Below that, the status of the four waivers the gym tracks: general, medical release, photo
              &amp; media and travel. Photo &amp; media reads Signed only when every guardian on file for
              your child has signed it; the Photo &amp; Video Consent page below is where you sign or
              withdraw yours. Missing means the gym has not recorded that waiver yet.
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
                  className="mat-leather rounded-[var(--r-lg)] border border-[color:rgb(var(--brass-400-rgb)_/_.14)] p-[var(--s5)]"
                >
                  <p className="t-eyebrow">{item.athlete_name ?? item.athlete_id}</p>

                  {item.hold ? (
                    <div className="mt-[var(--s3)] space-y-[var(--s2)]">
                      {/* Same shared mark TrainingHoldBanner.tsx and the Sports Medicine
                          board render for the same real thing (Room DNA: the stamp does
                          not change by room). Owner decision, 2026-08-19: a guardian now
                          reads the same coach name their child does -- a real point of
                          contact, not an unattributed note. */}
                      <h2 className="t-command" style={{ fontSize: 'var(--t-md)' }}>
                        {SCOPE_HEADLINE[item.hold.scope] ?? SCOPE_HEADLINE.all_training}
                      </h2>
                      <RefusalStamp
                        kind="training_hold"
                        coachExplanation={item.hold.athlete_explanation}
                        coachName={item.hold.placed_by_name}
                        endsWhen={
                          item.hold.lift_condition_text ||
                          `Ask ${item.hold.placed_by_name} what has to happen next.`
                        }
                      />
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

                  <div className="mt-[var(--s4)]">
                    <p className="t-label">Waivers</p>
                    <div className="mt-[var(--s2)] flex flex-col gap-[var(--s2)]">
                      {waiverRows(item.waivers).map(({ type, status }) => {
                        const display = waiverStatusDisplay(status);
                        return (
                          <div
                            key={type}
                            data-waiver-type={type}
                            className="flex items-center justify-between gap-[var(--s3)] text-[length:var(--t-sm)]"
                          >
                            <span>{waiverTypeLabel(type)}</span>
                            <span className={`badge ${display.badge}`}>
                              <i aria-hidden="true">{display.glyph}</i>
                              {display.label}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
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
