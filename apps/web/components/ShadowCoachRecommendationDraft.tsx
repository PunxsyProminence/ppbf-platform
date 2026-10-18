'use client';

import { useEffect, useState } from 'react';
import { apiBase } from '@/lib/apiBase';

interface FormulaChoice {
  resultId: string;
  formulaId: string;
  outputKey: string;
  value: number;
  unit: string;
  computedAt: string;
  validationState: string;
  warnings: string[];
  inputObservationIds: string[];
}
interface DraftPreview {
  previewToken: string;
  draftId: string;
  status: string;
  recommendationText: string;
  expectedOutcome: string;
  modelUsed: string;
  citations: Array<{ chunkId: string; sourceTitle: string; documentName: string }>;
}
interface Origin {
  generatedBy: string;
  modelUsed: string;
  sourceFormulaResultId: string;
  citations: Array<{ chunkId: string; sourceTitle: string; documentName: string }>;
}

const ENDPOINT = '/api/pilot/shadow/recommendations/draft';
const REASONS: Record<string, string> = {
  source_not_found: 'The selected measurement is no longer current. Refresh.',
  source_unavailable: 'The selected measurement cannot support a draft.',
  no_eligible_evidence: 'No matching approved Library evidence was found. No draft created.',
  evidence_unavailable: 'The evidence search is unavailable. No draft created.',
  generation_unavailable: 'SHADOW could not generate a draft. No recommendation was saved.',
  invalid_generated_candidate: 'SHADOW did not return an adequately sourced draft.',
};
async function readResponse(response: Response): Promise<Record<string, unknown>> {
  let data: unknown;
  try { data = await response.json(); } catch { throw new Error('Unreadable SHADOW response.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid SHADOW response.');
  const result = data as Record<string, unknown>;
  if (!response.ok || result.ok !== true) {
    const reason = typeof result.reason === 'string' ? REASONS[result.reason] : undefined;
    throw new Error(reason ?? (typeof result.error === 'string' ? result.error : 'SHADOW request failed.'));
  }
  return result;
}
export default function ShadowCoachRecommendationDraft({
  athleteId, onSaved,
}: { athleteId: string; onSaved: () => void }) {
  const [choices, setChoices] = useState<FormulaChoice[]>([]);
  const [origins, setOrigins] = useState<Record<string, Origin>>({});
  const [selected, setSelected] = useState('');
  const [question, setQuestion] = useState('');
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setChoices([]);
    setOrigins({});
    setPreview(null);
    setQuestion('');
    setSelected('');
    setError('');
    setMessage('');
    if (!athleteId) return () => controller.abort();
    setLoading(true);
    void (async () => {
      try {
        const response = await fetch(apiBase() + ENDPOINT + '?athleteId=' + encodeURIComponent(athleteId), {
          credentials: 'include', signal: controller.signal,
        });
        const data = await readResponse(response);
        if (!Array.isArray(data.choices) || !data.origins || typeof data.origins !== 'object') {
          throw new Error('The SHADOW measurement list was incomplete.');
        }
        if (!controller.signal.aborted) {
          setChoices(data.choices as FormulaChoice[]);
          setOrigins(data.origins as Record<string, Origin>);
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Measurements unavailable.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [athleteId]);

  async function submit(action: 'draft' | 'save') {
    if (!athleteId || busy) return;
    const currentPreview = preview;
    setBusy(true);
    setError('');
    setMessage('');
    if (action === 'draft') setPreview(null);
    try {
      const body = action === 'draft'
        ? { action, athleteId, formulaResultId: selected, coachQuestion: question.trim() }
        : { action, athleteId, previewToken: currentPreview?.previewToken };
      const response = await fetch(apiBase() + ENDPOINT, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readResponse(response);
      if (action === 'draft') {
        const draft = data.preview as DraftPreview | undefined;
        if (!draft || draft.status !== 'unpersisted_needs_coach_review' || !draft.previewToken
          || !draft.recommendationText || !Array.isArray(draft.citations)) {
          throw new Error('SHADOW did not return a complete preview.');
        }
        setPreview(draft);
      } else {
        const row = data.recommendation as { recommendation_id?: string; athlete_id?: string } | undefined;
        if (!row?.recommendation_id || row.athlete_id !== athleteId) {
          throw new Error('Save not confirmed. Check the recommendations list before trying again.');
        }
        setPreview(null);
        setMessage('Saved as provisional. Acceptance is a separate coach action.');
        onSaved();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'SHADOW request failed.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mat-leather--raised rounded-[var(--r-md)] p-[var(--s3)] mt-[var(--s3)] space-y-[var(--s3)]">
      <h3 className="t-label">Ask SHADOW for a draft</h3>
      <p className="t-muted">Only the coach can request and save a proposal. SHADOW never accepts or assigns it.</p>
      <label className="field block">
        <span className="t-label">Current measurement</span>
        <select className="select" value={selected} disabled={loading || busy}
          onChange={(event) => { setSelected(event.target.value); setPreview(null); }}>
          <option value="">Select a measurement</option>
          {choices.map((choice) => (
            <option key={choice.resultId} value={choice.resultId}>
              {choice.formulaId} / {choice.outputKey}: {choice.value} {choice.unit} ({choice.validationState})
            </option>
          ))}
        </select>
      </label>
      {!loading && choices.length === 0 && !error && (
        <p className="t-muted">No eligible current formula measurements were recorded for this athlete.</p>
      )}
      {choices.filter((choice) => choice.resultId === selected).map((choice) => (
        <p className="t-data" key={choice.resultId}>
          Measured: {choice.computedAt}; {choice.inputObservationIds.length} input observations.
          {choice.warnings.length > 0 ? ' Warnings: ' + choice.warnings.join(', ') : ''}
        </p>
      ))}
      <label className="field block">
        <span className="t-label">Coaching question</span>
        <textarea className="textarea" value={question} rows={3} maxLength={2000} disabled={busy}
          onChange={(event) => { setQuestion(event.target.value); setPreview(null); }} />
      </label>
      <button type="button" className="btn" disabled={loading || busy || !selected || !question.trim()}
        onClick={() => void submit('draft')}>
        {busy ? 'Working…' : 'Generate draft for coach review'}
      </button>
      {preview && (
        <div className="space-y-[var(--s2)] border-t pt-[var(--s3)]">
          <p className="t-label">Unpublished SHADOW draft ({preview.modelUsed})</p>
          <p className="t-body">{preview.recommendationText}</p>
          <p className="t-body">Expected observable outcome: {preview.expectedOutcome}</p>
          <p className="t-muted">Cited sources (IDs checked; claim support not independently verified):</p>
          <ul className="list-disc pl-[var(--s4)]">
            {preview.citations.map((citation) => (
              <li className="t-muted" key={citation.chunkId}>
                {citation.sourceTitle} — {citation.documentName} ({citation.chunkId})
              </li>
            ))}
          </ul>
          <button type="button" className="btn" disabled={busy} onClick={() => void submit('save')}>
            {busy ? 'Saving…' : 'Save as provisional'}
          </button>
          <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => setPreview(null)}>
            Discard preview
          </button>
        </div>
      )}
      {Object.entries(origins).length > 0 && (
        <details>
          <summary className="t-muted">SHADOW-generated recommendation provenance</summary>
          <ul className="space-y-[var(--s2)] mt-[var(--s2)]">
            {Object.entries(origins).map(([id, origin]) => (
              <li key={id} className="t-data">
                Recommendation {id}: SHADOW ({origin.modelUsed}), formula {origin.sourceFormulaResultId};
                cited {origin.citations.map((citation) => citation.sourceTitle).join(', ')}.
                Citation support not independently verified.
              </li>
            ))}
          </ul>
        </details>
      )}
      {message && <p role="status" className="t-body">{message}</p>}
      {error && <p role="alert" className="t-body">{error}</p>}
    </section>
  );
}
