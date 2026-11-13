import { DONATION_LINKS } from './donationLinks';

test('the two donation links are exactly the live Stripe links', () => {
  expect(DONATION_LINKS.oneTime).toBe('https://donate.stripe.com/28E5kw6HV69t5AQaR8gQE00');
  expect(DONATION_LINKS.monthly).toBe('https://donate.stripe.com/5kQ6oAeanapJbZe0cugQE01');
});
