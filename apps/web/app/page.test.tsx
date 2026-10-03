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
});

test('JSON-LD matches the visible facts', () => {
  const { ld, text, about } = renderPage();
  expect(ld['@type']).toBe('NGO');
  expect(ld.legalName).toBe(LEGAL_NAME);
  expect(about).toContain(ld.legalName);
  expect(text).toContain(`EIN ${ld.taxID}`);
  expect(ld.taxID).toBe('99-2073622');
  expect(ld.nonprofitStatus).toBe('https://schema.org/Nonprofit501c3');
  expect(ld.url).toBe('https://punxsyprominence.org/');
  expect(ld.email).toBe('admin@punxsyprominence.org');
  expect(text).toContain(ld.email);
  expect(text).toContain(ld.name);
  const a = ld.address;
  expect(a['@type']).toBe('PostalAddress');
  expect(`${a.streetAddress}, ${a.addressLocality}, ${a.addressRegion} ${a.postalCode}`).toBe(PHYSICAL);
  expect(about).toContain(`Established${ld.foundingDate}`);
});

test('canonical and metadataBase use the bare domain', () => {
  expect(metadata.alternates?.canonical).toBe('https://punxsyprominence.org/');
  expect(String(rootMetadata.metadataBase)).toBe('https://punxsyprominence.org/');
});

test('the share-card alt text claims youth are free, not every family', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const alt = require('fs').readFileSync(require('path').join(__dirname, 'opengraph-image.alt.txt'), 'utf8');
  expect(alt).toContain('free for youth');
  expect(alt).not.toMatch(/free for all/i);
});
