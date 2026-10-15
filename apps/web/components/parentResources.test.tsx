/**
 * @jest-environment jsdom
 */

// The Resources tab for one child's family (#1593, PH-11): each published
// resource with its type, summary and one action -- an app page opened in
// the app, an external address in a new tab with no referrer -- an empty
// state, and a failed read that says so.

import '@testing-library/jest-dom';
import { act, render, screen, within } from '@testing-library/react';

import ParentResources, { type ParentResourceItem } from './ParentResources';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

const INTERNAL: ParentResourceItem = {
  resource_id: 'r1', title: 'Hydration for young boxers', summary: 'What to drink around training.', resource_type: 'guide',
  destination_kind: 'internal', destination: '/help',
};
const EXTERNAL: ParentResourceItem = {
  resource_id: 'r2', title: 'Junior sparring policy', summary: 'How sparring works for juniors.', resource_type: 'policy',
  destination_kind: 'external', destination: 'https://example.org/policy.pdf',
};

async function renderWith(response: Response) {
  const fetchMock = jest.fn(async () => response);
  global.fetch = fetchMock as unknown as typeof fetch;
  await act(async () => {
    render(<ParentResources athleteId="ath-1" />);
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads the child’s resources; an app page opens in the app, an external one in a new tab with no referrer', async () => {
  const fetchMock = await renderWith(jsonResponse({ ok: true, items: [INTERNAL, EXTERNAL] }));

  expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/pilot/parent/resources?athlete_id=ath-1');
  const [guide, policy] = within(screen.getByRole('list', { name: 'Resources' })).getAllByRole('listitem');
  expect(guide!.textContent).toContain('Guide');
  expect(guide!.textContent).toContain('What to drink around training.');
  const read = within(guide!).getByRole('link', { name: 'Read the guide' });
  expect(read).toHaveAttribute('href', '/help');
  expect(read).not.toHaveAttribute('target');

  const open = within(policy!).getByRole('link', { name: /Read the policy/ });
  expect(open).toHaveAttribute('href', 'https://example.org/policy.pdf');
  expect(open).toHaveAttribute('target', '_blank');
  expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  expect(open.textContent).toContain('opens in a new tab');
});

test('nothing published says so', async () => {
  await renderWith(jsonResponse({ ok: true, items: [] }));
  expect(screen.getByText('No resources have been published for your family yet.')).toBeInTheDocument();
});

test('a failed read says so and never that nothing is published', async () => {
  await renderWith(jsonResponse({ error: 'boom' }, false));
  expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
  expect(screen.queryByText('No resources have been published for your family yet.')).toBeNull();
});
