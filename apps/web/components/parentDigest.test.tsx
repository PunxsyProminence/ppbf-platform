/**
 * @jest-environment jsdom
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';

import ParentDigest from './ParentDigest';

/**
 * The digest reads the two athlete-scoped APIs a guardian is actually
 * admitted to, and nothing else -- so the tests pin three things: the happy
 * read renders the coach's words attributed, the empty read renders honest
 * day-one copy rather than a blank, and a refused read says so instead of
 * pretending the corner is empty.
 */

function jsonResponse(body: unknown, ok = true): Promise<Response> {
  return Promise.resolve({
    ok,
    json: () => Promise.resolve(body),
  } as Response);
}

const originalFetch = global.fetch;

function installFetch(handler: (url: string) => Promise<Response>): void {
  global.fetch = jest.fn(async (input: unknown) => handler(String(input))) as unknown as typeof fetch;
}

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('the parent digest', () => {
  it('renders the coach\'s words, signed, and the milestones reached', async () => {
    installFetch((url) => {
      if (url.includes('/achievements/recognition')) {
        return jsonResponse({
          ok: true,
          items: [
            {
              recognition_id: 'rec-1',
              coach_display_name: 'Coach Neale',
              kind: 'effort',
              note: 'Worked the whole round without dropping her hands.',
              created_at: '2026-08-01T00:00:00Z',
            },
          ],
        });
      }
      if (url.includes('/achievements/milestones')) {
        return jsonResponse({
          ok: true,
          completed_sessions: 13,
          items: [
            {
              milestone_key: 'sessions-13',
              awarded_by_role: 'coach',
              note: 'Thirteen sessions on the card.',
              awarded_at: '2026-08-02T00:00:00Z',
            },
          ],
        });
      }
      return jsonResponse({}, false);
    });

    await act(async () => {
      render(<ParentDigest athleteId="ath-1" childName="Alex" />);
    });

    expect(await screen.findByText('Worked the whole round without dropping her hands.')).toBeTruthy();
    expect(screen.getByText(/Coach Neale/)).toBeTruthy();
    expect(screen.getByText(/13 sessions on the card/i)).toBeTruthy();
    expect(screen.getByText('sessions 13')).toBeTruthy();
    expect(screen.getByText(/Alex.s corner/)).toBeTruthy();
  });

  it('does not claim to show what changed since the parent last looked', async () => {
    // Neither fetch sends a since/after cursor and no last-seen state exists
    // anywhere in apps/web or infra, so a heading promising a delta was
    // promising something the component cannot know. Asserting the absence
    // rather than only the replacement is the half that stops the phrase
    // coming back: someone restoring the old wording alongside the new one
    // would satisfy a positive-only assertion.
    installFetch((url) => {
      if (url.includes('/achievements/recognition')) {
        return jsonResponse({ ok: true, items: [] });
      }
      return jsonResponse({ ok: true, completed_sessions: 0, items: [] });
    });

    await act(async () => {
      render(<ParentDigest athleteId="ath-1" childName="Alex" />);
    });

    expect(await screen.findByText(/Alex.s corner, as it stands/)).toBeTruthy();
    expect(screen.queryByText(/since you last looked/i)).toBeNull();
    // Nor a recency claim: achievements.ts orders milestones with unreached
    // ones first, so "newest first" would be the same defect reworded.
    expect(screen.queryByText(/most recent|newest first|new since/i)).toBeNull();
  });

  it('renders honest day-one copy when both lists are empty', async () => {
    installFetch((url) => {
      if (url.includes('/achievements/recognition')) {
        return jsonResponse({ ok: true, items: [] });
      }
      return jsonResponse({ ok: true, completed_sessions: 0, items: [] });
    });

    await act(async () => {
      render(<ParentDigest athleteId="ath-1" childName="Alex" />);
    });

    expect(await screen.findByText(/Nothing written up yet/)).toBeTruthy();
    expect(screen.getByText(/No milestones sealed yet/)).toBeTruthy();
  });

  it('says the corner could not be read when both reads fail, instead of faking empty', async () => {
    installFetch(() => jsonResponse({}, false));

    await act(async () => {
      render(<ParentDigest athleteId="ath-1" childName="Alex" />);
    });

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText(/Nothing written up yet/)).toBeNull();
  });

  it('reaches only the two guardian-admitted achievement routes', () => {
    // The source-level boundary, same style as the gym-wall module's test: no
    // path from this component to the session log or any member media.
    const { readFileSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const source = readFileSync(path.join(__dirname, 'ParentDigest.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');

    for (const forbidden of ['sessions/list', 'profile/photo', 'account_profiles', 'portraitUrl']) {
      expect({ forbidden, present: source.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
    expect(source.includes('/api/pilot/achievements/recognition')).toBe(true);
    expect(source.includes('/api/pilot/achievements/milestones')).toBe(true);
  });
});
