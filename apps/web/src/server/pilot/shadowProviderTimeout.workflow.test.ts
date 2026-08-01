// Pins the SHADOW provider timeout that each environment actually deploys, by
// reading the real workflow files.
//
// WHY THIS TEST EXISTS
//
// deploy-staging.yml sets PPBF_SHADOW_PROVIDER_TIMEOUT_MS; deploy-production.yml
// did not, even though its own comments state the rule that every variable is
// declared because `az containerapp update --set-env-vars` can update a value
// but cannot unset one. An undeclared variable is not "the code default" on an
// app that has ever carried a value -- it is whatever was last written there,
// invisibly, and a too-short timeout surfaces as DEGRADED_RESPONSE rather than
// as a configuration error.
//
// The token-budget sibling of this test (shadowTokenBudget.workflow.test.ts)
// exists because the same drift happened to PPBF_SHADOW_MAX_COMPLETION_TOKENS
// and CI was green throughout. This one covers the timeout the same way.

import fs from 'node:fs';
import path from 'node:path';

import { resolveShadowProviderTimeoutMs } from '@/app/api/pilot/shadow/chat/route';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');

// Measured 2026-07-29 quick-tier round trips, recorded in shadowRouter.ts: the
// slowest deployment took 58.0s (gpt-5-mini). A deployed timeout at or below
// this returns the degraded response on a call that was going to succeed.
const SLOWEST_MEASURED_PROVIDER_MS = 58_000;

const WORKFLOWS: Array<{ environment: string; file: string }> = [
  { environment: 'production', file: 'deploy-production.yml' },
  { environment: 'staging', file: 'deploy-staging.yml' },
];

function configuredTimeout(workflowFile: string): string {
  const contents = fs.readFileSync(
    path.join(REPO_ROOT, '.github/workflows', workflowFile),
    'utf8',
  );
  // Match the deployed assignment, not the explanatory comments above it --
  // both files discuss the number in prose, and a comment must never satisfy
  // this test.
  const assignments = [...contents.matchAll(/^\s*PPBF_SHADOW_PROVIDER_TIMEOUT_MS=(\S+?)\s*\\?\s*$/gm)];

  if (assignments.length === 0) {
    throw new Error(`${workflowFile} sets no PPBF_SHADOW_PROVIDER_TIMEOUT_MS`);
  }
  if (assignments.length > 1) {
    throw new Error(
      `${workflowFile} sets PPBF_SHADOW_PROVIDER_TIMEOUT_MS ${assignments.length} times; `
      + 'which one reaches the app depends on ordering, so this is ambiguous by construction',
    );
  }

  return assignments[0][1];
}

describe('deployed SHADOW provider timeout', () => {
  test.each(WORKFLOWS)('$environment declares the timeout explicitly', ({ file }) => {
    expect(() => configuredTimeout(file)).not.toThrow();
  });

  test.each(WORKFLOWS)(
    '$environment allows the slowest measured provider round trip',
    ({ file }) => {
      // Resolved through the real function the route calls, so the floor/ceiling
      // clamp is applied exactly as it is at runtime.
      const effective = resolveShadowProviderTimeoutMs(configuredTimeout(file));

      expect(effective).toBeGreaterThan(SLOWEST_MEASURED_PROVIDER_MS);
    },
  );

  test('production and staging deploy the same timeout', () => {
    // Keeping them equal is what makes a staging pass evidence about production.
    const [production, staging] = WORKFLOWS.map(({ file }) =>
      resolveShadowProviderTimeoutMs(configuredTimeout(file)),
    );

    expect(production).toBe(staging);
  });
});
