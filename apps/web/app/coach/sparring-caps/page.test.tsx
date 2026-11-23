// /coach/sparring-caps is the Sparring Caps section of Sparring and Limits now
// (lane AS-5, S2-3 A): the old address, bookmarks included, opens that section.

import SparringCapsAddress from './page';

const redirect = jest.fn();
jest.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

test('the old address opens the Sparring Caps section of Sparring and Limits', () => {
  SparringCapsAddress();
  expect(redirect).toHaveBeenCalledWith('/coach/sparring-exposure#sparring-caps');
});
