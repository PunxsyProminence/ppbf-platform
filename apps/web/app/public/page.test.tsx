import { permanentRedirect } from 'next/navigation';

import PublicPage from './page';

jest.mock('next/navigation', () => ({
  permanentRedirect: jest.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

test('/public forwards permanently to the one front page at /', () => {
  expect(() => PublicPage()).toThrow('NEXT_REDIRECT');
  expect(permanentRedirect).toHaveBeenCalledWith('/');
});
