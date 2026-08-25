import fs from 'node:fs';
import path from 'node:path';

/**
 * A gate that cannot fail is not a gate.
 *
 * deploy-staging.yml's "Runtime Verification Ledger" runs the declared probe
 * set against the environment that was just deployed. It carried
 * `continue-on-error: true` for a narrow and honest reason: two probes were
 * EXPECTED to fail until the drill library and disciplines were seeded, and a
 * brand-new check must not turn a successful deploy red for a condition
 * already known and already tracked. The comment above it said so, and said
 * that deleting that one line once the ledger came clean "is the whole change,
 * and it should be made rather than left forever".
 *
 * Run 32770638337 (2026-08-24, c7dee86d, enable_shadow_gate=true) came clean
 * against the migrated and seeded staging database -- tally PASS=72, zero
 * failed probes, with PR-238x/drill-library-seeded, PR-238ac/disciplines-seeded
 * and PR-238aa/library-sources all ok -- so the line went. This pins that it
 * stays gone, and that the gate is not neutered by one of the other routes to
 * the same place: `|| true` on the probe command, or a bare `exit 0` replacing
 * the preserved probe status. Restoring any of those makes THIS file red, by
 * name, rather than quietly returning the step to reporting-only.
 *
 * The second half pins the cleanup escalation. "Deactivate Gate Athlete
 * Fixture" must STAY non-fatal -- a cleanup failure must never overwrite the
 * gate's own verdict -- but its silence had a cost: the one thing that failure
 * means is that a working PIN for gate_shadow_athlete is still live on a
 * publicly reachable staging login, and continue-on-error rendered that as a
 * grey step in a green run. A following annotation step now says so and still
 * exits 0. It is keyed on `steps.<id>.outcome`, never `failure()`, which is
 * wrong in both directions: the ledger is a hard gate now, so failure() is
 * true whenever a probe failed and would cry credential-leak on a run whose
 * cleanup was fine, and a continue-on-error step's own failure never sets
 * failure() at all.
 *
 * METHOD, stated honestly: raw workflow text plus regex/indexOf ordering, the
 * same idiom as workflowResourceGroupContract.test.ts and
 * seedWorkflowContract.test.ts (js-yaml exists here only as an undeclared
 * transitive dependency, so no real YAML parser is used). Structural only:
 * this cannot execute the shell, cannot observe a real probe run, and cannot
 * prove GitHub evaluates `outcome` the way the comments claim. It CAN catch
 * the regressions that matter -- continue-on-error returning to the ledger
 * step, the exit-status plumbing being dropped, and the escalation vanishing
 * or being rekeyed onto failure().
 */
const WORKFLOW_DIR = path.resolve(__dirname, '../../../../../.github/workflows');

/** Normalized: a CRLF checkout defeats $-anchored regexes silently. */
function readWorkflow(file: string): string {
  return fs.readFileSync(path.join(WORKFLOW_DIR, file), 'utf8').replace(/\r\n/g, '\n');
}

const staging = readWorkflow('deploy-staging.yml');

const LEDGER_STEP = '- name: Runtime Verification Ledger';
const CLEANUP_STEP = '- name: Deactivate Gate Athlete Fixture';
const ESCALATION_STEP = '- name: Report Gate Athlete Fixture Still Live';

/**
 * The YAML block for one step: from its `- name:` line to the next step's, so
 * a key found here belongs to this step and not to a neighbour.
 */
function stepBody(name: string): string {
  const at = staging.indexOf(name);
  if (at === -1) throw new Error(`step not found in deploy-staging.yml: ${name}`);
  const next = staging.slice(at + name.length).search(/\n {6}- name:/);
  return next === -1 ? staging.slice(at) : staging.slice(at, at + name.length + next);
}

/**
 * Full-line comments dropped before any structural assertion. The rewritten
 * note above this step, and the shell comments inside its run block, both
 * discuss continue-on-error in prose -- a test that matched prose would go red
 * on an accurate comment and green on a real regression that happened to be
 * uncommented.
 */
function withoutComments(block: string): string {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('the runtime verification ledger gates the staging deploy', () => {
  test('the workflow and the ledger step both exist (guard against a vacuous file)', () => {
    // Every assertion below is an indexOf or a regex over this text. A moved
    // file or a renamed step would make them all pass by matching nothing.
    expect(staging).toContain('name: deploy-staging');
    expect(staging).toContain(LEDGER_STEP);
    expect(staging).toContain('pilot:runtime-verify');
  });

  test('the Runtime Verification Ledger step carries NO continue-on-error', () => {
    // THE point of this file. continue-on-error on this step means a failed
    // probe is a grey step inside a green deploy -- the check still prints its
    // ledger and stops being a gate. The exemption that bought this line was
    // spent by run 32770638337; it must not come back without the comment
    // above the step being rewritten to justify it again.
    expect(withoutComments(stepBody(LEDGER_STEP))).not.toMatch(/^\s*continue-on-error:/m);
  });

  test('the probe exit status is captured and re-raised as the step status', () => {
    // The step runs with -e, so `set +e` is what lets a failing probe reach
    // the status capture instead of aborting mid-summary; PIPESTATUS[0] is the
    // probe's status rather than tee's; and `exit "$status"` is what turns it
    // into the step's status. Drop any one of the three and the step reports a
    // failure it does not act on -- continue-on-error by other means.
    const ledger = withoutComments(stepBody(LEDGER_STEP));
    expect(ledger).toMatch(/^\s*set \+e$/m);
    expect(ledger).toMatch(/status=\$\{PIPESTATUS\[0\]\}/);
    expect(ledger).toMatch(/^\s*exit "\$status"$/m);
  });

  test('nothing swallows the probe status on the way out', () => {
    // The other two routes to a gate that cannot fail: `|| true` appended to
    // the probe invocation, and a bare `exit 0` ending the step regardless of
    // what the ledger found.
    const ledger = withoutComments(stepBody(LEDGER_STEP));
    expect(ledger).not.toMatch(/\|\|\s*true/);
    expect(ledger).not.toMatch(/^\s*exit 0\s*$/m);
  });

  test('the step no longer tells its reader it does not gate', () => {
    // The step writes prose into GITHUB_STEP_SUMMARY, which is what a
    // gatekeeper actually reads. It used to print "This step does not gate the
    // deploy." Leaving that after removing the line would publish a false
    // statement to every future run.
    expect(stepBody(LEDGER_STEP)).not.toMatch(/does not gate the deploy/);
  });

  test('the outstanding-probe list is still described as prose, not failures', () => {
    // The ledger prints items that still need a human-authored acceptance
    // probe (16 on run 32770638337). They are declared future work, they do
    // not move the exit status, and a future reader must not mistake them for
    // a red gate. Both the comment and the printed summary say so.
    const ledgerAt = staging.indexOf(LEDGER_STEP);
    const commentBlock = staging.slice(staging.lastIndexOf('\n      # Thirty-two', ledgerAt), ledgerAt);
    expect(commentBlock).toMatch(/PROSE|prose/);
    expect(commentBlock).toMatch(/NOT probe failures|not probe failures/);
    expect(stepBody(LEDGER_STEP)).toMatch(/rather than probe failures/);
  });

  test('the comment above the step records the run that earned the gate', () => {
    // This file's convention is evidence-carrying comments citing run ids. A
    // gate whose justification is "someone decided" is one nobody can audit.
    const ledgerAt = staging.indexOf(LEDGER_STEP);
    const commentBlock = staging.slice(staging.lastIndexOf('\n      # Thirty-two', ledgerAt), ledgerAt);
    expect(commentBlock).toContain('32770638337');
    expect(commentBlock).toMatch(/PASS=72/);
  });
});

describe('gate athlete cleanup stays non-fatal but stops being silent', () => {
  test('the cleanup step KEEPS continue-on-error', () => {
    // Deliberately the opposite assertion to the ledger's. If cleanup could
    // fail the job, a cleanup failure would mask the gate's own result -- the
    // verdict this whole job exists to produce would be overwritten by its
    // own tidying up.
    expect(withoutComments(stepBody(CLEANUP_STEP))).toMatch(/^\s*continue-on-error: true$/m);
  });

  test('the cleanup step is addressable by id', () => {
    // The escalation reads this step's outcome; without the id it cannot.
    expect(withoutComments(stepBody(CLEANUP_STEP))).toMatch(/^\s*id: deactivate-gate-athlete$/m);
  });

  test('a following step escalates a failed cleanup by name', () => {
    // A failed cleanup means a working PIN for gate_shadow_athlete may still
    // authenticate on staging, which is publicly reachable. The annotation has
    // to name the account, because naming it is what lets a responder go clear
    // it.
    const cleanupAt = staging.indexOf(CLEANUP_STEP);
    const escalationAt = staging.indexOf(ESCALATION_STEP);
    expect(escalationAt).toBeGreaterThan(-1);
    expect(cleanupAt).toBeLessThan(escalationAt);

    const escalation = withoutComments(stepBody(ESCALATION_STEP));
    expect(escalation).toMatch(/::error/);
    expect(escalation).toContain('gate_shadow_athlete');
    expect(escalation).toContain('GATE-SHADOW-ATH-1');
  });

  test('the escalation is keyed on the cleanup outcome, never on failure()', () => {
    // failure() is wrong in both directions here. The ledger above is a hard
    // gate now, so failure() is true whenever a probe failed -- the escalation
    // would announce a leaked credential on a run whose cleanup was fine. And
    // a continue-on-error step's failure never sets failure() at all, so it
    // would stay silent in exactly the case it exists for.
    const escalation = withoutComments(stepBody(ESCALATION_STEP));
    expect(escalation).toMatch(/steps\.deactivate-gate-athlete\.outcome == 'failure'/);
    expect(escalation).toMatch(/always\(\)/);
    expect(escalation).not.toMatch(/if:[^\n]*failure\(\)/);
  });

  test('the escalation cannot fail the job', () => {
    // It must be loud without being able to change the result: an annotation
    // plus exit 0. Anything that could exit non-zero would make cleanup fatal
    // through the back door and mask the gate's verdict after all.
    const escalation = withoutComments(stepBody(ESCALATION_STEP));
    expect(escalation).toMatch(/^\s*exit 0$/m);
    expect(escalation).not.toMatch(/^\s*exit 1$/m);
  });

  test('the escalation never prints the PIN itself', () => {
    // It is ::add-mask::ed at mint, so it would be redacted anyway -- but a
    // step whose job is to report a live credential must not be the step that
    // publishes it. The account id is what a responder needs.
    const escalation = stepBody(ESCALATION_STEP);
    expect(escalation).not.toMatch(/GATE_ATHLETE_PIN/);
    expect(escalation).not.toMatch(/PILOT_SHADOW_ATHLETE_PIN/);
  });
});
