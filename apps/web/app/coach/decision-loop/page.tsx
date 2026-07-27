'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

type MedicalStatusValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';
type RecommendationStatus = 'provisional' | 'accepted' | 'rejected' | 'expired' | 'superseded';
type NearMissSeverity = 'low' | 'moderate' | 'high' | 'critical';
type MatchState = 'match' | 'partial' | 'miss' | 'confounded';

interface AthleteListItem {
  athlete_id: string;
  full_name?: string;
}

interface MedicalStatusRow {
  status_id: string;
  athlete_id: string;
  status: MedicalStatusValue;
  restriction_flags: Record<string, unknown>;
  source_reference: string | null;
  set_by_account_id: string;
  set_by_role: string;
  effective_at: string;
  created_at: string;
}

interface RecommendationRow {
  recommendation_id: string;
  athlete_id: string;
  recommendation_text: string;
  expected_outcome: string;
  status: RecommendationStatus;
  created_by_account_id: string;
  created_at: string;
  expires_at: string;
  decided_by_account_id: string | null;
  decided_at: string | null;
}

interface DecisionRow {
  decision_id: string;
  athlete_id: string;
  recommendation_id: string | null;
  decision_text: string;
  expected_outcome: string;
  decided_by_account_id: string;
  decided_by_role: string;
  status: 'active' | 'superseded' | 'reversed';
  decided_at: string;
}

interface NearMissRow {
  near_miss_id: string;
  athlete_id: string;
  decision_id: string | null;
  description: string;
  severity: NearMissSeverity;
  detected_by: 'system' | 'human';
  created_at: string;
}

interface DecisionOutcomeRow {
  outcome_id: string;
  decision_id: string;
  observation_ids: string[];
  match_state: MatchState;
  notes: string | null;
  evaluated_by_account_id: string;
  evaluated_at: string;
}

async function readJsonOrThrow<T>(response: Response, fallbackMessage: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as (T & { ok?: boolean; error?: string }) | { error?: string };
  if (!response.ok || (payload as { ok?: boolean }).ok === false) {
    throw new Error((payload as { error?: string }).error || fallbackMessage);
  }
  return payload as T;
}

function statusChipClasses(status: string): string {
  if (status === 'provisional' || status === 'pending') return 'border-[var(--black)] bg-[var(--canvas-tan-light)]';
  if (status === 'accepted' || status === 'cleared' || status === 'active' || status === 'match') {
    return 'border-[var(--black)] bg-[var(--canvas-tan-light)] font-bold';
  }
  if (status === 'rejected' || status === 'not_cleared' || status === 'miss') {
    return 'border-[var(--red-primary)] bg-[var(--canvas-tan-light)] text-[var(--red-primary)]';
  }
  return 'border-[var(--gray-dark)] bg-[var(--canvas-tan-light)] text-[var(--gray-dark)]';
}

export default function DecisionLoopReviewPage() {
  const [athletes, setAthletes] = useState<AthleteListItem[]>([]);
  const [athleteId, setAthleteId] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const [medicalStatus, setMedicalStatus] = useState<MedicalStatusRow | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [nearMisses, setNearMisses] = useState<NearMissRow[]>([]);
  const [outcomesByDecision, setOutcomesByDecision] = useState<Record<string, DecisionOutcomeRow[]>>({});

  const [medicalStatusDraft, setMedicalStatusDraft] = useState<MedicalStatusValue>('pending');
  const [medicalSourceRef, setMedicalSourceRef] = useState('');

  const [decisionText, setDecisionText] = useState('');
  const [decisionExpectedOutcome, setDecisionExpectedOutcome] = useState('');
  const [decisionRecommendationId, setDecisionRecommendationId] = useState('');
  const [decisionMedicallySensitive, setDecisionMedicallySensitive] = useState(false);

  const [nearMissDescription, setNearMissDescription] = useState('');
  const [nearMissSeverity, setNearMissSeverity] = useState<NearMissSeverity>('low');
  const [nearMissDecisionId, setNearMissDecisionId] = useState('');

  const [outcomeDecisionId, setOutcomeDecisionId] = useState('');
  const [outcomeObservationIds, setOutcomeObservationIds] = useState('');
  const [outcomeMatchState, setOutcomeMatchState] = useState<MatchState>('match');
  const [outcomeNotes, setOutcomeNotes] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/athletes/list`, { credentials: 'include' });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: AthleteListItem[] };
        setAthletes(payload.items ?? []);
      } catch {
        // Manual athleteId entry remains available if the roster fetch fails.
      }
    })();
  }, []);

  const refreshAll = useCallback(async (targetAthleteId: string) => {
    if (!targetAthleteId) {
      return;
    }
    setLoading(true);
    setErrorMessage('');
    try {
      const [statusRes, recsRes, decisionsRes, nearMissesRes] = await Promise.all([
        fetch(`${apiBase()}/api/pilot/shadow/medical-status?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/recommendations?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/decisions?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
        fetch(`${apiBase()}/api/pilot/shadow/near-misses?athleteId=${encodeURIComponent(targetAthleteId)}`, { credentials: 'include' }),
      ]);

      const statusPayload = await readJsonOrThrow<{ status: MedicalStatusRow | null }>(statusRes, 'Failed to load medical status.');
      const recsPayload = await readJsonOrThrow<{ recommendations: RecommendationRow[] }>(recsRes, 'Failed to load recommendations.');
      const decisionsPayload = await readJsonOrThrow<{ decisions: DecisionRow[] }>(decisionsRes, 'Failed to load decisions.');
      const nearMissesPayload = await readJsonOrThrow<{ nearMisses: NearMissRow[] }>(nearMissesRes, 'Failed to load near-misses.');

      setMedicalStatus(statusPayload.status ?? null);
      setRecommendations(recsPayload.recommendations ?? []);
      setDecisions(decisionsPayload.decisions ?? []);
      setNearMisses(nearMissesPayload.nearMisses ?? []);
      setOutcomesByDecision({});
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load decision loop data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshAll(athleteId);
  }, [athleteId, refreshAll]);

  async function handleSetMedicalStatus(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId) return;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/medical-status`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          status: medicalStatusDraft,
          sourceReference: medicalSourceRef || undefined,
        }),
      });
      await readJsonOrThrow(response, 'Failed to set medical status.');
      setMedicalSourceRef('');
      await refreshAll(athleteId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to set medical status.');
    }
  }

  async function handleDecideRecommendation(recommendationId: string, decision: 'accepted' | 'rejected') {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/recommendations/decide`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ athleteId, recommendationId, decision }),
      });
      await readJsonOrThrow(response, 'Failed to record decision on recommendation.');
      await refreshAll(athleteId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to record decision on recommendation.');
    }
  }

  async function handleRecordDecision(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !decisionText.trim() || !decisionExpectedOutcome.trim()) return;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/decisions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          recommendationId: decisionRecommendationId || undefined,
          decisionText,
          expectedOutcome: decisionExpectedOutcome,
          isMedicallySensitive: decisionMedicallySensitive,
        }),
      });
      await readJsonOrThrow(response, 'Failed to record decision.');
      setDecisionText('');
      setDecisionExpectedOutcome('');
      setDecisionRecommendationId('');
      setDecisionMedicallySensitive(false);
      await refreshAll(athleteId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to record decision.');
    }
  }

  async function handleFlagNearMiss(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !nearMissDescription.trim()) return;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/near-misses`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          decisionId: nearMissDecisionId || undefined,
          description: nearMissDescription,
          severity: nearMissSeverity,
        }),
      });
      await readJsonOrThrow(response, 'Failed to flag near-miss.');
      setNearMissDescription('');
      setNearMissDecisionId('');
      setNearMissSeverity('low');
      await refreshAll(athleteId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to flag near-miss.');
    }
  }

  async function handleLoadOutcomes(decisionId: string) {
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/decision-outcomes?decisionId=${encodeURIComponent(decisionId)}`, {
        credentials: 'include',
      });
      const payload = await readJsonOrThrow<{ outcomes: DecisionOutcomeRow[] }>(response, 'Failed to load decision outcomes.');
      setOutcomesByDecision((prev) => ({ ...prev, [decisionId]: payload.outcomes ?? [] }));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to load decision outcomes.');
    }
  }

  async function handleEvaluateOutcome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!outcomeDecisionId) return;
    try {
      const observationIds = outcomeObservationIds
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

      const response = await fetch(`${apiBase()}/api/pilot/shadow/decision-outcomes`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decisionId: outcomeDecisionId,
          observationIds,
          matchState: outcomeMatchState,
          notes: outcomeNotes || undefined,
        }),
      });
      await readJsonOrThrow(response, 'Failed to evaluate decision outcome.');
      setOutcomeObservationIds('');
      setOutcomeNotes('');
      await handleLoadOutcomes(outcomeDecisionId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to evaluate decision outcome.');
    }
  }

  const actionableRecommendations = recommendations.filter((rec) => rec.status === 'provisional' || rec.status === 'accepted');

  return (
    <RoleStandaloneView
      roleLabel="Decision Loop Review"
      routeLabel="/coach/decision-loop"
      allowedRoles={['coach', 'admin']}
      showShellHeader={false}
    >
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--red-primary)]">Coach Workspace</p>
            <h1 className="font-display text-4xl font-black">SHADOW Decision Loop</h1>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Review provisional recommendations, record human decisions, flag near-misses, and evaluate outcomes.
              Every recommendation starts provisional and stays that way until a human accepts or rejects it — silence
              never equals acceptance, and medical/sparring-clearance topics are gated by the athlete&apos;s current
              medical administrative status below.
            </p>
          </header>

          <section className="mt-6 border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
            <label className="block text-xs font-bold uppercase tracking-[0.1em]">
              Athlete
              <select
                value={athleteId}
                onChange={(event) => setAthleteId(event.target.value)}
                className="mt-1 h-11 w-full max-w-md border-2 border-[var(--black)] bg-white px-3 text-sm"
              >
                <option value="">Select an athlete…</option>
                {athletes.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>
                    {athlete.full_name || athlete.athlete_id}
                  </option>
                ))}
              </select>
            </label>
            <label className="mt-3 block text-xs font-bold uppercase tracking-[0.1em]">
              Or enter an athlete ID directly
              <input
                value={athleteId}
                onChange={(event) => setAthleteId(event.target.value)}
                placeholder="athlete-id"
                className="mt-1 h-11 w-full max-w-md border-2 border-[var(--black)] bg-white px-3 text-sm"
              />
            </label>
            {loading && <p className="mt-2 text-xs text-[var(--gray-dark)]">Loading…</p>}
            {errorMessage && <p className="mt-2 text-sm font-bold text-[var(--red-primary)]">{errorMessage}</p>}
          </section>

          {!athleteId ? (
            <p className="mt-6 text-sm text-[var(--gray-dark)]">Select or enter an athlete to review their decision loop.</p>
          ) : (
            <div className="mt-6 grid gap-6 xl:grid-cols-2">
              {/* Medical Administrative Status */}
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-lg font-black uppercase tracking-[0.04em]">Medical Administrative Status</h2>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  Read-only gate for medically sensitive recommendations/decisions. Setting a new status never clears an
                  existing restriction automatically — each change is its own explicit, human-attributed record.
                </p>
                {medicalStatus ? (
                  <div className="mt-3 space-y-1 text-sm">
                    <p>
                      Current status:{' '}
                      <span className={`inline-flex border px-2 py-0.5 font-mono text-xs ${statusChipClasses(medicalStatus.status)}`}>
                        {medicalStatus.status}
                      </span>
                    </p>
                    <p className="text-xs text-[var(--gray-dark)]">
                      Set by {medicalStatus.set_by_role} ({medicalStatus.set_by_account_id}) at {medicalStatus.effective_at}
                    </p>
                    {medicalStatus.source_reference && (
                      <p className="text-xs text-[var(--gray-dark)]">Reference: {medicalStatus.source_reference}</p>
                    )}
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-[var(--gray-dark)]">No medical administrative status recorded yet.</p>
                )}

                <form onSubmit={handleSetMedicalStatus} className="mt-4 space-y-2 border-t border-[var(--black)]/20 pt-3">
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    New status
                    <select
                      value={medicalStatusDraft}
                      onChange={(event) => setMedicalStatusDraft(event.target.value as MedicalStatusValue)}
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    >
                      <option value="pending">Pending</option>
                      <option value="cleared">Cleared</option>
                      <option value="restricted">Restricted</option>
                      <option value="not_cleared">Not Cleared</option>
                    </select>
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Source reference (optional)
                    <input
                      value={medicalSourceRef}
                      onChange={(event) => setMedicalSourceRef(event.target.value)}
                      placeholder="e.g. physician note, incident id"
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    />
                  </label>
                  <button
                    type="submit"
                    className="h-11 border-2 border-[var(--black)] bg-[var(--black)] px-4 text-xs font-bold uppercase tracking-[0.1em] text-white"
                  >
                    Set Status
                  </button>
                </form>
              </section>

              {/* Recommendations */}
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-lg font-black uppercase tracking-[0.04em]">Recommendations</h2>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  Always created provisional. Only a human decision below can move one to accepted or rejected.
                </p>
                <div className="mt-3 max-h-[360px] space-y-2 overflow-y-auto">
                  {recommendations.length === 0 && <p className="text-sm text-[var(--gray-dark)]">No recommendations yet.</p>}
                  {recommendations.map((rec) => (
                    <article key={rec.recommendation_id} className="border border-[var(--black)]/40 bg-white p-3 text-sm">
                      <p className="font-semibold">{rec.recommendation_text}</p>
                      <p className="mt-1 text-xs text-[var(--gray-dark)]">Expected: {rec.expected_outcome}</p>
                      <p className="mt-1">
                        <span className={`inline-flex border px-2 py-0.5 font-mono text-xs ${statusChipClasses(rec.status)}`}>
                          {rec.status}
                        </span>
                        <span className="ml-2 text-xs text-[var(--gray-dark)]">expires {rec.expires_at}</span>
                      </p>
                      {rec.status === 'provisional' && (
                        <div className="mt-2 flex gap-2">
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'accepted')}
                            className="h-9 border-2 border-[var(--black)] bg-[var(--black)] px-3 text-xs font-bold uppercase text-white"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'rejected')}
                            className="h-9 border-2 border-[var(--red-primary)] px-3 text-xs font-bold uppercase text-[var(--red-primary)]"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              {/* Decisions */}
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-lg font-black uppercase tracking-[0.04em]">Decisions</h2>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  A decision always requires a human. It may reference a still-live recommendation, or be logged directly.
                </p>
                <div className="mt-3 max-h-[280px] space-y-2 overflow-y-auto">
                  {decisions.length === 0 && <p className="text-sm text-[var(--gray-dark)]">No decisions recorded yet.</p>}
                  {decisions.map((decision) => (
                    <article key={decision.decision_id} className="border border-[var(--black)]/40 bg-white p-3 text-sm">
                      <p className="font-semibold">{decision.decision_text}</p>
                      <p className="mt-1 text-xs text-[var(--gray-dark)]">Expected: {decision.expected_outcome}</p>
                      <p className="mt-1 text-xs text-[var(--gray-dark)]">
                        By {decision.decided_by_role} at {decision.decided_at}
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleLoadOutcomes(decision.decision_id)}
                        className="mt-2 h-8 border border-[var(--black)] px-2 text-xs font-bold uppercase"
                      >
                        Load Outcomes
                      </button>
                      {outcomesByDecision[decision.decision_id] && (
                        <div className="mt-2 space-y-1 border-t border-[var(--black)]/20 pt-2">
                          {outcomesByDecision[decision.decision_id].length === 0 ? (
                            <p className="text-xs text-[var(--gray-dark)]">No outcomes evaluated yet.</p>
                          ) : (
                            outcomesByDecision[decision.decision_id].map((outcome) => (
                              <p key={outcome.outcome_id} className="text-xs">
                                <span className={`inline-flex border px-2 py-0.5 font-mono ${statusChipClasses(outcome.match_state)}`}>
                                  {outcome.match_state}
                                </span>{' '}
                                {outcome.notes}
                              </p>
                            ))
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <form onSubmit={handleRecordDecision} className="mt-4 space-y-2 border-t border-[var(--black)]/20 pt-3">
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Link to recommendation (optional)
                    <select
                      value={decisionRecommendationId}
                      onChange={(event) => setDecisionRecommendationId(event.target.value)}
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    >
                      <option value="">None — log directly</option>
                      {actionableRecommendations.map((rec) => (
                        <option key={rec.recommendation_id} value={rec.recommendation_id}>
                          {rec.recommendation_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Decision text
                    <textarea
                      value={decisionText}
                      onChange={(event) => setDecisionText(event.target.value)}
                      className="mt-1 min-h-[72px] w-full border-2 border-[var(--black)] bg-white px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Expected outcome
                    <textarea
                      value={decisionExpectedOutcome}
                      onChange={(event) => setDecisionExpectedOutcome(event.target.value)}
                      className="mt-1 min-h-[56px] w-full border-2 border-[var(--black)] bg-white px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.1em]">
                    <input
                      type="checkbox"
                      checked={decisionMedicallySensitive}
                      onChange={(event) => setDecisionMedicallySensitive(event.target.checked)}
                    />
                    Medically sensitive (checks medical status before allowing this decision)
                  </label>
                  <button
                    type="submit"
                    className="h-11 border-2 border-[var(--black)] bg-[var(--black)] px-4 text-xs font-bold uppercase tracking-[0.1em] text-white"
                  >
                    Record Decision
                  </button>
                </form>
              </section>

              {/* Near-Misses */}
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
                <h2 className="text-lg font-black uppercase tracking-[0.04em]">Near-Misses</h2>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  Human-flagged only. Use this when something almost went wrong that a Decision didn&apos;t already cover.
                </p>
                <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto">
                  {nearMisses.length === 0 && <p className="text-sm text-[var(--gray-dark)]">No near-misses flagged yet.</p>}
                  {nearMisses.map((nearMiss) => (
                    <article key={nearMiss.near_miss_id} className="border border-[var(--black)]/40 bg-white p-3 text-sm">
                      <p>{nearMiss.description}</p>
                      <p className="mt-1 text-xs text-[var(--gray-dark)]">
                        Severity: {nearMiss.severity} · {nearMiss.created_at}
                      </p>
                    </article>
                  ))}
                </div>

                <form onSubmit={handleFlagNearMiss} className="mt-4 space-y-2 border-t border-[var(--black)]/20 pt-3">
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Description
                    <textarea
                      value={nearMissDescription}
                      onChange={(event) => setNearMissDescription(event.target.value)}
                      className="mt-1 min-h-[56px] w-full border-2 border-[var(--black)] bg-white px-3 py-2 text-sm"
                    />
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Severity
                    <select
                      value={nearMissSeverity}
                      onChange={(event) => setNearMissSeverity(event.target.value as NearMissSeverity)}
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    >
                      <option value="low">Low</option>
                      <option value="moderate">Moderate</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Related decision (optional)
                    <select
                      value={nearMissDecisionId}
                      onChange={(event) => setNearMissDecisionId(event.target.value)}
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    >
                      <option value="">None</option>
                      {decisions.map((decision) => (
                        <option key={decision.decision_id} value={decision.decision_id}>
                          {decision.decision_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="submit"
                    className="h-11 border-2 border-[var(--red-primary)] px-4 text-xs font-bold uppercase tracking-[0.1em] text-[var(--red-primary)]"
                  >
                    Flag Near-Miss
                  </button>
                </form>
              </section>

              {/* Decision Outcomes */}
              <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4 xl:col-span-2">
                <h2 className="text-lg font-black uppercase tracking-[0.04em]">Evaluate a Decision Outcome</h2>
                <p className="mt-1 text-xs text-[var(--gray-dark)]">
                  Always a human judgment: compare the decision&apos;s expected outcome against what actually happened.
                </p>
                <form onSubmit={handleEvaluateOutcome} className="mt-3 grid gap-2 md:grid-cols-2">
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Decision
                    <select
                      value={outcomeDecisionId}
                      onChange={(event) => setOutcomeDecisionId(event.target.value)}
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    >
                      <option value="">Select a decision…</option>
                      {decisions.map((decision) => (
                        <option key={decision.decision_id} value={decision.decision_id}>
                          {decision.decision_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                    Match state
                    <select
                      value={outcomeMatchState}
                      onChange={(event) => setOutcomeMatchState(event.target.value as MatchState)}
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    >
                      <option value="match">Match</option>
                      <option value="partial">Partial</option>
                      <option value="miss">Miss</option>
                      <option value="confounded">Confounded</option>
                    </select>
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em] md:col-span-2">
                    Observation IDs (comma-separated)
                    <input
                      value={outcomeObservationIds}
                      onChange={(event) => setOutcomeObservationIds(event.target.value)}
                      placeholder="obs-1, obs-2"
                      className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                    />
                  </label>
                  <label className="block text-xs font-bold uppercase tracking-[0.1em] md:col-span-2">
                    Notes
                    <textarea
                      value={outcomeNotes}
                      onChange={(event) => setOutcomeNotes(event.target.value)}
                      className="mt-1 min-h-[56px] w-full border-2 border-[var(--black)] bg-white px-3 py-2 text-sm"
                    />
                  </label>
                  <button
                    type="submit"
                    className="h-11 w-fit border-2 border-[var(--black)] bg-[var(--black)] px-4 text-xs font-bold uppercase tracking-[0.1em] text-white md:col-span-2"
                  >
                    Evaluate Outcome
                  </button>
                </form>
              </section>
            </div>
          )}

          <div className="mt-8">
            <Link
              href="/coach/review-queue"
              className="inline-flex min-h-[42px] items-center border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] px-4 text-xs font-bold uppercase tracking-[0.08em]"
            >
              Back to Coach Workspace
            </Link>
          </div>
        </div>
      </main>
    </RoleStandaloneView>
  );
}
