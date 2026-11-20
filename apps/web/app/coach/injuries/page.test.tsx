// /coach/injuries is the Injury Record section of Athlete Safety now (lane
// AS-5, S2-3 A): the old address, bookmarks included, opens that section.

import InjuryRecordAddress from './page';

const redirect = jest.fn();
jest.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

test('the old address opens the Injury Record section of Athlete Safety', () => {
  InjuryRecordAddress();
  expect(redirect).toHaveBeenCalledWith('/coach/athlete-safety#injury-record');
});
