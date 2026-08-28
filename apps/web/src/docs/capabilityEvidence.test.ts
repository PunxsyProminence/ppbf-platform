import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * A CAPABILITY THAT SAYS "DONE" MUST BE ABLE TO SHOW YOU SOMETHING.
 *
 * Owner direction: "we will want to add more capabilities later and will need
 * proof that these exist". This is that proof, or rather the guard that stops
 * the absence of it going unnoticed.
 *
 * WHAT WAS FOUND WHEN THIS WAS WRITTEN (2026-08-28), by reading all 201 module
 * files rather than by sampling:
 *
 *   - 94 of 201 modules claim DONE, and 59 of those 94 cite NOTHING checkable.
 *   - Only 37 of 201 cite ANY concrete path into the codebase.
 *   - expanded-200-index.json says 2 modules are DONE and 198 are DRAFT, and
 *     therefore disagrees with the markdown on 91 modules.
 *
 * So the catalogue had two trackers contradicting each other on nearly half its
 * entries, and the majority of its DONE claims rested on prose -- "gate states
 * + persist + block one participation path" -- which nobody can check.
 *
 * WHAT DONE ACTUALLY MEANS HERE, AND WHY THAT IS NOT A CRITICISM. Reading the
 * audit logs, DONE was recorded by tracker WAVES: "Wave 6 batch DONE in
 * tracker". It is an honest record of a planning decision. It was never a claim
 * that a route exists, that a human signed anything off, or that production
 * runs it -- `Active` is false on all 201, and 47 carry
 * ManualVerification -- signed off in one blanket owner decision on 2026-08-28,
 * which each of those modules records as a blanket decision rather than as 47
 * inspections. The defect is not that the waves lied;
 * it is that a reader cannot tell a wave-marking from a shipped slice, and the
 * word DONE invites the second reading.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS GUARD ENFORCES
 *
 * 1. A CITED PATH MUST EXIST. No tolerance, no ceiling. If a module names
 *    `apps/web/src/server/pilot/intake.ts`, that file is either there or the
 *    module is making a false statement about this repository. This is the
 *    half that can catch a capability quietly deleted underneath its own
 *    documentation.
 *
 * 2. UNEVIDENCED `DONE` IS CAPPED, NOT BANNED. Existing debt passes: the
 *    ceiling is measured below, at today's count. One MORE unevidenced DONE
 *    fails the run and names the module. Same shape as
 *    legacyVisualVocabulary.test.ts -- tolerate what is there, refuse growth --
 *    because retro-evidencing 54 modules is a body of work, not a line edit,
 *    and blocking the suite until it is done would just get the guard deleted.
 *
 * 3. THE TWO TRACKERS MAY NOT DRIFT FURTHER APART. Also a measured ceiling.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide whether a capability
 * WORKS. A cited file existing is not a working feature, and this guard never
 * says it is -- that is what ManualVerification and a human on a deployed URL
 * are for. It only refuses the two failures a machine can actually see: a
 * citation pointing at nothing, and the unevidenced pile growing.
 */

const REPO = path.resolve(__dirname, '../../../..');
const MODULE_DIR = path.join(REPO, 'docs/capabilities/modules');
const INDEX_FILE = path.join(REPO, 'docs/capabilities/expanded-200-index.json');

/**
 * Measured 2026-08-28 by running this file against the catalogue as it stood.
 * These are floors-to-not-exceed, not targets. Lowering one as modules get
 * evidenced is the point; raising one is an admission that has to be argued
 * for in the same change.
 */
const CEILING_UNEVIDENCED_DONE = 59;
const CEILING_TRACKER_DISAGREEMENTS = 91;

interface Module {
  file: string;
  id: number | null;
  status: string | null;
  manualVerification: string | null;
  claimsDone: boolean;
  citations: string[];
}

/**
 * A path-shaped citation, however the module happens to write it.
 *
 * `tsx?` and NOT `ts|tsx`: regex alternation is first-match-wins, so `ts|tsx`
 * matches the `ts` of `ParentDigest.tsx` and stops, yielding `ParentDigest.ts`
 * -- a file that does not exist. The first run of this guard reported sixteen
 * "missing" files that were all really this, and every one of them was a real
 * .tsx sitting exactly where the module said it was.
 */
const CITATION = /(?:^|[\s`(])((?:apps\/web\/|src\/|app\/|infra\/|scripts\/)[A-Za-z0-9/_.\-[\]]*\.(?:tsx?|mjs|js|sql|json))/g;

function tableField(text: string, name: string): string | null {
  const m = new RegExp(`^\\|\\s*${name}\\s*\\|\\s*(.+?)\\s*\\|`, 'm').exec(text);
  return m ? m[1].trim() : null;
}

function loadModules(): Module[] {
  /* Read defensively so a moved catalogue FAILS this suite rather than
     preventing it from loading. A readdirSync throw at module scope takes the
     whole file down, and jest reports that as `Tests: 0 total` -- the
     assertions do not fail, they cease to exist, which is the exact failure
     suiteAttendance.test.ts was written about. Returning [] instead lets the
     first test below fail by name. */
  let entries: string[];
  try {
    entries = readdirSync(MODULE_DIR);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((file) => {
      const text = readFileSync(path.join(MODULE_DIR, file), 'utf8');
      const status = tableField(text, 'Status');
      const idMatch = /^(\d+)/.exec(file);
      const citations = new Set<string>();
      for (const m of text.matchAll(CITATION)) citations.add(m[1].replace(/[.,;]$/, ''));
      return {
        file,
        id: idMatch ? Number(idMatch[1]) : null,
        status,
        manualVerification: tableField(text, 'ManualVerification'),
        claimsDone: /\bDONE\b/.test(status ?? ''),
        citations: [...citations],
      };
    });
}

/** apps/web-relative and repo-relative are both used; accept either. */
function citationExists(citation: string): boolean {
  const candidates = citation.startsWith('apps/web/')
    ? [path.join(REPO, citation)]
    : [path.join(REPO, 'apps/web', citation), path.join(REPO, citation)];
  return candidates.some((p) => existsSync(p));
}

const modules = loadModules();

describe('the capability catalogue is readable as evidence', () => {
  test('the catalogue is actually here -- an empty read must not pass silently', () => {
    // The failure this prevents: a moved directory turns every assertion below
    // into a loop over nothing, and the guard reports green while checking
    // zero modules. Same species as suiteAttendance.test.ts's subject.
    expect(modules.length).toBeGreaterThanOrEqual(200);
    expect(modules.filter((m) => m.status !== null).length).toBeGreaterThanOrEqual(200);
  });

  test('every path a module cites is a path that exists', () => {
    const broken: string[] = [];
    for (const m of modules) {
      for (const c of m.citations) {
        if (!citationExists(c)) broken.push(`${m.file} cites missing ${c}`);
      }
    }
    // No ceiling here on purpose. A citation is a checkable factual claim about
    // this repository, and a wrong one is wrong today -- there is no legacy
    // pile to tolerate.
    expect(broken).toEqual([]);
  });

  test('the pile of DONE-without-evidence does not grow', () => {
    const unevidenced = modules.filter((m) => m.claimsDone && m.citations.length === 0);
    const names = unevidenced.map((m) => m.file);
    if (unevidenced.length > CEILING_UNEVIDENCED_DONE) {
      throw new Error(
        `${unevidenced.length} modules claim DONE while citing nothing checkable, ` +
          `above the ceiling of ${CEILING_UNEVIDENCED_DONE} measured 2026-08-28.\n` +
          `A new DONE needs at least one path into the codebase in its module file.\n` +
          names.slice(0, 40).join('\n'),
      );
    }
    expect(unevidenced.length).toBeLessThanOrEqual(CEILING_UNEVIDENCED_DONE);
  });

  test('the markdown and the JSON index do not drift further apart', () => {
    const index = JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as {
      modules: { ModuleId: number; Status: string }[];
    };
    const byId = new Map(index.modules.map((m) => [m.ModuleId, m.Status]));
    const disagreements = modules.filter((m) => {
      if (m.id === null || !byId.has(m.id)) return false;
      return m.claimsDone !== (byId.get(m.id) === 'DONE');
    });
    if (disagreements.length > CEILING_TRACKER_DISAGREEMENTS) {
      throw new Error(
        `${disagreements.length} modules disagree with expanded-200-index.json about DONE, ` +
          `above the ceiling of ${CEILING_TRACKER_DISAGREEMENTS} measured 2026-08-28. ` +
          `The index was generated 2026-08-03 and the module files have moved since; ` +
          `regenerating it is the fix, not raising this number.\n` +
          disagreements.slice(0, 20).map((d) => `${d.file}: md=${d.status}`).join('\n'),
      );
    }
    expect(disagreements.length).toBeLessThanOrEqual(CEILING_TRACKER_DISAGREEMENTS);
  });

  test('a DONE module that has been signed off says so, rather than leaving it blank', () => {
    // Not a ceiling: this asserts the FIELD is present wherever it is claimed,
    // so "signed off" and "nobody has looked" stay distinguishable. A module
    // may legitimately have no ManualVerification row; what it may not do is
    // carry one with an empty or unrecognised value.
    const bad = modules
      .filter((m) => m.manualVerification !== null)
      .filter((m) => !['PENDING_SIGN_OFF', 'SIGNED_OFF', 'NOT_REQUIRED'].includes(m.manualVerification!));
    expect(bad.map((m) => `${m.file}: ${m.manualVerification}`)).toEqual([]);
  });
});
