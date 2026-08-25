import fs from 'node:fs';
import path from 'node:path';

/**
 * Production deploys PROMOTE a staging-tested digest; they never build.
 *
 * deploy-production.yml's whole safety story is that the artifact reaching
 * production is byte-identical to the one staging tested: the workflow takes
 * `release_digest` as input, verifies it exists in ACR, and repoints the
 * Container App at that digest. A build step appearing in that file would
 * quietly replace "same tested image" with "rebuild and hope" -- the exact
 * shape the owner ruled out for release day (2026-08-24: "SAME CODE SAME
 * IMAGE DIGEST NEW ENVIRONMENT not rebuild and hope").
 *
 * The second pin is revision truth. `az containerapp update` returns when the
 * new revision is CREATED, not when it serves traffic. deploy-staging learned
 * this on run 30503641552 -- its post-deploy checks reached the PREVIOUS
 * revision -- and grew "Wait For New Revision To Take Traffic".
 * deploy-production's smoke checks are revision-generic 400/200/401 probes,
 * so without an equivalent wait a revision that never starts leaves the old
 * one serving, the probes pass against it, and the run reports a deploy that
 * did not happen. The wait must also assert the revision it waits on carries
 * the promoted digest, otherwise "latest revision is Running" can be true of
 * somebody else's revision.
 *
 * METHOD, stated honestly: raw workflow text plus regex/indexOf ordering, the
 * same idiom as workflowResourceGroupContract.test.ts and
 * seedWorkflowContract.test.ts (js-yaml is only an undeclared transitive
 * dependency here, so no real YAML parser). Structural only: this cannot
 * execute the shell or observe Azure. It CAN catch the two regressions that
 * matter -- a build step reappearing in the promotion path, and the wait step
 * disappearing or drifting out of order.
 */
const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

/** Normalized: a CRLF checkout defeats $-anchored regexes silently. */
function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

const production = readWorkflow('deploy-production.yml');
const staging = readWorkflow('deploy-staging.yml');

describe('deploy-production promotes a tested digest and never builds', () => {
  test('no image build exists anywhere in the workflow', () => {
    expect(production).not.toMatch(/docker\/build-push-action/);
    expect(production).not.toMatch(/\bdocker build\b/);
    expect(production).not.toMatch(/az acr build/);
  });

  test('the deployed image is the release_digest input, verbatim', () => {
    expect(production).toMatch(
      /--image "\$\{ACR_LOGIN_SERVER\}\/ppbf-frontend@\$\{\{ inputs\.release_digest \}\}"/
    );
  });

  test('the digest is verified to exist in ACR before anything deploys', () => {
    const verifyAt = production.indexOf('- name: Verify release digest exists in ACR');
    const deployAt = production.indexOf('- name: Deploy Tested Digest to Azure Container App');
    expect(verifyAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeLessThan(deployAt);
  });

  /* confirm_sha and release_digest arrive as two independent strings. Proving
     each one valid on its own is not the same as proving they belong together:
     a transposed pair deploys the wrong image under the right name, and
     PPBF_RELEASE_SHA then records the mismatch as fact for the rollback guard
     to trust. deploy-staging tags every push `ppbf-frontend:<github.sha>`, so
     the binding is already in the registry and the verify step must assert it. */
  test('the ACR check binds the digest to the commit, not just to existence', () => {
    const verifyAt = production.indexOf('- name: Verify release digest exists in ACR');
    const nextStepAt = production.indexOf('- name:', verifyAt + 1);
    const step = production.slice(verifyAt, nextStepAt === -1 ? undefined : nextStepAt);

    // It must read the manifest's tags and compare them against confirm_sha.
    expect(step).toMatch(/\$\{\{ inputs\.confirm_sha \}\}/);
    expect(step).toMatch(/\.tags/);
    expect(step).toMatch(/PROVENANCE MISMATCH/);
    // And refuse, rather than warn, when they do not agree.
    expect(step).toMatch(/^\s*exit 1$/m);
  });

  test('staging tags every image it pushes with the commit sha, or the binding has nothing to read', () => {
    // The assertion above is only meaningful while this remains true.
    expect(staging).toMatch(/tags:\s*\$\{\{ env\.ACR_LOGIN_SERVER \}\}\/ppbf-frontend:\$\{\{ github\.sha \}\}/);
  });

  test('staging is the only workflow that builds the frontend image', () => {
    // The digest production promotes has to come from somewhere that tested
    // it. If this moves, the promotion story needs re-verifying, not just a
    // list update.
    const builders = fs
      .readdirSync(WORKFLOW_DIR)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .filter((f) => /docker\/build-push-action/.test(readWorkflow(f)));
    expect(builders).toEqual(['deploy-staging.yml']);
  });
});

describe('post-deploy verification talks to the revision that was deployed', () => {
  test('production waits for the promoted revision between update and smoke checks', () => {
    const deployAt = production.indexOf('- name: Deploy Tested Digest to Azure Container App');
    const waitAt = production.indexOf('- name: Wait For Promoted Revision To Take Traffic');
    const smokeAt = production.indexOf('- name: Pilot API Smoke Checks');
    expect(deployAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(-1);
    expect(smokeAt).toBeGreaterThan(-1);
    expect(deployAt).toBeLessThan(waitAt);
    expect(waitAt).toBeLessThan(smokeAt);
  });

  test('the production wait asserts the revision carries the promoted digest', () => {
    const waitAt = production.indexOf('- name: Wait For Promoted Revision To Take Traffic');
    const nextStepAt = production.indexOf('- name:', waitAt + 1);
    const wait = production.slice(waitAt, nextStepAt === -1 ? undefined : nextStepAt);
    expect(wait).toMatch(/latestRevisionName/);
    expect(wait).toMatch(/@\$\{\{ inputs\.release_digest \}\}/);
    expect(wait).toMatch(/runningState/);
    expect(wait).toMatch(/"Running 100"/);
    // A wait that cannot fail is a sleep: both refusal paths must exist.
    expect(wait).toMatch(/does not carry the promoted digest/);
    expect(wait).toMatch(/did not reach Running\/100% traffic/);
    // And neither may be swallowed.
    expect(wait).not.toMatch(/continue-on-error/);
  });

  test('staging keeps its own wait between update and its post-deploy checks', () => {
    const updateAt = staging.indexOf('az containerapp update');
    const waitAt = staging.indexOf('- name: Wait For New Revision To Take Traffic');
    expect(updateAt).toBeGreaterThan(-1);
    expect(waitAt).toBeGreaterThan(-1);
    expect(updateAt).toBeLessThan(waitAt);
  });
});

describe('deploy-production fails closed on the resource group', () => {
  test('the resource group is the production secret with no fallback expression', () => {
    expect(production).toMatch(
      /RESOURCE_GROUP:\s*\$\{\{\s*secrets\.AZURE_PRODUCTION_RESOURCE_GROUP\s*\}\}/
    );
    expect(production).not.toMatch(/AZURE_PRODUCTION_RESOURCE_GROUP[^\n}]*\|\|/);
    expect(production).not.toMatch(/^\s*RESOURCE_GROUP:\s*rg-ppbf-enterprise-staging\s*$/m);
  });

  test('an explicit refusal step precedes the Azure login', () => {
    const guardAt = production.indexOf('- name: Resolve Production Resource Group');
    expect(guardAt).toBeGreaterThan(-1);
    const nextStepAt = production.indexOf('- name:', guardAt + 1);
    const guard = production.slice(guardAt, nextStepAt === -1 ? undefined : nextStepAt);
    expect(guard).toMatch(/-z "\$RESOURCE_GROUP"/);
    expect(guard).toMatch(/::error::.*AZURE_PRODUCTION_RESOURCE_GROUP/);
    expect(guard).toMatch(/^\s*exit 1$/m);

    const loginAt = production.indexOf('azure/login');
    expect(loginAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(loginAt);
  });
});
