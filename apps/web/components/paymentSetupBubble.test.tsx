/**
 * @jest-environment jsdom
 */

// A setup prompt earns its place by disappearing. These cover the three ways
// it must stay silent -- setup complete, request refused, request failed --
// because a hint that lingers or that shouts on failure is worse than none.

import { render, screen, waitFor } from '@testing-library/react';

import PaymentSetupBubble from './PaymentSetupBubble';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 403,
    json: async () => body,
  } as Response;
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function mockFetch(impl: () => Promise<Response>): jest.Mock {
  const fetchMock = jest.fn(impl);
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('payment setup bubble', () => {
  test('lists the remaining steps while setup is unfinished', async () => {
    mockFetch(async () => jsonResponse({
      ready: false,
      enabled: false,
      lanes: { giving: 'not_connected', program: 'not_connected' },
      remainingSteps: ['Open the Stripe accounts, starting with Giving.', 'Connect the Program account.'],
    }));

    render(<PaymentSetupBubble />);

    expect(await screen.findByText('Finish connecting payments')).toBeTruthy();
    expect(screen.getByText('Connect the Program account.')).toBeTruthy();
  });

  test('renders nothing once setup is complete', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({
      ready: true,
      enabled: true,
      lanes: { giving: 'connected', program: 'connected' },
      remainingSteps: [],
    }));

    const { container } = render(<PaymentSetupBubble />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  test('renders nothing when the caller is refused', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ error: 'Forbidden' }, false));

    const { container } = render(<PaymentSetupBubble />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  test('a failed request leaves the page exactly as it was', async () => {
    const fetchMock = mockFetch(async () => { throw new Error('offline'); });

    const { container } = render(<PaymentSetupBubble />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  test('an empty step list renders nothing even if ready is absent', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ remainingSteps: [] }));

    const { container } = render(<PaymentSetupBubble />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
