/**
 * @jest-environment jsdom
 */

// The banner told four file-room pages that earlier stages were "Completed"
// purely because of which route was rendering it: opening /audit asserted that
// RESEARCH INTAKE, EVIDENCE REVIEW and KNOWLEDGE GRAPH were finished with
// nothing checking whether a single source had ever been approved. Position in
// a list is not progress.

import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';

import DevelopmentPipelineBanner from './DevelopmentPipelineBanner';
import { clearRoleSession, createPersistentRoleSession } from './roleSession';

afterEach(() => {
  act(() => clearRoleSession());
});

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
  render(<DevelopmentPipelineBanner currentStage="simulator" />);

  expect(screen.getByText('Stage 4 of 5: Validation Sandbox')).toBeTruthy();
  expect(screen.getByText('Next: Audit Trace')).toBeTruthy();
});

test('the last stage is the last stage, not a release announcement', () => {
  // Audit Trace is the last stage since lane N4-04 deleted the mock source
  // control and publish pages; the banner no longer links to either.
  const { container } = render(<DevelopmentPipelineBanner currentStage="audit" />);

  expect(container.textContent).not.toMatch(/Ecosystem Release Complete/);
  expect(screen.getByText('Stage 5 of 5: Audit Trace')).toBeTruthy();
  expect(screen.getByText('Next: this is the last stage')).toBeTruthy();
  expect(container.querySelector('a[href^="/source-control"]')).toBeNull();
});

test('every stage link but the current one is drawn the same way', () => {
  // The old banner styled stages behind you differently from stages ahead of
  // you, which is the same false claim made in colour rather than in words.
  // An admin's doors admit all five stages, so all five are links.
  createPersistentRoleSession('admin');
  const { container } = render(<DevelopmentPipelineBanner currentStage="simulator" />);

  const links = [...container.querySelectorAll('a')];
  expect(links).toHaveLength(5);

  const current = links.filter((link) => link.getAttribute('aria-current') === 'page');
  expect(current).toHaveLength(1);
  expect(current[0].textContent).toBe('Validation Sandbox');

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

// AS12-2, BOA-11 (OD-2026-10-17-001 ruling 1): each stage is named by the
// title of the page it opens. CSS draws the links in capitals; the words are
// the titles.
test('each stage label is the title of the page it opens', () => {
  // An admin's doors admit all five stages (lane AS4-4D4E: a stage is a link
  // only when its door admits the reader).
  createPersistentRoleSession('admin');
  const { container } = render(<DevelopmentPipelineBanner currentStage="research" />);

  const links = [...container.querySelectorAll('a')].map((link) => [link.textContent, link.getAttribute('href')]);
  expect(links).toEqual([
    ['Research Inbox', '/research'],
    ['Evidence Review Queue', '/evidence'],
    ['Concept Relationship Map', '/knowledge-graph'],
    ['Validation Sandbox', '/simulator'],
    ['Audit Trace', '/audit'],
  ]);
  expect(screen.getByText('Stage 1 of 5: Research Inbox')).toBeTruthy();
  expect(screen.getByText('Next: Evidence Review Queue')).toBeTruthy();
});

// Lane AS4-4D4E (app scrub BOA-09; Q2 = A on #2128): a stage is a link only
// when its door admits the reader. Audit Trace admits coaches, and its banner
// offered them Evidence Review Queue, whose gate refuses them.
describe('a stage is a link only when its door admits the reader', () => {
  const linkNames = (container: HTMLElement) => [...container.querySelectorAll('a')].map((a) => a.textContent);

  test('a coach on Audit Trace is not offered the admin-only stages', () => {
    createPersistentRoleSession('coach');
    const { container } = render(<DevelopmentPipelineBanner currentStage="audit" />);

    expect(linkNames(container)).toEqual(['Research Inbox', 'Audit Trace']);
    // Every stage is still named, in order, and the count still reads 5.
    expect(screen.getByText('Evidence Review Queue').tagName).toBe('SPAN');
    expect(screen.getByText('Stage 5 of 5: Audit Trace')).toBeTruthy();
  });

  test('the platform owner is not offered Audit Trace, whose gate refuses it', () => {
    createPersistentRoleSession('platform_owner');
    const { container } = render(<DevelopmentPipelineBanner currentStage="simulator" />);

    expect(linkNames(container)).toEqual(['Research Inbox', 'Evidence Review Queue', 'Concept Relationship Map', 'Validation Sandbox']);
    expect(screen.getByText('Audit Trace').tagName).toBe('SPAN');
  });

  test('with no session no stage is a link, and the current stage is still marked', () => {
    const { container } = render(<DevelopmentPipelineBanner currentStage="research" />);

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.getByText('Research Inbox').getAttribute('aria-current')).toBe('page');
  });
});
