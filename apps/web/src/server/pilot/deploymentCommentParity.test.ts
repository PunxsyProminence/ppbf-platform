// Holds deploy-staging.yml's PROSE to what deploy-production.yml actually
// deploys, for the one kind of claim that goes stale silently: staging saying
// production leaves a variable unset.
//
// WHY THIS TEST EXISTS
//
// deploy-staging.yml explains each flag it turns on, and those explanations
// described production's posture as part of the staging-first story -- "Production
// states it explicitly false until...", "Production stays unset (= disabled)
// until...", "production leaves it unset". Each was true when written. Each flag
// was then promoted to production by its own workflow change, and nothing went
// back to update the file that had described the old state.
//
// Five of six such claims were false when this test was written:
//
//   PPBF_SHADOW_WORKER_ENABLED           "explicitly false"  -> production: true
//   AZURE_AI_EMBEDDING_DEPLOYMENT_NAME   "stays unset"       -> production: set
//   PPBF_INTAKE_PROMOTION_ENABLED        "does not set it"   -> production: true
//   AZURE_AI_VISION_DEPLOYMENT_NAME      "Staging-only"      -> production: set
//   PPBF_VIDEO_CONTENT_SCAN              "leaves it unset"   -> production: vision
//
// The consequence is operational, not cosmetic. An operator reading
// deploy-staging.yml to decide whether a flag is safe to promote was told
// production did not have it, while production had been running it for weeks.
// That is the same defect class as the SHADOW token budget (PR #81) and the
// .env.example inventory drift (PR #837): a second record of a fact, kept by
// hand, drifting from the artifact that actually decides it.
//
// THE RULE THIS ENFORCES
//
// deploy-production.yml is the authority for what production deploys. Staging's
// comments may explain staging, and may record rollout HISTORY, but they may not
// assert that production lacks a variable production's own block assigns.
//
// Claims in the other direction are deliberately not checked. "Production sets
// this too" is a statement this test cannot falsify from source alone, and a
// guard that pretends otherwise would be the overclaim it exists to prevent.

import fs from 'node:fs';
import path from 'node:path';

const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

/** The variable names a workflow's --set-env-vars block actually assigns. */
function deployedNames(workflowFile: string): string[] {
  const lines = fs.readFileSync(path.join(WORKFLOW_DIR, workflowFile), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^\s*--set-env-vars\s*\\\s*$/.test(line));

  if (start < 0) throw new Error(`${workflowFile} has no --set-env-vars block`);

  const names: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^\s+([A-Z][A-Z0-9_]*)=/.exec(lines[i]);
    if (!match) break;
    names.push(match[1]);
  }
  return names;
}

interface Paragraph {
  text: string;
  line: number;
}

/**
 * deploy-staging.yml's comment paragraphs, split on blank comment lines.
 */
function commentParagraphs(workflowFile: string): Paragraph[] {
  const lines = fs.readFileSync(path.join(WORKFLOW_DIR, workflowFile), 'utf8').split('\n');
  const paragraphs: Paragraph[] = [];

  let current: string[] = [];
  let startLine = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    paragraphs.push({ text: current.join(' '), line: startLine });
    current = [];
  };

  lines.forEach((line, index) => {
    const comment = /^\s*#\s?(.*)$/.exec(line);
    if (!comment) {
      flush();
      return;
    }
    const body = comment[1].trim();
    if (body === '') {
      flush();
      return;
    }
    if (current.length === 0) startLine = index + 1;
    current.push(body);
  });
  flush();

  return paragraphs;
}

/**
 * Which variable a claim at `offset` is about: the NEAREST PRECEDING variable
 * name in the same paragraph.
 *
 * Not the paragraph's first name. One paragraph in this file discusses
 * PPBF_SHADOW_PROVIDER_TIMEOUT_MS and then PPBF_SHADOW_WORKER_ENABLED with no
 * blank line between them, and a first-name rule charged the worker's
 * "explicitly false" claim to the timeout -- a correct failure pointing at the
 * wrong variable, which is how a real finding gets dismissed as a false
 * positive. Prose runs top to bottom, so the name most recently introduced is
 * the one being discussed.
 */
function claimSubject(text: string, offset: number, known: Set<string>): string | null {
  let subject: string | null = null;
  for (const match of text.slice(0, offset).matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) {
    // Only a name some deployment actually assigns. A shape-based pattern reads
    // ordinary shouted prose as a variable -- "the in-process SHADOW job
    // worker", "Enabled HERE FIRST" -- and SHADOW/FIRST then become the nearest
    // preceding "name", silently swallowing the real claim behind them. That
    // cost two of five true findings before this set was threaded through.
    if (known.has(match[1])) subject = match[1];
  }
  return subject;
}

// Phrasings that assert production does NOT carry the variable. Each is taken
// from prose that was actually in this file, not invented for the test.
const ABSENCE_CLAIMS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'production ... unset', pattern: /production[^.]{0,80}\bunset\b/i },
  { label: 'production ... does not set', pattern: /production[^.]{0,80}\bdoes ?n[o']t set\b/i },
  { label: 'production ... never sets', pattern: /production[^.]{0,80}\bnever sets?\b/i },
  { label: 'production ... explicitly false', pattern: /production[^.]{0,80}\bexplicitly false\b/i },
  { label: 'staging-only', pattern: /\bstaging[- ]only\b/i },
];

describe('deploy-staging.yml comments match what production deploys', () => {
  const productionNames = new Set(deployedNames('deploy-production.yml'));
  const knownNames = new Set([...productionNames, ...deployedNames('deploy-staging.yml')]);
  const paragraphs = commentParagraphs('deploy-staging.yml');

  test('production deploys a non-empty variable block', () => {
    // Anti-vacuity: an empty production set makes every assertion below pass by
    // having nothing to contradict.
    expect(productionNames.size).toBeGreaterThan(0);
  });

  test('staging comments are found and attributed to variables', () => {
    // Anti-vacuity: a parse that finds no paragraphs, or none naming a
    // variable, reports a clean bill of health for nothing.
    const naming = paragraphs.filter((p) => claimSubject(p.text, p.text.length, knownNames) !== null);
    expect(naming.length).toBeGreaterThan(5);
  });

  test('no staging comment claims production lacks a variable production sets', () => {
    const contradictions: string[] = [];

    for (const paragraph of paragraphs) {
      for (const { label, pattern } of ABSENCE_CLAIMS) {
        const found = pattern.exec(paragraph.text);
        if (!found) continue;

        const subject = claimSubject(paragraph.text, found.index, knownNames);
        if (subject === null || !productionNames.has(subject)) continue;

        contradictions.push(
          `deploy-staging.yml:${paragraph.line} says "${label}" about ${subject}, `
          + 'but deploy-production.yml assigns it. Correct the comment -- '
          + 'deploy-production.yml is the authority for what production deploys.',
        );
      }
    }

    expect(contradictions).toEqual([]);
  });
});
