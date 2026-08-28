/**
 * @jest-environment jsdom
 */

/*
 * A red flag about a child used to wait for somebody to open the right page.
 *
 * /api/pilot/escalations is a pull surface by construction -- its own header
 * records that this platform sends no email, ever -- so an unacknowledged
 * high or critical escalation was visible only to a coach who chose to open
 * the escalation inbox or the coach workspace. Everything about the model
 * underneath was, and still is, correct: assigned-plus-covered scope,
 * athlete_voice excluded from coach reads, coach acknowledges and only admin
 * resolves, critical-first ordering. What was missing was reaching the coach.
 *
 * These tests hold three properties of the badge that closes that:
 *
 *   1. it is unmissable when there is something to see;
 *   2. it discloses a COUNT and nothing more, on a bar that renders on every
 *      screen in the building;
 *   3. its silence means "none", and only ever after a read that established
 *      it -- a failed read gets its own visible marker.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

import SafetyAttentionBadge from './SafetyAttentionBadge';

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...rest }: { readonly children: ReactNode; readonly href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

interface EscalationFixture {
  escalation_id: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  athlete_id?: string;
  reason?: string;
  source_type?: string;
}

function escalation(overrides: Partial<EscalationFixture> = {}): EscalationFixture {
  return {
    escalation_id: 'esc_1',
    severity: 'high',
    status: 'open',
    ...overrides,
  };
}

function installFetch(result: { ok?: boolean; escalations?: EscalationFixture[] } = {}): jest.Mock {
  const fetchMock = jest.fn(async () => ({
    ok: result.ok ?? true,
    status: result.ok === false ? 503 : 200,
    json: async () => ({ ok: true, escalations: result.escalations ?? [] }),
  } as unknown as Response));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function renderBadge(role: string | null, result: Parameters<typeof installFetch>[0] = {}) {
  const fetchMock = installFetch(result);
  await act(async () => {
    render(<SafetyAttentionBadge role={role} />);
  });
  return fetchMock;
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('the badge appears where a coach cannot walk past it', () => {
  test('an open critical escalation is named on the bar, with a way into the record', async () => {
    await renderBadge('coach', { escalations: [escalation({ severity: 'critical' })] });

    const link = screen.getByRole('link', { name: /Safety escalations needing acknowledgement/i });
    expect(link.getAttribute('href')).toBe('/admin/escalations');
    expect(screen.getByText(/1 critical/)).toBeTruthy();
  });

  test('critical and high are both counted, and critical leads', async () => {
    await renderBadge('coach', {
      escalations: [
        escalation({ escalation_id: 'e1', severity: 'high' }),
        escalation({ escalation_id: 'e2', severity: 'critical' }),
        escalation({ escalation_id: 'e3', severity: 'high' }),
      ],
    });

    expect(screen.getByText(/1 critical, 2 high/)).toBeTruthy();
  });

  test('a set with no critical still shows the highs', async () => {
    await renderBadge('coach', {
      escalations: [escalation({ escalation_id: 'e1' }), escalation({ escalation_id: 'e2' })],
    });

    expect(screen.getByText(/2 high/)).toBeTruthy();
    expect(screen.queryByText(/critical/)).toBeNull();
  });

  test('one critical among many highs still wears the top rung', async () => {
    // The badge stands for the worst thing waiting. A set containing a
    // critical is a critical situation however many highs sit beside it.
    const { container } = { container: document.body };
    await renderBadge('coach', {
      escalations: [
        escalation({ escalation_id: 'e1', severity: 'critical' }),
        escalation({ escalation_id: 'e2', severity: 'high' }),
      ],
    });

    expect(container.querySelector('.badge--locked')).toBeTruthy();
    expect(container.querySelector('.badge--restricted')).toBeNull();
  });

  test('a high-only set wears the rung below it', async () => {
    await renderBadge('coach', { escalations: [escalation()] });

    expect(document.body.querySelector('.badge--restricted')).toBeTruthy();
    expect(document.body.querySelector('.badge--locked')).toBeNull();
  });

  test('moderate and low do not raise the badge', async () => {
    // The order says high/critical must be extremely difficult to overlook.
    // Putting every severity on the chassis is how a person stops seeing the
    // row at all; moderate and low stay on the record, where they are worked.
    await renderBadge('coach', {
      escalations: [
        escalation({ escalation_id: 'e1', severity: 'moderate' }),
        escalation({ escalation_id: 'e2', severity: 'low' }),
      ],
    });

    expect(screen.queryByRole('link')).toBeNull();
  });
});

describe('the badge discloses a count, and nothing about a child', () => {
  test('no athlete id, reason, or source reaches the bar', async () => {
    // This bar renders on every surface, including whatever screen faces the
    // room. A safeguarding disclosure must not become readable over a coach's
    // shoulder because the chassis decided to be helpful.
    await renderBadge('coach', {
      escalations: [escalation({
        severity: 'critical',
        athlete_id: 'ath-rosa',
        reason: 'Repeated headache reports after contact rounds',
        source_type: 'athlete_voice',
      })],
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('1 critical');
    expect(text).not.toContain('ath-rosa');
    expect(text).not.toContain('headache');
    expect(text).not.toContain('athlete_voice');
  });
});

describe('silence means none, and only after a read that said so', () => {
  test('a clear read renders nothing at all', async () => {
    await renderBadge('coach', { escalations: [] });

    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Safety/);
  });

  test('a failed read says so rather than disappearing into the same silence', async () => {
    await renderBadge('coach', { ok: false });

    const link = screen.getByRole('link', { name: /could not be read/i });
    expect(link.getAttribute('href')).toBe('/admin/escalations');
    expect(screen.getByText('Safety: unread')).toBeTruthy();
  });

  test('a failed read never renders as a zero count', async () => {
    await renderBadge('coach', { ok: false });

    expect(document.body.textContent).not.toMatch(/0 critical/);
    expect(document.body.textContent).not.toMatch(/0 high/);
  });

  test('a thrown request is treated the same as a refused one', async () => {
    global.fetch = jest.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await act(async () => {
      render(<SafetyAttentionBadge role="coach" />);
    });

    expect(screen.getByText('Safety: unread')).toBeTruthy();
  });
});

describe('who this control exists for', () => {
  test.each(['coach', 'organization_admin', 'admin'])(
    'the %s role, whom /api/pilot/escalations serves, gets the read',
    async (role) => {
      const fetchMock = await renderBadge(role, { escalations: [escalation()] });

      expect(fetchMock).toHaveBeenCalled();
      expect(String(fetchMock.mock.calls[0][0])).toContain('/api/pilot/escalations?status=open');
    },
  );

  test.each(['athlete', 'parent', 'board', 'staff', 'volunteer', 'platform_owner'])(
    'the %s role gets no badge and no request',
    async (role) => {
      // The route refuses these roles. A control that can only ever fail is
      // worse than no control, and board in particular reads aggregates only.
      const fetchMock = await renderBadge(role, { escalations: [escalation({ severity: 'critical' })] });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByRole('link')).toBeNull();
    },
  );

  test('a session with no role asks nothing', async () => {
    const fetchMock = await renderBadge(null);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the count does not go stale while a coach sits on one screen', () => {
  test('it re-reads on an interval, so an escalation filed mid-session arrives', async () => {
    jest.useFakeTimers();
    let escalations: EscalationFixture[] = [];
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, escalations }),
    } as unknown as Response));
    global.fetch = fetchMock as unknown as typeof fetch;

    await act(async () => {
      render(<SafetyAttentionBadge role="coach" />);
    });
    expect(screen.queryByRole('link')).toBeNull();

    // Filed while the coach is looking at some other surface entirely.
    escalations = [escalation({ severity: 'critical' })];

    await act(async () => {
      jest.advanceTimersByTime(120_000);
    });

    await waitFor(() => expect(screen.getByText(/1 critical/)).toBeTruthy());
  });

  test('it does not poll for a role it does not serve', async () => {
    jest.useFakeTimers();
    const fetchMock = installFetch({ escalations: [] });

    await act(async () => {
      render(<SafetyAttentionBadge role="athlete" />);
    });
    await act(async () => {
      jest.advanceTimersByTime(600_000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the badge reads the existing record, not a second one', () => {
  test('it asks for open escalations on the route that already owns them', async () => {
    // No new queue, no new endpoint, no new table. If this ever starts
    // reading somewhere else, there are two answers to "is anyone flagged".
    const fetchMock = await renderBadge('coach', { escalations: [] });

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('/api/pilot/escalations?status=open');
  });

  test('it sends no athlete or organization scope of its own', async () => {
    // Scope is the server's: assigned plus actively covered athletes for a
    // coach, the organization for an admin. A client that offered either
    // would be offering a scope to widen.
    const fetchMock = await renderBadge('coach', { escalations: [] });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).not.toContain('athlete_id');
    expect(url).not.toContain('organization_id');
    expect(url).not.toContain('coach');
  });
});
