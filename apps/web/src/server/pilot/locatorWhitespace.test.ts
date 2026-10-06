import fs from 'node:fs';
import path from 'node:path';

import { LOCATOR_WHITESPACE_CLASS, trimLocator } from './locatorWhitespace';

// CL-C1: the chunks route and the source-rights trigger must agree on what a
// blank locator is. The route uses String.prototype.trim; the trigger uses
// LOCATOR_WHITESPACE_CLASS. These tests hold the class to trim, and the
// migration to the class.
const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres_source_rights_migration.sql'),
  'utf8',
);

describe('LOCATOR_WHITESPACE_CLASS', () => {
  test('matches exactly the characters String.prototype.trim removes, across the whole BMP', () => {
    const inClass = new RegExp(`^[${LOCATOR_WHITESPACE_CLASS}]$`, 'u');
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCharCode(cp);
      if ((ch.trim() === '') !== inClass.test(ch)) mismatches.push(cp.toString(16));
    }
    expect(mismatches).toEqual([]);
  });

  test('the migration carries the class verbatim in every place it decides what a locator is', () => {
    const has = `~ '[^${LOCATOR_WHITESPACE_CLASS}]'`;
    const trim = `'^[${LOCATOR_WHITESPACE_CLASS}]+|[${LOCATOR_WHITESPACE_CLASS}]+$'`;
    // backfill + trigger reclassify (has), trigger refusal (!~), backfill + trigger trim.
    expect(MIGRATION.split(has).length - 1).toBe(3);
    expect(MIGRATION.split(`!${has}`).length - 1).toBe(1);
    expect(MIGRATION.split(trim).length - 1).toBe(2);
    // No locator decision is left on btrim of the metadata locator.
    expect(MIGRATION).not.toMatch(/btrim\([^)]*metadata->>'locator'/);
  });

  test('trimLocator: whitespace-only is blank; a real locator is kept, trimmed', () => {
    expect(trimLocator('\t\n\u00a0\u3000')).toBe('');
    expect(trimLocator('\u00a0p. 9\t')).toBe('p. 9');
  });
});
