/** @jest-environment jsdom */
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';

import PrivacyPage, { metadata } from './page';

jest.mock('next/link', () => ({ __esModule: true, default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));

function text() {
  const { container } = render(<PrivacyPage />);
  return (container.textContent ?? '').replace(/\s+/g, ' ');
}

test("states Jason's privacy terms as written", () => {
  const t = text();
  for (const line of [
    'Punxsy Prominence Boxing and Fitness (EIN 99-2073622) runs this website, punxsyprominence.org.',
    'Only to answer you about our programs. Sending the form is your request for us to contact you.',
    'PPBF staff who handle new members. We do not sell or share it.',
    'We keep it for 12 months, then delete it, unless you join.',
    'The form is for people 13 or older; a parent or guardian can send it for a younger child.',
    'To see, correct or delete what you sent, email admin@punxsyprominence.org.',
    'Punxsy Prominence Boxing and Fitness, PO Box 54, Big Run, PA 15715 · admin@punxsyprominence.org',
  ]) {
    expect(t).toContain(line);
  }
});

test('lists every field the interest form actually sends', () => {
  expect(text()).toContain(
    'your name, email, phone number if you give it, who you are, the program you are interested in, how you would like us to contact you, and any message you write',
  );
});

test('is titled Privacy with its own canonical address', () => {
  expect(metadata.title).toBe('Privacy');
  expect(metadata.alternates?.canonical).toBe('https://www.punxsyprominence.org/privacy');
});
