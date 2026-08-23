'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';
import WorkAxis from '@/components/WorkAxis';

type MedicalStatusValue = 'cleared' | 'restricted' | 'not_cleared' | 'pending';
type RecommendationStatus = 'provisional' | 'accepted' | 'rejected' | 'expired' | 'superseded';
type NearMissSeverity = 'low' | 'moderate' | 'high' | 'critical';
type IncidentSeverity = 'high' | 'critical';
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

/* Every status on this page is a queue outcome or the safety gate itself, so
   it maps onto the design system's four-rung ladder and renders as a `.badge`:
   glyph + uppercase label, never colour alone (Laws 2 + 3). Lifecycle values
   that are neither a safety state nor an outcome (expired, superseded,
   confounded) take a neutral chip. */
type BadgeTone = 'cleared' | 'monitor' | 'restricted' | 'locked' | 'neutral';

const BADGE_GLYPH: Record<Exclude<BadgeTone, 'neutral'>, string> = {
  cleared: '✓',
  monitor: '◉',
  restricted: '▲',
  locked: '✕',
};

function statusBadgeTone(status: string): BadgeTone {
  if (status === 'accepted' || status === 'cleared' || status === 'active' || status === 'match') return 'cleared';
  if (status === 'provisional' || status === 'pending' || status === 'partial') return 'restricted';
  if (status === 'rejected' || status === 'not_cleared' || status === 'miss') return 'locked';
  return 'neutral';
}

function StatusBadge({ status }: { readonly status: string }) {
  const tone = statusBadgeTone(status);
  if (tone === 'neutral') {
    return (
      <span className="badge badge--filed">
        <i>◌</i>
        {status}
      </span>
    );
  }
  return (
    <span className={`badge badge--${tone}`}>
      <i>{BADGE_GLYPH[tone]}</i>
      {status}
    </span>
  );
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

  const [incidentDescription, setIncidentDescription] = useState('');
  const [incidentSeverity, setIncidentSeverity] = useState<IncidentSeverity>('high');
  const [incidentOccurredAt, setIncidentOccurredAt] = useState('');
  const [incidentFiledMessage, setIncidentFiledMessage] = useState('');
  const [incidentSubmitting, setIncidentSubmitting] = useState(false);

  const [behaviorNoteText, setBehaviorNoteText] = useState('');
  const [behaviorNoteMessage, setBehaviorNoteMessage] = useState('');
  const [behaviorNoteSubmitting, setBehaviorNoteSubmitting] = useState(false);

  const [messageHomeText, setMessageHomeText] = useState('');
  const [messageHomeMessage, setMessageHomeMessage] = useState('');
  const [messageHomeSubmitting, setMessageHomeSubmitting] = useState(false);

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
    // Round 9 review: these confirmation banners are scoped to whichever
    // athlete was on screen when the form was submitted. Without this they
    // survive a switch to a different athlete's data below them, reading as
    // if that report/note was just filed for the athlete now selected.
    setIncidentFiledMessage('');
    setBehaviorNoteMessage('');
    setMessageHomeMessage('');
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

  // Capability #152: a post-hoc report that something actually happened --
  // distinct from a near-miss above, which is a close call. Filing lands
  // directly in the escalation ladder (severity forced high/critical), so
  // there is no separate list to refresh here -- /admin/escalations is
  // where a filed incident is read back and acted on.
  async function handleReportIncident(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !incidentDescription.trim() || incidentSubmitting) return;
    setIncidentFiledMessage('');
    setIncidentSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/incidents`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          athleteId,
          description: incidentDescription,
          severity: incidentSeverity,
          occurredAt: incidentOccurredAt || undefined,
        }),
      });
      await readJsonOrThrow(response, 'Failed to file incident report.');
      setIncidentDescription('');
      setIncidentSeverity('high');
      setIncidentOccurredAt('');
      setIncidentFiledMessage('Incident filed -- it is now in the escalation queue.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to file incident report.');
    } finally {
      setIncidentSubmitting(false);
    }
  }

  // Capability #125/#70/#74: capture only, deliberately. pilot.coach_observations'
  // note_type column already accepts any free-text value with no taxonomy
  // (createCoachObservation/domain-upsert), so this is a UI wiring gap, not
  // a schema one -- reuses domain-upsert directly rather than a new route.
  // A single generic note_type ('behavior_standard') is used on purpose:
  // picking specific category names (e.g. "respect," "effort") is a
  // coaching-philosophy decision for the gym's own staff, not something to
  // invent here. Pattern detection, streaks, and consequences are Phase 6
  // scope (#70/#74's own engines) and are not attempted by this capture form.
  async function handleLogBehaviorNote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !behaviorNoteText.trim() || behaviorNoteSubmitting) return;
    setBehaviorNoteMessage('');
    setBehaviorNoteSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'coach_note',
          athlete_id: athleteId,
          payload: { note_type: 'behavior_standard', note_text: behaviorNoteText },
        }),
      });
      await readJsonOrThrow(response, 'Failed to log the note.');
      setBehaviorNoteText('');
      setBehaviorNoteMessage('Note logged.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to log the note.');
    } finally {
      setBehaviorNoteSubmitting(false);
    }
  }

  // Capability #90, scoped down deliberately to one-directional send: a
  // coach/admin message to the athlete's guardian(s), read on
  // /parent/messages. Reply, threading, and messaging any coach besides the
  // athlete's own are real moderation/product decisions, not attempted
  // here. Reuses domain-upsert exactly like the Behavior Note panel above --
  // note_type: 'parent_message' is the one value listParentMessages reads
  // back, so a message sent here and nothing else ever reaches a guardian's
  // feed.
  async function handleMessageHome(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!athleteId || !messageHomeText.trim() || messageHomeSubmitting) return;
    setMessageHomeMessage('');
    setMessageHomeSubmitting(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/domain-upsert`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity_type: 'coach_note',
          athlete_id: athleteId,
          payload: { note_type: 'parent_message', note_text: messageHomeText },
        }),
      });
      await readJsonOrThrow(response, 'Failed to send the message.');
      setMessageHomeText('');
      setMessageHomeMessage('Sent to the family.');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to send the message.');
    } finally {
      setMessageHomeSubmitting(false);
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
      room="floor"
    >
      <div className="text-[color:var(--bone-200)]">
        <div className="mx-auto w-full max-w-6xl">
          <header className="space-y-[var(--s3)] border-b-[3px] border-[color:var(--brass-700)] pb-[var(--s5)]">
            <p className="t-eyebrow">Coach Workspace</p>
            <h1 className="t-command text-[length:var(--t-2xl)]">SHADOW Decision Loop</h1>
            <p className="t-body max-w-4xl text-[color:var(--bone-300)]">
              Review provisional recommendations, record human decisions, flag near-misses, and evaluate outcomes.
              Every recommendation starts provisional and stays that way until a human accepts or rejects it — silence
              never equals acceptance, and medical/sparring-clearance topics are gated by the athlete&apos;s current
              medical administrative status below.
            </p>
          </header>

          <section className="mat-leather mt-[var(--s5)] rounded-[var(--r-lg)] p-[var(--s4)]">
            <label className="field block">
              <span className="t-label">Athlete</span>
              <select
                value={athleteId}
                onChange={(event) => setAthleteId(event.target.value)}
                className="select max-w-md"
              >
                <option value="">Select an athlete…</option>
                {athletes.map((athlete) => (
                  <option key={athlete.athlete_id} value={athlete.athlete_id}>
                    {athlete.full_name || athlete.athlete_id}
                  </option>
                ))}
              </select>
            </label>
            <label className="field mt-[var(--s3)] block">
              <span className="t-label">Or enter an athlete ID directly</span>
              <input
                value={athleteId}
                onChange={(event) => setAthleteId(event.target.value)}
                placeholder="athlete-id"
                className="input max-w-md"
              />
            </label>
            {loading && <p className="t-muted mt-[var(--s3)]">Loading…</p>}
            {/* --restricted-ink, not --locked-ink. A roster that would not
                load is a network fact, not a medical one; sports-medicine
                already made this correction and states the reason -- red is
                left to mean a child is in danger. */}
            {errorMessage && <p className="mt-[var(--s3)] text-[length:var(--t-sm)] font-bold text-[var(--restricted-ink)]">{errorMessage}</p>}
          </section>

          {!athleteId ? (
            <p className="t-body mt-[var(--s5)] text-[color:var(--bone-300)]">Select or enter an athlete to review their decision loop.</p>
          ) : (
            <div className="mt-[var(--s5)] grid gap-[var(--s5)] xl:grid-cols-2">
              {/* Medical Administrative Status */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Medical Administrative Status</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Read-only gate for medically sensitive recommendations/decisions. Setting a new status never clears an
                  existing restriction automatically — each change is its own explicit, human-attributed record.
                </p>
                {medicalStatus ? (
                  <div className="mt-[var(--s3)] space-y-[var(--s2)] text-[length:var(--t-sm)]">
                    <p className="flex flex-wrap items-center gap-[var(--s3)]">
                      Current status: <StatusBadge status={medicalStatus.status} />
                    </p>
                    <p className="t-data text-[color:var(--bone-400)]">
                      Set by {medicalStatus.set_by_role} ({medicalStatus.set_by_account_id}) at {medicalStatus.effective_at}
                    </p>
                    {medicalStatus.source_reference && (
                      <p className="t-data text-[color:var(--bone-400)]">Reference: {medicalStatus.source_reference}</p>
                    )}
                  </div>
                ) : (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--bone-300)]">No medical administrative status recorded yet.</p>
                )}

                <form onSubmit={handleSetMedicalStatus} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">New status</span>
                    <select
                      value={medicalStatusDraft}
                      onChange={(event) => setMedicalStatusDraft(event.target.value as MedicalStatusValue)}
                      className="select"
                    >
                      <option value="pending">Pending</option>
                      <option value="cleared">Cleared</option>
                      <option value="restricted">Restricted</option>
                      <option value="not_cleared">Not Cleared</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Source reference (optional)</span>
                    <input
                      value={medicalSourceRef}
                      onChange={(event) => setMedicalSourceRef(event.target.value)}
                      placeholder="e.g. physician note, incident id"
                      className="input"
                    />
                  </label>
                  {/* The one danger-face control on this page: it operates the
                      medical gate itself, the red that Law 2 reserves. */}
                  <button type="submit" className="btn btn--danger">
                    Set Status
                  </button>
                </form>
              </section>

              {/* Recommendations */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Recommendations</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Always created provisional. Only a human decision below can move one to accepted or rejected.
                </p>
                <div className="mt-[var(--s3)] max-h-[360px] space-y-[var(--s3)] overflow-y-auto">
                  {recommendations.length === 0 && <p className="t-body text-[color:var(--bone-300)]">No recommendations yet.</p>}
                  {recommendations.map((rec) => (
                    <article key={rec.recommendation_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">{rec.recommendation_text}</p>
                      <p className="t-muted mt-[var(--s2)]">Expected: {rec.expected_outcome}</p>
                      <p className="mt-[var(--s2)] flex flex-wrap items-center gap-[var(--s3)]">
                        <StatusBadge status={rec.status} />
                        <span className="t-data text-[color:var(--bone-400)]">expires {rec.expires_at}</span>
                      </p>
                      {rec.status === 'provisional' && (
                        <div className="mt-[var(--s3)] flex gap-[var(--s3)]">
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'accepted')}
                            className="btn"
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDecideRecommendation(rec.recommendation_id, 'rejected')}
                            className="btn btn--ghost"
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
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Decisions</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A decision always requires a human. It may reference a still-live recommendation, or be logged directly.
                </p>
                <div className="mt-[var(--s3)] max-h-[280px] space-y-[var(--s3)] overflow-y-auto">
                  {decisions.length === 0 && <p className="t-body text-[color:var(--bone-300)]">No decisions recorded yet.</p>}
                  {decisions.map((decision) => (
                    <article key={decision.decision_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)]">
                      <p className="font-semibold text-[color:var(--bone-100)]">{decision.decision_text}</p>
                      <p className="t-muted mt-[var(--s2)]">Expected: {decision.expected_outcome}</p>
                      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                        By {decision.decided_by_role} at {decision.decided_at}
                      </p>
                      <button
                        type="button"
                        onClick={() => void handleLoadOutcomes(decision.decision_id)}
                        className="btn btn--ghost mt-[var(--s3)]"
                      >
                        Load Outcomes
                      </button>
                      {outcomesByDecision[decision.decision_id] && (
                        <div className="mt-[var(--s3)] space-y-[var(--s2)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s3)]">
                          {outcomesByDecision[decision.decision_id].length === 0 ? (
                            <p className="t-muted">No outcomes evaluated yet.</p>
                          ) : (
                            outcomesByDecision[decision.decision_id].map((outcome) => (
                              <p key={outcome.outcome_id} className="flex flex-wrap items-center gap-[var(--s3)] text-[length:var(--t-xs)]">
                                <StatusBadge status={outcome.match_state} />
                                {outcome.notes}
                              </p>
                            ))
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>

                <form onSubmit={handleRecordDecision} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Link to recommendation (optional)</span>
                    <select
                      value={decisionRecommendationId}
                      onChange={(event) => setDecisionRecommendationId(event.target.value)}
                      className="select"
                    >
                      <option value="">None — log directly</option>
                      {actionableRecommendations.map((rec) => (
                        <option key={rec.recommendation_id} value={rec.recommendation_id}>
                          {rec.recommendation_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Decision text</span>
                    <textarea
                      value={decisionText}
                      onChange={(event) => setDecisionText(event.target.value)}
                      className="textarea min-h-[72px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Expected outcome</span>
                    <textarea
                      value={decisionExpectedOutcome}
                      onChange={(event) => setDecisionExpectedOutcome(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <label className="t-label flex items-center gap-[var(--s3)]">
                    <input
                      type="checkbox"
                      checked={decisionMedicallySensitive}
                      onChange={(event) => setDecisionMedicallySensitive(event.target.checked)}
                    />
                    Medically sensitive (checks medical status before allowing this decision)
                  </label>
                  <button type="submit" className="btn">
                    Record Decision
                  </button>
                </form>
              </section>

              {/* Near-Misses */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Near-Misses</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Human-flagged only. Use this when something almost went wrong that a Decision didn&apos;t already cover.
                </p>
                <div className="mt-[var(--s3)] max-h-[220px] space-y-[var(--s3)] overflow-y-auto">
                  {nearMisses.length === 0 && <p className="t-body text-[color:var(--bone-300)]">No near-misses flagged yet.</p>}
                  {nearMisses.map((nearMiss) => (
                    <article key={nearMiss.near_miss_id} className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] text-[length:var(--t-sm)]">
                      <p className="text-[color:var(--bone-100)]">{nearMiss.description}</p>
                      <p className="t-data mt-[var(--s2)] text-[color:var(--bone-400)]">
                        Severity: {nearMiss.severity} · {nearMiss.created_at}
                      </p>
                    </article>
                  ))}
                </div>

                <form onSubmit={handleFlagNearMiss} className="mt-[var(--s4)] space-y-[var(--s3)] border-t border-[color:rgba(212,175,74,.22)] pt-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Description</span>
                    <textarea
                      value={nearMissDescription}
                      onChange={(event) => setNearMissDescription(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Severity</span>
                    <select
                      value={nearMissSeverity}
                      onChange={(event) => setNearMissSeverity(event.target.value as NearMissSeverity)}
                      className="select"
                    >
                      <option value="low">Low</option>
                      <option value="moderate">Moderate</option>
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Related decision (optional)</span>
                    <select
                      value={nearMissDecisionId}
                      onChange={(event) => setNearMissDecisionId(event.target.value)}
                      className="select"
                    >
                      <option value="">None</option>
                      {decisions.map((decision) => (
                        <option key={decision.decision_id} value={decision.decision_id}>
                          {decision.decision_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button type="submit" className="btn btn--ghost">
                    Flag Near-Miss
                  </button>
                </form>
              </section>

              {/* Report Incident */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Report Incident</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Use this when something actually happened -- an injury, a broken rule with a real
                  consequence -- not a close call. This files directly into the safety escalation queue.
                </p>

                {incidentFiledMessage && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{incidentFiledMessage}</p>
                )}

                <form onSubmit={handleReportIncident} className="mt-[var(--s4)] space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">What happened</span>
                    <textarea
                      value={incidentDescription}
                      onChange={(event) => setIncidentDescription(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <label className="field block">
                    <span className="t-label">Severity</span>
                    <select
                      value={incidentSeverity}
                      onChange={(event) => setIncidentSeverity(event.target.value as IncidentSeverity)}
                      className="select"
                    >
                      <option value="high">High</option>
                      <option value="critical">Critical</option>
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">When it happened (optional, if not today)</span>
                    <input
                      type="text"
                      value={incidentOccurredAt}
                      onChange={(event) => setIncidentOccurredAt(event.target.value)}
                      placeholder="e.g. 2026-08-05"
                      className="input"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={incidentSubmitting}>
                    {incidentSubmitting ? 'Filing…' : 'File Incident Report'}
                  </button>
                </form>
              </section>

              {/* Behavior & Habit Note */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Behavior &amp; Habit Note</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A quick note on behavior, discipline, or a habit you noticed -- not a safety concern (use
                  Near-Misses or Report Incident for those). This just records it; nothing acts on it yet.
                </p>

                {behaviorNoteMessage && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{behaviorNoteMessage}</p>
                )}

                <form onSubmit={handleLogBehaviorNote} className="mt-[var(--s4)] space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Note</span>
                    <textarea
                      value={behaviorNoteText}
                      onChange={(event) => setBehaviorNoteText(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={behaviorNoteSubmitting}>
                    {behaviorNoteSubmitting ? 'Logging…' : 'Log Note'}
                  </button>
                </form>
              </section>

              {/* Message Home */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)]">
                <h2 className="t-command text-[length:var(--t-lg)]">Message Home</h2>
                <p className="t-muted mt-[var(--s2)]">
                  A one-way note to the athlete&apos;s family -- they&apos;ll see it on their Messages tab.
                  There&apos;s no reply yet; call the family directly for anything that needs a conversation.
                </p>

                {messageHomeMessage && (
                  <p className="t-body mt-[var(--s3)] text-[color:var(--brass-300)]">{messageHomeMessage}</p>
                )}

                <form onSubmit={handleMessageHome} className="mt-[var(--s4)] space-y-[var(--s3)]">
                  <label className="field block">
                    <span className="t-label">Message</span>
                    <textarea
                      value={messageHomeText}
                      onChange={(event) => setMessageHomeText(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button type="submit" className="btn btn--ghost" disabled={messageHomeSubmitting}>
                    {messageHomeSubmitting ? 'Sending…' : 'Send to Family'}
                  </button>
                </form>
              </section>

              {/* Decision Outcomes */}
              <section className="mat-leather rounded-[var(--r-lg)] p-[var(--s4)] xl:col-span-2">
                <h2 className="t-command text-[length:var(--t-lg)]">Evaluate a Decision Outcome</h2>
                <p className="t-muted mt-[var(--s2)]">
                  Always a human judgment: compare the decision&apos;s expected outcome against what actually happened.
                </p>
                <form onSubmit={handleEvaluateOutcome} className="mt-[var(--s3)] grid gap-[var(--s3)] md:grid-cols-2">
                  <label className="field block">
                    <span className="t-label">Decision</span>
                    <select
                      value={outcomeDecisionId}
                      onChange={(event) => setOutcomeDecisionId(event.target.value)}
                      className="select"
                    >
                      <option value="">Select a decision…</option>
                      {decisions.map((decision) => (
                        <option key={decision.decision_id} value={decision.decision_id}>
                          {decision.decision_text.slice(0, 60)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field block">
                    <span className="t-label">Match state</span>
                    <select
                      value={outcomeMatchState}
                      onChange={(event) => setOutcomeMatchState(event.target.value as MatchState)}
                      className="select"
                    >
                      <option value="match">Match</option>
                      <option value="partial">Partial</option>
                      <option value="miss">Miss</option>
                      <option value="confounded">Confounded</option>
                    </select>
                  </label>
                  <label className="field block md:col-span-2">
                    <span className="t-label">Observation IDs (comma-separated)</span>
                    <input
                      value={outcomeObservationIds}
                      onChange={(event) => setOutcomeObservationIds(event.target.value)}
                      placeholder="obs-1, obs-2"
                      className="input"
                    />
                  </label>
                  <label className="field block md:col-span-2">
                    <span className="t-label">Notes</span>
                    <textarea
                      value={outcomeNotes}
                      onChange={(event) => setOutcomeNotes(event.target.value)}
                      className="textarea min-h-[56px]"
                    />
                  </label>
                  <button type="submit" className="btn w-fit md:col-span-2">
                    Evaluate Outcome
                  </button>
                </form>
              </section>
            </div>
          )}

          <div className="mt-[var(--s6)]">
            <Link href="/coach/environment/intake-router" className="btn btn--ghost">
              Back to Coach Workspace
            </Link>
          </div>

        {/* The four words, at the foot of the page — the same foot the
            approved boards put under every full screen. See WorkAxis. */}
        <WorkAxis />
        </div>
      </div>
    </RoleStandaloneView>
  );
}
