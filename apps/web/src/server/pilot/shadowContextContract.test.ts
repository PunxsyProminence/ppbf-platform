// shadowContextContract.test.ts -- pulls the lever nobody pulled for #975.
//
// SHADOW_CONTEXT_CONTRACT_VERSION must move whenever the code that decides
// what goes into a job's `authorizedContext` moves (OD-2026-09-30-007
// section 2, S3 "A"). This hashes that code and fails until the version is
// bumped and the new hash appended. See the comment on the constant in
// shadowJobQueue.ts for why the version stays a number.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  SHADOW_CONTEXT_CONTRACT_FINGERPRINTS,
  SHADOW_CONTEXT_CONTRACT_SOURCES,
  SHADOW_CONTEXT_CONTRACT_VERSION,
} from './shadowJobQueue';

const WEB_ROOT = path.resolve(__dirname, '../../..');

// The recipe. Line endings are normalised so a Windows checkout and CI hash
// the same bytes; everything else, comments included, counts.
function fingerprintSources(sources: readonly string[], root = WEB_ROOT): string {
  const hash = createHash('sha256');
  for (const relative of [...sources].sort()) {
    const text = readFileSync(path.join(root, relative), 'utf8').replace(/\r\n/g, '\n');
    hash.update(`${relative}\n${text}\n`);
  }
  return hash.digest('hex');
}

function nonTestTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...nonTestTsFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('SHADOW context contract fingerprint', () => {
  it('lists real files, once each', () => {
    expect(new Set(SHADOW_CONTEXT_CONTRACT_SOURCES).size).toBe(SHADOW_CONTEXT_CONTRACT_SOURCES.length);
    for (const relative of SHADOW_CONTEXT_CONTRACT_SOURCES) {
      expect({ relative, exists: existsSync(path.join(WEB_ROOT, relative)) }).toEqual({ relative, exists: true });
    }
  });

  it('keeps one append-only entry per version, ending at the current version', () => {
    expect(typeof SHADOW_CONTEXT_CONTRACT_VERSION).toBe('number');
    const versions = SHADOW_CONTEXT_CONTRACT_FINGERPRINTS.map((entry) => entry.version);
    // Contiguous from 2, the first version that had a fingerprint.
    expect(versions).toEqual(versions.map((_, index) => index + 2));
    expect(versions[versions.length - 1]).toBe(SHADOW_CONTEXT_CONTRACT_VERSION);
  });

  it('matches the code: change a listed file and the version must move', () => {
    const actual = fingerprintSources(SHADOW_CONTEXT_CONTRACT_SOURCES);
    const recorded = SHADOW_CONTEXT_CONTRACT_FINGERPRINTS[SHADOW_CONTEXT_CONTRACT_FINGERPRINTS.length - 1];
    if (recorded?.sha256 !== actual) {
      throw new Error(
        'The code that builds SHADOW job context changed. In shadowJobQueue.ts: bump '
        + `SHADOW_CONTEXT_CONTRACT_VERSION to ${SHADOW_CONTEXT_CONTRACT_VERSION + 1} and append `
        + `{ version: ${SHADOW_CONTEXT_CONTRACT_VERSION + 1}, sha256: '${actual}' } to `
        + 'SHADOW_CONTEXT_CONTRACT_FINGERPRINTS. Do not edit the existing entry.',
      );
    }
  });

  it('covers every file that stamps a job with the contract version', () => {
    // A new enqueuer that carries authorizedContext without being listed would
    // change job context with no fingerprint watching it.
    const stampers = [...nonTestTsFiles(path.join(WEB_ROOT, 'app')), ...nonTestTsFiles(path.join(WEB_ROOT, 'src'))]
      .filter((file) => /contextContractVersion\s*:/.test(readFileSync(file, 'utf8')))
      .map((file) => path.relative(WEB_ROOT, file).split(path.sep).join('/'));
    expect(stampers.length).toBeGreaterThan(0);
    for (const stamper of stampers) {
      expect(SHADOW_CONTEXT_CONTRACT_SOURCES).toContain(stamper);
    }
  });
});
