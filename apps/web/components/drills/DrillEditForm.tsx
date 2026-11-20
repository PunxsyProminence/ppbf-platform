'use client';

import { useEffect, useRef, useState } from 'react';

import { apiBase } from '@/lib/apiBase';
import { breaksCueRule, cueRequiredMessage, isConditioningLabel } from '@/src/lib/drillCueRule';
import { humanizeContactLevel, scaleLevelName } from '@/src/lib/drillPresentation';
import { VOCABULARIES } from '@/src/server/pilot/contentImport/vocabularies';
import type { DRILL_TEXT_FIELDS } from '@/src/server/pilot/drillLibraryEdit';
import type { DrillWithDetail } from '@/src/server/pilot/drillLibraryV3';

// THE EDIT BUTTON'S FORM (OD-2026-11-19-005, OW25-51; lane ED-UI PR1): one
// library drill through PATCH /api/pilot/drill-library, which writes its next
// version (drillLibraryEdit.ts). Roles, bounds, vocabularies and the cue rule
// are the server's; a refusal is shown in its words. Only what changed is sent,
// so untouched text keeps its AI-draft label (OD-2026-11-15-011 ruling 2); a
// scale level or stop rule is edited, never added or removed, as the route
// allows. The drill's OWN stop rules sit in Safety (lane ED-UI PR1b), grouped
// as the drill page groups them; the gym's stored-once rules are not shown or
// sent (this route does not edit them). The one check before save is the cue
// rule (OD-2026-10-06-026 ruling 2), judged as the server judges it. Labels are
// the drill page's own words; the dark `mat-leather` panel is the Add a drill
// form's, so its ink is the one proven readable there.

type TextKey = (typeof DRILL_TEXT_FIELDS)[number];

/** The twelve long-text fields, in the order the drill reads (DrillDetail.tsx). */
const TEXT_FIELDS: readonly { key: TextKey; label: string; rows: number }[] = [
  { key: 'purpose', label: 'What it is for', rows: 2 },
  { key: 'standard_setup', label: 'Setup', rows: 2 },
  { key: 'equipment_needed', label: 'Equipment', rows: 1 },
  { key: 'execution', label: 'How it runs', rows: 5 },
  { key: 'what_good_looks_like', label: 'What good looks like', rows: 3 },
  { key: 'what_bad_looks_like', label: 'What to avoid', rows: 3 },
  { key: 'common_errors', label: 'Common errors', rows: 3 },
  { key: 'exit_condition', label: 'Exit condition', rows: 2 },
  { key: 'corrections', label: 'Corrections', rows: 3 },
  { key: 'correction_path', label: 'Correction path', rows: 2 },
  { key: 'target_behavior', label: 'Target behaviour', rows: 2 },
  { key: 'transfer', label: 'Transfer', rows: 2 },
];
const COACHING_NOTES: readonly TextKey[] = ['target_behavior', 'transfer'];

/** Every key this form can send beside drill_id; the test holds it to the route's editable keys. */
export const DRILL_EDIT_FORM_KEYS = [
  'name', 'category', 'difficulty', 'contact_level', 'requires_coach_authorization',
  ...TEXT_FIELDS.map((field) => field.key), 'cues', 'scale_levels', 'stop_rules',
] as const;

const SHORT_KEYS = ['name', 'category', 'difficulty', 'contact_level'] as const;
/** A scale level's editable parts, labelled as DrillDetail shows them ("Constraint:", "Watch for:", "Contact:"). */
const SCALE_FIELDS = [
  { key: 'demand_description', label: 'What it demands' },
  { key: 'constraint_applied', label: 'Constraint' },
  { key: 'coach_watch_point', label: 'Watch for' },
  { key: 'contact_level', label: 'Contact' },
] as const;
type ScaleKey = (typeof SCALE_FIELDS)[number]['key'];
type StopValues = { condition_text: string; rule_kind: string };

interface Values {
  name: string;
  category: string;
  difficulty: string;
  contact_level: string;
  requires_coach_authorization: boolean;
  text: Record<TextKey, string>;
  /** One cue per line. */
  cues: string;
  /** The cue box was typed in. Untouched, the cues are never sent, so their label is never at risk. */
  cuesEdited: boolean;
  /** By scale level ('A', 'B', 'C'). */
  scales: Record<string, Record<ScaleKey, string>>;
  /** The drill's own stop rules, by ordinal. */
  stops: Record<number, StopValues>;
}

function initialValues(drill: DrillWithDetail): Values {
  return {
    name: drill.name ?? '',
    category: drill.category ?? '',
    difficulty: drill.difficulty ?? '',
    contact_level: drill.contact_level ?? '',
    requires_coach_authorization: Boolean(drill.requires_coach_authorization),
    text: Object.fromEntries(TEXT_FIELDS.map(({ key }) => [key, drill[key] ?? ''])) as Record<TextKey, string>,
    // The order the drill shows them in (drillDetailView.ts fromCoachDrillDetail).
    cues: [...(drill.cues ?? [])]
      .sort((a, b) => a.cue_family.localeCompare(b.cue_family) || a.cue_text.localeCompare(b.cue_text))
      .map((cue) => cue.cue_text)
      .join('\n'),
    cuesEdited: false,
    scales: Object.fromEntries((drill.scale_levels ?? []).map((level) => [
      level.scale_level,
      Object.fromEntries(SCALE_FIELDS.map(({ key }) => [key, level[key] ?? ''])) as Record<ScaleKey, string>,
    ])),
    stops: Object.fromEntries((drill.stop_rules ?? []).map((rule) => [
      rule.ordinal, { condition_text: rule.condition_text ?? '', rule_kind: rule.rule_kind ?? '' },
    ])),
  };
}

/** A cue per non-blank line, repeats once: what the server keeps of a cue list. */
function cueLines(text: string): string[] {
  return [...new Set(text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0))];
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

/** The PATCH body's changed parts, or null when nothing changed. `cues` is set only when the cue list changed. */
function changedParts(drill: DrillWithDetail, values: Values): { body: Record<string, unknown>; cues?: string[] } | null {
  const body: Record<string, unknown> = {};
  for (const key of SHORT_KEYS) {
    if (values[key] !== (drill[key] ?? '')) body[key] = values[key];
  }
  if (values.requires_coach_authorization !== Boolean(drill.requires_coach_authorization)) {
    body.requires_coach_authorization = values.requires_coach_authorization;
  }
  for (const { key } of TEXT_FIELDS) {
    if (values.text[key] !== (drill[key] ?? '')) body[key] = values.text[key];
  }
  let cues: string[] | undefined;
  const lines = cueLines(values.cues);
  if (values.cuesEdited && !sameSet(lines, (drill.cues ?? []).map((cue) => cue.cue_text))) {
    cues = lines;
    body.cues = lines;
  }
  // A level or rule is sent with only its changed parts, so the server
  // relabels only those (drillLibraryEdit.ts compares part by part too).
  const scales: Record<string, Partial<Record<ScaleKey, string>>> = {};
  for (const level of drill.scale_levels ?? []) {
    const now = values.scales[level.scale_level];
    const changes = Object.fromEntries(SCALE_FIELDS.filter(({ key }) => now[key] !== (level[key] ?? '')).map(({ key }) => [key, now[key]]));
    if (Object.keys(changes).length > 0) scales[level.scale_level] = changes;
  }
  if (Object.keys(scales).length > 0) body.scale_levels = scales;
  const stops = (drill.stop_rules ?? []).flatMap((rule) => {
    const now = values.stops[rule.ordinal];
    const changes = Object.fromEntries((['condition_text', 'rule_kind'] as const)
      .filter((key) => now[key] !== (rule[key] ?? '')).map((key) => [key, now[key]]));
    return Object.keys(changes).length > 0 ? [{ ordinal: rule.ordinal, ...changes }] : [];
  });
  if (stops.length > 0) body.stop_rules = stops;
  return Object.keys(body).length > 0 ? { body, cues } : null;
}

export type DrillEditOutcome = { changed: false } | { changed: true; drillId: string; version: number };

const SAVE_FAILED = 'The drill could not be saved.';
// A fault or a dropped connection may have landed after the write committed,
// so it is said as unknown and nothing else (the page's OUTCOME_EXPLANATIONS
// 'unknown'); a refusal changed nothing ('refused'). Both are the page's words.
const SAVE_UNKNOWN = 'It is not known whether this change was saved.';
const NOTHING_CHANGED = 'Nothing was changed. This drill is as it was.';
// The route's bounds (drillLibraryEdit.ts MAX_SHORT_TEXT, MAX_LONG_TEXT; the
// test holds them equal), so a field cannot be typed past what it refuses.
const MAX_SHORT = 200;
const MAX_LONG = 4000;
const MAX_STOP_RULE = 1000;
/** The stop-rule kind DrillDetail lists under "Before contact or maximal effort" rather than as a stop. */
const READINESS_KIND = 'warmup_decay';
/** A sub-group's name inside Safety or Scaling: bold bone ink, so it reads apart from the labels under it. */
const SUBGROUP = 'mb-[var(--s2)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]';

/** The vocabulary, with the drill's current value first when the list does not hold it, so an untouched select changes nothing. */
function optionsFor(list: readonly string[], current: string): string[] {
  return list.includes(current) ? [...list] : [current, ...list];
}

export default function DrillEditForm({
  drill,
  onCancel,
  onSaved,
  onSaving,
  onFailed,
  busy,
}: {
  drill: DrillWithDetail;
  /** The page is still busy with this save's re-reads: nothing here may start or leave until they end. */
  busy: boolean;
  onCancel: () => void;
  /** Called once the server has answered a save, or when nothing changed. */
  onSaved: (outcome: DrillEditOutcome) => void;
  /** A save was sent: the page is busy until onSaved or onFailed has run its re-reads. */
  onSaving: () => void;
  /** A sent save failed: the response status, or null when the outcome is not known (no answer, or an answer that says nothing). */
  onFailed: (status: number | null) => void;
}) {
  const [values, setValues] = useState<Values>(() => initialValues(drill));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false);
  const savingRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const id = (key: string) => `edit-drill-${drill.drill_id}-${key}`;

  // The detail this form replaced took its focus with it.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  async function save() {
    if (savingRef.current || busy) return;
    const parts = changedParts(drill, values);
    if (!parts) {
      onSaved({ changed: false });
      return;
    }
    if (parts.cues && breaksCueRule({ conditioning: isConditioningLabel(drill.discipline), cues: parts.cues })) {
      setError(cueRequiredMessage(values.name));
      setUnknown(false);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setUnknown(false);
    onSaving();
    let status: number | null = null;
    try {
      const response = await fetch(`${apiBase()}/api/pilot/drill-library`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drill_id: drill.drill_id, ...parts.body }),
      });
      status = response.status;
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string; changed?: unknown; drill_id?: unknown; version?: unknown;
      };
      if (!response.ok) throw new Error(payload.error || SAVE_FAILED);
      if (payload.changed === false) {
        onSaved({ changed: false });
      } else if (payload.changed === true && typeof payload.drill_id === 'string' && typeof payload.version === 'number') {
        onSaved({ changed: true, drillId: payload.drill_id, version: payload.version });
      } else {
        // A 2xx that does not say what it wrote: what happened is not known.
        status = null;
        throw new Error(SAVE_FAILED);
      }
    } catch (failure) {
      const outcomeUnknown = status === null || status >= 500;
      setError(outcomeUnknown ? SAVE_UNKNOWN : (failure instanceof Error && failure.message) || SAVE_FAILED);
      setUnknown(outcomeUnknown);
      onFailed(status);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const set = <K extends keyof Values>(key: K, value: Values[K]) => setValues((prev) => ({ ...prev, [key]: value }));
  const setText = (key: TextKey, value: string) => setValues((prev) => ({ ...prev, text: { ...prev.text, [key]: value } }));
  const setScale = (level: string, key: ScaleKey, value: string) =>
    setValues((prev) => ({ ...prev, scales: { ...prev.scales, [level]: { ...prev.scales[level], [key]: value } } }));
  const setStop = (ordinal: number, key: keyof StopValues, value: string) =>
    setValues((prev) => ({ ...prev, stops: { ...prev.stops, [ordinal]: { ...prev.stops[ordinal], [key]: value } } }));
  // The drill's own rules only (never universal_stop_rules: both number from
  // 1, and the state is keyed by ordinal). Grouped as DrillDetail groups them,
  // by the STORED kind so a rule does not jump while its kind is changed: a
  // readiness rule (warmup_decay) is "Before contact or maximal effort", not a
  // stop rule, and each group is numbered by position, as the page lists it.
  const ownStops = [...(drill.stop_rules ?? [])].sort((a, b) => a.ordinal - b.ordinal);
  const stopGroups = [
    { heading: 'Stop rules', item: 'Stop rule', rules: ownStops.filter((rule) => rule.rule_kind !== READINESS_KIND) },
    { heading: 'Before contact or maximal effort', item: 'Before contact or maximal effort', rules: ownStops.filter((rule) => rule.rule_kind === READINESS_KIND) },
  ].filter((group) => group.rules.length > 0);
  const levels = [...(drill.scale_levels ?? [])].sort((a, b) => a.scale_level.localeCompare(b.scale_level));
  const textArea = ({ key, label, rows }: (typeof TEXT_FIELDS)[number]) => (
    <div key={key} className="field">
      <label htmlFor={id(key)} className="t-label">{label}</label>
      <textarea id={id(key)} value={values.text[key]} onChange={(event) => setText(key, event.target.value)} rows={rows} maxLength={MAX_LONG} className="textarea input--kiosk" />
    </div>
  );

  return (
    <section aria-labelledby={id('heading')} className="mat-leather space-y-[var(--s4)] rounded-[var(--r-lg)] p-[var(--s5)]">
      <h2 id={id('heading')} ref={headingRef} tabIndex={-1} className="t-command text-[length:var(--t-lg)]">Edit {drill.name}</h2>

      {/* Nothing can be typed while a save runs: it would not be in the save. */}
      <fieldset disabled={saving || busy} className="min-w-0 space-y-[var(--s4)]">
      <div className="grid gap-[var(--s4)] md:grid-cols-2">
        <div className="field">
          <label htmlFor={id('name')} className="t-label">Name</label>
          <input id={id('name')} value={values.name} onChange={(event) => set('name', event.target.value)} maxLength={MAX_SHORT} className="input input--kiosk" />
        </div>
        <div className="field">
          <label htmlFor={id('category')} className="t-label">Category</label>
          <input id={id('category')} value={values.category} onChange={(event) => set('category', event.target.value)} maxLength={MAX_SHORT} className="input input--kiosk" />
        </div>
        <div className="field">
          <label htmlFor={id('difficulty')} className="t-label">Difficulty</label>
          <select id={id('difficulty')} value={values.difficulty} onChange={(event) => set('difficulty', event.target.value)} className="select input--kiosk">
            {optionsFor(VOCABULARIES.difficulty.values, values.difficulty).map((level) => <option key={level} value={level}>{level}</option>)}
          </select>
        </div>
      </div>

      <fieldset className="min-w-0">
        <legend className="t-command mb-[var(--s3)] text-[length:var(--t-md)]">Safety</legend>
        <div className="grid gap-[var(--s4)] md:grid-cols-2">
          <div className="field">
            <label htmlFor={id('contact_level')} className="t-label">Contact</label>
            <select id={id('contact_level')} value={values.contact_level} onChange={(event) => set('contact_level', event.target.value)} className="select input--kiosk">
              {optionsFor(VOCABULARIES.contact_level.values, values.contact_level).map((level) => (
                <option key={level} value={level}>{humanizeContactLevel(level)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={id('requires_coach_authorization')} className="t-label">Coach authorization</label>
            <select
              id={id('requires_coach_authorization')}
              value={values.requires_coach_authorization ? 'required' : 'not_required'}
              onChange={(event) => set('requires_coach_authorization', event.target.value === 'required')}
              className="select input--kiosk"
            >
              <option value="required">Required</option>
              <option value="not_required">Not required</option>
            </select>
          </div>
        </div>
        {stopGroups.map((group) => (
          <fieldset key={group.heading} className="mt-[var(--s4)] min-w-0">
            <legend className={SUBGROUP}>{group.heading}</legend>
            {group.rules.map((rule, index) => {
              const name = `${group.item}${group.rules.length > 1 || group.item === 'Stop rule' ? ` ${index + 1}` : ''}`;
              return (
                <div key={rule.ordinal} className="mt-[var(--s3)] grid gap-[var(--s4)] md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <div className="field">
                    <label htmlFor={id(`stop-${rule.ordinal}`)} className="t-label">{name}</label>
                    <textarea id={id(`stop-${rule.ordinal}`)} value={values.stops[rule.ordinal].condition_text} onChange={(event) => setStop(rule.ordinal, 'condition_text', event.target.value)} rows={2} maxLength={MAX_STOP_RULE} className="textarea input--kiosk" />
                  </div>
                  <div className="field">
                    <label htmlFor={id(`stop-${rule.ordinal}-kind`)} className="t-label">{name}: kind</label>
                    <select id={id(`stop-${rule.ordinal}-kind`)} value={values.stops[rule.ordinal].rule_kind} onChange={(event) => setStop(rule.ordinal, 'rule_kind', event.target.value)} className="select input--kiosk">
                      {optionsFor(VOCABULARIES.stop_rule_kind.values, values.stops[rule.ordinal].rule_kind).map((kind) => (
                        <option key={kind} value={kind}>{kind.replace(/_/g, ' ')}</option>
                      ))}
                    </select>
                  </div>
                </div>
              );
            })}
          </fieldset>
        ))}
      </fieldset>

      {TEXT_FIELDS.filter(({ key }) => !COACHING_NOTES.includes(key)).map(textArea)}

      <div className="field">
        <label htmlFor={id('cues')} className="t-label">Coaching cues, one per line</label>
        <textarea id={id('cues')} value={values.cues} onChange={(event) => setValues((prev) => ({ ...prev, cues: event.target.value, cuesEdited: true }))} rows={4} className="textarea input--kiosk" />
      </div>

      {levels.length > 0 && (
        <fieldset className="min-w-0 space-y-[var(--s4)]">
          <legend className="t-command mb-[var(--s3)] text-[length:var(--t-md)]">Scaling</legend>
          {levels.map(({ scale_level: level, is_starting_point: start }) => (
            <fieldset key={level} className="min-w-0 pt-[var(--s4)]">
              {/* "where to start" is DrillDetail's own marker; outside the id, so field names stay "Standard (B) Constraint". */}
              <legend className={SUBGROUP}><span id={id(`scale-${level}`)}>{scaleLevelName(level)}</span>{start ? ' · where to start' : ''}</legend>
              <div className="grid gap-[var(--s4)] md:grid-cols-2">
                {SCALE_FIELDS.map(({ key, label }) => {
                  const fieldId = id(`scale-${level}-${key}`);
                  // Named with its level ("Standard (B) Constraint"): four such fields per level.
                  const named = { id: fieldId, 'aria-labelledby': `${id(`scale-${level}`)} ${fieldId}-label` };
                  return (
                    <div key={key} className={key === 'demand_description' ? 'field md:col-span-2' : 'field'}>
                      <label id={`${fieldId}-label`} htmlFor={fieldId} className="t-label">{label}</label>
                      {key === 'contact_level' ? (
                        <select {...named} value={values.scales[level][key]} onChange={(event) => setScale(level, key, event.target.value)} className="select input--kiosk">
                          {optionsFor(VOCABULARIES.contact_level.values, values.scales[level][key]).map((contact) => (
                            <option key={contact} value={contact}>{humanizeContactLevel(contact)}</option>
                          ))}
                        </select>
                      ) : (
                        <textarea {...named} value={values.scales[level][key]} onChange={(event) => setScale(level, key, event.target.value)} rows={key === 'demand_description' ? 4 : 2} maxLength={MAX_LONG} className="textarea input--kiosk" />
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </fieldset>
      )}

      <fieldset className="min-w-0 space-y-[var(--s3)]">
        <legend className="t-command mb-[var(--s3)] text-[length:var(--t-md)]">Coaching notes</legend>
        {TEXT_FIELDS.filter(({ key }) => COACHING_NOTES.includes(key)).map(textArea)}
      </fieldset>
      </fieldset>

      {error && (
        <div role="alert" className="rounded-[var(--r-md)] border-2 border-[color:var(--brass-300)] bg-[rgba(0,0,0,.28)] px-[var(--s3)] py-[var(--s3)] text-[length:var(--t-md)] font-semibold text-[color:var(--bone-100)]">
          <p><span aria-hidden="true">▲</span> <span>{error}</span></p>
          {!unknown && <p className="mt-[var(--s2)]">{NOTHING_CHANGED}</p>}
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
