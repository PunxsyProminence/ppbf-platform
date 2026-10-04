import fs from 'node:fs';
import path from 'node:path';

import { FAMILY_MEMBER_CODES, UNMAPPED_SKILL_CODES } from '../skillFamilies';
import { readCsv } from './csv';
import { committedPath, FILE_SPECS } from './specs';
import type { ParsedFile, ParsedPackage, ReferenceSets } from './types';
import { parseFile } from './validate';
import { integerText, isIntegerText } from './values';

// WHAT A PACKAGE IS CHECKED AGAINST, WHEN THERE IS NO DATABASE.
//
// The offline reference sets come from committed files only, so `npm run
// content:validate` needs no connection string and no environment:
//   - research claim ids from the LOADED research package: the one
//     import-shadow-research.mjs:16 imports (2026-08-07), read from each
//     chunk's metadata claim_id. The 2026-08-08 registry is NOT loaded, so a
//     drill citing a claim that exists only there would point at nothing.
//   - SK codes from skillFamilies.ts (mapped and explicitly unmapped)
//   - disciplines, level ordinals, drills, templates, scripts and blocks from
//     the committed seed CSVs
// The plan stage (IMP-06) builds the same ReferenceSets from the database.

/** Relative to apps/web/seed-data. */
export const LOADED_RESEARCH_CHUNKS = 'shadow-research/2026-08-07/seed_shadow_library_chunks.csv';

/** Claim ids in the loaded research package, from each chunk's metadata. */
export function claimIdsFromChunksCsv(text: string): Set<string> {
  const table = readCsv(text);
  const metadataIndex = table.header.indexOf('metadata');
  if (metadataIndex < 0) throw new Error('research chunks file has no metadata column');
  const ids = new Set<string>();
  for (const record of table.records) {
    const raw = record.cells[metadataIndex];
    if (!raw) continue;
    const claimId = (JSON.parse(raw) as { claim_id?: unknown }).claim_id;
    if (typeof claimId === 'string' && claimId) ids.add(claimId);
  }
  return ids;
}

/** Every SK code skillFamilies.ts accounts for. */
export function skillCodesFromSkillFamilies(): Set<string> {
  return new Set([...Object.values(FAMILY_MEMBER_CODES).flatMap((codes) => [...(codes ?? [])]), ...UNMAPPED_SKILL_CODES]);
}

function rowsOf(baseline: ParsedPackage, file: string): ParsedFile['rows'] {
  return baseline.files.find((f) => f.spec.file === file)?.rows ?? [];
}

/** The committed-content half of the reference sets. Pure. */
export function referenceSetsFromBaseline(
  baseline: ParsedPackage,
  extra: { claimIds: ReadonlySet<string>; skillCodes: ReadonlySet<string> },
): ReferenceSets {
  return {
    claimIds: extra.claimIds,
    skillCodes: extra.skillCodes,
    disciplines: new Set(rowsOf(baseline, 'seed_disciplines.csv').map((row) => row.values.discipline)),
    levelOrdinals: new Set(
      rowsOf(baseline, 'seed_competence_levels.csv')
        .map((row) => row.values.ordinal)
        .filter(isIntegerText)
        .map((value) => Number(integerText(value))),
    ),
    drills: new Map(
      rowsOf(baseline, 'seed_drill_library.csv').map((row) => [
        row.values.drill_id,
        {
          discipline: row.values.discipline,
          name: row.values.name,
          skillId: row.values.skill_id,
          // The committed seed writes booleans as True/False (specs/drills.ts,
          // the active column). Only an explicit false is withdrawn: a blank
          // or missing cell is the column's default (active), never a refusal.
          active: (row.values.active ?? '').trim().toLowerCase() !== 'false',
          // Required on a drill row (specs/drills.ts); the column's database
          // default is 'none' (drill_library_v3 :107), so a blank reads as that.
          contactLevel: row.values.contact_level || 'none',
        },
      ]),
    ),
    templates: new Set(rowsOf(baseline, 'seed_workout_templates.csv').map((row) => row.values.template_id)),
    scripts: new Set(rowsOf(baseline, 'seed_session_scripts.csv').map((row) => row.values.script_id)),
    blocks: new Set(rowsOf(baseline, 'seed_session_script_blocks.csv').map((row) => row.values.block_id)),
  };
}

// ---------------------------------------------------------------------------
// Disk. Only the CLI and the tests call these; the core above never reads files.

/** Every committed seed CSV the contract knows, parsed. Missing files are simply absent. */
export function readCommittedBaseline(seedDataDir: string): ParsedPackage {
  const files: ParsedFile[] = [];
  for (const spec of FILE_SPECS) {
    const relative = committedPath(spec);
    const absolute = path.join(seedDataDir, relative);
    if (!fs.existsSync(absolute)) continue;
    const { file, findings } = parseFile(relative, spec, fs.readFileSync(absolute, 'utf8'));
    // A committed file the parser cannot read would make every later check
    // meaningless; the fast guard reports such a file itself, so stop here.
    const unreadable = findings.filter((f) => f.code === 'csv_unreadable' || f.code === 'column_count');
    if (unreadable.length > 0) {
      throw new Error(`committed ${relative} is unreadable: ${unreadable.map((f) => f.message).join('; ')}`);
    }
    files.push(file);
  }
  return { files };
}

export function loadOfflineReferenceSets(seedDataDir: string, baseline: ParsedPackage = readCommittedBaseline(seedDataDir)): ReferenceSets {
  const chunks = fs.readFileSync(path.join(seedDataDir, LOADED_RESEARCH_CHUNKS), 'utf8');
  return referenceSetsFromBaseline(baseline, {
    claimIds: claimIdsFromChunksCsv(chunks),
    skillCodes: skillCodesFromSkillFamilies(),
  });
}
