import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readCsv, writeCsv } from './csv';
import { inAppEditLabel, writeItemLabels } from './datasets/contentLabels';
import { findInAppEditLabels, heldReason, IN_APP_EDIT_SOURCE, isInAppEditLabel } from './inAppEdits';
import { loadOfflineReferenceSets } from './referenceSets';
import { validatePackage } from './validate';

/*
  LANE IG, without a database: how an in-app edit's label is recognised, that a
  package may not claim one (in_app_edit_label), and that the label writer
  refuses one outright. contentImportInAppEdits.pg.test.ts is the database half
  (held items, the rest of the package, dry run, plan hash).
*/

const SEED_DATA = path.resolve(__dirname, '../../../../seed-data');
const TEMPLATES_CSV = 'workout-templates/seed_workout_templates.csv';
const DRAFT = { status: 'INFERRED', draft: 'AI draft, lane test', sources: ['DOC-1'] };
const EDIT = inAppEditLabel({ accountId: 'acct-coach', role: 'coach', at: '2026-11-19T12:00:00.000Z' });

describe('recognising an in-app edit label', () => {
  it('knows the label the edit paths write, and nothing else', () => {
    expect(isInAppEditLabel(EDIT)).toBe(true);
    expect(isInAppEditLabel({ status: 'REPORTED', sources: [IN_APP_EDIT_SOURCE] })).toBe(true);
    expect(isInAppEditLabel(DRAFT)).toBe(false);
    expect(isInAppEditLabel({ status: 'OBSERVED', sources: ['DOC-1'] })).toBe(false);
    // An editor record on an AI draft is not an in-app edit.
    expect(isInAppEditLabel({ ...DRAFT, edited: { by_role: 'coach' } })).toBe(false);
    expect(isInAppEditLabel('In-app edit')).toBe(false);
  });

  it('finds it on a field, on a part of a field, and in JSON text', () => {
    const labels = {
      purpose: EDIT,
      execution: DRAFT,
      scale_levels: { ...DRAFT, A: { status: 'INFERRED', sources: [] }, B: EDIT },
    };
    expect(findInAppEditLabels(labels).map((found) => found.path)).toEqual(['purpose', 'scale_levels.B']);
    expect(findInAppEditLabels(JSON.stringify(labels)).map((found) => found.path)).toEqual(['purpose', 'scale_levels.B']);
    expect(findInAppEditLabels({ purpose: DRAFT })).toEqual([]);
    expect(findInAppEditLabels('')).toEqual([]);
    expect(findInAppEditLabels('not json')).toEqual([]);
    expect(findInAppEditLabels(undefined)).toEqual([]);
  });

  it('says what was kept, by whom and when, without an account id', () => {
    const reason = heldReason(3, { path: 'purpose', role: 'coach', date: '2026-11-19' });
    expect(reason).toBe(
      "kept: its current version v3 holds an in-app edit (purpose) by coach, 2026-11-19; the package's version was not loaded. "
      + "The coach's version stays in use and is held on every later plan; a coach who wants the package's text enters it in the app.",
    );
    expect(reason).not.toContain('acct-');
  });
});

describe('a package may not claim an in-app edit', () => {
  const committed = readFileSync(path.join(SEED_DATA, TEMPLATES_CSV), 'utf8');
  const references = loadOfflineReferenceSets(SEED_DATA);

  function withFirstTemplateLabels(fieldLabels: unknown): string {
    const table = readCsv(committed);
    const column = table.header.indexOf('field_labels');
    const rows = table.records.map((record, index) => {
      const cells = [...record.cells];
      if (index === 0) cells[column] = JSON.stringify(fieldLabels);
      return cells;
    });
    return writeCsv(table.header, rows);
  }

  it('refuses the label the app writes, by name, and accepts an AI draft label', () => {
    const forged = validatePackage([{ path: TEMPLATES_CSV, text: withFirstTemplateLabels({ intent: EDIT }) }], { references });
    const findings = forged.blocking.filter((finding) => finding.code === 'in_app_edit_label');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: TEMPLATES_CSV, line: 2, column: 'field_labels' });
    expect(findings[0].message).toContain('field_labels intent claims an in-app edit');

    const drafted = validatePackage([{ path: TEMPLATES_CSV, text: withFirstTemplateLabels({ intent: DRAFT }) }], { references });
    expect(drafted.blocking.filter((finding) => finding.code === 'in_app_edit_label')).toEqual([]);
  });
});

describe('the label writer never writes an in-app edit label', () => {
  it('throws before any query, so the import rolls back', async () => {
    const query = jest.fn();
    const ctx = { client: { query }, organizationId: 'org-ig', actor: { accountId: 'acct-import', role: 'organization_admin' } };
    await expect(writeItemLabels(
      ctx as never,
      'drill-library',
      'imp_test',
      [{ lineage: 'drl_x', version: 3, cells: { field_labels: JSON.stringify({ purpose: EDIT, execution: DRAFT }) } }],
      { inserted: [], updated: [], ledgerRows: 0 },
    )).rejects.toThrow(/refusing to write an "In-app edit" label \(purpose\) onto drill-library drl_x v3/);
    expect(query).not.toHaveBeenCalled();
  });
});
