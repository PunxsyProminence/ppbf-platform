/**
 * @jest-environment jsdom
 */

// Make a session script from an open workout template (lane L1). What these
// pin: one press sends one POST naming only the template; the result on screen
// is the server's answer and nothing more -- made (201, even when the body
// cannot be read), not made (a refusal, with its reason), or not known (no
// answer, or a server fault) -- and the link lands on the plan that was made.

import type { ReactNode } from 'react';
import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';

import MakeSessionScript from './MakeSessionScript';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@/lib/apiBase', () => ({ apiBase: () => '' }));

function answer(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('unreadable');
      return body;
    },
  } as Response;
}

function mockFetch(handler: () => Response | Promise<Response>) {
  const fetchMock = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit?]>(async () => handler());
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

const MADE = { script: { script_id: 'scr new/1', name: 'Boxing Fundamentals 60', blocks: [{}, {}, {}] } };

const press = () => fireEvent.click(screen.getByRole('button', { name: 'Make a session script' }));

describe('make a session script', () => {
  it('one press posts the template and nothing else, and the result links to the plan that was made', async () => {
    const fetchMock = mockFetch(() => answer(201, MADE));
    render(<MakeSessionScript templateId="wt-1" />);

    press();

    expect(await screen.findByRole('status')).toHaveTextContent('Made the session script Boxing Fundamentals 60: 3 blocks.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/pilot/session-scripts');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ template_id: 'wt-1' });
    expect(screen.getByRole('link', { name: 'Open it in Session Scripts' }))
      .toHaveAttribute('href', '/coach/session-scripts?script=scr%20new%2F1');
    // Made once: the button that would make a second is gone.
    expect(screen.queryByRole('button', { name: 'Make a session script' })).toBeNull();
  });

  it('a 201 whose body cannot be read still says a script was made', async () => {
    mockFetch(() => answer(201, undefined));
    render(<MakeSessionScript templateId="wt-1" />);

    press();

    expect(await screen.findByRole('status')).toHaveTextContent(/A session script was made, but its details could not be read here/);
    expect(screen.getByRole('link', { name: 'Open it in Session Scripts' })).toHaveAttribute('href', '/coach/session-scripts');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each([
    ['WORKOUT_TEMPLATE_NOT_CURRENT', 409, /no longer in use, so no session script was made/],
    ['WORKOUT_TEMPLATE_EMPTY', 409, /has no steps, so no session script was made/],
    ['WORKOUT_TEMPLATE_NOT_FOUND', 404, /could not be found, so no session script was made/],
    ['SOMETHING_NEW', 403, /The server refused, so no session script was made/],
  ])('a refusal (%s) says nothing was made and why, and the button stays', async (code, status, sentence) => {
    mockFetch(() => answer(status, { error: code }));
    render(<MakeSessionScript templateId="wt-1" />);

    press();

    expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByRole('button', { name: 'Make a session script' })).not.toBeDisabled();
  });

  it('no answer, a server fault, or a 4xx that is not the app\'s is "not known": it never says nothing was made', async () => {
    const handlers = [
      () => { throw new Error('offline'); },
      () => answer(500, { error: 'boom' }),
      // A timeout or a rate limit from something in between carries no error of the app's.
      () => answer(429, undefined),
      () => answer(408, {}),
    ];
    for (const handler of handlers) {
      mockFetch(handler);
      const view = render(<MakeSessionScript templateId="wt-1" />);

      press();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/it is not known whether the session script was made/);
      expect(alert).not.toHaveTextContent(/no session script was made/i);
      expect(screen.getByRole('link', { name: 'Session Scripts' })).toHaveAttribute('href', '/coach/session-scripts');
      view.unmount();
    }
  });

  it('a double tap makes one script', async () => {
    let finish: ((value: Response) => void) | null = null;
    const fetchMock = mockFetch(() => new Promise<Response>((resolve) => { finish = resolve; }));
    render(<MakeSessionScript templateId="wt-1" />);

    // Both taps land before React re-renders, as a real double tap can.
    await act(async () => {
      press();
      press();
    });
    expect(screen.getByRole('button', { name: 'Making...' })).toBeDisabled();
    await act(async () => {
      finish?.(answer(201, MADE));
    });

    expect(await screen.findByRole('status')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tells the page while the request is running, and when it has answered', async () => {
    let finish: ((value: Response) => void) | null = null;
    mockFetch(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const onBusyChange = jest.fn();
    render(<MakeSessionScript templateId="wt-1" onBusyChange={onBusyChange} />);

    await act(async () => press());
    expect(onBusyChange.mock.calls).toEqual([[true]]);
    await act(async () => {
      finish?.(answer(201, MADE));
    });

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it('says what a block with no minutes is given, as a length and not a start', () => {
    mockFetch(() => answer(201, MADE));
    render(<MakeSessionScript templateId="wt-1" />);

    expect(screen.getByText(/A block with no minutes\s+is given 5\./)).toBeInTheDocument();
  });
});
