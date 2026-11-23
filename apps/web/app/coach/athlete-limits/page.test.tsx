// /coach/athlete-limits is the Athlete Limits section of Sparring and Limits
// now (lane AS-5, S2-3 A): the old address, bookmarks included, opens that section.

import AthleteLimitsAddress from './page';

const redirect = jest.fn();
jest.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

test('the old address opens the Athlete Limits section of Sparring and Limits', () => {
  AthleteLimitsAddress();
  expect(redirect).toHaveBeenCalledWith('/coach/sparring-exposure#athlete-limits');
});
