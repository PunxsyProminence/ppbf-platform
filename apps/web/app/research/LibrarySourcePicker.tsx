'use client';

import { useId, useMemo, useState } from 'react';
import { formatIntakeCount } from '@/src/client/libraryTextIntake';

/* RINT-05b: choosing one registered source out of about a thousand.

   A plain select of 1,000 titles cannot be searched by eye, so a filter box
   narrows it by title as the curator types. The list it filters is the one the
   page loaded (up to LIBRARY_SOURCE_PICKER_CAP newest sources on the shelf in
   view); when the shelf holds more than that, the picker says so rather than
   letting a missing title look absent. Searching on the server is the upgrade
   if a shelf outgrows the cap: the sources route has no text search today. */

// The most sources the page loads for the picker: five pages of the sources
// route's 200-row maximum.
export const LIBRARY_SOURCE_PICKER_CAP = 1_000;

export interface LibrarySourcePickerOption {
  source_id: string;
  title: string;
  source_type?: string;
}

interface Props {
  readonly sources: readonly LibrarySourcePickerOption[];
  readonly value: string;
  readonly onChange: (sourceId: string) => void;
  readonly label: string;
  readonly placeholder: string;
  readonly disabled?: boolean;
  // True when the shelf holds more sources than were loaded.
  readonly truncated?: boolean;
  readonly showType?: boolean;
  readonly labelClassName?: string;
}

export function filterLibrarySources<T extends LibrarySourcePickerOption>(
  sources: readonly T[],
  query: string,
): T[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...sources];
  return sources.filter((source) => source.title.toLowerCase().includes(wanted));
}

export default function LibrarySourcePicker({
  sources, value, onChange, label, placeholder, disabled = false, truncated = false, showType = false,
  labelClassName = 't-label',
}: Props) {
  const [query, setQuery] = useState('');
  const filterId = useId();

  const shown = useMemo(() => {
    const matches = filterLibrarySources(sources, query);
    // The chosen source stays in the list even when the filter no longer
    // matches it, so the select never silently shows a different choice.
    if (value && !matches.some((source) => source.source_id === value)) {
      const chosen = sources.find((source) => source.source_id === value);
      if (chosen) matches.unshift(chosen);
    }
    return matches;
  }, [sources, query, value]);

  const matchCount = query.trim() ? filterLibrarySources(sources, query).length : sources.length;

  return (
    <div className="space-y-[var(--s2)]">
      <label className="field" htmlFor={filterId}>
        <span className={labelClassName}>Find a source by title</span>
        <input id={filterId} type="search" className="input" value={query} disabled={disabled}
          aria-label={`Find a source by title (${label})`}
          placeholder="Type part of the title"
          onChange={(event) => setQuery(event.target.value)} />
      </label>
      <label className="field">
        <span className={labelClassName}>{label}</span>
        <select aria-label={label} className="select" value={value} disabled={disabled}
          onChange={(event) => onChange(event.target.value)}>
          <option value="">{placeholder}</option>
          {shown.map((source) => (
            <option key={source.source_id} value={source.source_id}>
              {showType && source.source_type ? `${source.title} (${source.source_type})` : source.title}
            </option>
          ))}
        </select>
      </label>
      <p className="t-muted" aria-live="polite">
        {query.trim()
          ? `${formatIntakeCount(matchCount)} of ${formatIntakeCount(sources.length)} sources match.`
          : `${formatIntakeCount(sources.length)} sources.`}
        {truncated
          ? ` Only the newest ${formatIntakeCount(sources.length)} are listed; an older source will not appear here.`
          : ''}
      </p>
    </div>
  );
}
