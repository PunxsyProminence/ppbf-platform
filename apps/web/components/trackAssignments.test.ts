import { allTrackIds, trackManifests } from './trackAssignments';

// OD-2026-09-29-003 (Q6 A): school grades do not block training. The Collegiate
// Track's description said it "Enforces academic passing standards as a
// requirement for on-floor training access". Nothing did: a track is a label an
// admin toggles on /admin ("Who Trains On What"), saved per organization in
// pilot.admin_track_assignments, and nothing reads a grade or gates the floor
// on one. The description now says so, and no track may claim otherwise.
describe('track descriptions claim no grade gate on training', () => {
  test.each(allTrackIds)('%s', (trackId) => {
    const { desc, focusWorkout } = trackManifests[trackId];
    for (const text of [desc, ...focusWorkout]) {
      expect(text).not.toMatch(/passing standards?|academic (?:hold|eligibility|requirement)/i);
      expect(text).not.toMatch(/requirement for on-floor training access/i);
    }
  });

  test('the Collegiate Track says it reads no grades and gates nothing', () => {
    expect(trackManifests.collegiate.desc).toBe(
      'Tailored for student-athletes; its focus workout includes a study or homework block. It reads no grades and does not gate on-floor training access.',
    );
  });
});
