/**
 * @jest-environment jsdom
 */

// The banner told four file-room pages that earlier stages were "Completed"
// purely because of which route was rendering it: opening /audit asserted that
// RESEARCH INTAKE, EVIDENCE REVIEW and KNOWLEDGE GRAPH were finished with
// nothing checking whether a single source had ever been approved. Position in
// a list is not progress.

import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';

import DevelopmentPipelineBanner from './DevelopmentPipelineBanner';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

test('claims no stage is complete, on the page furthest down the pipeline', () => {
  const { container } = render(<DevelopmentPipelineBanner currentStage="audit" />);

  expect(container.textContent).not.toMatch(/Completed/i);
  expect(container.textContent).not.toMatch(/RESEARCH INTAKE \/ EVIDENCE REVIEW/);
  expect(screen.getByText(/This is the order of the stages, not their progress/i)).toBeTruthy();
});

test('says where you are standing, counted rather than judged', () => {
  render(<DevelopmentPipelineBanner currentStage="audit" />);

  expect(screen.getByText('Stage 5 of 7: AUDIT TRACE')).toBeTruthy();
  expect(screen.getByText('Next: SOURCE CONTROL')).toBeTruthy();
});

test('the last stage is the last stage, not a release announcement', () => {
  const { container } = render(<DevelopmentPipelineBanner currentStage="publish" />);

  expect(container.textContent).not.toMatch(/Ecosystem Release Complete/);
  expect(screen.getByText('Next: Publish is the last stage')).toBeTruthy();
});

test('every stage link but the current one is drawn the same way', () => {
  // The old banner styled stages behind you differently from stages ahead of
  // you, which is the same false claim made in colour rather than in words.
  const { container } = render(<DevelopmentPipelineBanner currentStage="simulator" />);

  const links = [...container.querySelectorAll('a')];
  expect(links).toHaveLength(7);

  const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
  expect(current).toHaveLength(1);
  expect(current[0].textContent).toBe('SCENARIO SIMULATOR');

  const others = links.filter((link) => link.getAttribute('aria-current') !== 'page');
  expect(new Set(others.map((link) => link.className)).size).toBe(1);
});

test('no label is written in the form Tailwind v4 drops on the floor', () => {
  // `text-[var(--x)]` is ambiguous between a length and a colour and emits
  // nothing at all, so the current-stage label fell back to inherited ink at
  // roughly 1.3:1 -- invisible on every file-room page. `text-[color:...]` is
  // the form that lands. RoleStandaloneView.tsx:45-47 documents the trap.
  const { container } = render(<DevelopmentPipelineBanner currentStage="research" />);

  for (const node of container.querySelectorAll('[class]')) {
    expect(node.className).not.toMatch(/(?:^|\s)(?:text|bg|border)-\[var\(/);
  }
});

test('stands on leather rather than on the night ground', () => {
  const { container } = render(<DevelopmentPipelineBanner currentStage="research" />);

  const banner = container.querySelector('section');
  expect(banner?.className).toContain('mat-leather');
  expect(banner?.className).not.toContain('hide-950');
});
