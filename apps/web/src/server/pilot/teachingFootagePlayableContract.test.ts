import fs from 'node:fs';
import path from 'node:path';

/**
 * EVERY CLIP THAT CAN LEGALLY EXIST MUST HAVE A SOURCE SOMEBODY CAN WATCH.
 *
 * WHAT WENT WRONG, because this file exists for one specific failure and the
 * next reader deserves it plainly.
 *
 * Two rules landed a day apart, each correct, each with a passing suite:
 *
 *   2026-09-24  95f106e0  assertVideoClippable began REQUIRING a capture
 *               take -- only footage recorded to teach Shadow may become a
 *               study clip. Pinned by calibrationProjects.pg.test.ts, "footage
 *               that was not recorded to teach Shadow cannot be cut into a
 *               study clip".
 *   2026-09-25  4982943d  GET /api/pilot/video/[videoId] began REFUSING a
 *               capture take -- teaching footage is not Film Study media.
 *               Pinned by that route's own suite, take-backed video -> 404.
 *
 * Together they meant EVERY clip that could legally exist had a source video
 * the only playback route 404'd, and the annotation page fetches exactly that
 * route. The labelling screen could not play anything it was allowed to show.
 * It shipped to production and sat there, because no suite could see both
 * halves at once: each tested its own route and each was right.
 *
 * The refusal's own comment even named an escape hatch -- "Teach Shadow's own
 * review goes through /api/pilot/video/review-link and is unaffected" -- and
 * that was wrong too: authorizeVideoScanReview refuses anything not
 * 'quarantined', so released teaching footage had no playback path anywhere.
 *
 * WHY THIS TEST IS A SOURCE READ AND NOT A RUNTIME ONE. The property is about
 * the RELATIONSHIP between two modules that never call each other, so there is
 * no single execution to instrument -- which is exactly why unit tests missed
 * it. What can be checked is that the door still exists and is still reachable
 * from the surfaces that need it. A cheap check that fires on the real mistake
 * beats an elaborate one nobody writes.
 *
 * A RULE EARNS ITS PLACE BY CATCHING A REAL FAILURE. This one has already
 * caught its: it is written after the fact, and its job is to make the same
 * contradiction impossible to reintroduce quietly.
 */

const WEB_ROOT = path.resolve(__dirname, '../../..');

const TEACHING_STREAM_ROUTE = path.join(
  WEB_ROOT,
  'app/api/pilot/teach-shadow/footage/[videoId]/stream/route.ts',
);
const FILM_STUDY_ROUTE = path.join(WEB_ROOT, 'app/api/pilot/video/[videoId]/route.ts');
const CLIP_GATE = path.join(WEB_ROOT, 'src/server/pilot/calibration/projects.ts');
const CUTTER_PAGE = path.join(WEB_ROOT, 'app/teach-shadow/cut/page.tsx');
const ANNOTATION_PAGE = path.join(WEB_ROOT, 'app/teach-shadow/annotation/page.tsx');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

describe('teaching footage has a playback path', () => {
  test('the Film Study route still refuses teaching footage -- the separation is not the bug', () => {
    /*
     * POSITIVE CONTROL FOR THE OTHER DIRECTION. The fix must not be "let the
     * Film Study route serve teaching footage after all": that would undo the
     * separation TS-01 exists for, and this suite would then be passing while
     * a different rule broke. Both halves are asserted so a future change
     * cannot satisfy one by discarding the other.
     */
    expect(read(FILM_STUDY_ROUTE)).toContain('capture_take_id !== null');
  });

  test('and only teaching footage may be cut into a clip -- also unchanged', () => {
    expect(read(CLIP_GATE)).toContain('capture_take_id');
    expect(read(CLIP_GATE)).toContain('not_teaching_footage');
  });

  test('so teaching footage has a route of its own', () => {
    // THE CLAIM THAT FAILED BEFORE. With both refusals above in place and no
    // third route, every legal clip is unwatchable.
    expect(fs.existsSync(TEACHING_STREAM_ROUTE)).toBe(true);
  });

  test('that route is gated by the same question the cut asks', () => {
    /*
     * assertVideoClippable, not a hand-rolled status check. A second opinion
     * about "may this footage be used for teaching work" is a second opinion
     * that can drift: footage that stops being clippable must stop being
     * watchable here in the same instant, and sharing the call is what
     * guarantees that rather than hoping for it.
     */
    const source = read(TEACHING_STREAM_ROUTE);
    expect(source).toContain('assertVideoClippable');
    expect(source).toContain('requireAnnotator');
  });

  test('it does not borrow the safeguarding review link', () => {
    /*
     * review-link exists so a designated reviewer can look at QUARANTINED
     * footage in order to decide about it. Borrowing it for ordinary teaching
     * work would turn a narrow safeguarding exception into a general way to
     * watch unscanned video of children -- the annotation page states this
     * rule for itself and it holds here for the same reason.
     *
     * The IMPORT is what is checked, not the name: this route's own header
     * discusses authorizeVideoScanReview at length to explain why review-link
     * does not cover released footage, and a test that failed on the
     * explanation would punish writing one down.
     */
    expect(read(TEACHING_STREAM_ROUTE)).not.toContain("from '@/src/server/pilot/videoScanReview'");
  });

  test('and the cutter page uses it rather than the Film Study route', () => {
    // The page-level half of the same contradiction: a cutter that fetched
    // /api/pilot/video/[videoId] would be broken on arrival, exactly as the
    // annotation page was.
    const page = read(CUTTER_PAGE);
    expect(page).toContain('/api/pilot/teach-shadow/footage/');
    expect(page).not.toContain('/api/pilot/video/');
  });

  test('and so does the annotation page -- the surface the contradiction was found on', () => {
    /*
     * THE HALF THIS SUITE MISSED. #1018 built the teaching door, wired the
     * cutter to it and wrote the test above -- and left the annotation page
     * fetching the Film Study route, with its own page suite requiring exactly
     * that. The header of this file described the annotation page's failure
     * and then checked only the cutter, so the original defect stayed in
     * place under a suite written to prevent it (found 2026-10-02,
     * TEACH-DATA-01).
     *
     * Same two assertions as the cutter, for the same reason: the page must
     * ask the teaching door, and must not mention the Film Study video route
     * or the review link under it at all.
     */
    const page = read(ANNOTATION_PAGE);
    expect(page).toContain('/api/pilot/teach-shadow/footage/');
    expect(page).not.toContain('/api/pilot/video/');
  });
});
