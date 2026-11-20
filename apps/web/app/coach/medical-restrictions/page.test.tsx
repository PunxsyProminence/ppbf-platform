// /coach/medical-restrictions is the Medical Restrictions section of Athlete
// Safety now (lane AS-5, S2-3 A): the old address, bookmarks included, opens
// that section. The panel's own states are pinned in
// components/MedicalRestrictionsPanel.test.tsx; the page that mounts it, in
// app/coach/athlete-safety/page.test.tsx.

import MedicalRestrictionsAddress from './page';

const redirect = jest.fn();
jest.mock('next/navigation', () => ({ redirect: (to: string) => redirect(to) }));

test('the old address opens the Medical Restrictions section of Athlete Safety', () => {
  MedicalRestrictionsAddress();
  expect(redirect).toHaveBeenCalledWith('/coach/athlete-safety#medical-restrictions');
});
