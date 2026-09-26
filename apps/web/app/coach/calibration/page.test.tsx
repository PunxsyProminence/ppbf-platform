import { redirect } from 'next/navigation';

import CoachCalibrationAliasPage from './page';

jest.mock('next/navigation', () => ({ redirect: jest.fn() }));

/*
 * Clip Annotation moved to Teach Shadow. This URL stays behind because it is
 * in people's history and in whatever a coach bookmarked mid-study, and a 404
 * would read as "the annotation tool is gone" -- the opposite of what
 * happened.
 *
 * ASSERTED RATHER THAN ASSUMED because the failure is silent in both
 * directions: a redirect to a path that no longer exists lands on a 404 just
 * the same, and a redirect quietly deleted leaves the old URL dead with
 * nothing failing anywhere. components/internalLinksResolve.test.ts proves the
 * target resolves to a real page; this proves that target is the one named.
 */
test('sends the old Clip Annotation URL to where Clip Annotation now lives', () => {
  CoachCalibrationAliasPage();

  expect(redirect).toHaveBeenCalledWith('/teach-shadow/annotation');
});
