'use client';

import { useMemo, useState } from 'react';

interface SafetyEscalationRow {
  organization_id: string;
  escalation_id: string;
  source_type: 'near_miss' | 'pain_report' | 'safety_gate_evaluation' | 'repeated_pattern' | 'athlete_voice' | 'training_hold' | 'incident';
  source_id: string | null;
  athlete_id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  reason: string;
  escalated_to_role: 'coach' | 'organization_admin' | 'admin';
  triggered_by: 'system' | 'human';
  triggered_by_account_id: string | null;
  triggered_by_role: string | null;
  status: 'open' | 'acknowledged' | 'resolved';
  acknowledged_by_account_id: string | null;
  acknowledged_at: string | null;
  resolved_by_account_id: string | null;
  resolved_at: string | null;
  resolution_note: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface ShadowNearMissRow {
  near_miss_id: string;
  organization_id: string;
  athlete_id: string;
  decision_id: string | null;
  description: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  detected_by: 'system' | 'human';
  detected_by_account_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface HeavyBagAssignment {
  station: string;
  athlete_id: string;
  athlete_name: string;
  duration_min: number;
  contact_level: 'none' | 'light' | 'moderate';
}

const MOCK_ESCALATIONS: SafetyEscalationRow[] = [
  {
    organization_id: 'ppbf-org-001',
    escalation_id: 'esc-2026-0811-01',
    source_type: 'incident',
    source_id: null,
    athlete_id: 'ath-091',
    severity: 'critical',
    reason: 'Post-sparring dizziness report pending medical review.',
    escalated_to_role: 'organization_admin',
    triggered_by: 'human',
    triggered_by_account_id: 'acct-coach-11',
    triggered_by_role: 'coach',
    status: 'open',
    acknowledged_by_account_id: null,
    acknowledged_at: null,
    resolved_by_account_id: null,
    resolved_at: null,
    resolution_note: '',
    metadata: {
      occurred_at: '2026-08-11T10:15:00.000Z',
      awaiting_return_to_training: true,
    },
    created_at: '2026-08-11T10:18:00.000Z',
    updated_at: '2026-08-11T10:18:00.000Z',
  },
  {
    organization_id: 'ppbf-org-001',
    escalation_id: 'esc-2026-0811-02',
    source_type: 'training_hold',
    source_id: 'hold-440',
    athlete_id: 'ath-044',
    severity: 'high',
    reason: 'Training hold was bypassed during scheduler registration attempt.',
    escalated_to_role: 'organization_admin',
    triggered_by: 'system',
    triggered_by_account_id: 'acct-system',
    triggered_by_role: 'system',
    status: 'acknowledged',
    acknowledged_by_account_id: 'acct-admin-01',
    acknowledged_at: '2026-08-11T09:47:00.000Z',
    resolved_by_account_id: null,
    resolved_at: null,
    resolution_note: '',
    metadata: {
      awaiting_return_to_training: false,
    },
    created_at: '2026-08-11T09:41:00.000Z',
    updated_at: '2026-08-11T09:47:00.000Z',
  },
];

const MOCK_NEAR_MISSES: ShadowNearMissRow[] = [
  {
    near_miss_id: 'nm-2026-001',
    organization_id: 'ppbf-org-001',
    athlete_id: 'ath-091',
    decision_id: 'dec-291',
    description: 'Athlete reported headache after glove impact; contact volume halted.',
    severity: 'high',
    detected_by: 'human',
    detected_by_account_id: 'acct-coach-11',
    metadata: { trigger: 'contact_observation_during_training_hold', context_id: 'sess-771' },
    created_at: '2026-08-11T10:07:00.000Z',
  },
  {
    near_miss_id: 'nm-2026-002',
    organization_id: 'ppbf-org-001',
    athlete_id: 'ath-044',
    decision_id: null,
    description: 'Hydration warning flagged during conditioning interval.',
    severity: 'moderate',
    detected_by: 'system',
    detected_by_account_id: null,
    metadata: { trigger: 'pain_report_threshold', context_id: 'sess-770' },
    created_at: '2026-08-11T09:36:00.000Z',
  },
];

const MOCK_HEAVY_BAG_ASSIGNMENTS: HeavyBagAssignment[] = [
  { station: 'Bag-1', athlete_id: 'ath-091', athlete_name: 'A. Rivera', duration_min: 6, contact_level: 'light' },
  { station: 'Bag-2', athlete_id: 'ath-044', athlete_name: 'J. Clark', duration_min: 6, contact_level: 'none' },
  { station: 'Bag-3', athlete_id: 'ath-062', athlete_name: 'N. Ellis', duration_min: 6, contact_level: 'moderate' },
  { station: 'Bag-4', athlete_id: 'ath-018', athlete_name: 'K. Young', duration_min: 6, contact_level: 'light' },
];

const HALLUCINATION_BLOCKER = '⚠️ CRITICAL LOG ERROR: Source parameters unavailable. AI hallucination blocker active. Generating missing parameter request trace string for Head Coach Jason.';

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

export default function IncidentCommandCenter() {
  const [ringAvailable, setRingAvailable] = useState(true);

  const queuedCount = useMemo(
    () => MOCK_ESCALATIONS.filter((row) => row.status !== 'resolved').length,
    [],
  );

  return (
    <section className="border border-zinc-800 rounded-none bg-black p-4">
      <header className="mb-4 border border-zinc-800 rounded-none bg-black p-4">
        <p className="text-xs uppercase tracking-[0.12em] text-slate-500">Role 9 Program &amp; Safety Director</p>
        <h1 className="mt-2 text-lg uppercase tracking-[0.12em] text-slate-200">Incident Command Center / Facility Operations</h1>
        <p className="mt-2 text-sm text-slate-400">Open escalation queue: {queuedCount}</p>
      </header>

      <p className="mb-4 animate-pulse text-[#b91c1c] text-sm">{HALLUCINATION_BLOCKER}</p>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section className="border border-zinc-800 rounded-none bg-black p-4">
          <h2 className="text-sm uppercase tracking-[0.1em] text-slate-300">[L26] Safety Escalation Queue</h2>
          <div className="mt-3 space-y-3">
            {MOCK_ESCALATIONS.map((row) => (
              <article key={row.escalation_id} className="border border-zinc-800 rounded-none p-3">
                <p className="text-xs text-slate-500">{row.escalation_id} · {row.source_type} · {row.severity.toUpperCase()}</p>
                <p className="mt-1 text-sm text-slate-200">Athlete: {row.athlete_id}</p>
                <p className="mt-1 text-sm text-slate-300">{row.reason}</p>
                <p className="mt-1 text-xs text-slate-500">Status: {row.status} · Triggered: {row.triggered_by}</p>
                {asBoolean(row.metadata.awaiting_return_to_training) ? (
                  <p className="mt-2 border border-zinc-800 rounded-none bg-[#09090b] px-2 py-1 text-xs uppercase tracking-[0.08em] text-slate-300">
                    Pending Coach Verification Flag {"{"}"verified_by_jason": false{"}"}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <section className="border border-zinc-800 rounded-none bg-black p-4">
          <h2 className="text-sm uppercase tracking-[0.1em] text-slate-300">[L26] Near-Miss Radar</h2>
          <div className="mt-3 space-y-3">
            {MOCK_NEAR_MISSES.map((row) => (
              <article key={row.near_miss_id} className="border border-zinc-800 rounded-none p-3">
                <p className="text-xs text-slate-500">{row.near_miss_id} · {row.severity.toUpperCase()} · {row.detected_by}</p>
                <p className="mt-1 text-sm text-slate-200">Athlete: {row.athlete_id}</p>
                <p className="mt-1 text-sm text-slate-300">{row.description}</p>
                <p className="mt-1 text-xs text-slate-500">Context: {asOptionalString(row.metadata.context_id) ?? 'n/a'} · Trigger: {asOptionalString(row.metadata.trigger) ?? 'n/a'}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="border border-zinc-800 rounded-none bg-black p-4">
          <h2 className="text-sm uppercase tracking-[0.1em] text-slate-300">[L28] Facility Operations</h2>

          <label className="mt-3 flex items-center gap-3 border border-zinc-800 rounded-none bg-[#09090b] p-3 text-sm">
            <input
              type="checkbox"
              checked={ringAvailable}
              onChange={(event) => setRingAvailable(event.target.checked)}
              className="h-4 w-4"
            />
            Ring Availability: {ringAvailable ? 'ACTIVE' : 'LOCKED'}
          </label>

          <div className="mt-3 border border-zinc-800 rounded-none bg-[#09090b] p-3">
            <p className="text-xs uppercase tracking-[0.1em] text-slate-400">Heavy Bag Assignment Matrix</p>
            <div className="mt-2 overflow-x-auto">
              <table className="min-w-full border-collapse text-xs">
                <thead>
                  <tr className="text-left text-slate-400">
                    <th className="border border-zinc-800 px-2 py-1">Station</th>
                    <th className="border border-zinc-800 px-2 py-1">Athlete ID</th>
                    <th className="border border-zinc-800 px-2 py-1">Athlete</th>
                    <th className="border border-zinc-800 px-2 py-1">Duration (min)</th>
                    <th className="border border-zinc-800 px-2 py-1">Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_HEAVY_BAG_ASSIGNMENTS.map((row) => (
                    <tr key={row.station} className="text-slate-300">
                      <td className="border border-zinc-800 px-2 py-1">{row.station}</td>
                      <td className="border border-zinc-800 px-2 py-1">{row.athlete_id}</td>
                      <td className="border border-zinc-800 px-2 py-1">{row.athlete_name}</td>
                      <td className="border border-zinc-800 px-2 py-1">{row.duration_min}</td>
                      <td className="border border-zinc-800 px-2 py-1">{row.contact_level}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </section>
  );
}
