// videoReleasePolicy.ts — which scan states a coach may release from, per
// organization.
//
// The video gate shipped with one posture compiled in: a coach could release
// only from a scan_state where the scanner explicitly deferred. That is the
// right DEFAULT and the wrong CONSTANT. A platform serving more than one gym
// cannot hard-code one gym's risk assessment, and the owner's decision
// (2026-08-17) puts it with the organization administrator instead.
//
// ABSENCE MEANS STRICT. An organization with no row reads 'scan_required',
// which is exactly today's behaviour. Deploying this changes nothing for
// anybody until an administrator records a decision against their own
// organization, with their account id attached.
//
// THE CEILING IS FIXED AND NOT CONFIGURABLE. No policy value reaches
// 'infected' or 'blocked':
//
//   * 'infected' is a malware verdict from a real scanner. No human, under any
//     setting, releases it.
//   * 'blocked' is the content screen refusing footage of a minor. It still
//     escalates to an administrator, and the coach who filmed it still cannot
//     overturn it (#149's reasoning, unchanged).
//
// So the widest this dial reaches is "a video nothing has judged" -- never "a
// video something judged and refused". That boundary is why this is a policy
// dial rather than a bypass, and it is asserted in the tests rather than left
// to the reader.

import { queryOne } from './db';

export type VideoReleasePolicy = 'scan_required' | 'coach_attested';

export const DEFAULT_VIDEO_RELEASE_POLICY: VideoReleasePolicy = 'scan_required';

/**
 * States the scanner reached and then handed to a person. Releasable under
 * EVERY policy, including the strict default -- this is the set the route
 * already allowed.
 *
 * 'unconfigured' is here because an environment with no scanner has no verdict
 * coming; 'needs_human_review' because the screen looked and could not decide.
 */
const SCANNER_DEFERRED_STATES = ['needs_human_review', 'unconfigured'] as const;

/**
 * States where a verdict is still genuinely in flight. Releasable only under
 * 'coach_attested', where the uploading coach stands behind footage they
 * filmed rather than waiting on a scan.
 *
 * Under the strict policy these stay refused, because releasing ahead of a
 * scan that IS coming would make the gate optional for whoever clicks first.
 */
const AWAITING_VERDICT_STATES = ['pending', 'scanning'] as const;

/**
 * Never releasable, at any policy setting, on this route. Named explicitly so
 * that widening the policy vocabulary later cannot silently pick them up.
 */
export const NEVER_COACH_RELEASABLE_STATES = ['blocked', 'infected', 'error'] as const;

/**
 * The scan states a coach may release from under a given policy.
 *
 * Built by union rather than by subtraction: a new scan_state added later is
 * excluded until somebody deliberately adds it, which is the safe direction
 * for a set that governs footage of minors.
 */
export function releasableScanStates(policy: VideoReleasePolicy): string[] {
  if (policy === 'coach_attested') {
    return [...SCANNER_DEFERRED_STATES, ...AWAITING_VERDICT_STATES];
  }
  return [...SCANNER_DEFERRED_STATES];
}

/**
 * Read one organization's policy. Missing row -> the strict default, so a
 * failure to configure can never read as permission.
 */
export async function getVideoReleasePolicy(
  organizationId: string,
): Promise<VideoReleasePolicy> {
  const row = await queryOne<{ release_policy: string }>(
    `select release_policy from pilot.organization_video_policy
     where organization_id = $1`,
    [organizationId],
  );
  return row?.release_policy === 'coach_attested' ? 'coach_attested' : DEFAULT_VIDEO_RELEASE_POLICY;
}

/**
 * Record an organization's policy.
 *
 * The setter's account id is stored whenever the policy is not the default --
 * the database's own CHECK requires it. A control that can be relaxed has to
 * say by whom, or a deliberate exception and the shipped default look
 * identical a year later.
 */
export async function setVideoReleasePolicy(input: {
  organizationId: string;
  policy: VideoReleasePolicy;
  setByAccountId: string;
}): Promise<VideoReleasePolicy> {
  const row = await queryOne<{ release_policy: string }>(
    `insert into pilot.organization_video_policy
       (organization_id, release_policy, set_by_account_id)
     values ($1, $2, $3)
     on conflict (organization_id) do update
       set release_policy = excluded.release_policy,
           set_by_account_id = excluded.set_by_account_id,
           updated_at = now()
     returning release_policy`,
    [input.organizationId, input.policy, input.setByAccountId],
  );
  if (!row) {
    throw new Error('VIDEO_RELEASE_POLICY_WRITE_FAILED');
  }
  return row.release_policy as VideoReleasePolicy;
}
