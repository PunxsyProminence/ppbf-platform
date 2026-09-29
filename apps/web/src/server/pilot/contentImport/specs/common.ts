import type { IdKind } from '../ids';
import {
  ACCOUNT_PLACEHOLDER,
  type ColumnSpec,
  ORG_PLACEHOLDER,
  type ReferenceTarget,
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
