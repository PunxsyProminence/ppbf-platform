import {
  bootstrapCalibrationClip,
  parseCalibrationBootstrapArgv,
} from '../src/server/pilot/calibration/bootstrap';
import { closePool } from '../src/server/pilot/db';
import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Establishes one existing 'ready' video as a calibration study and clip, so
// the /coach/calibration annotation workflow has something to open.
//
// usage:
//   PPBF_EXPECTED_POSTGRES_HOSTNAME=... PPBF_EXPECTED_POSTGRES_DATABASE=... \
//   npm run calibration:bootstrap -- \
//     --organization-id org-x --video-session-id vs-y \
//     --project-name "Calibration round 1" --clip-code C-01 \
//     --start-ms 91337 --end-ms 97004 \
//     --sampling-reason simultaneous_exchange \
//     --created-by-account-id acct-z
//
// A THIN COMMAND LINE, deliberately. Everything it knows lives in
// src/server/pilot/calibration/bootstrap.ts, which is where the tests reach
// it -- the same split pilot-cleanup-sessions.ts uses against sessionPolicy.
// A script that held the rules itself would be a script nothing could test.
//
// THE WRITE-TARGET GUARD IS NOT OPTIONAL. This writes rows, and the guard
// exists because a run from a laptop or an agent shell holding a production
// connection string is exactly how 361 orphaned rows reached production on
// 2026-07-18. It fails closed when the expected host and database are unset,
// which is the point: a guard that skips when unconfigured protects only the
// environments that remembered it.

async function main(): Promise<void> {
  // Parsed before anything reaches the network: a mistyped flag should cost no
  // database connection at all.
  const request = parseCalibrationBootstrapArgv(process.argv.slice(2));

  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING;
  if (!connectionString?.trim()) {
    throw new Error('Missing required environment variable: AZURE_POSTGRES_CONNECTION_STRING');
  }
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const { project, clip } = await bootstrapCalibrationClip(request);

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`organization_id: ${project.organization_id}`);
  console.log(`calibration_project_id: ${project.calibration_project_id}`);
  console.log(`project_status: ${project.status}`);
  console.log(`ontology_version: ${project.ontology_version}`);
  console.log(`calibration_clip_id: ${clip.calibration_clip_id}`);
  // Printed because it is derived from the source video rather than supplied:
  // the operator should see which boxer the platform attributed the clip to,
  // or that the footage is unattributed team footage.
  console.log(`athlete_id: ${clip.athlete_id ?? '(none -- unattributed team footage)'}`);
  console.log(`video_session_id: ${clip.video_session_id}`);
  console.log(`clip_bounds_ms: ${clip.start_ms}-${clip.end_ms}`);
  console.log('PILOT CALIBRATION BOOTSTRAP PASS');
}

main()
  .catch((error: unknown) => {
    console.error('PILOT CALIBRATION BOOTSTRAP FAIL');
    console.error(String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
