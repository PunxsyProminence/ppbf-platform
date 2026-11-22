/**
 * PATTERN-1d (PunxsyProminence/ppbf-platform#2082, Q2 A): the pure parts of a
 * sampled window. A chance's episode is a name-based UUID (version 5) of the
 * gym, the window and the chance, so every coach who taps chance 4 of one
 * window writes to the same attempt, and nothing else does.
 */

import { uuidV5, windowEpisodeId } from './behaviourObservations';
import { contextOf, windowChances } from './behaviourSampleWindows';

describe('the episode of a window chance', () => {
  test('uuidV5 is RFC 4122 version 5: the published DNS-namespace example', () => {
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  test('a chance\'s episode has the table\'s ep:<uuid> shape, version 5, and is the same every time', () => {
    const id = windowEpisodeId('org-1', '11111111-1111-4111-8111-111111111111', 4);
    expect(id).toMatch(/^ep:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(windowEpisodeId('org-1', '11111111-1111-4111-8111-111111111111', 4)).toBe(id);
  });

  test('another chance, another window or another gym is another episode', () => {
    const id = windowEpisodeId('org-1', '11111111-1111-4111-8111-111111111111', 4);
    expect(new Set([
      id,
      windowEpisodeId('org-1', '11111111-1111-4111-8111-111111111111', 5),
      windowEpisodeId('org-1', '22222222-2222-4222-8222-222222222222', 4),
      windowEpisodeId('org-2', '11111111-1111-4111-8111-111111111111', 4),
    ]).size).toBe(4);
  });
});

describe('a window\'s number of chances (Q7 A)', () => {
  test('ten unless the coach says otherwise; a whole number from 1 to 50', () => {
    expect(windowChances(undefined)).toBe(10);
    expect(windowChances(1)).toBe(1);
    expect(windowChances(50)).toBe(50);
    for (const bad of [0, 51, 2.5, -1, '10', null, Number.NaN]) {
      expect(() => windowChances(bad)).toThrow('A window has 1 to 50 chances.');
    }
  });
});

describe('the drill or context a window is about', () => {
  test('read back as the writer takes it', () => {
    expect(contextOf({ context_kind: 'drill', context_id: 'drill-1' })).toEqual({ drillId: 'drill-1' });
    expect(contextOf({ context_kind: 'block', context_id: 'block-1' })).toEqual({ blockId: 'block-1' });
    expect(contextOf({ context_kind: 'context', context_id: 'session' })).toEqual({ attemptContext: 'session' });
  });
});
