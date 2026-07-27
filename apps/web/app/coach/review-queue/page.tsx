'use client';

import { useCallback, useEffect, useState } from 'react';
import RoleStandaloneView from '@/components/RoleStandaloneView';
import { apiBase } from '@/lib/apiBase';

type CaseStatus = 'pending_review' | 'approved' | 'rejected' | 'promoted';

interface QueueItem {
  intake_case_id: string;
  status: CaseStatus;
  summary: string;
  primary_athlete_id: string | null;
  created_at: string;
  updated_at: string;
  document_count: number;
}

interface IntakeDocument {
  intake_document_id: string;
  document_type: string;
  file_name: string;
  classification: string;
  review_status: CaseStatus;
  created_at: string;
}

interface IntakeCaseDetail {
  intake_case_id: string;
  status: CaseStatus;
  summary: string;
  primary_athlete_id: string | null;
  review_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface CaseAggregate {
  intake_case: IntakeCaseDetail;
  documents: IntakeDocument[];
}

interface PromotionDraft {
  athleteId: string;
  fullName: string;
  dob: string;
  weightClass: string;
  gymStatus: string;
  emergencyContact: string;
  coachId: string;
  guardianFullName: string;
  guardianRelationship: string;
  guardianPhone: string;
  guardianEmail: string;
  waiverType: string;
  waiverSignedByName: string;
  waiverSignedByRole: string;
  waiverStatus: string;
}

const EMPTY_PROMOTION_DRAFT: PromotionDraft = {
  athleteId: '',
  fullName: '',
  dob: '',
  weightClass: '',
  gymStatus: 'active',
  emergencyContact: '',
  coachId: '',
  guardianFullName: '',
  guardianRelationship: 'parent',
  guardianPhone: '',
  guardianEmail: '',
  waiverType: '',
  waiverSignedByName: '',
  waiverSignedByRole: '',
  waiverStatus: 'signed',
};

async function readJsonOrThrow<T>(response: Response, fallbackMessage: string): Promise<T> {
  const payload = (await response.json().catch(() => ({}))) as (T & { ok?: boolean; error?: string }) | { error?: string };
  if (!response.ok || (payload as { ok?: boolean }).ok === false) {
    throw new Error((payload as { error?: string }).error || fallbackMessage);
  }
  return payload as T;
}

function statusChipClasses(status: CaseStatus): string {
  if (status === 'promoted' || status === 'approved') return 'border-[var(--black)] bg-[var(--canvas-tan-light)] font-bold';
  if (status === 'rejected') return 'border-[var(--red-primary)] bg-[var(--canvas-tan-light)] text-[var(--red-primary)]';
  return 'border-[var(--gray-dark)] bg-[var(--canvas-tan-light)] text-[var(--gray-dark)]';
}

export default function IntakeReviewQueuePage() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [queueError, setQueueError] = useState('');

  const [role, setRole] = useState<string | null>(null);

  const [selectedCaseId, setSelectedCaseId] = useState('');
  const [aggregate, setAggregate] = useState<CaseAggregate | null>(null);
  const [loadingCase, setLoadingCase] = useState(false);
  const [caseError, setCaseError] = useState('');

  const [notes, setNotes] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionPending, setActionPending] = useState(false);

  const [promotionDraft, setPromotionDraft] = useState<PromotionDraft>(EMPTY_PROMOTION_DRAFT);
  const [promotionError, setPromotionError] = useState('');
  const [promotionPending, setPromotionPending] = useState(false);

  const isOrgAdmin = role === 'organization_admin' || role === 'admin';

  const refreshQueue = useCallback(async () => {
    setLoadingQueue(true);
    setQueueError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/review-queue`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const payload = await readJsonOrThrow<{ queue: QueueItem[] }>(response, 'Failed to load the review queue.');
      setQueue(payload.queue ?? []);
    } catch (error) {
      setQueueError(error instanceof Error ? error.message : 'Failed to load the review queue.');
    } finally {
      setLoadingQueue(false);
    }
  }, []);

  const loadCase = useCallback(async (intakeCaseId: string) => {
    if (!intakeCaseId) {
      setAggregate(null);
      return;
    }
    setLoadingCase(true);
    setCaseError('');
    setActionError('');
    setPromotionError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/cases/get`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intake_case_id: intakeCaseId }),
      });
      const payload = await readJsonOrThrow<{ found: boolean; aggregate?: CaseAggregate }>(
        response,
        'Failed to load the intake case.',
      );
      if (!payload.found || !payload.aggregate) {
        setCaseError('That intake case could not be found.');
        setAggregate(null);
        return;
      }
      setAggregate(payload.aggregate);
      setNotes(payload.aggregate.intake_case.review_notes ?? '');
    } catch (error) {
      setCaseError(error instanceof Error ? error.message : 'Failed to load the intake case.');
      setAggregate(null);
    } finally {
      setLoadingCase(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshQueue();
  }, [refreshQueue]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${apiBase()}/api/pilot/auth/session`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { authenticated?: boolean; role?: string };
        if (payload.authenticated) {
          setRole(payload.role ?? null);
        }
      } catch {
        // Promotion is admin-only either way; the server enforces this regardless.
      }
    })();
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadCase(selectedCaseId);
  }, [selectedCaseId, loadCase]);

  async function handleReviewAction(action: 'approve' | 'reject') {
    if (!selectedCaseId) return;
    setActionPending(true);
    setActionError('');
    try {
      const response = await fetch(`${apiBase()}/api/pilot/intake/review-action`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intake_case_id: selectedCaseId, action, notes: notes || undefined }),
      });
      await readJsonOrThrow(response, `Failed to ${action} the intake case.`);
      await Promise.all([refreshQueue(), loadCase(selectedCaseId)]);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : `Failed to ${action} the intake case.`);
    } finally {
      setActionPending(false);
    }
  }

  async function handlePromote(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedCaseId) return;
    if (!promotionDraft.athleteId.trim() || !promotionDraft.fullName.trim() || !promotionDraft.dob.trim() || !promotionDraft.coachId.trim()) {
      setPromotionError('Athlete ID, full name, date of birth, and coach ID are required.');
      return;
    }

    setPromotionPending(true);
    setPromotionError('');
    try {
      const guardian = promotionDraft.guardianFullName.trim()
        ? {
            parent_id: `parent_${promotionDraft.athleteId.trim()}`,
            full_name: promotionDraft.guardianFullName.trim(),
            relationship_to_athlete: promotionDraft.guardianRelationship.trim() || 'guardian',
            phone: promotionDraft.guardianPhone.trim() || undefined,
            email: promotionDraft.guardianEmail.trim() || undefined,
          }
        : undefined;

      const waiver = promotionDraft.waiverSignedByName.trim()
        ? {
            waiver_type: promotionDraft.waiverType.trim() || 'general_liability',
            signed_by_name: promotionDraft.waiverSignedByName.trim(),
            signed_by_role: promotionDraft.waiverSignedByRole.trim() || 'guardian',
            signed_at: new Date().toISOString(),
            consent_version: '1.0',
            status: promotionDraft.waiverStatus.trim() || 'signed',
          }
        : undefined;

      const response = await fetch(`${apiBase()}/api/pilot/intake/review-action`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intake_case_id: selectedCaseId,
          action: 'promote',
          notes: notes || undefined,
          promotion: {
            athlete: {
              athlete_id: promotionDraft.athleteId.trim(),
              full_name: promotionDraft.fullName.trim(),
              dob: promotionDraft.dob.trim(),
              weight_class: promotionDraft.weightClass.trim() || 'unassigned',
              gym_status: promotionDraft.gymStatus.trim() || 'active',
              emergency_contact: promotionDraft.emergencyContact.trim() || 'unknown',
              coach_id: promotionDraft.coachId.trim(),
            },
            guardian,
            waiver,
          },
        }),
      });
      await readJsonOrThrow(response, 'Failed to promote the intake case.');
      setPromotionDraft(EMPTY_PROMOTION_DRAFT);
      await Promise.all([refreshQueue(), loadCase(selectedCaseId)]);
    } catch (error) {
      setPromotionError(error instanceof Error ? error.message : 'Failed to promote the intake case.');
    } finally {
      setPromotionPending(false);
    }
  }

  const selectedCase = aggregate?.intake_case ?? null;

  return (
    <RoleStandaloneView roleLabel="Intake Review" routeLabel="/coach/review-queue" allowedRoles={['coach', 'admin']} showShellHeader={false}>
      <main className="min-h-screen bg-[var(--canvas-tan)] text-[var(--black)]">
        <div className="mx-auto w-full max-w-6xl px-6 py-10 lg:px-10">
          <header className="space-y-3 border-b-[3px] border-[var(--black)] pb-6">
            <p className="text-xs font-mono uppercase tracking-[0.18em] text-[var(--red-primary)]">Coach Workspace</p>
            <h1 className="font-display text-4xl font-black">Intake Review Queue</h1>
            <p className="max-w-4xl text-sm leading-6 text-[var(--gray-dark)]">
              Every uploaded document lands here as a quarantined intake case before it becomes part of an athlete&apos;s
              record. Approve or reject each case; only an organization admin can promote an approved case into a real
              athlete record.
            </p>
          </header>

          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,340px)_1fr]">
            <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-black uppercase tracking-[0.04em]">Cases</h2>
                <button
                  type="button"
                  onClick={() => void refreshQueue()}
                  className="h-9 border-2 border-[var(--black)] px-3 text-xs font-bold uppercase"
                >
                  Refresh
                </button>
              </div>
              {loadingQueue && <p className="mt-2 text-xs text-[var(--gray-dark)]">Loading…</p>}
              {queueError && <p className="mt-2 text-sm font-bold text-[var(--red-primary)]">{queueError}</p>}
              <div className="mt-3 max-h-[560px] space-y-2 overflow-y-auto">
                {queue.length === 0 && !loadingQueue && (
                  <p className="text-sm text-[var(--gray-dark)]">No intake cases in this organization yet.</p>
                )}
                {queue.map((item) => (
                  <button
                    key={item.intake_case_id}
                    type="button"
                    onClick={() => setSelectedCaseId(item.intake_case_id)}
                    className={`block w-full border-2 p-3 text-left text-sm ${
                      selectedCaseId === item.intake_case_id ? 'border-[var(--red-primary)]' : 'border-[var(--black)]/40'
                    } bg-white`}
                  >
                    <p className="font-semibold">{item.summary}</p>
                    <p className="mt-1">
                      <span className={`inline-flex border px-2 py-0.5 font-mono text-xs ${statusChipClasses(item.status)}`}>
                        {item.status}
                      </span>
                      <span className="ml-2 text-xs text-[var(--gray-dark)]">{item.document_count} document(s)</span>
                    </p>
                  </button>
                ))}
              </div>
            </section>

            <section className="border-2 border-[var(--black)] bg-[var(--canvas-tan-light)] p-4">
              {loadingCase && <p className="text-sm text-[var(--gray-dark)]">Loading case…</p>}
              {caseError && <p className="text-sm font-bold text-[var(--red-primary)]">{caseError}</p>}

              {!selectedCase && !loadingCase && !caseError && (
                <p className="text-sm text-[var(--gray-dark)]">Select a case from the list to review it.</p>
              )}

              {selectedCase && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-black uppercase tracking-[0.04em]">{selectedCase.summary}</h2>
                    <p className="mt-1 text-xs text-[var(--gray-dark)]">
                      Status:{' '}
                      <span className={`inline-flex border px-2 py-0.5 font-mono ${statusChipClasses(selectedCase.status)}`}>
                        {selectedCase.status}
                      </span>
                    </p>
                  </div>

                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-[0.08em]">Documents</h3>
                    <div className="mt-2 space-y-2">
                      {(aggregate?.documents ?? []).map((doc) => (
                        <article key={doc.intake_document_id} className="border border-[var(--black)]/40 bg-white p-3 text-sm">
                          <p className="font-semibold">{doc.file_name}</p>
                          <p className="text-xs text-[var(--gray-dark)]">
                            {doc.document_type} · {doc.classification} · review: {doc.review_status}
                          </p>
                        </article>
                      ))}
                      {(aggregate?.documents ?? []).length === 0 && (
                        <p className="text-sm text-[var(--gray-dark)]">No documents attached to this case.</p>
                      )}
                    </div>
                  </div>

                  {selectedCase.status === 'pending_review' && (
                    <div className="border-t border-[var(--black)]/20 pt-4">
                      <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                        Review notes (optional)
                        <textarea
                          value={notes}
                          onChange={(event) => setNotes(event.target.value)}
                          className="mt-1 min-h-[64px] w-full border-2 border-[var(--black)] bg-white px-3 py-2 text-sm"
                        />
                      </label>
                      {actionError && <p className="mt-2 text-sm font-bold text-[var(--red-primary)]">{actionError}</p>}
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          disabled={actionPending}
                          onClick={() => void handleReviewAction('approve')}
                          className="h-11 border-2 border-[var(--black)] bg-[var(--black)] px-4 text-xs font-bold uppercase text-white disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={actionPending}
                          onClick={() => void handleReviewAction('reject')}
                          className="h-11 border-2 border-[var(--red-primary)] px-4 text-xs font-bold uppercase text-[var(--red-primary)] disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  )}

                  {selectedCase.status === 'approved' && isOrgAdmin && (
                    <form onSubmit={handlePromote} className="border-t border-[var(--black)]/20 pt-4 space-y-3">
                      <h3 className="text-sm font-bold uppercase tracking-[0.08em]">Promote to Athlete Record</h3>
                      <p className="text-xs text-[var(--gray-dark)]">
                        Enter the details from the reviewed documents. This creates (or updates) the athlete record and,
                        if provided, a guardian link and signed waiver.
                      </p>
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Athlete ID
                          <input
                            value={promotionDraft.athleteId}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, athleteId: event.target.value }))}
                            placeholder="athlete-jane-doe"
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Full name
                          <input
                            value={promotionDraft.fullName}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, fullName: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Date of birth
                          <input
                            type="date"
                            value={promotionDraft.dob}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, dob: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Weight class
                          <input
                            value={promotionDraft.weightClass}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, weightClass: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Gym status
                          <input
                            value={promotionDraft.gymStatus}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, gymStatus: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Emergency contact
                          <input
                            value={promotionDraft.emergencyContact}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, emergencyContact: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Coach account ID
                          <input
                            value={promotionDraft.coachId}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, coachId: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                      </div>

                      <h4 className="pt-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--gray-dark)]">
                        Guardian (optional — leave blank to skip)
                      </h4>
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Full name
                          <input
                            value={promotionDraft.guardianFullName}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, guardianFullName: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Relationship
                          <input
                            value={promotionDraft.guardianRelationship}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, guardianRelationship: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Phone
                          <input
                            value={promotionDraft.guardianPhone}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, guardianPhone: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Email
                          <input
                            value={promotionDraft.guardianEmail}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, guardianEmail: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                      </div>

                      <h4 className="pt-2 text-xs font-bold uppercase tracking-[0.08em] text-[var(--gray-dark)]">
                        Waiver (optional — leave signer blank to skip)
                      </h4>
                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Waiver type
                          <input
                            value={promotionDraft.waiverType}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, waiverType: event.target.value }))}
                            placeholder="general_liability"
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Signed by (name)
                          <input
                            value={promotionDraft.waiverSignedByName}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, waiverSignedByName: event.target.value }))}
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Signed by (role)
                          <input
                            value={promotionDraft.waiverSignedByRole}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, waiverSignedByRole: event.target.value }))}
                            placeholder="guardian"
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-xs font-bold uppercase tracking-[0.1em]">
                          Status
                          <input
                            value={promotionDraft.waiverStatus}
                            onChange={(event) => setPromotionDraft((draft) => ({ ...draft, waiverStatus: event.target.value }))}
                            placeholder="signed"
                            className="mt-1 h-11 w-full border-2 border-[var(--black)] bg-white px-3 text-sm"
                          />
                        </label>
                      </div>

                      {promotionError && <p className="text-sm font-bold text-[var(--red-primary)]">{promotionError}</p>}
                      <button
                        type="submit"
                        disabled={promotionPending}
                        className="h-11 border-2 border-[var(--black)] bg-[var(--black)] px-4 text-xs font-bold uppercase text-white disabled:opacity-50"
                      >
                        Promote to Athlete Record
                      </button>
                    </form>
                  )}

                  {selectedCase.status === 'approved' && !isOrgAdmin && (
                    <p className="border-t border-[var(--black)]/20 pt-4 text-sm text-[var(--gray-dark)]">
                      This case is approved and ready for promotion. Only an organization admin can promote it into an
                      athlete record.
                    </p>
                  )}

                  {(selectedCase.status === 'rejected' || selectedCase.status === 'promoted') && (
                    <p className="border-t border-[var(--black)]/20 pt-4 text-sm text-[var(--gray-dark)]">
                      This case is {selectedCase.status} and no further action is needed.
                    </p>
                  )}
                </div>
              )}
            </section>
          </div>
        </div>
      </main>
    </RoleStandaloneView>
  );
}
