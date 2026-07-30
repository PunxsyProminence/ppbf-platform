// Pins the SHADOW completion-token budget that each environment actually
// deploys, by reading the real workflow files.
//
// WHY THIS TEST EXISTS
//
// Production shipped PPBF_SHADOW_MAX_COMPLETION_TOKENS=4096 while staging ran
// 8192, and CI was green the entire time. It was green because the only
// existing assertion on this value is
//
//   expect(resolveShadowMaxCompletionTokens(undefined)).toBeGreaterThan(2054)
//
// (chat/route.test.ts) -- which pins the DEFAULT against the peak of one
// measurement set (ordinary prompts, 964/1682/2054 tokens) and says nothing
// about what any environment is configured to send. Nothing in the suite read
// the workflows at all, so the two environments could and did drift apart
// silently.
//
// Azure counts reasoning tokens against max_completion_tokens. When the budget
// runs out the provider returns HTTP 200 with finish_reason "length" and NO
// content; the chat route reads empty content as failure and answers with
// DEGRADED_RESPONSE -- "SHADOW is temporarily unavailable ... try again later".
// A permanent misconfiguration therefore presented as a transient outage, and
// only on long-form prompts, which is why it read as intermittent.
//
// This test asserts the deployed budget clears the highest completion count
// this repository has actually measured, for BOTH environments, so a future
// edit to either workflow fails here rather than in production.

import fs from 'node:fs';
import path from 'node:path';

import { resolveShadowMaxCompletionTokens } from '@/app/api/pilot/shadow/chat/route';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

// Measured 2026-07-29 against a representative demanding prompt (athlete
// plateau analysis + 6-week plan), recorded in shadowRouter.ts:31-35. These are
// completion tokens, reasoning included.
const MEASURED_COMPLETION_TOKENS: Record<string, number> = {
  'gpt-5.6-sol': 5579,
  'gpt-5.6-luna': 4110,
  'gpt-5': 6352,
  'gpt-5-mini': 5168,
};

const HIGHEST_MEASURED_NEED = Math.max(...Object.values(MEASURED_COMPLETION_TOKENS));

const WORKFLOWS: Array<{ environment: string; file: string }> = [
  { environment: 'production', file: 'deploy-production.yml' },
  { environment: 'staging', file: 'deploy-staging.yml' },
];

function configuredBudget(workflowFile: string): string {
  const contents = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows', workflowFile),
    'utf8',
  );
  // Match the deployed assignment, not the explanatory comments above it --
  // both files discuss the number in prose, and a comment must never satisfy
  // this test.
  const assignments = [...contents.matchAll(/^\s*PPBF_SHADOW_MAX_COMPLETION_TOKENS=(\S+?)\s*\\?\s*$/gm)];

  if (assignments.length === 0) {
    throw new Error(`${workflowFile} sets no PPBF_SHADOW_MAX_COMPLETION_TOKENS`);
  }
  if (assignments.length > 1) {
    throw new Error(
      `${workflowFile} sets PPBF_SHADOW_MAX_COMPLETION_TOKENS ${assignments.length} times; `
      + 'which one reaches the app depends on ordering, so this is ambiguous by construction',
    );
  }

  return assignments[0][1];
}

describe('deployed SHADOW completion-token budget', () => {
  test.each(WORKFLOWS)(
    '$environment clears the highest measured completion need',
    ({ file }) => {
      // Resolved through the real function the route calls, so clamping
      // (floor 256, ceiling 8192) is applied exactly as it is at runtime --
      // a workflow could set 99999 and still deploy an 8192 budget.
      const effective = resolveShadowMaxCompletionTokens(configuredBudget(file));

      expect(effective).toBeGreaterThanOrEqual(HIGHEST_MEASURED_NEED);
    },
  );

  test('every measured deployment fits inside each environment budget', () => {
    // Names the specific deployment that would truncate, so a failure says
    // which model breaks rather than only that a number is too small.
    for (const { environment, file } of WORKFLOWS) {
      const effective = resolveShadowMaxCompletionTokens(configuredBudget(file));
      for (const [deployment, need] of Object.entries(MEASURED_COMPLETION_TOKENS)) {
        expect({ environment, deployment, need, effective, fits: need <= effective })
          .toEqual({ environment, deployment, need, effective, fits: true });
      }
    }
  });

  test('production and staging deploy the same budget', () => {
    // The defect was drift between environments: staging exercised 8192 and
    // production shipped 4096, so the gate could never have caught it. Keeping
    // them equal is what makes a staging pass evidence about production.
    const [production, staging] = WORKFLOWS.map(({ file }) =>
      resolveShadowMaxCompletionTokens(configuredBudget(file)),
    );

    expect(production).toBe(staging);
  });
});
