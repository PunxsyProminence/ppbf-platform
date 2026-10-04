/** @jest-environment jsdom */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import HomePage, { metadata } from './page';
import { metadata as rootMetadata } from './layout';

jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
jest.mock('./globals.css', () => ({}));
jest.mock('next/font/local', () => () => ({ variable: '' }));
jest.mock('@/components/GlobalRoleHeader', () => function GlobalRoleHeader() { return null; });
jest.mock('@/components/PlateVariantGround', () => function PlateVariantGround({ children }: { children: ReactNode }) { return <>{children}</>; });
jest.mock('@/components/ThemeProvider', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));

function renderPage() {
  const { container } = render(<HomePage />);
  // Visible text only: the JSON-LD script would otherwise satisfy every
  // parity check by itself.
  const visible = container.cloneNode(true) as HTMLElement;
  visible.querySelectorAll('script').forEach((s) => s.remove());
  const text = (visible.textContent ?? '').replace(/\s+/g, ' ');
  const script = container.querySelector('script[type="application/ld+json"]');
  const ld = JSON.parse(script?.innerHTML ?? '{}');
  const footer = (container.querySelector('footer')?.textContent ?? '').replace(/\s+/g, ' ');
  const about = (container.querySelector('#about')?.textContent ?? '').replace(/\s+/g, ' ');
  const mailtos = Array.from(container.querySelectorAll('a[href^="mailto:"]')).map((a) => a.getAttribute('href'));
  return { container, text, ld, footer, about, mailtos };
}

const LEGAL_NAME = 'Punxsy Prominence Boxing and Fitness';
const EIN = 'EIN 99-2073622';
const PHYSICAL = '220 N Jefferson St, Punxsutawney, PA 15767';
const MAILING = 'PO Box 54, Big Run, PA 15715';
const DOMAIN_STATEMENT = 'punxsyprominence.org is the official website and application of Punxsy Prominence Boxing and Fitness.';

test('legal name, EIN, physical address and domain statement show in the organization section and the footer', () => {
  const { about, footer } = renderPage();
  for (const fact of [LEGAL_NAME, EIN, PHYSICAL, DOMAIN_STATEMENT]) {
    expect(about).toContain(fact);
    expect(footer).toContain(fact);
  }
  expect(about).toContain(MAILING);
});

test('the private office address is not published', () => {
  const { text, ld } = renderPage();
  expect(text).not.toContain('204');
  expect(JSON.stringify(ld)).not.toContain('204');
});

test('support block links both monitored addresses and offers no payment button', () => {
  const { container, mailtos } = renderPage();
  expect(mailtos).toEqual(expect.arrayContaining(['mailto:treasurer@punxsyprominence.org', 'mailto:grants@punxsyprominence.org']));
  const support = container.querySelector('#support');
  expect(support?.textContent).toMatch(/Donations/);
  expect(support?.textContent).toMatch(/Grants and Funders/);
  expect(support?.querySelectorAll('button, form').length).toBe(0);
  expect(container.textContent).not.toMatch(/donate now|paypal|zeffy|givebutter|stripe/i);
});

test('unsupported claims are gone and Jason\'s figures replace them', () => {
  const { text } = renderPage();
  expect(text).not.toContain('500+');
  expect(text).not.toContain('2020');
  expect(text).not.toContain('100%');
  expect(text).not.toMatch(/hundreds of young people/i);
  expect(text).toContain('200+');
  expect(text).toContain('People have come through our doors since 2024');
  expect(text).toContain('For youth. Adults $20 a month.');
  expect(text).toContain('IRS-recognized 501(c)(3)');
  expect(text).toContain('supported by donations');
  expect(text).not.toContain('run on donations');
});

test('JSON-LD matches the visible facts', () => {
  const { ld, text, about } = renderPage();
  expect(ld['@type']).toBe('NGO');
  expect(ld.legalName).toBe(LEGAL_NAME);
  expect(about).toContain(ld.legalName);
  expect(text).toContain(`EIN ${ld.taxID}`);
  expect(ld.taxID).toBe('99-2073622');
  expect(ld.nonprofitStatus).toBe('https://schema.org/Nonprofit501c3');
  expect(ld.url).toBe('https://www.punxsyprominence.org/');
  expect(ld.email).toBe('admin@punxsyprominence.org');
  expect(text).toContain(ld.email);
  expect(text).toContain(ld.name);
  const a = ld.address;
  expect(a['@type']).toBe('PostalAddress');
  expect(`${a.streetAddress}, ${a.addressLocality}, ${a.addressRegion} ${a.postalCode}`).toBe(PHYSICAL);
  expect(about).toContain(`Established${ld.foundingDate}`);
  // Founder kept on Jason's say-so (2026-10-03); pinned so it cannot drift.
  expect(ld.founder).toEqual({ '@type': 'Person', name: 'Jason Neale', jobTitle: 'Head Coach/Governor' });
  expect(about).toContain('Head Coach / GovernorJason Neale');
  expect(about).toContain(ld.areaServed.name);
});

test('canonical and metadataBase use the www address', () => {
  expect(metadata.alternates?.canonical).toBe('https://www.punxsyprominence.org/');
  expect(String(rootMetadata.metadataBase)).toBe('https://www.punxsyprominence.org/');
});

test('the share-card alt text claims youth are free, not every family', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const alt = require('fs').readFileSync(require('path').join(__dirname, 'opengraph-image.alt.txt'), 'utf8');
  expect(alt).toContain('free for youth');
  expect(alt).not.toMatch(/free for all/i);
});

/* One front page (Jason, 2026-10-03): /public's form, programs and FAQ live
   here now, and nothing on them may contradict the facts above. */
test('the interest form is on the front page, with no consent checkbox', () => {
  const { container } = renderPage();
  const form = container.querySelector('#interest-intake form');
  expect(form).not.toBeNull();
  expect(form?.querySelector('input[type="checkbox"]')).toBeNull();
  expect(form?.querySelector('input[type="email"]')).not.toBeNull();
});

test('programs and FAQ moved over, and the program intro no longer miscounts them', () => {
  const { container, text } = renderPage();
  expect(container.querySelectorAll('#programs article').length).toBe(8);
  expect(text).not.toMatch(/four different reasons/i);
  expect(container.querySelectorAll('#public-faq details').length).toBeGreaterThan(0);
});

test('the FAQ cost answer carries the adult figure, not "ask us"', () => {
  const { container } = renderPage();
  const faq = (container.querySelector('#public-faq')?.textContent ?? '').replace(/\s+/g, ' ');
  expect(faq).toContain('Adults pay $20 a month.');
  expect(faq).toContain('Youth train free.');
  expect(faq).not.toMatch(/adults, ask us/i);
});

test('no claim on the page contradicts the registry facts', () => {
  const { text } = renderPage();
  expect(text).not.toMatch(/free for all/i);
  expect(text).not.toMatch(/ask us --/i);
  expect(text).toContain('veteran-led');
  // Internal surfaces stay off the public page.
  expect(text).not.toMatch(/tester guide/i);
});

test('the page does not link to /public, which forwards here', () => {
  const { container } = renderPage();
  const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');
  expect(hrefs.filter((h) => h === '/public' || h.startsWith('/public#'))).toEqual([]);
});

test('the server page reads form labels from a plain module, never from the client form', () => {
  /* A server component that indexes into an export of a 'use client' module
     gets a client-reference proxy and fails at render; jsdom cannot see that,
     so the boundary is pinned here instead (review finding on this PR). */
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs'); const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, 'page.tsx'), 'utf8');
  const options = fs.readFileSync(path.join(__dirname, '../components/publicInterestOptions.ts'), 'utf8');
  expect(page).not.toMatch(/import\s+\w*\s*,?\s*\{[^}]*\}\s*from\s*["']@\/components\/PublicInterestForm["']/);
  expect(options).not.toMatch(/^\s*['"]use client['"]/);
});
