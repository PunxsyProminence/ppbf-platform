/* The two Stripe donation links, stated once (OD-2026-11-12-004).
   Both are hosted by Stripe; this site holds no payment code. The monthly link
   is a suggested donation, never a fee, and neither is described as
   tax-deductible here. */
export const DONATION_LINKS = {
  oneTime: 'https://donate.stripe.com/28E5kw6HV69t5AQaR8gQE00',
  monthly: 'https://donate.stripe.com/5kQ6oAeanapJbZe0cugQE01',
} as const;
