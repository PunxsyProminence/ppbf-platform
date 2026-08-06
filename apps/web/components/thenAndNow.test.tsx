/**
 * @jest-environment jsdom
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';

import ThenAndNow from './ThenAndNow';

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({ ok, json: () => Promise.resolve(body) } as Response);
}

const originalFetch = global.fetch;

function installFetch(handler: (url: string) => Promise<Response>): void {
  global.fetch = jest.fn(async (input: unknown) => handler(String(input))) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('the then-and-now frame', () => {
  it('holds day one against the current record', async () => {
    installFetch((url) => {
      if (url.includes('/sessions/list')) {
        return jsonResponse({
          items: [
            { date: '2026-07-01', created_at: '2026-07-01T18:00:00Z' },
            { date: '2026-01-12', created_at: '2026-01-12T18:00:00Z' },
            { date: '2026-08-01', created_at: '2026-08-01T18:00:00Z' },
          ],
        });
      }
      if (url.includes('/achievements/milestones')) {
        return jsonResponse({
          ok: true,
          items: [
            { milestone_key: 'sessions-13', note: '', awarded_at: '2026-07-20T00:00:00Z' },
            { milestone_key: 'first_week', note: '', awarded_at: '2026-01-19T00:00:00Z' },
          ],
        });
      }
      return jsonResponse({
        ok: true,
        items: [
          {
            recognition_id: 'rec-1',
            coach_display_name: 'Coach Neale',
            note: 'Kept her guard up the whole round.',
            created_at: '2026-08-01T00:00:00Z',
          },
        ],
      });
    });

    await act(async () => {
      render(<ThenAndNow athleteId="ath-1" />);
    });

    // Then: the EARLIEST session date, not list order.
    expect(await screen.findByText(/January 12, 2026/)).toBeTruthy();
    expect(screen.getByText('first week')).toBeTruthy();
    // Now: the count, the latest seal, the latest signed word.
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('sessions 13')).toBeTruthy();
    expect(screen.getByText(/Kept her guard up/)).toBeTruthy();
    expect(screen.getByText(/Coach Neale/)).toBeTruthy();
  });

  it('says the frame fills itself when there is no history yet', async () => {
    installFetch((url) => {
      if (url.includes('/sessions/list')) return jsonResponse({ items: [] });
      return jsonResponse({ ok: true, items: [] });
    });

    await act(async () => {
      render(<ThenAndNow athleteId="ath-1" />);
    });

    expect(await screen.findByText(/This frame fills itself/)).toBeTruthy();
  });

  it('renders nothing at all without a resolved athlete identity', () => {
    const { container } = render(<ThenAndNow athleteId={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('is built from the record, never from photographs', () => {
    // The portrait store keeps one image per member, overwritten on replace,
    // so a photo before/after cannot exist here -- pin that this component
    // never reaches for member media.
    const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const source = readFileSync(path.join(__dirname, 'ThenAndNow.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    for (const forbidden of ['profile/photo', 'account_profiles', 'portraitUrl', 'gym-photos', '<img']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });
});
