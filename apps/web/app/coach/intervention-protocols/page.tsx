'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleSessionGate from '@/components/RoleSessionGate';
import { apiBase } from '@/lib/apiBase';

// Intervention protocols (module 026 slice 1): the durable record of what
// we INTENDED to do about a problem -- the hypothesis, the intervention as
// designed, the intended exposure, and what would count as contradiction.
// Nothing here is evidence anything was delivered; executions (slice 2)
// record what actually happened, and the gap between the two is where half
// the learning lives.
//
// Exposure is structured -- dimension by dimension in real units. There is
// deliberately no single "difficulty" or "dose" number to type anywhere on
// this page.

interface ProtocolRow {
  protocol_id: string;
  lineage_id: string;
  version: number;
  athlete_id: string | null;
  athlete_name: string | null;
  title: string;
  target_problem: string;
  hypothesis: string;
  intervention_description: string;
  intended_task_context: string;
  intended_exposure: Record<string, number>;
  expected_outcome: string;
  contradicting_evidence: string;
  alternative_explanations: string;
  evaluation_plan: string;
  status: 'active' | 'retired' | 'superseded';
  created_at: string;
}

interface AthleteOption {
  athlete_id: string;
  full_name: string;
}

const EXPOSURE_DIMENSIONS: Array<{ key: string; label: string }> = [
  { key: 'sessions', label: 'Sessions' },
  { key: 'rounds', label: 'Rounds' },
  { key: 'minutes', label: 'Minutes' },
  { key: 'repetitions', label: 'Repetitions' },
  { key: 'live_opportunities', label: 'Live opportunities' },
  { key: 'constrained_opportunities', label: 'Constrained opportunities' },
  { key: 'cue_exposures', label: 'Cue exposures' },
  { key: 'task_exposures', label: 'Task exposures' },
];

const EMPTY_FORM = {
  title: '',
  target_problem: '',
  hypothesis: '',
  intervention_description: '',
  intended_task_context: '',
  expected_outcome: '',
  contradicting_evidence: '',
  alternative_explanations: '',
  evaluation_plan: '',
};

export default function InterventionProtocolsPage() {
  const [athletes, setAthletes] = useState<AthleteOption[]>([]);
  const [protocols, setProtocols] = useState<ProtocolRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [athleteId, setAthleteId] = useState('');
  const [exposure, setExposure] = useState<Record<string, string>>({});

  const reload = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-protocols`, {
      credentials: 'include',
      signal,
    });
    if (!response.ok) throw new Error('Unable to load protocols.');
    const payload = (await response.json()) as { items?: ProtocolRow[] };
    setProtocols(payload.items ?? []);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const [, athleteResponse] = await Promise.all([
          reload(controller.signal),
          fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (athleteResponse.ok) {
          const payload = (await athleteResponse.json()) as { items?: AthleteOption[] };
          if (!controller.signal.aborted) setAthletes(payload.items ?? []);
        }
        setLoaded(true);
      } catch {
        if (controller.signal.aborted) return;
        setErrorMessage('Unable to load protocols.');
        setLoaded(true);
      }
    })();
    return () => controller.abort();
  }, [reload]);

  const handleCreate = async () => {
    const intendedExposure: Record<string, number> = {};
    for (const [dimension, raw] of Object.entries(exposure)) {
      if (raw.trim() === '') continue;
      const amount = Number(raw);
      if (!Number.isFinite(amount) || amount <= 0) {
        setErrorMessage(`${dimension.replaceAll('_', ' ')} must be a positive number.`);
        return;
      }
      intendedExposure[dimension] = amount;
    }
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-protocols`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          athlete_id: athleteId || undefined,
          intended_exposure: intendedExposure,
        }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Create failed (${response.status})`);
      }
      setForm(EMPTY_FORM);
      setAthleteId('');
      setExposure({});
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to file the protocol.');
    } finally {
      setBusy(false);
    }
  };

  const handleRetire = async (protocolId: string) => {
    setBusy(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/coach/intervention-protocols`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retire', protocol_id: protocolId }),
      });
      if (!response.ok) {
        const err = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error || `Retire failed (${response.status})`);
      }
      await reload();
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to retire the protocol.');
    } finally {
      setBusy(false);
    }
  };

  const textField = (key: keyof typeof EMPTY_FORM, label: string, hint?: string) => (
    <div className="field md:col-span-2">
      <label className="t-label" htmlFor={`proto-${key}`}>{label}{hint ? ` — ${hint}` : ''}</label>
      <textarea id={`proto-${key}`} className="input" rows={2} value={form[key]}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))} />
    </div>
  );

  return (
    <RoleSessionGate allowedRoles={['coach', 'admin']}>
      <main className="room room--floor min-h-screen bg-[var(--hide-950)] p-[var(--s5)] text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-4xl">
          <header className="mb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command mt-[var(--s3)]" style={{ fontSize: 'var(--t-xl)' }}>Intervention Protocols</h1>
            <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">
              What we intend to do about a problem, written down before we do it: the hypothesis,
              the intervention as designed, and what would prove it wrong. A protocol is intent,
              not evidence — what actually happened gets recorded separately, against it.
            </p>
          </header>

          {errorMessage && (
            <div className="alert alert--critical" role="alert">
              <span className="alert-icon" aria-hidden="true">✕</span>
              <div className="alert-body">
                <p className="alert-title">Failed</p>
                <p className="alert-msg">{errorMessage}</p>
              </div>
            </div>
          )}

          <section className="mat-leather mb-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <h2 className="t-label mb-[var(--s3)]">File a protocol</h2>
            <div className="grid gap-[var(--s3)] md:grid-cols-2">
              <div className="field md:col-span-2">
                <label className="t-label" htmlFor="proto-athlete">Athlete (leave unset for an org-general protocol)</label>
                <select id="proto-athlete" className="select" value={athleteId}
                  onChange={(e) => setAthleteId(e.target.value)}>
                  <option value="">Org-general</option>
                  {athletes.map((athlete) => (
                    <option key={athlete.athlete_id} value={athlete.athlete_id}>{athlete.full_name}</option>
                  ))}
                </select>
              </div>
              {textField('title', 'Title')}
              {textField('target_problem', 'Target problem', 'the observed problem, specifically')}
              {textField('hypothesis', 'Hypothesis', 'why we believe this problem exists')}
              {textField('intervention_description', 'Intervention', 'as designed')}
              {textField('intended_task_context', 'Task context (optional)', 'controlled, constrained-live, live…')}
              {textField('expected_outcome', 'Expected outcome', 'what should change, and by roughly when')}
              {textField('contradicting_evidence', 'What would contradict this (optional)', 'written before, not after')}
              {textField('alternative_explanations', 'Alternative explanations (optional)')}
              {textField('evaluation_plan', 'Evaluation plan (optional)')}
            </div>

            <fieldset className="mt-[var(--s4)]">
              <legend className="t-label">Intended exposure — per dimension, in real units. There is no single dose number.</legend>
              <div className="mt-[var(--s2)] grid gap-[var(--s2)] md:grid-cols-4">
                {EXPOSURE_DIMENSIONS.map((dimension) => (
                  <div className="field" key={dimension.key}>
                    <label className="t-label" htmlFor={`exposure-${dimension.key}`} style={{ fontSize: 'var(--t-xs)' }}>
                      {dimension.label}
                    </label>
                    <input id={`exposure-${dimension.key}`} className="input" inputMode="decimal"
                      value={exposure[dimension.key] ?? ''}
                      onChange={(e) => setExposure((x) => ({ ...x, [dimension.key]: e.target.value }))} />
                  </div>
                ))}
              </div>
            </fieldset>

            <div className="mt-[var(--s4)]">
              <button type="button" className="btn" disabled={busy} onClick={() => void handleCreate()}>
                {busy ? 'Filing…' : 'File protocol'}
              </button>
            </div>
          </section>

          {loaded && (
            protocols.length === 0 && !errorMessage ? (
              <div className="mat-leather rounded-[var(--r-lg)]">
                <div className="empty">
                  <div className="empty-title">No protocols on record</div>
                  <p className="empty-msg mx-auto">Intent gets written down before the work starts.</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-[var(--s2)]">
                {protocols.map((protocol) => (
                  <li key={protocol.protocol_id} className="mat-leather rounded-[var(--r-md)] p-[var(--s3)]">
                    <div className="flex flex-wrap items-center gap-[var(--s3)]">
                      {protocol.status === 'retired' ? (
                        <span className="badge badge--locked"><i aria-hidden="true">◼</i>retired</span>
                      ) : (
                        <span className="badge badge--cleared"><i aria-hidden="true">●</i>active</span>
                      )}
                      <span className="t-body font-semibold text-[color:var(--bone-100)]">{protocol.title}</span>
                      <span className="t-data" style={{ fontSize: 'var(--t-xs)' }}>
                        v{protocol.version} · {protocol.athlete_name ?? 'org-general'} · {protocol.created_at.slice(0, 10)}
                      </span>
                      {protocol.status === 'active' && (
                        <button type="button" className="btn btn--ghost" disabled={busy}
                          onClick={() => void handleRetire(protocol.protocol_id)}>
                          Retire
                        </button>
                      )}
                    </div>
                    <p className="t-body mt-[var(--s2)]" style={{ fontSize: 'var(--t-sm)' }}>
                      <strong>Problem:</strong> {protocol.target_problem}
                    </p>
                    <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>
                      <strong>Hypothesis:</strong> {protocol.hypothesis}
                    </p>
                    <p className="t-body mt-[var(--s1)]" style={{ fontSize: 'var(--t-sm)' }}>
                      <strong>Expected:</strong> {protocol.expected_outcome}
                    </p>
                    {Object.keys(protocol.intended_exposure).length > 0 && (
                      <p className="t-data mt-[var(--s2)]" style={{ fontSize: 'var(--t-xs)' }}>
                        {Object.entries(protocol.intended_exposure)
                          .map(([dimension, amount]) => `${dimension.replaceAll('_', ' ')}: ${amount}`)
                          .join(' · ')}
                      </p>
                    )}
                    {protocol.contradicting_evidence ? (
                      <p className="t-body mt-[var(--s1)] text-[color:var(--bone-300)]" style={{ fontSize: 'var(--t-sm)' }}>
                        <strong>Would contradict:</strong> {protocol.contradicting_evidence}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          )}

          <div className="mt-[var(--s5)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">Back to Coach Workspace</Link>
          </div>
        </div>
      </main>
    </RoleSessionGate>
  );
}
