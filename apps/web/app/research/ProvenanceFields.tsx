'use client';

// The optional provenance inputs of the General Research form (issue #345 R29),
// kept in one collapsed block so the common path (title, domain, DOI) stays
// short on a gym tablet. All optional; an empty value is not sent
// (researchProvenanceForm.ts builds the request). The boxing-specificity and
// protected-domain lists are the contract's own.

import {
  RESEARCH_BOXING_SPECIFICITY_VALUES,
  RESEARCH_PROTECTED_DOMAINS,
} from '@/src/shared/researchProvenance';
import {
  BOXING_SPECIFICITY_LABEL,
  PROTECTED_DOMAINS_LABEL,
  PROVENANCE_INPUTS,
  provenanceWords,
  type ProvenanceDraft,
} from './researchProvenanceForm';

export default function ProvenanceFields({
  draft,
  onChange,
  disabled,
  open,
  onOpenChange,
}: {
  draft: ProvenanceDraft;
  onChange: (next: ProvenanceDraft) => void;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <details className="md:col-span-2" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
      {/* PROPOSED copy: the block's name. */}
      <summary className="t-label flex min-h-[var(--tap)] cursor-pointer items-center">More provenance (optional)</summary>
      <div className="grid gap-[var(--s3)] pt-[var(--s3)] md:grid-cols-2">
        {PROVENANCE_INPUTS.map((input) => (
          <label key={input.draft} className="field">
            <span className="t-label">{input.label}</span>
            {input.multiline ? (
              <textarea
                className="textarea"
                rows={2}
                placeholder={input.hint}
                value={draft[input.draft]}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, [input.draft]: event.target.value })}
              />
            ) : (
              <input
                className="input"
                type={input.type ?? 'text'}
                inputMode={input.inputMode}
                value={draft[input.draft]}
                disabled={disabled}
                onChange={(event) => onChange({ ...draft, [input.draft]: event.target.value })}
              />
            )}
          </label>
        ))}
        <label className="field">
          <span className="t-label">{BOXING_SPECIFICITY_LABEL}</span>
          <select
            className="select"
            value={draft.boxingSpecificity}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, boxingSpecificity: event.target.value })}
          >
            <option value="">Not stated</option>
            {RESEARCH_BOXING_SPECIFICITY_VALUES.map((value) => (
              <option key={value} value={value}>{provenanceWords(value)}</option>
            ))}
          </select>
        </label>
        <fieldset className="md:col-span-2">
          <legend className="t-label">{PROTECTED_DOMAINS_LABEL}</legend>
          <div className="flex flex-wrap gap-x-[var(--s5)]">
            {RESEARCH_PROTECTED_DOMAINS.map((domain) => (
              <label
                key={domain}
                className="flex min-h-[var(--tap)] cursor-pointer items-center gap-[var(--s3)] t-body"
              >
                <input
                  type="checkbox"
                  className="h-5 w-5 accent-[var(--brass-500)]"
                  checked={draft.protectedDomains[domain] === true}
                  disabled={disabled}
                  onChange={(event) => onChange({
                    ...draft,
                    protectedDomains: { ...draft.protectedDomains, [domain]: event.target.checked },
                  })}
                />
                <span>{provenanceWords(domain)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </details>
  );
}
