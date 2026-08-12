import fs from 'node:fs';
import path from 'node:path';

// import-shadow-research.yml previously required organization_id as a typed input, while its
// sibling seed-reference-data.yml resolves the same value from the target app's own
// ppbf-pilot-default-org-id secret. #273 made that change on the grounds that the value is a secret
// the operator cannot see from the dispatch form, and a typo seeds a live database under an
// organization that does not exist. The argument applied identically here and had not been applied.
//
// Source-level, like seedWorkflowContract.test.ts, so it runs in the fast suite rather than behind
// the pg chain. It guards the two properties that can break while leaving the YAML completely valid
// -- which is why neither would be caught by anything else.

const PILOT_DIR = __dirname;
const REPO_ROOT = path.resolve(PILOT_DIR, '../../../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/import-shadow-research.yml');

// The repo checks out CRLF, so anchoring on '\n' matches nothing. seedWorkflowContract.test.ts was
// written with that bug and passed vacuously until it was found; not repeating it here.
const raw = fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

function indexOfStep(name: string): number {
  const at = raw.indexOf(`- name: ${name}`);
  expect(at).toBeGreaterThan(-1);
  return at;
}

describe('import-shadow-research.yml resolves the owning organization', () => {
  it('does not require organization_id from the operator', () => {
    const block = raw.slice(raw.indexOf('organization_id:'), raw.indexOf('seed_account_id:'));
    expect(block).toContain('required: false');
  });

  it('resolves it from the app secret when the input is blank', () => {
    expect(raw).toContain('--secret-name ppbf-pilot-default-org-id');
  });

  // The bug this exists to prevent. $GITHUB_ENV only reaches LATER steps, so a resolve step placed
  // after its consumers leaves the YAML valid and hands the importer an empty organization -- which
  // surfaces as MISSING_PPBF_ORG_ID for a reason nobody would guess from the dispatch form.
  it('resolves the organization BEFORE the steps that read it', () => {
    const resolve = indexOfStep('Resolve Owning Organization');
    expect(resolve).toBeLessThan(indexOfStep('Validate Research Package'));
    expect(resolve).toBeLessThan(indexOfStep('Import Research Package'));
    // az is needed to read the secret, so the login has to come first.
    expect(indexOfStep('Authenticate via Azure OIDC')).toBeLessThan(resolve);
  });

  // Ordering alone was not enough, and this test is here because the ordering
  // assertion above passed while the workflow was broken.
  //
  // Authenticate via Azure OIDC carried `if: inputs.mode == 'apply'`. Resolve
  // Owning Organization is unconditional and shells out to
  // `az containerapp secret show` whenever organization_id is blank -- the
  // normal case, and one dry-run reaches. So in dry-run the login was skipped,
  // the az call ran unauthenticated, and `set -euo pipefail` failed the step:
  // the feature's headline path, in the mode an operator tries first.
  //
  // Asserting the ORDER of two steps says nothing about whether either RUNS.
  it('does not gate the Azure login on mode, because dry-run needs az too', () => {
    const loginAt = raw.indexOf('- name: Authenticate via Azure OIDC');
    expect(loginAt).toBeGreaterThan(-1);

    // Everything between the step name and its `uses:` -- where an `if:` would sit.
    const header = raw.slice(loginAt, raw.indexOf('uses:', loginAt));
    expect(header).not.toContain('if:');
  });

  // The other half: if someone later makes the resolve step conditional instead,
  // the same hole reopens from the other direction.
  it('resolves the organization in every mode', () => {
    const resolveAt = raw.indexOf('- name: Resolve Owning Organization');
    expect(resolveAt).toBeGreaterThan(-1);

    const header = raw.slice(resolveAt, raw.indexOf('run:', resolveAt));
    expect(header).not.toContain("if: inputs.mode");
  });

  // Two sources for one name is precisely the defect #273 fixed in the sibling workflow: a job-level
  // env entry would win over, or race with, the value written to $GITHUB_ENV.
  it('does not also declare PPBF_ORG_ID in the job env block', () => {
    const jobEnv = raw.slice(raw.indexOf('    env:\n'), raw.indexOf('    steps:'));
    expect(jobEnv).not.toContain('PPBF_ORG_ID:');
    // SEED_ACCOUNT_ID stays here on purpose -- it is operator-supplied, not resolved.
    expect(jobEnv).toContain('SEED_ACCOUNT_ID:');
  });

  it('masks the resolved organization', () => {
    expect(raw).toContain('::add-mask::$ORG');
  });

  // A masked value printed into the run summary is a masked value no longer. The summary reports
  // where the organization came from, never what it is.
  it('never echoes the organization value into the run summary', () => {
    expect(raw).not.toContain('- organization: `${{ inputs.organization_id }}`');
    expect(raw).toContain('$ORG_SOURCE');
  });

  it('fails closed when neither the input nor the secret yields a value', () => {
    expect(raw).toContain('Could not resolve an owning organization');
  });

  // seed_account_id genuinely cannot be resolved this way -- it is an account id, not a secret the
  // app holds. #283 adds the read-only seed-identity check so an operator can look it up without
  // reading production by eye; it must stay a required input here.
  it('still requires seed_account_id', () => {
    const block = raw.slice(raw.indexOf('seed_account_id:'));
    expect(block.slice(0, 200)).toContain('required: true');
  });
});

// --- Corpus scope, added when the platform baseline split shipped ---
//
// The scope input decides which slice of the corpus is imported, and for the
// platform baseline it also decides the organization. Both properties can break
// while leaving the YAML valid, and both fail silently in the direction that
// matters: a baseline landing in a gym's own organization hands that gym 1,194
// sources every other gym reads as private evidence.

describe('import-shadow-research.yml scopes the corpus', () => {
  it('offers the three scopes and defaults to the platform baseline', () => {
    const block = raw.slice(raw.indexOf('scope:'), raw.indexOf('organization_id:'));
    expect(block).toContain('default: platform_baseline');
    expect(block).toContain('- platform_baseline');
    expect(block).toContain('- ppbf_policy');
    expect(block).toContain('- whole_corpus');
  });

  it('forces the reserved organization for the platform baseline', () => {
    const block = raw.slice(indexOfStep('Resolve Owning Organization'), indexOfStep('Resolve Declared Database Target'));
    expect(block).toContain('if [ "$SCOPE" = "platform_baseline" ]; then');
    expect(block).toContain('echo "PPBF_ORG_ID=__platform__" >> "$GITHUB_ENV"');
  });

  // Refused, not silently overridden: an input that quietly does nothing is
  // worse than one that errors, because the operator keeps believing it works.
  it('refuses an organization_id that disagrees with the platform baseline', () => {
    const block = raw.slice(indexOfStep('Resolve Owning Organization'), indexOfStep('Resolve Declared Database Target'));
    expect(block).toContain('!= "__platform__"');
    expect(block).toMatch(/::error::scope platform_baseline imports only into __platform__/);
  });

  // whole_corpus is the importer's UNSET default, not a value it accepts --
  // passing the literal string would trip UNKNOWN_SEED_SCOPE and fail the run.
  it('maps whole_corpus to an unset variable rather than a literal', () => {
    const block = raw.slice(indexOfStep('Resolve Corpus Scope'), indexOfStep('Validate Research Package'));
    expect(block).toContain('if [ "$SCOPE" != "whole_corpus" ]; then');
    expect(block).toContain('echo "PPBF_RESEARCH_SEED_SCOPE=$SCOPE" >> "$GITHUB_ENV"');
  });

  // Same $GITHUB_ENV trap as the organization: a resolve step after its
  // consumers leaves the YAML valid and silently imports the whole corpus.
  it('resolves the scope BEFORE the steps that read it', () => {
    const resolve = indexOfStep('Resolve Corpus Scope');
    expect(resolve).toBeLessThan(indexOfStep('Validate Research Package'));
    expect(resolve).toBeLessThan(indexOfStep('Import Research Package'));
  });
});

// --- The approval workflow ---

const APPROVAL_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/approve-library-baseline.yml');
const approvalRaw = fs.readFileSync(APPROVAL_WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

describe('approve-library-baseline.yml', () => {
  // The one property that makes the dry run trustworthy: the script writes only
  // when this is exactly 'true', and the job derives it from the mode rather than
  // letting a step set it.
  it('derives the apply flag from the mode input', () => {
    expect(approvalRaw).toContain("PPBF_LIBRARY_APPROVAL_APPLY: ${{ inputs.mode == 'apply' }}");
  });

  it('requires the target to be retyped and the approval phrase for apply', () => {
    expect(approvalRaw).toContain('test "$TARGET" = "$CONFIRM_TARGET"');
    expect(approvalRaw).toContain('test "$CONFIRM_APPROVAL" = "APPROVE EVIDENCE"');
  });

  // Same lesson as the sibling workflow: the dry run reads the same database, so
  // gating the login on mode breaks the mode an operator tries first.
  it('does not gate the Azure login on mode', () => {
    const login = approvalRaw.indexOf('- name: Authenticate via Azure OIDC');
    const nextStep = approvalRaw.indexOf('- name: Resolve Declared Database Target');
    expect(login).toBeGreaterThan(-1);
    expect(approvalRaw.slice(login, nextStep)).not.toContain('if: inputs.mode');
  });

  it('resolves the declared target before approving', () => {
    expect(approvalRaw.indexOf('- name: Resolve Declared Database Target'))
      .toBeLessThan(approvalRaw.indexOf('- name: Approve Library Evidence'));
  });
});
