'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { humanizeContactLevel, scaleLevelName } from '@/src/lib/drillPresentation';
import { VOCABULARIES } from '@/src/server/pilot/contentImport/vocabularies';
import type { WorkoutTemplateItemWithDrillHead, WorkoutTemplateRow } from '@/src/server/pilot/workoutTemplates';

// THE TEMPLATE EDIT FORM (OD-2026-11-19-005, OW25-51; lane ED-UI PR2): PATCH /api/pilot/workout-templates writes
// the next version. Only changed fields are sent (OD-2026-11-15-011 ruling 2); items are edited in place (Q6 = A);
// a refusal names the field as labelled here (Q-PR1-1). Labels: the plan's words (Q5, Q6 = A).

type Template = WorkoutTemplateRow;
type Item = WorkoutTemplateItemWithDrillHead;

const TEXT = [
  { key: 'name', label: 'Name', max: 200 },
  { key: 'session_type', label: 'Session type', max: 200 },
  { key: 'age_band', label: 'Age group', max: 200 },
] as const;
type TextKey = (typeof TEXT)[number]['key'];

/** An item's editable parts, as the plan named them (Q6 = A). Order is the order on screen. */
const ITEM_FIELDS = [
  { key: 'block', label: 'Block' },
  { key: 'free_text_drill', label: 'Words' },
  { key: 'scale_level', label: 'Scale' },
  { key: 'duration_minutes', label: 'Minutes' },
  { key: 'rep_count', label: 'Reps' },
  { key: 'contact_level', label: 'Contact' },
  { key: 'coach_note', label: 'Note' },
] as const;
type ItemKey = (typeof ITEM_FIELDS)[number]['key'];
const NUMBER_ITEM_KEYS: readonly ItemKey[] = ['duration_minutes', 'rep_count'];

/** Every key this form can send beside template_id; the test runs them through the route's own parser. */
export const TEMPLATE_EDIT_FORM_KEYS = [
  ...TEXT.map((field) => field.key), 'difficulty', 'duration_minutes', 'intent', 'coach_notes', 'requires_coach_authorization', 'items',
] as const;

type ItemValues = Record<ItemKey, string>;
interface Values {
  text: Record<TextKey, string>;
  difficulty: string;
  duration: string;
  intent: string;
  coachNotes: string;
  requiresAuthorization: boolean;
  items: ItemValues[];
}

const asText = (value: string | number | null | undefined) => (value === null || value === undefined ? '' : String(value));
/** An item field as shown; Block as the page shows it (Overwatch, #2022). An untouched box equals this, so is never sent. */
const shown = (item: Item, key: ItemKey) => (key === 'block' ? item.block.replace(/_/g, ' ') : asText(item[key]));

function initialValues(template: Template, items: readonly Item[]): Values {
  return {
    text: { name: template.name ?? '', session_type: template.session_type ?? '', age_band: template.age_band ?? '' },
    difficulty: template.difficulty ?? '',
    duration: asText(template.duration_minutes),
    intent: template.intent ?? '',
    coachNotes: template.coach_notes ?? '',
    requiresAuthorization: Boolean(template.requires_coach_authorization),
    items: items.map((item) => Object.fromEntries(ITEM_FIELDS.map(({ key }) => [key, shown(item, key)])) as ItemValues),
  };
}

/** A whole number, null when empty, else sent as typed for the route to refuse (text boxes: type="number" reads a typo as empty). */
function numberOrNull(typed: string): number | null | string {
  const trimmed = typed.trim();
  if (trimmed === '') return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : typed;
}

/** The PATCH body's changed parts, or null when nothing changed. */
function changedParts(template: Template, items: readonly Item[], values: Values): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  for (const { key } of TEXT) if (values.text[key] !== (template[key] ?? '')) body[key] = values.text[key];
  if (values.difficulty !== (template.difficulty ?? '')) body.difficulty = values.difficulty;
  if (values.duration !== asText(template.duration_minutes)) body.duration_minutes = numberOrNull(values.duration);
  if (values.intent !== (template.intent ?? '')) body.intent = values.intent;
  if (values.coachNotes !== (template.coach_notes ?? '')) body.coach_notes = values.coachNotes === '' ? null : values.coachNotes;
  if (values.requiresAuthorization !== Boolean(template.requires_coach_authorization)) {
    body.requires_coach_authorization = values.requiresAuthorization;
  }
  // The route takes the whole ordered list: every item by its id, in order, with only its changed fields.
  const entries = items.map((item, index) => {
    const now = values.items[index];
    const changes = Object.fromEntries(ITEM_FIELDS.filter(({ key }) => now[key] !== shown(item, key)).map(({ key }) => {
      if (NUMBER_ITEM_KEYS.includes(key)) return [key, numberOrNull(now[key])];
      return [key, now[key] === '' && key !== 'block' && key !== 'contact_level' ? null : now[key]];
    }));
    return { changed: Object.keys(changes).length > 0, entry: { item_id: item.item_id, ...changes } };
  });
  if (entries.some((entry) => entry.changed)) body.items = entries.map((entry) => entry.entry);
  return Object.keys(body).length > 0 ? body : null;
}

const TOP_LABELS: Record<string, string> = {
  ...Object.fromEntries(TEXT.map(({ key, label }) => [key, label])),
  difficulty: 'Difficulty',
  duration_minutes: 'Minutes',
  intent: 'Intent',
  coach_notes: 'Coach notes',
  requires_coach_authorization: 'Coach authorization',
  items: 'The blocks',
};

/** A refusal in the form's words (Overwatch Q-PR1-1): "Missing <label>: ...", the rest of the server's sentence kept. */
function inFormWords(message: string, itemNames: readonly string[]): string {
  const match = /^(Missing|Unsupported) ([a-z_]+(?:\[\d+\]\.[a-z_]+)?): /.exec(message);
  if (!match) return message;
  const item = /^items\[(\d+)\]\.([a-z_]+)$/.exec(match[2]);
  const field = item ? ITEM_FIELDS.find(({ key }) => key === item[2]) : undefined;
  const label = item
    ? (field && itemNames[Number(item[1])] !== undefined ? `${itemNames[Number(item[1])]} ${field.label}` : null)
    : TOP_LABELS[match[2]] ?? null;
  return label ? `${match[1]} ${label}: ${message.slice(match[0].length)}` : message;
}

export type TemplateEditOutcome = { changed: false } | { changed: true; templateId: string; version: number };

// --bone-200, the design system's lift for .t-label on lit leather (OD-2026-10-02-010); inline, as .t-label is unlayered.
const LABEL = { className: 't-label', style: { color: 'var(--bone-200)' } } as const;
const SAVE_FAILED = 'The template could not be saved.';
// The drill form's words for the same two outcomes (DrillEditForm.tsx).
const SAVE_UNKNOWN = 'It is not known whether this change was saved.';
const NOTHING_CHANGED = 'Nothing was changed. This template is as it was.';

function optionsFor(list: readonly string[], current: string): string[] {
  return list.includes(current) ? [...list] : [current, ...list];
}

export default function TemplateEditForm({
  template,
  items,
  itemNames,
  onCancel,
  onSaved,
  onSaving,
  onFailed,
  busy,
}: {
  template: Template;
  items: readonly Item[];
  /** Each item's name as the page shows it, numbered by position ("2. Jab return"). */
  itemNames: readonly string[];
  onCancel: () => void;
  onSaved: (outcome: TemplateEditOutcome) => void;
  onSaving: () => void;
  /** A sent save failed: its status, or null when the outcome is not known. */
  onFailed: (status: number | null) => void;
  /** The page is still busy with this save's re-reads. */
  busy: boolean;
}) {
  const [values, setValues] = useState<Values>(() => initialValues(template, items));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  // A save with no known outcome may have written: no later refusal may then say nothing changed.
  const [earlierUnknown, setEarlierUnknown] = useState(false);
  const [stale, setStale] = useState(false);
  const savingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const alertRef = useRef<HTMLDivElement | null>(null);
  const id = (key: string) => `edit-template-${template.template_id}-${key}`;

  useEffect(() => { // Centred: the fields below show, clear of the sticky bar.
    headingRef.current?.focus({ preventScroll: true });
    headingRef.current?.scrollIntoView?.({ block: 'center' });
  }, []);
  useEffect(() => { // Save disables itself while it runs; focus goes to what went wrong, not the page.
    if (error) alertRef.current?.focus();
  }, [error]);

  async function save() {
    if (savingRef.current || busy) return;
    const body = changedParts(template, items, values);
    if (!body) {
      onSaved({ changed: false });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setUnknown(false);
    onSaving();
    let status: number | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/workout-templates`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_id: template.template_id, ...body }),
      });
      status = response.status;
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string; changed?: unknown; template_id?: unknown; version?: unknown;
      };
      if (!response.ok) throw new Error(payload.error ? inFormWords(payload.error, itemNames) : SAVE_FAILED);
      if (payload.changed === false) {
        onSaved({ changed: false });
      } else if (payload.changed === true && typeof payload.template_id === 'string' && typeof payload.version === 'number') {
        onSaved({ changed: true, templateId: payload.template_id, version: payload.version });
      } else {
        status = null;
        throw new Error(SAVE_FAILED);
      }
    } catch (failure) {
      const outcomeUnknown = status === null || status >= 500;
      setError(outcomeUnknown ? SAVE_UNKNOWN : (failure instanceof Error && failure.message) || SAVE_FAILED);
      setUnknown(outcomeUnknown);
      if (outcomeUnknown) setEarlierUnknown(true);
      setStale(status === 409);
      onFailed(status);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const setItem = (index: number, key: ItemKey, value: string) =>
    setValues((prev) => ({ ...prev, items: prev.items.map((item, at) => (at === index ? { ...item, [key]: value } : item)) }));
  const select = (fieldId: string, value: string, list: readonly string[], onChange: (value: string) => void, show: (value: string) => string, extra?: Record<string, string>) => (
    <select id={fieldId} {...extra} value={value} onChange={(event) => onChange(event.target.value)} className="select input--kiosk">
      {optionsFor(list, value).map((option) => <option key={option} value={option}>{show(option)}</option>)}
    </select>
  );

  return (
    // The page's own inset and kiosk floor, as the Issue control wears them (page.tsx IssueToAthlete).
    <section data-surface="kiosk" aria-labelledby={id('heading')} className="space-y-[var(--s4)] rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] bg-[rgba(0,0,0,.28)] p-[var(--s4)]">
      <h3 id={id('heading')} ref={headingRef} tabIndex={-1} className="t-command text-[length:var(--t-md)]">Edit {template.name}</h3>

      <fieldset disabled={saving || busy} className="min-w-0 space-y-[var(--s4)]">
        <div className="grid gap-[var(--s4)] md:grid-cols-2">
          {TEXT.map(({ key, label, max }) => (
            <div key={key} className="field">
              <label htmlFor={id(key)} {...LABEL}>{label}</label>
              <input id={id(key)} value={values.text[key]} onChange={(event) => setValues((prev) => ({ ...prev, text: { ...prev.text, [key]: event.target.value } }))} maxLength={max} className="input input--kiosk" />
            </div>
          ))}
          <div className="field">
            <label htmlFor={id('difficulty')} {...LABEL}>Difficulty</label>
            {select(id('difficulty'), values.difficulty, VOCABULARIES.difficulty.values, (value) => setValues((prev) => ({ ...prev, difficulty: value })), (value) => value)}
          </div>
          <div className="field">
            <label htmlFor={id('duration')} {...LABEL}>Minutes</label>
            <input id={id('duration')} type="text" inputMode="numeric" value={values.duration} onChange={(event) => setValues((prev) => ({ ...prev, duration: event.target.value }))} className="input input--kiosk" />
          </div>
          <div className="field">
            <label htmlFor={id('authorization')} {...LABEL}>Coach authorization</label>
            <select id={id('authorization')} value={values.requiresAuthorization ? 'required' : 'not_required'} onChange={(event) => setValues((prev) => ({ ...prev, requiresAuthorization: event.target.value === 'required' }))} className="select input--kiosk">
              <option value="required">Required</option>
              <option value="not_required">Not required</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={id('intent')} {...LABEL}>Intent</label>
          <textarea id={id('intent')} value={values.intent} onChange={(event) => setValues((prev) => ({ ...prev, intent: event.target.value }))} rows={3} maxLength={4000} className="textarea input--kiosk" />
        </div>
        <div className="field">
          <label htmlFor={id('notes')} {...LABEL}>Coach notes</label>
          <textarea id={id('notes')} value={values.coachNotes} onChange={(event) => setValues((prev) => ({ ...prev, coachNotes: event.target.value }))} rows={3} maxLength={4000} className="textarea input--kiosk" />
        </div>

        <fieldset className="min-w-0 space-y-[var(--s4)]">
          <legend className="t-command mb-[var(--s3)] text-[length:var(--t-md)]">The blocks</legend>
          {items.map((item, index) => (
            <fieldset key={item.item_id} className="min-w-0 rounded-[var(--r-md)] border border-[color:rgb(var(--brass-400-rgb)_/_.22)] p-[var(--s4)]">
              <legend id={id(`item-${index}`)} className="mb-[var(--s2)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">{itemNames[index]}</legend>
              <div className="grid gap-[var(--s4)] md:grid-cols-2">
                {ITEM_FIELDS.map(({ key, label }) => {
                  const fieldId = id(`item-${index}-${key}`);
                  const named = { 'aria-labelledby': `${id(`item-${index}`)} ${fieldId}-label` };
                  const value = values.items[index][key];
                  const onChange = (next: string) => setItem(index, key, next);
                  let control;
                  if (key === 'contact_level') {
                    control = select(fieldId, value, VOCABULARIES.contact_level.values, onChange, humanizeContactLevel, named);
                  } else if (key === 'scale_level') {
                    control = select(fieldId, value, ['', ...VOCABULARIES.scale_level.values], onChange, (level) => (level === '' ? 'None' : scaleLevelName(level)), named);
                  } else if (NUMBER_ITEM_KEYS.includes(key)) {
                    control = <input id={fieldId} {...named} type="text" inputMode="numeric" value={value} onChange={(event) => onChange(event.target.value)} className="input input--kiosk" />;
                  } else if (key === 'block') {
                    control = <input id={fieldId} {...named} value={value} onChange={(event) => onChange(event.target.value)} maxLength={200} className="input input--kiosk" />;
                  } else {
                    control = <textarea id={fieldId} {...named} value={value} onChange={(event) => onChange(event.target.value)} rows={2} maxLength={1000} className="textarea input--kiosk" />;
                  }
                  return (
                    <div key={key} className={key === 'free_text_drill' || key === 'coach_note' ? 'field md:col-span-2' : 'field'}>
                      <label id={`${fieldId}-label`} htmlFor={fieldId} {...LABEL}>{label}</label>
                      {control}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </fieldset>
      </fieldset>

      {error && (
        <div role="alert" ref={alertRef} tabIndex={-1} className="rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
          <p><span aria-hidden="true">▲</span> <span>{error}</span></p>
          {/* A 409 means the template changed meanwhile, so "as it was" would not be true. */}
          {!unknown && (earlierUnknown || !stale) && <p className="mt-[var(--s2)]">{earlierUnknown ? SAVE_UNKNOWN : NOTHING_CHANGED}</p>}
        </div>
      )}

      <div className="flex flex-wrap gap-[var(--s3)]">
        <button type="button" onClick={() => void save()} disabled={saving || busy} className="btn disabled:cursor-not-allowed disabled:opacity-60">
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving || busy} className="btn btn--ghost">Cancel</button>
      </div>
    </section>
  );
}
