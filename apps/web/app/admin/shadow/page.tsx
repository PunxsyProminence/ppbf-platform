'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { usePilotSession } from '@/components/usePilotSession';
import { apiBase } from '@/lib/apiBase';
import type { OrgMetrics } from '@/app/api/pilot/shadow/metrics/route';
import {
  interpretShadowFeedbackReviewResponse,
  isShadowFeedbackResolvable,
  selectShadowFeedbackReviewQueue,
} from '@/lib/shadowFeedbackReview';

// 'Classified' and 'Staged' were client-side theater with no backend state
// (audit AS-2): the real workflow is document review -> approve/reject ->
// import, so only statuses the backend can actually produce remain.
type IntakeStatus = 'Pending' | 'Approved' | 'Rejected' | 'Imported';
type ConfidenceLevel = 'Low' | 'Medium' | 'High';
type DataType =
  | 'System'
  | 'Command'
  | 'Workout'
  | 'Biometric'
  | 'Coach Note'
  | 'Video'
  | 'Athlete Check-In'
  | 'Parent Observation'
  | 'Board Document'
  | 'Policy Draft'
  | 'Incident Note'
  | 'Assessment Result'
  | 'File Intake';

type IntakeDestination =
  | 'Athlete Workspace'
  | 'Coach Workspace'
  | 'Parent Hub'
  | 'Admin Hub'
  | 'Board Hub'
  | 'Capability Registry'
  | 'Evidence Library'
  | 'Incident / Safety Log'
  | 'SHADOW Local State';

interface ConsoleLogEntry {
  id: string;
  timestamp: string;
  source: string;
  dataType: DataType;
  status: string;
  message: string;
  destination?: IntakeDestination;
}

interface IntakeItem {
  id: string;
  intakeCaseId: string;
  itemName: string;
  dataType: DataType;
  source: string;
  suggestedDestination: IntakeDestination;
  status: IntakeStatus;
  reviewNeeded: boolean;
  requiresJasonReview: boolean;
  detectedType: DataType;
  confidence: ConfidenceLevel;
  notes: string;
  destinationRoute: string;
  timestamp: string;
  lastUpdatedAt: string;
}

interface TelemetryEvent {
  timestamp: string;
  event:
    | 'file upload clicked'
    | 'quick add created'
    | 'command submitted'
    | 'item approved'
    | 'item rejected'
    | 'item imported'
    | 'feedback reviewed';
  payload: Record<string, unknown>;
}

interface ShadowUploadResponse {
  ok: boolean;
  intake_id: string;
  intake_case_id: string;
  intake_document_id: string;
  document_type: string;
  classification: string;
  routed_queue: string;
  review_status: string;
}

interface ReviewQueueApiResponse {
  ok: boolean;
  queue: Array<{
    intake_case_id: string;
    status: 'pending_review' | 'approved' | 'rejected' | 'promoted';
    summary: string;
    primary_athlete_id: string | null;
    created_at: string;
    updated_at: string;
    document_count: number;
    shadow_event_name?: string | null;
    shadow_event_at?: string | null;
  }>;
}

interface ShadowTelemetryApiResponse {
  ok: boolean;
  telemetry: Array<{
    shadow_telemetry_event_id: number;
    metric_name: string;
    actor_account_id: string | null;
    actor_role: string | null;
    dimensions: Record<string, unknown>;
    created_at: string;
  }>;
}

interface ShadowAuthorityApiResponse {
  ok: boolean;
  authority_checks: Array<{
    authority_check_id: number;
    action: string;
    allowed: boolean;
    reason: string;
    actor_role: string | null;
    created_at: string;
  }>;
}

interface ShadowFeedbackItem {
  feedback_id: number;
  account_id: string;
  role: string;
  helpful: boolean;
  rating: number | null;
  comment: string | null;
  outcome_signal: string | null;
  correlation_type: string | null;
  correlation_id: string | null;
  verification_state: 'unverified' | 'durable_client' | 'human_reviewed';
  human_review_required: boolean;
  created_at: string;
}

interface ShadowFeedbackApiResponse {
  ok: boolean;
  summary: {
    total_responses: number;
    helpful_count: number;
    satisfaction_rate: number;
    avg_rating: number | null;
  } | null;
  items: ShadowFeedbackItem[];
}

interface ShadowFeedbackReviewApiResponse {
  ok: boolean;
  decision?: 'approve' | 'reject';
  learningPromoted?: boolean;
  alreadyResolved?: boolean;
  retryable?: boolean;
  error?: string;
}

type QueueSort = 'newest' | 'oldest' | 'status';

const DESTINATION_OPTIONS: IntakeDestination[] = [
  'Athlete Workspace',
  'Coach Workspace',
  'Parent Hub',
  'Admin Hub',
  'Board Hub',
  'Capability Registry',
  'Evidence Library',
  'Incident / Safety Log',
  'SHADOW Local State',
];

const QUICK_ADD_OPTIONS: Array<{ label: DataType; source: string; destination: IntakeDestination; route: string }> = [
  { label: 'Workout', source: 'Coach', destination: 'Coach Workspace', route: '/coach/review-queue' },
  { label: 'Biometric', source: 'Athlete Device', destination: 'Athlete Workspace', route: '/athlete/dashboard' },
  { label: 'Coach Note', source: 'Coach', destination: 'Coach Workspace', route: '/coach/review-queue' },
  { label: 'Video', source: 'Media Upload', destination: 'Evidence Library', route: '/evidence' },
  { label: 'Athlete Check-In', source: 'Athlete', destination: 'Athlete Workspace', route: '/athlete/dashboard' },
  { label: 'Parent Observation', source: 'Parent / Guardian', destination: 'Parent Hub', route: '/parent/dashboard' },
  { label: 'Board Document', source: 'Board', destination: 'Board Hub', route: '/board' },
  { label: 'Policy Draft', source: 'Admin', destination: 'Capability Registry', route: '/admin' },
  { label: 'Incident Note', source: 'Safety', destination: 'Incident / Safety Log', route: '/audit' },
  { label: 'Assessment Result', source: 'Program Team', destination: 'Evidence Library', route: '/evidence' },
];

// Upload, case review-action, document review, and feedback promotion are all
// organization-scoped writes whose routes admit only an organization admin or
// coach. A platform owner gathers data here and reads every projection, so the
// refusal is stated on the control instead of arriving as a 403 that reads like
// a bug.
const INTAKE_WRITE_REFUSAL =
  'Read-only in a platform-owner session: SHADOW intake and review actions belong to gym admins and coaches.';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-fallback-id`;
}

interface CaseDocumentRow {
  intake_document_id: string;
  document_type: string;
  file_name: string;
  metadata: Record<string, unknown> | null;
}

type DocumentReviewState = 'clean' | 'quarantined' | 'unreviewed';

// Mirrors isIntakeDocumentReadyForReview server-side: 'clean' here means the
// document satisfies the states case approval checks.
function documentReviewState(metadata: Record<string, unknown> | null | undefined): DocumentReviewState {
  if (!metadata) return 'unreviewed';
  if (metadata.security_state === 'quarantined') return 'quarantined';
  if (
    (metadata.security_state === 'clean' || metadata.quarantine_status === 'clean')
    && metadata.extraction_state === 'ready_for_review'
  ) {
    return 'clean';
  }
  return 'unreviewed';
}

function reviewStateChip(state: DocumentReviewState): string {
  if (state === 'clean') return 'border-[var(--cleared)] bg-[var(--patina-900)] text-[var(--cleared-ink)]';
  if (state === 'quarantined') return 'border-[var(--patina-700)] bg-[var(--rust-900)] text-[var(--locked-ink)]';
  return 'border-[var(--brass-500)] bg-[var(--hide-900)] text-[var(--bone-200)]';
}

// Per-case document security review: every uploaded file must be opened and
// attested clean by a human before case approval unblocks. This panel is that
// workflow -- open the document (short-lived signed link), then record the
// verdict. Approval stays refused server-side while any document is
// unreviewed or quarantined.
function CaseDocumentsPanel({ intakeCaseId }: { intakeCaseId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [documents, setDocuments] = useState<CaseDocumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyDocumentId, setBusyDocumentId] = useState('');
  const [error, setError] = useState('');

  async function loadDocuments() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/cases/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ intake_case_id: intakeCaseId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.found) {
        throw new Error(payload?.error || 'Failed to load case documents');
      }
      setDocuments((payload.aggregate?.documents ?? []) as CaseDocumentRow[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load case documents');
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && documents.length === 0) {
      await loadDocuments();
    }
  }

  async function handleOpenDocument(intakeDocumentId: string) {
    setBusyDocumentId(intakeDocumentId);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/document-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ intake_document_id: intakeDocumentId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to issue document link');
      }
      window.open(payload.url as string, '_blank', 'noopener');
    } catch (linkError) {
      setError(linkError instanceof Error ? linkError.message : 'Failed to issue document link');
    } finally {
      setBusyDocumentId('');
    }
  }

  async function handleReviewDocument(intakeDocumentId: string, decision: 'clean' | 'quarantined') {
    setBusyDocumentId(intakeDocumentId);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/document-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ intake_document_id: intakeDocumentId, decision }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to record document review');
      }
      await loadDocuments();
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : 'Failed to record document review');
    } finally {
      setBusyDocumentId('');
    }
  }

  return (
    <div className="mt-3 border-t-2 border-[var(--patina-700)]/50 pt-3">
      <button
        type="button"
        onClick={() => void handleToggle()}
        className="h-9 border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[12px] font-bold text-[var(--brass-300)] transition hover:border-[var(--brass-500)]"
      >
        {expanded ? 'Hide Document Security Review' : 'Document Security Review'}
      </button>
      {expanded ? (
        <div className="mt-2 space-y-2">
          {loading ? <p className="text-[13px] text-[var(--brass-300)]/80">Loading documents…</p> : null}
          {error ? <p className="text-[13px] text-[var(--locked-ink)]">{error}</p> : null}
          {!loading && documents.length === 0 && !error ? (
            <p className="text-[13px] text-[var(--brass-300)]/80">No documents on this case.</p>
          ) : null}
          {documents.map((doc) => {
            const state = documentReviewState(doc.metadata);
            const busy = busyDocumentId === doc.intake_document_id;
            return (
              <div
                key={doc.intake_document_id}
                className="flex flex-wrap items-center gap-2 border border-[var(--patina-700)]/60 bg-[var(--hide-900)] p-2 text-[13px] text-[var(--bone-200)]"
              >
                <span className="min-w-0 flex-1 truncate font-mono">{doc.file_name}</span>
                <span className={`inline-flex border px-2 py-0.5 font-mono text-[11px] uppercase ${reviewStateChip(state)}`}>
                  {state}
                </span>
                <button
                  type="button"
                  onClick={() => void handleOpenDocument(doc.intake_document_id)}
                  disabled={busy}
                  className="h-9 border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-2 text-[12px] font-bold text-[var(--bone-200)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Open
                </button>
                <button
                  type="button"
                  onClick={() => void handleReviewDocument(doc.intake_document_id, 'clean')}
                  disabled={busy}
                  className="h-9 border-2 border-[var(--cleared)] bg-[var(--patina-900)] px-2 text-[12px] font-bold text-[var(--cleared-ink)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Mark Clean
                </button>
                <button
                  type="button"
                  onClick={() => void handleReviewDocument(doc.intake_document_id, 'quarantined')}
                  disabled={busy}
                  className="h-9 border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-2 text-[12px] font-bold text-[var(--locked-ink)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Quarantine
                </button>
              </div>
            );
          })}
          <p className="text-[12px] text-[var(--brass-300)]/70">
            Open each document before marking it clean. Case approval stays blocked until every document is reviewed clean; quarantining any document keeps the case unapprovable.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function routeForDestination(destination: IntakeDestination): string {
  if (destination === 'Athlete Workspace') return '/athlete/dashboard';
  if (destination === 'Coach Workspace') return '/coach/review-queue';
  if (destination === 'Parent Hub') return '/parent/dashboard';
  if (destination === 'Admin Hub') return '/admin';
  if (destination === 'Board Hub') return '/board';
  if (destination === 'Capability Registry') return '/admin';
  if (destination === 'Evidence Library') return '/evidence';
  if (destination === 'Incident / Safety Log') return '/audit';
  return '/admin/shadow';
}

function parsePromotionPayloadFromNotes(notes: string): Record<string, unknown> | null {
  const trimmed = notes.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function statusChipClasses(status: IntakeStatus): string {
  if (status === 'Pending') return 'border-[var(--patina-700)] bg-[var(--rust-700)] text-[var(--locked-ink)]';
  if (status === 'Approved') return 'border-[var(--cleared)] bg-[var(--patina-900)] text-[var(--cleared-ink)]';
  if (status === 'Rejected') return 'border-[var(--patina-700)] bg-[var(--rust-900)] text-[var(--locked-ink)]';
  return 'border-[var(--monitor)] bg-[var(--slate-board)] text-[var(--monitor-ink)]';
}

function toDataType(value: string): DataType {
  const known: DataType[] = [
    'System',
    'Command',
    'Workout',
    'Biometric',
    'Coach Note',
    'Video',
    'Athlete Check-In',
    'Parent Observation',
    'Board Document',
    'Policy Draft',
    'Incident Note',
    'Assessment Result',
    'File Intake',
  ];
  return known.includes(value as DataType) ? (value as DataType) : 'File Intake';
}

function toDestination(value: string): IntakeDestination {
  return DESTINATION_OPTIONS.includes(value as IntakeDestination)
    ? (value as IntakeDestination)
    : 'SHADOW Local State';
}

function fromBackendStatus(status: 'pending_review' | 'approved' | 'rejected' | 'promoted'): IntakeStatus {
  if (status === 'approved') return 'Approved';
  if (status === 'rejected') return 'Rejected';
  if (status === 'promoted') return 'Imported';
  return 'Pending';
}

function renderMetricsPanel(
  growthMetrics: OrgMetrics | null,
  metricsLoading: boolean,
  metricsError: string,
) {
  return (
    <section className="col-span-full border-2 border-[var(--cleared)]/40 bg-[var(--patina-900)] p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--cleared-ink)]/70">SHADOW Intelligence — Last 30 Days</p>
        {metricsLoading && <span className="text-xs text-[var(--cleared-ink)]/40">Loading…</span>}
      </div>
      {growthMetrics ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
          {([
            ['Interactions', growthMetrics.growth.totalInteractions],
            ['Filter Rate', growthMetrics.growth.filterRate != null ? `${(growthMetrics.growth.filterRate * 100).toFixed(1)}%` : '—'],
            ['Avg Satisfaction', growthMetrics.growth.avgSatisfaction != null ? growthMetrics.growth.avgSatisfaction.toFixed(2) : '—'],
            ['Effectiveness %', growthMetrics.effectiveness.avgRecommendationScore != null ? String(growthMetrics.effectiveness.avgRecommendationScore) : '—'],
            ['Reviewed Outcomes', growthMetrics.growth.reviewedOutcomes],
            ['Research Created', growthMetrics.growth.researchRequirementsCreated],
            ['Research Closed', growthMetrics.growth.researchRequirementsClosed],
            ['New Patterns', growthMetrics.growth.newLibraryPatterns],
          ] as [string, string | number][]).map(([label, value]) => (
            <div key={label} className="border border-[var(--cleared)]/30 bg-[var(--patina-900)] p-3 text-center">
              <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--cleared-ink)]/60">{label}</p>
              <p className="mt-1 text-xl font-black text-[var(--cleared-ink)]">{value}</p>
            </div>
          ))}
        </div>
      ) : metricsError ? (
        // "Metrics unavailable" was shown for a failed load, a forbidden load
        // and a genuinely empty organization alike, so the one panel that could
        // not explain itself was also the one most likely to be refused: this
        // endpoint is admin-only, while five of the console's other panels
        // admit coaches. A coach saw an unexplained blank here and working
        // panels beside it.
        <p role="status" className="text-xs text-[var(--locked-ink)]">{metricsError}</p>
      ) : (
        <p className="text-xs text-[var(--cleared-ink)]/40">Metrics unavailable</p>
      )}
    </section>
  );
}

/**
 * Human review gate for the SHADOW learning loop.
 *
 * Feedback is written at `durable_client` and is deliberately never learned
 * from until a human approves it here. Approving calls PATCH
 * /api/pilot/shadow/feedback, which is the only path that runs
 * `processLearningSignal` (profile facts, communication style, effectiveness
 * metrics, research requirements). Without this panel the queue has no exit.
 */
type ActivationModeValue = 'disabled' | 'observation' | 'enabled';

interface UnlockThresholdRow {
  featureKey: string;
  metricKey: string;
  minValue: number;
  activationMode: ActivationModeValue;
  description: string;
}

interface UnlockStatusRow {
  unlocked: boolean;
  activationMode: ActivationModeValue;
  satisfied: boolean;
  currentValue: number;
  thresholdValue: number;
}

type UnlockAdminRow = UnlockThresholdRow & { status: UnlockStatusRow | null };

interface LibraryReviewFlag {
  flag_id: string;
  topic: string;
  latest_outcome_signal: string | null;
  outcome_signal: string | null;
  user_note: string | null;
  flag_count: number;
  last_flagged_at: string;
}

// The other half of the learning loop's library flags: negative outcomes on
// cited answers upsert a pending flag per topic, and until this panel existed
// no surface showed them and nothing could settle one -- the "concerned
// topics" metric could only grow. A verdict here is terminal for the current
// flag; new negative feedback on the same topic reopens it as pending.
function LibraryReviewFlagsPanel() {
  const [flags, setFlags] = useState<LibraryReviewFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyFlagId, setBusyFlagId] = useState('');
  const [error, setError] = useState('');

  const loadFlags = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/library/review-flags?state=pending`, {
        credentials: 'include',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to load library review flags');
      }
      setFlags((payload.flags ?? []) as LibraryReviewFlag[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load library review flags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadFlags();
  }, [loadFlags]);

  async function handleVerdict(flagId: string, reviewState: 'resolved' | 'rejected') {
    setBusyFlagId(flagId);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/library/review-flags`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ flag_id: flagId, review_state: reviewState }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to record verdict');
      }
      await loadFlags();
    } catch (verdictError) {
      setError(verdictError instanceof Error ? verdictError.message : 'Failed to record verdict');
    } finally {
      setBusyFlagId('');
    }
  }

  return (
    <section className="border-4 border-[var(--brass-500)] bg-[var(--hide-950)]/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--brass-300)]">Library Quality</p>
          <h3 className="mt-1 text-xl font-black text-[var(--bone-200)]">Review Flags ({flags.length})</h3>
        </div>
        <button
          type="button"
          onClick={() => void loadFlags()}
          className="h-9 border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[12px] font-bold text-[var(--brass-300)] transition hover:border-[var(--brass-500)]"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-[12px] text-[var(--brass-300)]/70">
        Topics flagged by negative feedback on cited answers. Resolve after checking the underlying Library evidence; reject if the flag is noise. New negative feedback reopens a settled topic.
      </p>
      <div className="mt-3 space-y-2">
        {loading ? <p className="text-[13px] text-[var(--brass-300)]/80">Loading flags…</p> : null}
        {error ? <p className="text-[13px] text-[var(--locked-ink)]">{error}</p> : null}
        {!loading && !error && flags.length === 0 ? (
          <p className="text-[13px] text-[var(--brass-300)]/80">No pending flags. The Library has no unreviewed negative-outcome reports.</p>
        ) : null}
        {flags.map((flag) => {
          const busy = busyFlagId === flag.flag_id;
          return (
            <div key={flag.flag_id} className="border border-[var(--patina-700)]/60 bg-[var(--hide-900)] p-3 text-[13px] text-[var(--bone-200)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{flag.topic}</span>
                <span className="border border-[var(--patina-700)] px-2 py-0.5 font-mono text-[11px] uppercase text-[var(--locked-ink)]">
                  {flag.latest_outcome_signal ?? flag.outcome_signal ?? 'negative outcome'}
                </span>
                <span className="font-mono text-[11px] text-[var(--brass-300)]/70">
                  ×{flag.flag_count} · last {flag.last_flagged_at.slice(0, 10)}
                </span>
                <span className="ml-auto flex gap-2">
                  <button
                    type="button"
                    onClick={() => void handleVerdict(flag.flag_id, 'resolved')}
                    disabled={busy}
                    className="h-9 border-2 border-[var(--cleared)] bg-[var(--patina-900)] px-2 text-[12px] font-bold text-[var(--cleared-ink)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Resolve
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleVerdict(flag.flag_id, 'rejected')}
                    disabled={busy}
                    className="h-9 border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-2 text-[12px] font-bold text-[var(--locked-ink)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Reject
                  </button>
                </span>
              </div>
              {flag.user_note ? (
                <p className="mt-2 text-[12px] text-[var(--bone-400)]">&ldquo;{flag.user_note}&rdquo;</p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// Feature unlock thresholds (audit E1). The GET/POST endpoint has existed and
// worked for months with ZERO client callers, so activation mode was
// unreachable: three of the four features ship in observation/disabled, which
// means `unlocked = activationMode === 'enabled' && satisfied` can never be
// true for them no matter how high the counter climbs. #123 stopped the UI
// promising those unlocks; this is the other half -- the surface that can
// actually grant one.
//
// The panel states the REASON a feature is locked, because "counter not met"
// and "cannot ever unlock in this mode" are different facts and conflating
// them is what made the old banners dishonest.
function FeatureUnlockPanel() {
  const [rows, setRows] = useState<UnlockAdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyFeatureKey, setBusyFeatureKey] = useState('');
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, { minValue: string; activationMode: ActivationModeValue }>>({});

  const loadThresholds = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/unlocks`, {
        credentials: 'include',
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to load feature thresholds');
      }
      const thresholds = (payload.thresholds ?? []) as UnlockThresholdRow[];
      const features = (payload.state?.features ?? {}) as Record<string, UnlockStatusRow>;
      const merged: UnlockAdminRow[] = thresholds.map((threshold) => ({
        ...threshold,
        status: features[threshold.featureKey] ?? null,
      }));
      setRows(merged);
      setDrafts(Object.fromEntries(merged.map((row) => [
        row.featureKey,
        { minValue: String(row.minValue), activationMode: row.activationMode },
      ])));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load feature thresholds');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadThresholds();
  }, [loadThresholds]);

  async function handleSave(row: UnlockAdminRow) {
    const draft = drafts[row.featureKey];
    if (!draft) return;
    const parsedMinValue = Number.parseInt(draft.minValue, 10);
    if (!Number.isFinite(parsedMinValue) || parsedMinValue < 0) {
      setError(`Threshold for ${row.featureKey} must be a whole number of 0 or more.`);
      return;
    }

    setBusyFeatureKey(row.featureKey);
    setError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/unlocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          featureKey: row.featureKey,
          metricKey: row.metricKey,
          minValue: parsedMinValue,
          activationMode: draft.activationMode,
          description: row.description,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to save threshold');
      }
      await loadThresholds();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save threshold');
    } finally {
      setBusyFeatureKey('');
    }
  }

  return (
    <section className="border-4 border-[var(--brass-500)] bg-[var(--hide-950)]/70 p-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--brass-300)]">Capability Governance</p>
          <h3 className="mt-1 text-xl font-black text-[var(--bone-200)]">Feature Unlock Thresholds</h3>
        </div>
        <button
          type="button"
          onClick={() => void loadThresholds()}
          className="h-9 border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[12px] font-bold text-[var(--brass-300)] transition hover:border-[var(--brass-500)]"
        >
          Refresh
        </button>
      </div>
      <p className="mt-1 text-[12px] text-[var(--brass-300)]/70">
        A feature unlocks only when its activation mode is <span className="font-mono">enabled</span> AND its counter has reached the threshold. In <span className="font-mono">observation</span> or <span className="font-mono">disabled</span>, the counter is tracked but the feature can never unlock — raising it changes nothing.
      </p>
      <div className="mt-3 space-y-2">
        {loading ? <p className="text-[13px] text-[var(--brass-300)]/80">Loading thresholds…</p> : null}
        {error ? <p className="text-[13px] text-[var(--locked-ink)]">{error}</p> : null}
        {rows.map((row) => {
          const busy = busyFeatureKey === row.featureKey;
          const draft = drafts[row.featureKey] ?? { minValue: String(row.minValue), activationMode: row.activationMode };
          const status = row.status;
          const dirty = draft.minValue !== String(row.minValue) || draft.activationMode !== row.activationMode;
          // Why it is locked, stated separately: a counter that is met but
          // gated by mode is a different fact from one that is not met.
          const lockReason = status?.unlocked
            ? null
            : row.activationMode !== 'enabled'
              ? `Cannot unlock: activation mode is '${row.activationMode}'.`
              : 'Counter has not reached the threshold.';

          return (
            <div key={row.featureKey} className="border border-[var(--patina-700)]/60 bg-[var(--hide-900)] p-3 text-[13px] text-[var(--bone-200)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold">{row.featureKey}</span>
                <span className={`border px-2 py-0.5 font-mono text-[11px] uppercase ${
                  status?.unlocked
                    ? 'border-[var(--cleared)] text-[var(--cleared-ink)]'
                    : 'border-[var(--patina-700)] text-[var(--locked-ink)]'
                }`}>
                  {status?.unlocked ? 'unlocked' : 'locked'}
                </span>
                <span className="font-mono text-[11px] text-[var(--brass-300)]/70">
                  {row.metricKey}: {status?.currentValue ?? 0} / {row.minValue}
                </span>
              </div>
              <p className="mt-2 text-[12px] text-[var(--bone-400)]">{row.description}</p>
              {lockReason ? (
                <p className="mt-1 text-[12px] text-[var(--locked-ink)]">{lockReason}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1 text-[12px] text-[var(--brass-300)]/80">
                  Mode
                  <select
                    value={draft.activationMode}
                    onChange={(event) => setDrafts((previous) => ({
                      ...previous,
                      [row.featureKey]: { ...draft, activationMode: event.target.value as ActivationModeValue },
                    }))}
                    className="h-9 border-2 border-[var(--patina-700)] bg-[var(--hide-950)] px-2 text-[12px] text-[var(--bone-200)]"
                  >
                    <option value="disabled">disabled</option>
                    <option value="observation">observation</option>
                    <option value="enabled">enabled</option>
                  </select>
                </label>
                <label className="flex items-center gap-1 text-[12px] text-[var(--brass-300)]/80">
                  Threshold
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={draft.minValue}
                    onChange={(event) => setDrafts((previous) => ({
                      ...previous,
                      [row.featureKey]: { ...draft, minValue: event.target.value },
                    }))}
                    className="h-9 w-24 border-2 border-[var(--patina-700)] bg-[var(--hide-950)] px-2 text-[12px] text-[var(--bone-200)]"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void handleSave(row)}
                  disabled={busy || !dirty}
                  className="h-9 border-2 border-[var(--cleared)] bg-[var(--patina-900)] px-3 text-[12px] font-bold text-[var(--cleared-ink)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          );
        })}
        {!loading && !error && rows.length === 0 ? (
          <p className="text-[13px] text-[var(--brass-300)]/80">No feature thresholds returned.</p>
        ) : null}
      </div>
    </section>
  );
}

function renderFeedbackReviewPanel(props: {
  summary: ShadowFeedbackApiResponse['summary'];
  reviewQueue: ShadowFeedbackItem[];
  retryQueue: ShadowFeedbackItem[];
  loading: boolean;
  error: string;
  pendingFeedbackId: number | null;
  reviewRefusal: string;
  onReview: (item: ShadowFeedbackItem, decision: 'approve' | 'reject') => void;
  onRefresh: () => void;
}) {
  const { summary, reviewQueue, retryQueue, loading, error, pendingFeedbackId, reviewRefusal, onReview, onRefresh } = props;

  const renderItem = (item: ShadowFeedbackItem, mode: 'review' | 'retry') => {
    const busy = pendingFeedbackId === item.feedback_id;
    const resolvable = isShadowFeedbackResolvable(item);
    const reviewable = resolvable && !reviewRefusal;

    return (
      <article key={`${mode}-${item.feedback_id}`} className="border border-[var(--cleared)]/30 bg-[var(--patina-900)] p-3">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--cleared-ink)]/60">
          <span>#{item.feedback_id}</span>
          <span>{item.role}</span>
          <span className={item.helpful ? 'text-[var(--cleared-ink)]' : 'text-[var(--locked-ink)]'}>
            {item.helpful ? 'Helpful' : 'Not helpful'}
          </span>
          {item.outcome_signal && <span>{item.outcome_signal}</span>}
          {item.rating != null && <span>Rating {item.rating}</span>}
          <span className="text-[var(--cleared-ink)]/40">{item.created_at}</span>
        </div>

        {item.comment ? (
          <p className="mt-2 text-[13px] leading-6 text-[var(--cleared-ink)]/90">{item.comment}</p>
        ) : (
          <p className="mt-2 text-[13px] italic text-[var(--cleared-ink)]/40">No comment provided.</p>
        )}

        {mode === 'retry' && (
          <p className="mt-2 text-[12px] leading-5 text-[var(--brass-200)]">
            Review was recorded, but durable learning promotion did not complete. Retry to finish promoting it.
          </p>
        )}

        {!resolvable && (
          <p className="mt-2 text-[12px] leading-5 text-[var(--locked-ink)]">
            Not reviewable: only feedback correlated to a durable SHADOW message can be promoted
            {item.correlation_type ? ` (this item is “${item.correlation_type}”)` : ' (no correlation recorded)'}.
          </p>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || !reviewable}
            onClick={() => onReview(item, 'approve')}
            className="border border-[var(--cleared)] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--cleared-ink)] transition hover:bg-[var(--cleared)]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? 'Working…' : mode === 'retry' ? 'Retry promotion' : 'Approve for learning'}
          </button>
          {mode === 'review' && (
            <button
              type="button"
              disabled={busy || !reviewable}
              onClick={() => onReview(item, 'reject')}
              className="border border-[var(--patina-700)] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--bone-200)] transition hover:bg-[var(--patina-700)]/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Reject
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <section className="col-span-full border-2 border-[var(--cleared)]/40 bg-[var(--patina-900)] p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--cleared-ink)]/70">
            SHADOW Learning Review — Human Approval Gate
          </p>
          <p className="mt-1 text-[13px] leading-6 text-[var(--cleared-ink)]/70">
            Nothing SHADOW learns from user feedback is applied until it is approved here.
          </p>
          {reviewRefusal && (
            <p className="mt-1 text-[13px] leading-6 text-[var(--brass-200)]">{reviewRefusal}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          {loading && <span className="text-xs text-[var(--cleared-ink)]/40">Loading…</span>}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="border border-[var(--cleared)]/60 px-3 py-1 font-mono text-[11px] uppercase tracking-[0.14em] text-[var(--cleared-ink)] transition hover:bg-[var(--cleared)]/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>

      {summary && (
        <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([
            ['Responses (30d)', summary.total_responses],
            ['Helpful', summary.helpful_count],
            ['Satisfaction', `${(summary.satisfaction_rate * 100).toFixed(1)}%`],
            ['Avg Rating', summary.avg_rating != null ? summary.avg_rating.toFixed(2) : '—'],
          ] as [string, string | number][]).map(([label, value]) => (
            <div key={label} className="border border-[var(--cleared)]/30 bg-[var(--patina-900)] p-3 text-center">
              <p className="text-[11px] font-mono uppercase tracking-[0.12em] text-[var(--cleared-ink)]/60">{label}</p>
              <p className="mt-1 text-xl font-black text-[var(--cleared-ink)]">{value}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="mb-3 border border-[var(--patina-700)] bg-[var(--rust-900)] p-3 text-[13px] leading-6 text-[var(--locked-ink)]">{error}</p>
      )}

      {retryQueue.length > 0 && (
        <div className="mb-4">
          <p className="mb-2 text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--brass-200)]">
            Promotion retry required ({retryQueue.length})
          </p>
          <div className="space-y-3">{retryQueue.map((item) => renderItem(item, 'retry'))}</div>
        </div>
      )}

      <p className="mb-2 text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--cleared-ink)]/60">
        Awaiting review ({reviewQueue.length})
      </p>
      {reviewQueue.length === 0 ? (
        <p className="text-xs text-[var(--cleared-ink)]/40">
          {loading ? 'Loading feedback…' : 'No feedback is awaiting human review.'}
        </p>
      ) : (
        <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
          {reviewQueue.map((item) => renderItem(item, 'review'))}
        </div>
      )}
    </section>
  );
}

export default function AdminShadowConsolePage() {
  const pilotSession = usePilotSession();
  const intakeWriteRefusal = pilotSession.role === 'platform_owner' ? INTAKE_WRITE_REFUSAL : '';
  const [consoleLogs, setConsoleLogs] = useState<ConsoleLogEntry[]>([
    {
      id: newId(),
      timestamp: nowIso(),
      source: 'Admin',
      dataType: 'System',
      status: 'Initialized',
      message: 'SHADOW Admin Console initialized.',
      destination: 'SHADOW Local State',
    },
  ]);
  const [commandInput, setCommandInput] = useState('');
  const [pendingQueue, setPendingQueue] = useState<IntakeItem[]>([]);
  const [backendQueueReady, setBackendQueueReady] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState('');
  const [queueFilterStatus, setQueueFilterStatus] = useState<'ALL' | IntakeStatus>('ALL');
  const [queueSort, setQueueSort] = useState<QueueSort>('newest');
  const [telemetryEvents, setTelemetryEvents] = useState<TelemetryEvent[]>([]);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [shadowTelemetry, setShadowTelemetry] = useState<ShadowTelemetryApiResponse['telemetry']>([]);
  const [shadowAuthorityChecks, setShadowAuthorityChecks] = useState<ShadowAuthorityApiResponse['authority_checks']>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [lastIngestSummary, setLastIngestSummary] = useState<ShadowUploadResponse | null>(null);
  // Typed against the route's exported OrgMetrics on purpose: this panel
  // once read a flat shape the API had stopped returning, and a blind cast
  // let every tile render NaN/blank for weeks (audit AS-1). Binding to the
  // imported contract makes the next shape change a compile error here.
  const [growthMetrics, setGrowthMetrics] = useState<OrgMetrics | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState('');
  const [feedbackSummary, setFeedbackSummary] = useState<ShadowFeedbackApiResponse['summary']>(null);
  const [feedbackReviewQueue, setFeedbackReviewQueue] = useState<ShadowFeedbackItem[]>([]);
  // Items whose review was recorded but whose learning promotion returned a
  // retryable failure. The GET projection cannot identify these (it does not
  // expose learning-event presence), so they are tracked for this session only.
  const [feedbackRetryQueue, setFeedbackRetryQueue] = useState<ShadowFeedbackItem[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState('');
  const [feedbackPendingId, setFeedbackPendingId] = useState<number | null>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleItemActionRef = useRef(handleItemAction);

  useEffect(() => {
    handleItemActionRef.current = handleItemAction;
  });

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [consoleLogs]);

  useEffect(() => {
    void refreshBackendQueue().catch((error) => {
      setBackendQueueReady(false);
      setPendingQueue([]);
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Queue Load Failed',
        message: error instanceof Error ? error.message : 'Failed to load backend queue',
        destination: 'SHADOW Local State',
      });
    });

    void refreshShadowOperationalReads().catch(() => {
      // Keep console operational when SHADOW telemetry/authority reads are unavailable.
    });

    void refreshShadowFeedbackReviews().catch((error) => {
      setFeedbackReviewQueue([]);
      setFeedbackError(
        error instanceof Error ? error.message : 'Failed to load SHADOW feedback review queue',
      );
    });

    // Load growth metrics asynchronously
    const loadMetrics = async () => {
      setMetricsLoading(true);
      setMetricsError('');
      try {
        const response = await fetch(`${apiBase()}/api/pilot/shadow/metrics?days=30`, {
          credentials: 'include',
        });
        if (!response.ok) {
          setMetricsError(
            response.status === 401 || response.status === 403
              ? 'SHADOW Intelligence is limited to organization admins. The other panels on this page are unaffected.'
              : 'SHADOW Intelligence could not be loaded. The other panels on this page are unaffected.',
          );
          return;
        }
        const payload = (await response.json()) as { metrics?: OrgMetrics } | null;
        if (payload?.metrics?.growth) setGrowthMetrics(payload.metrics);
      } catch {
        setMetricsError('SHADOW Intelligence could not be reached. The other panels on this page are unaffected.');
      } finally {
        setMetricsLoading(false);
      }
    };

    void loadMetrics();
  }, []);

  const selectedItem = useMemo(() => pendingQueue.find((item) => item.id === selectedItemId) ?? null, [pendingQueue, selectedItemId]);

  async function refreshBackendQueue() {
    const response = await fetch(`${apiBase()}/api/pilot/shadow/review-projection`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const payload = (await response.json()) as ReviewQueueApiResponse | { error?: string };
    if (!response.ok || !('ok' in payload)) {
      const message = 'error' in payload && payload.error ? payload.error : 'Failed to load review queue';
      throw new Error(message);
    }

    const mapped: IntakeItem[] = payload.queue.map((entry) => {
      const athleteSuffix = entry.primary_athlete_id ? ` | Athlete: ${entry.primary_athlete_id}` : '';
      const eventSuffix = entry.shadow_event_name ? ` | Event: ${entry.shadow_event_name}` : '';

      return {
      id: entry.intake_case_id,
      intakeCaseId: entry.intake_case_id,
      itemName: entry.summary,
      dataType: 'File Intake',
      source: 'SHADOW Upload',
      suggestedDestination: 'Admin Hub',
      status: fromBackendStatus(entry.status),
      reviewNeeded: entry.status === 'pending_review',
      requiresJasonReview: entry.status === 'pending_review',
      detectedType: 'File Intake',
      confidence: 'Medium',
      notes: `Documents in case: ${entry.document_count}${athleteSuffix}${eventSuffix}`,
      destinationRoute: '/admin/shadow',
      timestamp: entry.created_at,
      lastUpdatedAt: entry.updated_at,
      };
    });

    setPendingQueue(mapped);
    setBackendQueueReady(true);
  }

  async function refreshShadowFeedbackReviews() {
    setFeedbackLoading(true);
    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/feedback?limit=200`, {
        credentials: 'include',
      });
      const payload = (await response.json().catch(() => null)) as
        | (Partial<ShadowFeedbackApiResponse> & { error?: string })
        | null;

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || 'Failed to load SHADOW feedback review queue');
      }

      setFeedbackSummary(payload.summary ?? null);
      setFeedbackReviewQueue(selectShadowFeedbackReviewQueue(payload.items ?? []));
      setFeedbackError('');
    } finally {
      setFeedbackLoading(false);
    }
  }

  async function handleFeedbackReview(item: ShadowFeedbackItem, decision: 'approve' | 'reject') {
    setFeedbackPendingId(item.feedback_id);
    setFeedbackError('');

    try {
      const response = await fetch(`${apiBase()}/api/pilot/shadow/feedback`, {
        credentials: 'include',
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedbackId: item.feedback_id, decision }),
      });
      const payload = (await response.json().catch(() => null)) as ShadowFeedbackReviewApiResponse | null;
      const outcome = interpretShadowFeedbackReviewResponse({
        status: response.status,
        payload,
        feedbackId: item.feedback_id,
        decision,
      });

      // The review landed but downstream learning promotion did not. Keep the
      // item actionable instead of letting the failure disappear.
      if (outcome.kind === 'retry_required') {
        setFeedbackRetryQueue((prev) => (
          prev.some((entry) => entry.feedback_id === item.feedback_id) ? prev : [item, ...prev]
        ));
        setFeedbackError(outcome.message);
        appendConsoleLog({
          source: 'SHADOW',
          dataType: 'System',
          status: 'Learning Promotion Retry Required',
          message: outcome.message,
          destination: 'SHADOW Local State',
        });
        await refreshShadowFeedbackReviews();
        return;
      }

      if (outcome.kind !== 'resolved') {
        throw new Error(outcome.message);
      }

      setFeedbackRetryQueue((prev) => prev.filter((entry) => entry.feedback_id !== item.feedback_id));
      appendConsoleLog({
        source: 'Admin',
        dataType: 'System',
        status: outcome.decision === 'approve' ? 'Feedback Approved' : 'Feedback Rejected',
        message: outcome.alreadyResolved
          ? `Feedback #${item.feedback_id} was already resolved; decision re-confirmed as ${outcome.decision}.`
          : `Feedback #${item.feedback_id} ${outcome.decision === 'approve' ? 'approved for learning' : 'rejected'}.`,
        destination: 'SHADOW Local State',
      });
      appendTelemetry('feedback reviewed', { feedbackId: item.feedback_id, decision: outcome.decision });
      await refreshShadowFeedbackReviews();
    } catch (error) {
      const message = error instanceof Error ? error.message : `Failed to ${decision} feedback`;
      setFeedbackError(message);
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Feedback Review Failed',
        message,
        destination: 'SHADOW Local State',
      });
    } finally {
      setFeedbackPendingId(null);
    }
  }

  async function refreshShadowOperationalReads() {
    const [telemetryResponse, authorityResponse] = await Promise.all([
      fetch(`${apiBase()}/api/pilot/shadow/telemetry`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 40 }),
      }),
      fetch(`${apiBase()}/api/pilot/shadow/authority`, {
        credentials: 'include',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 40 }),
      }),
    ]);

    if (telemetryResponse.ok) {
      const telemetryPayload = (await telemetryResponse.json()) as ShadowTelemetryApiResponse;
      setShadowTelemetry(telemetryPayload.telemetry ?? []);
    }

    if (authorityResponse.ok) {
      const authorityPayload = (await authorityResponse.json()) as ShadowAuthorityApiResponse;
      setShadowAuthorityChecks(authorityPayload.authority_checks ?? []);
    }
  }

  function appendTelemetry(event: TelemetryEvent['event'], payload: Record<string, unknown>) {
    setTelemetryEvents((prev) => [{ timestamp: nowIso(), event, payload }, ...prev].slice(0, 200));
  }

  function appendConsoleLog(entry: Omit<ConsoleLogEntry, 'id' | 'timestamp'>) {
    setConsoleLogs((prev) => [
      ...prev,
      {
        id: newId(),
        timestamp: nowIso(),
        ...entry,
      },
    ]);
  }

  function applyQueueUpdate(itemId: string, updater: (item: IntakeItem) => IntakeItem) {
    setPendingQueue((current) => current.map((item) => (item.id === itemId ? updater(item) : item)));
  }

  async function processReviewAction(item: IntakeItem, backendAction: 'approve' | 'reject') {
    if (!backendQueueReady) {
      throw new Error('Review action blocked: backend review queue is unavailable.');
    }

    const response = await fetch(`${apiBase()}/api/pilot/intake/review-action`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intake_case_id: item.intakeCaseId, action: backendAction, notes: item.notes }),
    });

    const payload = (await response.json()) as { error?: string };
    if (!response.ok) {
      throw new Error(payload.error || `Failed to ${backendAction} intake case`);
    }

    await refreshBackendQueue();
    await refreshShadowOperationalReads();
  }

  async function processPromotion(item: IntakeItem) {
    if (!backendQueueReady) {
      throw new Error('Promotion blocked: backend review queue is unavailable.');
    }

    const promotionPayload = parsePromotionPayloadFromNotes(item.notes);
    if (!promotionPayload) {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Promotion Blocked',
        message: 'To promote, set Notes to a valid JSON promotion payload.',
        destination: item.suggestedDestination,
      });
      return null;
    }

    const promoteResponse = await fetch(`${apiBase()}/api/pilot/intake/review-action`, {
      credentials: 'include',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intake_case_id: item.intakeCaseId,
        action: 'promote',
        notes: 'Promoted from SHADOW Admin Console',
        promotion: promotionPayload,
      }),
    });

    const promotePayload = (await promoteResponse.json()) as { error?: string; athlete_id?: string };
    if (!promoteResponse.ok) {
      throw new Error(promotePayload.error || 'Promotion failed');
    }

    await refreshBackendQueue();
    await refreshShadowOperationalReads();
    return promotePayload;
  }

  function handleViewAction(item: IntakeItem, itemId: string) {
    setSelectedItemId(itemId);
    appendConsoleLog({
      source: 'Admin',
      dataType: item.dataType,
      status: 'Viewed',
      message: `Viewing intake item ${item.itemName}.`,
      destination: item.suggestedDestination,
    });
  }

  async function handleReviewAction(item: IntakeItem, action: 'APPROVE' | 'REJECT') {
    const isApprove = action === 'APPROVE';
    const backendAction = isApprove ? 'approve' : 'reject';
    await processReviewAction(item, backendAction);
    appendTelemetry(isApprove ? 'item approved' : 'item rejected', { itemId: item.id, itemName: item.itemName });
    appendConsoleLog({
      source: 'Admin',
      dataType: item.dataType,
      status: isApprove ? 'Approved' : 'Rejected',
      message: isApprove
        ? `Backend approval recorded for intake case ${item.intakeCaseId}.`
        : `Backend rejection recorded for intake case ${item.intakeCaseId}.`,
      destination: item.suggestedDestination,
    });
  }

  async function handleImportAction(item: IntakeItem) {
    if (item.status !== 'Approved') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Blocked',
        message: `Import blocked for ${item.itemName}. Item requires Jason/Admin approval first.`,
        destination: item.suggestedDestination,
      });
      return;
    }

    const promotePayload = await processPromotion(item);
    if (!promotePayload) {
      return;
    }

    appendTelemetry('item imported', { itemId: item.id, itemName: item.itemName, destination: item.suggestedDestination });
    const promotedAthleteMessage = promotePayload.athlete_id ? ` for athlete ${promotePayload.athlete_id}` : '';
    appendConsoleLog({
      source: 'SHADOW',
      dataType: item.dataType,
      status: 'Imported',
      message: `Case ${item.intakeCaseId} promoted to domain records${promotedAthleteMessage}.`,
      destination: item.suggestedDestination,
    });
  }

  async function handleItemAction(itemId: string, action: 'VIEW' | 'APPROVE' | 'REJECT' | 'IMPORT') {
    const item = pendingQueue.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    if (action === 'VIEW') {
      handleViewAction(item, itemId);
      return;
    }

    // Also covers the command bar and the A/R/I shortcuts, which reach the same
    // refused routes as the buttons.
    if (intakeWriteRefusal) {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: item.dataType,
        status: 'Blocked',
        message: intakeWriteRefusal,
        destination: 'SHADOW Local State',
      });
      return;
    }

    if (action === 'APPROVE' || action === 'REJECT') {
      await handleReviewAction(item, action);
      return;
    }

    await handleImportAction(item);
  }

  function handleCommandSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const submitted = commandInput.trim().toLowerCase();
    if (!submitted) {
      return;
    }

    appendTelemetry('command submitted', { command: submitted });
    appendConsoleLog({
      source: 'Admin',
      dataType: 'Command',
      status: 'Submitted',
      message: `Command received: ${submitted}`,
      destination: 'SHADOW Local State',
    });

    if (submitted === 'status') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Status',
        message: `Queue=${pendingQueue.length} | Selected=${selectedItem ? selectedItem.itemName : 'None'}`,
        destination: 'SHADOW Local State',
      });
    } else if (submitted === 'list') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'List',
        message:
          pendingQueue.length === 0
            ? 'No pending intake items in queue.'
            : `Pending items: ${pendingQueue.map((item) => item.itemName).join(' | ')}`,
        destination: 'SHADOW Local State',
      });
    } else if (submitted === 'clear') {
      setConsoleLogs([
        {
          id: newId(),
          timestamp: nowIso(),
          source: 'SHADOW',
          dataType: 'System',
          status: 'Cleared',
          message: 'Console log cleared by admin command.',
          destination: 'SHADOW Local State',
        },
      ]);
    } else if (submitted === 'summarize' || submitted === 'merge') {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'System',
        status: 'Summary',
        message: `Queue status: ${pendingQueue.length} pending item(s). Review documents, then APPROVE and IMPORT.`,
        destination: 'Admin Hub',
      });
    } else if (submitted === 'approve' || submitted === 'reject') {
      if (!selectedItem) {
        appendConsoleLog({
          source: 'SHADOW',
          dataType: 'Command',
          status: 'No Target',
          message: `Command ${submitted} requires a selected queue item (use VIEW).`,
          destination: 'SHADOW Local State',
        });
      } else {
        const action = submitted.toUpperCase() as 'APPROVE' | 'REJECT';
        void handleItemAction(selectedItem.id, action);
      }
    } else {
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'Command',
        status: 'Placeholder',
        message: `Unknown command: ${submitted}. Use merge | status | list | clear | summarize | approve | reject`,
        destination: 'SHADOW Local State',
      });
    }

    setCommandInput('');
  }

  function handleUploadButtonClick() {
    appendTelemetry('file upload clicked', { ui: 'external-sources' });
    fileInputRef.current?.click();
  }

  async function processUploadedPdf(file: File) {
    setUploadError('');

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setUploadError('Only PDF files are accepted.');
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'File Intake',
        status: 'Validation Failed',
        message: `Rejected upload ${file.name}. Only PDF files are supported.`,
        destination: 'SHADOW Local State',
      });
      return;
    }

    setIsUploading(true);
    setUploadedFileName(file.name);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('hint', 'admin-upload');
      formData.append('document_type', 'general_intake');

      const response = await fetch(`${apiBase()}/api/pilot/shadow/upload`, {
        credentials: 'include',
        method: 'POST',
        body: formData,
      });

      const payload = (await response.json()) as ShadowUploadResponse | { error?: string };

      if (!response.ok || !('ok' in payload)) {
        const errorMessage = 'error' in payload && payload.error ? payload.error : 'Ingest request failed';
        throw new Error(errorMessage);
      }

      const destination = toDestination('Admin Hub');
      const detectedType = toDataType('File Intake');
      const now = nowIso();

      const newItem: IntakeItem = {
        id: payload.intake_case_id,
        intakeCaseId: payload.intake_case_id,
        itemName: file.name,
        dataType: 'File Intake',
        source: 'Admin Upload',
        suggestedDestination: destination,
        status: 'Pending',
        reviewNeeded: true,
        requiresJasonReview: true,
        detectedType,
        confidence: 'Medium',
        notes: `Classification=${payload.classification}; Queue=${payload.routed_queue}; DocumentType=${payload.document_type}`,
        destinationRoute: routeForDestination(destination),
        timestamp: now,
        lastUpdatedAt: now,
      };

      setPendingQueue((prev) => [newItem, ...prev.filter((entry) => entry.intakeCaseId !== newItem.intakeCaseId)]);
      setSelectedItemId(newItem.id);
      setLastIngestSummary(payload);

      await refreshBackendQueue();
      await refreshShadowOperationalReads();

      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'File Intake',
        status: 'Processed',
        message: `PDF processed and staged as case ${payload.intake_case_id}.`,
        destination,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown upload failure';
      setUploadError(message);
      appendConsoleLog({
        source: 'SHADOW',
        dataType: 'File Intake',
        status: 'Error',
        message: `Upload processing failed: ${message}`,
        destination: 'SHADOW Local State',
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  function handleFileUploadChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      return;
    }
    void processUploadedPdf(file);
  }

  function handleFileDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (!file) {
      return;
    }
    void processUploadedPdf(file);
  }

  function handleQuickAdd(dataType: DataType, source: string, destination: IntakeDestination, route: string) {
    appendConsoleLog({
      source: 'SHADOW',
      dataType: 'Command',
      status: 'Blocked',
      message: `Quick Add disabled in backend-required mode (${dataType} from ${source} to ${destination} via ${route}). Use Upload File so actions are persisted.`,
      destination: 'SHADOW Local State',
    });
  }

  function updateSelectedItem(fields: Partial<Pick<IntakeItem, 'detectedType' | 'suggestedDestination' | 'confidence' | 'requiresJasonReview' | 'notes' | 'destinationRoute'>>) {
    if (!selectedItemId) {
      return;
    }

    applyQueueUpdate(selectedItemId, (item) => {
      const nextDestination = fields.suggestedDestination ?? item.suggestedDestination;
      return {
        ...item,
        ...fields,
        reviewNeeded: fields.requiresJasonReview ?? item.requiresJasonReview,
        destinationRoute: fields.destinationRoute ?? routeForDestination(nextDestination),
        lastUpdatedAt: nowIso(),
      };
    });
  }

  useEffect(() => {
    function onGlobalKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName;
      const isTypingElement = tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT';
      if (isTypingElement) {
        return;
      }

      const key = event.key.toLowerCase();
      const runAction = (action: 'APPROVE' | 'REJECT' | 'IMPORT') => {
        if (!selectedItemId) {
          return;
        }
        void handleItemActionRef.current(selectedItemId, action);
      };

      if (key === 'a') {
        event.preventDefault();
        runAction('APPROVE');
      } else if (key === 'r') {
        event.preventDefault();
        runAction('REJECT');
      } else if (key === 'i') {
        event.preventDefault();
        runAction('IMPORT');
      } else if (key === 'v' && selectedItemId) {
        event.preventDefault();
        void handleItemActionRef.current(selectedItemId, 'VIEW');
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, [selectedItemId]);

  const filteredSortedQueue = useMemo(() => {
    const filtered = pendingQueue.filter((item) => queueFilterStatus === 'ALL' || item.status === queueFilterStatus);

    return [...filtered].sort((a, b) => {
      if (queueSort === 'oldest') {
        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
      }
      if (queueSort === 'status') {
        return a.status.localeCompare(b.status) || new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      }
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
  }, [pendingQueue, queueFilterStatus, queueSort]);

  const queueCounts = useMemo(() => {
    return {
      pending: pendingQueue.filter((item) => item.status === 'Pending').length,
      approved: pendingQueue.filter((item) => item.status === 'Approved').length,
    };
  }, [pendingQueue]);

  const commandHints = ['merge', 'status', 'list', 'clear', 'summarize', 'approve', 'reject'];

  return (
    <RoleStandaloneView roleLabel="SHADOW Admin Console" routeLabel="/admin/shadow" allowedRoles={['admin', 'platform_owner']} showShellHeader={false}>
      <main className="grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
        {/* ── SHADOW Growth Metrics ─────────────────────────────────── */}
        {renderMetricsPanel(growthMetrics, metricsLoading, metricsError)}
        {/* ── SHADOW Learning Review (human approval gate) ──────────── */}
        {renderFeedbackReviewPanel({
          summary: feedbackSummary,
          reviewQueue: feedbackReviewQueue,
          retryQueue: feedbackRetryQueue,
          loading: feedbackLoading,
          error: feedbackError,
          pendingFeedbackId: feedbackPendingId,
          reviewRefusal: intakeWriteRefusal,
          onReview: (item, decision) => {
            void handleFeedbackReview(item, decision);
          },
          onRefresh: () => {
            void refreshShadowFeedbackReviews().catch((error) => {
              setFeedbackError(
                error instanceof Error ? error.message : 'Failed to load SHADOW feedback review queue',
              );
            });
          },
        })}
        {/* ── Library Review Flags (negative-outcome verdicts) ─────── */}
        <LibraryReviewFlagsPanel />

        <FeatureUnlockPanel />
        <section className="space-y-6 border-4 border-[var(--patina-700)] bg-[var(--hide-950)]/70 p-6">
          <div className="mb-6 border-b border-[var(--patina-700)]/20 pb-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--brass-300)]">AI/ML Telemetry Scout</p>
            <h2 className="mt-2 text-3xl font-black text-[var(--bone-200)]">SHADOW Data Intake + Command Console</h2>
            <p className="mt-2 text-[16px] leading-7 text-[var(--brass-300)]/85">
              Import, classify, stage, and review external data before it enters the PPBF system.
            </p>
          </div>

          <section className="border-4 border-[var(--patina-700)] bg-[var(--hide-950)] p-4">
            <div className="mb-3 flex flex-wrap gap-2 text-xs font-mono uppercase tracking-[0.14em] text-[var(--brass-300)]/85">
              <span>Pending: {queueCounts.pending}</span>
              <span>Approved: {queueCounts.approved}</span>
            </div>
            <div className="max-h-[500px] space-y-3 overflow-y-auto pr-1">
              {consoleLogs.map((log) => (
                <article key={log.id} className="border-2 border-[var(--patina-700)]/70 bg-[var(--hide-900)] p-4 font-mono text-[14px] leading-6 text-[var(--bone-200)]">
                  <p className="text-[var(--brass-300)]">[{log.timestamp}]</p>
                  <p>SOURCE: {log.source}</p>
                  <p>TYPE: {log.dataType}</p>
                  <p>STATUS: {log.status}</p>
                  <p>MESSAGE: {log.message}</p>
                  <p>DESTINATION: {log.destination ?? 'Unknown'}</p>
                </article>
              ))}
              <div ref={logsEndRef} />
            </div>
          </section>

          <section className="border-4 border-[var(--patina-700)] bg-[var(--hide-950)] p-4">
            <p className="mb-3 text-[16px] font-semibold text-[var(--bone-200)]">Command Bar</p>
            <div className="mb-3 flex flex-wrap gap-2">
              {commandHints.map((hint) => (
                <button
                  key={hint}
                  type="button"
                  onClick={() => setCommandInput(hint)}
                  className="h-11 border border-[var(--rust-500)] bg-[var(--rust-900)] px-3 font-mono text-[13px] text-[var(--brass-300)] transition hover:border-[var(--brass-500)] hover:text-[var(--bone-100)]"
                >
                  {hint}
                </button>
              ))}
            </div>
            <p className="mb-3 font-mono text-[12px] text-[var(--brass-300)]/80">
              Shortcuts: V view, A approve, R reject, I import on selected item.
            </p>
            <form onSubmit={handleCommandSubmit} className="flex flex-wrap gap-3">
              <input
                type="text"
                value={commandInput}
                onChange={(e) => setCommandInput(e.target.value)}
                onKeyDown={(event) => {
                  if (event.ctrlKey && event.key === 'Enter') {
                    event.preventDefault();
                    const form = event.currentTarget.form;
                    if (form) {
                      form.requestSubmit();
                    }
                  }
                }}
                placeholder="merge | status | list | clear | summarize | approve | reject"
                className="h-11 min-w-[280px] flex-1 border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-4 font-mono text-[15px] text-[var(--bone-200)] placeholder-[var(--brass-300)] outline-none transition focus:border-[var(--brass-500)]"
              />
              <button
                type="submit"
                className="h-11 border-2 border-[var(--patina-700)] bg-[var(--rust-700)] px-6 font-mono text-[14px] font-bold text-[var(--bone-200)] transition hover:border-[var(--brass-500)] hover:bg-[var(--rust-500)]"
              >
                Submit Command
              </button>
            </form>
          </section>

          <section className="border-4 border-[var(--patina-700)] bg-[var(--hide-950)] p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-[18px] font-black text-[var(--bone-200)]">PENDING IMPORT QUEUE</h3>
              <p className="font-mono text-[13px] uppercase tracking-[0.1em] text-[var(--brass-300)]">Backed by SHADOW review projection</p>
            </div>

            <div className="mb-4 grid gap-2 md:grid-cols-2">
              <label className="text-[13px] text-[var(--brass-300)]">
                <span className="mb-1 block font-mono uppercase">Filter Status</span>
                <select
                  value={queueFilterStatus}
                  onChange={(event) => setQueueFilterStatus(event.target.value as 'ALL' | IntakeStatus)}
                  className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px] text-[var(--bone-200)]"
                >
                  <option value="ALL">ALL</option>
                  <option value="Pending">Pending</option>
                  <option value="Approved">Approved</option>
                  <option value="Rejected">Rejected</option>
                  <option value="Imported">Imported</option>
                </select>
              </label>
              <label className="text-[13px] text-[var(--brass-300)]">
                <span className="mb-1 block font-mono uppercase">Sort</span>
                <select
                  value={queueSort}
                  onChange={(event) => setQueueSort(event.target.value as QueueSort)}
                  className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px] text-[var(--bone-200)]"
                >
                  <option value="newest">Newest First</option>
                  <option value="oldest">Oldest First</option>
                  <option value="status">Status A-Z</option>
                </select>
              </label>
            </div>

            {filteredSortedQueue.length === 0 ? (
              <p className="text-[16px] text-[var(--brass-300)]/80">No pending intake items. Use Upload File or Quick Add to create staging entries.</p>
            ) : (
              <div className="space-y-3">
                {filteredSortedQueue.map((item) => (
                  <article
                    key={item.id}
                    className={`border-2 p-4 ${selectedItemId === item.id ? 'border-[var(--brass-500)] bg-[var(--rust-900)]' : 'border-[var(--patina-700)]/70 bg-[var(--hide-900)]'}`}
                  >
                    <div className="grid gap-2 text-[14px] text-[var(--bone-200)] md:grid-cols-2">
                      <p><span className="font-semibold text-[var(--brass-300)]">Item Name:</span> {item.itemName}</p>
                      <p><span className="font-semibold text-[var(--brass-300)]">Data Type:</span> {item.dataType}</p>
                      <p><span className="font-semibold text-[var(--brass-300)]">Source:</span> {item.source}</p>
                      <p><span className="font-semibold text-[var(--brass-300)]">Suggested Destination:</span> {item.suggestedDestination}</p>
                      <p>
                        <span className="font-semibold text-[var(--brass-300)]">Status:</span>{' '}
                        <span className={`inline-flex border px-2 py-0.5 font-mono text-[12px] ${statusChipClasses(item.status)}`}>{item.status}</span>
                      </p>
                      <p><span className="font-semibold text-[var(--brass-300)]">Review Needed:</span> {item.reviewNeeded ? 'Yes' : 'No'}</p>
                      <p className="md:col-span-2"><span className="font-semibold text-[var(--brass-300)]">Timestamp:</span> {item.timestamp}</p>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      {(['VIEW', 'APPROVE', 'REJECT', 'IMPORT'] as const).map((action) => (
                        <button
                          key={action}
                          type="button"
                          onClick={() => void handleItemAction(item.id, action)}
                          disabled={
                            (action !== 'VIEW' && Boolean(intakeWriteRefusal))
                            || (action === 'IMPORT' && item.status !== 'Approved')
                          }
                          className="h-11 border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-3 text-[13px] font-bold text-[var(--bone-200)] transition hover:border-[var(--brass-500)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                    {intakeWriteRefusal ? (
                      <p className="mt-2 text-[12px] text-[var(--brass-200)]">{intakeWriteRefusal}</p>
                    ) : null}
                    {item.reviewNeeded && !intakeWriteRefusal ? <CaseDocumentsPanel intakeCaseId={item.intakeCaseId} /> : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>

        <aside className="space-y-4">
          <section className="border-4 border-[var(--brass-500)] bg-[var(--hide-950)]/70 p-4">
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-[var(--brass-300)]">Data Intake Sources</p>
            <h3 className="mt-2 text-xl font-black text-[var(--bone-200)]">External Sources</h3>

            {intakeWriteRefusal ? (
              <p className="mt-4 border-2 border-dashed border-[var(--hide-600)] bg-[var(--hide-950)] p-3 text-[13px] leading-6 text-[var(--brass-200)]">
                {intakeWriteRefusal}
              </p>
            ) : (
              <div
                className={`mt-4 space-y-2 rounded border-2 border-dashed p-3 transition ${
                  isDragOver ? 'border-[var(--bone-200)] bg-[var(--hide-800)]' : 'border-[var(--hide-600)] bg-[var(--hide-950)]'
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragOver(true);
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleFileDrop}
              >
                <p className="text-[12px] font-mono uppercase tracking-[0.08em] text-[var(--brass-300)]">
                  Drop PDF here or use the upload button
                </p>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  onChange={handleFileUploadChange}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={handleUploadButtonClick}
                  disabled={isUploading}
                  className="h-11 w-full border-2 border-[var(--brass-500)] bg-[var(--hide-900)] px-3 text-[14px] font-mono text-[var(--brass-300)] transition hover:border-[var(--bone-200)] hover:bg-[var(--hide-800)] hover:text-[var(--bone-200)]"
                >
                  {isUploading ? 'Processing PDF...' : 'Upload PDF'}
                </button>
                {uploadedFileName && <p className="text-[14px] text-[var(--brass-300)]/80">Last staged file: {uploadedFileName}</p>}
                {uploadError && <p className="text-[13px] text-[var(--locked-ink)]">{uploadError}</p>}
                {lastIngestSummary && (
                  <div className="border border-[var(--hide-600)] bg-[var(--hide-900)] p-2 text-[12px] text-[var(--bone-200)]">
                    <p>Intake Case: {lastIngestSummary.intake_case_id}</p>
                    <p>Intake Document: {lastIngestSummary.intake_document_id}</p>
                    <p>Classification: {lastIngestSummary.classification}</p>
                    <p>Queue: {lastIngestSummary.routed_queue}</p>
                    <p>Review Status: {lastIngestSummary.review_status}</p>
                  </div>
                )}
              </div>
            )}

            <div className="mt-4 border-t border-[var(--brass-500)]/20 pt-3">
              <p className="text-[14px] font-mono text-[var(--brass-300)]/80">Quick Add:</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {QUICK_ADD_OPTIONS.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => handleQuickAdd(option.label, option.source, option.destination, option.route)}
                    className="h-11 border-2 border-[var(--brass-500)] bg-[var(--hide-900)] px-2 text-[12px] text-[var(--brass-300)] transition hover:border-[var(--bone-200)] hover:bg-[var(--hide-800)]"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="border-4 border-[var(--patina-700)] bg-[var(--hide-950)]/70 p-4">
            <h3 className="text-xl font-black text-[var(--bone-200)]">Classification Panel</h3>
            {!selectedItem ? (
              <p className="mt-3 text-[16px] text-[var(--brass-300)]/80">Select an intake item via VIEW to classify and route it.</p>
            ) : (
              <div className="mt-3 space-y-3 text-[14px] text-[var(--bone-200)]">
                <p className="font-semibold text-[var(--brass-300)]">Selected: {selectedItem.itemName}</p>
                <p className={`inline-flex border px-2 py-1 font-mono text-[12px] ${selectedItem.requiresJasonReview ? 'border-[var(--patina-700)] bg-[var(--rust-700)] text-[var(--locked-ink)]' : 'border-[var(--brass-500)] bg-[var(--patina-900)] text-[var(--bone-100)]'}`}>
                  {selectedItem.requiresJasonReview ? 'PENDING JASON REVIEW' : 'APPROVED FOR IMPORT'}
                </p>

                <label className="block">
                  <span className="mb-1 block text-[var(--brass-300)]">Detected Type</span>
                  <select
                    value={selectedItem.detectedType}
                    onChange={(event) => updateSelectedItem({ detectedType: event.target.value as DataType })}
                    className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px]"
                  >
                    {QUICK_ADD_OPTIONS.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                    <option value="File Intake">File Intake</option>
                    <option value="System">System</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[var(--brass-300)]">Suggested Destination</span>
                  <select
                    value={selectedItem.suggestedDestination}
                    onChange={(event) => {
                      const destination = event.target.value as IntakeDestination;
                      updateSelectedItem({ suggestedDestination: destination, destinationRoute: routeForDestination(destination) });
                    }}
                    className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px]"
                  >
                    {DESTINATION_OPTIONS.map((destination) => (
                      <option key={destination} value={destination}>
                        {destination}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[var(--brass-300)]">Confidence</span>
                  <select
                    value={selectedItem.confidence}
                    onChange={(event) => updateSelectedItem({ confidence: event.target.value as ConfidenceLevel })}
                    className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px]"
                  >
                    <option value="Low">Low</option>
                    <option value="Medium">Medium</option>
                    <option value="High">High</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[var(--brass-300)]">Requires Jason Review</span>
                  <select
                    value={selectedItem.requiresJasonReview ? 'Yes' : 'No'}
                    onChange={(event) => updateSelectedItem({ requiresJasonReview: event.target.value === 'Yes' })}
                    className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px]"
                  >
                    <option value="Yes">Yes</option>
                    <option value="No">No</option>
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[var(--brass-300)]">Notes</span>
                  <textarea
                    value={selectedItem.notes}
                    onChange={(event) => updateSelectedItem({ notes: event.target.value })}
                    className="min-h-[92px] w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 py-2 text-[14px]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[var(--brass-300)]">Destination Route</span>
                  <input
                    value={selectedItem.destinationRoute}
                    onChange={(event) => updateSelectedItem({ destinationRoute: event.target.value })}
                    className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 text-[14px]"
                  />
                </label>
              </div>
            )}
          </section>

          <section className="border-4 border-[var(--patina-700)] bg-[var(--hide-950)]/70 p-4">
            <button
              type="button"
              onClick={() => setShowTelemetry((current) => !current)}
              className="h-11 w-full border-2 border-[var(--patina-700)] bg-[var(--rust-900)] text-[14px] font-bold text-[var(--bone-200)] transition hover:border-[var(--brass-500)]"
            >
              {showTelemetry ? 'Hide' : 'Show'} telemetry and authority streams
            </button>
            {showTelemetry && (
              <div className="mt-3 max-h-[220px] space-y-2 overflow-y-auto border border-[var(--patina-700)]/60 bg-[var(--hide-950)] p-2 font-mono text-[12px] text-[var(--brass-300)]">
                {telemetryEvents.length === 0 && <p className="p-2 text-[var(--brass-300)]/75">No telemetry events yet.</p>}
                {telemetryEvents.map((event, index) => (
                  <pre key={`${event.timestamp}-${index}`} className="whitespace-pre-wrap border border-[var(--patina-700)] bg-[var(--hide-900)] p-2 text-[var(--brass-300)]">
{JSON.stringify(event, null, 2)}
                  </pre>
                ))}

                <div className="border-t border-[var(--patina-700)]/60 pt-2">
                  <p className="mb-2 text-xs uppercase tracking-[0.08em] text-[var(--bone-200)]">SHADOW telemetry read model</p>
                  {shadowTelemetry.length === 0 && <p className="p-2 text-[var(--brass-300)]/75">No SHADOW telemetry events returned.</p>}
                  {shadowTelemetry.map((event) => (
                    <pre key={`shadow-telemetry-${event.shadow_telemetry_event_id}`} className="whitespace-pre-wrap border border-[var(--cleared)] bg-[var(--patina-900)] p-2 text-[var(--cleared-ink)]">
{JSON.stringify(event, null, 2)}
                    </pre>
                  ))}
                </div>

                <div className="border-t border-[var(--patina-700)]/60 pt-2">
                  <p className="mb-2 text-xs uppercase tracking-[0.08em] text-[var(--bone-200)]">SHADOW authority read model</p>
                  {shadowAuthorityChecks.length === 0 && <p className="p-2 text-[var(--brass-300)]/75">No SHADOW authority checks returned.</p>}
                  {shadowAuthorityChecks.map((check) => (
                    <pre key={`shadow-authority-${check.authority_check_id}`} className="whitespace-pre-wrap border border-[var(--hide-600)] bg-[var(--hide-900)] p-2 text-[var(--bone-200)]">
{JSON.stringify(check, null, 2)}
                    </pre>
                  ))}
                </div>
              </div>
            )}
          </section>

          <div className="flex gap-2 pt-2">
            <Link
              href="/admin"
              className="flex-1 border-2 border-[var(--patina-700)] bg-[var(--hide-900)] px-3 py-2 text-center text-[12px] font-mono text-[var(--brass-300)] transition hover:border-[var(--brass-500)] hover:text-[var(--bone-200)]"
            >
              Admin Hub
            </Link>
            <Link
              href="/shadow"
              className="flex-1 border-2 border-[var(--patina-700)] bg-[var(--rust-900)] px-3 py-2 text-center text-[12px] font-mono text-[var(--brass-300)] transition hover:border-[var(--brass-500)] hover:bg-[var(--rust-900)]"
            >
              SHADOW
            </Link>
          </div>
        </aside>
      </main>
    </RoleStandaloneView>
  );
}
