import type { IdKind } from '../ids';
import {
  ACCOUNT_PLACEHOLDER,
  type ColumnSpec,
  EVIDENCE_LABELS,
  ORG_PLACEHOLDER,
  RECORD_STATUSES,
  type ReferenceTarget,
  STAGE_KEYS,
} from '../types';
import type { BoundName, VocabularyName } from '../vocabularies';

// Column builders the per-dataset specs share, so "organization_id" or
// "version" means the same thing in every file.

export function organizationColumn(): ColumnSpec {
  return {
    name: 'organization_id',
    role: 'placeholder',
    type: 'text',
    placeholder: ORG_PLACEHOLDER,
    description: 'The seed workflow (or the signed-in session) decides the organization.',
  };
}

export function createdByColumn(): ColumnSpec {
  return {
    name: 'created_by_account_id',
    role: 'placeholder',
    type: 'text',
    placeholder: ACCOUNT_PLACEHOLDER,
    description: 'The account that runs the load is recorded as the author.',
  };
}

export function lineageColumn(keyColumn: string): ColumnSpec {
  return {
    name: 'lineage_id',
    role: 'lineage',
    type: 'text',
    description: `In a package ${keyColumn} already is the lineage key.`,
  };
}

export function systemColumn(name: string, systemDefault: string, what: string): ColumnSpec {
  return {
    name,
    role: 'system',
    type: systemDefault === 'true' ? 'boolean' : 'text',
    systemDefault: systemDefault || undefined,
    description: `Decided by the tool: ${what}.`,
  };
}

interface Options {
  required?: boolean;
  blankDefault?: string;
  blankMeans?: string;
  label?: boolean;
}

export function text(name: string, description: string, options: Options = {}): ColumnSpec {
  return { name, role: 'content', type: 'text', description, ...options };
}

export function bool(name: string, description: string, options: Options = {}): ColumnSpec {
  return { name, role: 'content', type: 'boolean', description, ...options };
}

export function integer(name: string, description: string, options: Options & { bound?: BoundName } = {}): ColumnSpec {
  return { name, role: 'content', type: 'integer', description, ...options };
}

export function number(name: string, description: string, options: Options & { bound?: BoundName } = {}): ColumnSpec {
  return { name, role: 'content', type: 'number', description, ...options };
}

export function vocabulary(name: string, vocab: VocabularyName, description: string, options: Options = {}): ColumnSpec {
  return { name, role: 'content', type: 'text', vocabulary: vocab, description, ...options };
}

export function keyColumn(name: string, idKind: IdKind, description: string, allowNew: boolean): ColumnSpec {
  return { name, role: 'key', type: 'text', idKind, allowNew, required: true, description };
}

export function childIdColumn(name: string, idKind: IdKind, description: string): ColumnSpec {
  return { name, role: 'child_id', type: 'text', idKind, description };
}

export function parentColumn(name: string, target: 'drill' | 'template' | 'script', idKind: IdKind, description: string): ColumnSpec {
  return { name, role: 'parent', type: 'text', idKind, references: target, allowNew: true, required: true, description };
}

export function referenceColumn(
  name: string,
  target: ReferenceTarget,
  description: string,
  options: Options & { idKind?: IdKind; allowNew?: boolean; list?: '|' | ',' } = {},
): ColumnSpec {
  return { name, role: 'reference', type: 'text', references: target, description, ...options };
}

/**
 * The backbone's three label columns (SCHEMA_PROPOSAL P19, SP-11), on every
 * dataset's root file. Optional: a package without them loads as it did
 * before, and its items hash exactly as before (canonical.ts). Stored beside
 * the item, not in its table: pilot.content_record_labels (field_labels,
 * evidence, by item version) and pilot.content_stage_links (stage_keys, by
 * lineage), content_labels migration.
 */
export function labelColumns(): ColumnSpec[] {
  return [
    {
      name: 'field_labels',
      role: 'annotation',
      annotation: 'field_labels',
      type: 'text',
      description:
        'JSON object: per field, {"status": one of ' + RECORD_STATUSES.join(', ')
        + ', "sources": [source keys]} (backbone RULES section 10). A field may hold labels for its own parts the same way. '
        + 'Stored by item version.',
      blankMeans: 'no field labels. A file without this column leaves the stored field labels of each item as they are',
    },
    {
      name: 'evidence',
      role: 'annotation',
      annotation: 'evidence',
      type: 'text',
      description:
        'JSON object, or a JSON list of them: evidence_category, evidence_label (one of ' + EVIDENCE_LABELS.join(', ')
        + '), check_state, evidence_item_ids, registry_claim_ids, basis (backbone EVIDENCE_VOCABULARY). Other keys are kept as written. '
        + 'Stored by item version.',
      blankMeans: 'no evidence entry. A file without this column leaves the stored evidence of each item as it is',
    },
    {
      name: 'stage_keys',
      role: 'annotation',
      annotation: 'stage_keys',
      type: 'text',
      list: '|',
      description:
        'The pathway stages the item serves, separated by | (' + STAGE_KEYS.join(', ')
        + '). Stored by lineage; a link describes the map and never limits where a coach places a member or what a coach runs.',
      blankMeans: 'no stage links (current links are ended). A file without this column leaves the links of each item as they are',
    },
  ];
}
