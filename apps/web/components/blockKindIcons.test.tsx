/**
 * @jest-environment jsdom
 */

import { render } from '@testing-library/react';

import { vocabularyValues } from '@/src/server/pilot/contentImport/vocabularies';

import { BLOCK_KIND_WORDS, BlockKindIcon, blockKindWord } from './blockKindIcons';

/**
 * Every kind a session block can have (the plan's own vocabulary, which the importer and the
 * database check constraint share: contentImport/vocabularies.ts block_kind) gets a pictogram and a
 * word on the gym TV. Lane L39; Jason 2026-10-17, drill icons "Both" (part one: the real kinds).
 */
describe('block kind pictograms', () => {
  const kinds = vocabularyValues('block_kind');

  it('covers exactly the kinds a block can have', () => {
    expect(kinds.length).toBeGreaterThan(5);
    expect(Object.keys(BLOCK_KIND_WORDS).sort()).toEqual([...kinds].sort());
  });

  it('draws each kind as a decorative picture with no lettering in it', () => {
    for (const kind of kinds) {
      const { container, unmount } = render(<BlockKindIcon kind={kind} />);
      const svg = container.querySelector('svg');
      expect({ kind, drawn: svg !== null }).toEqual({ kind, drawn: true });
      expect(svg?.getAttribute('aria-hidden')).toBe('true');
      expect(svg?.getAttribute('data-kind')).toBe(kind);
      expect(svg?.querySelector('text')).toBeNull();
      expect(svg?.textContent).toBe('');
      expect(svg?.querySelectorAll('path, rect, circle').length).toBeGreaterThan(0);
      unmount();
    }
  });

  it('gives each kind its own picture', () => {
    const drawings = kinds.map((kind) => render(<BlockKindIcon kind={kind} />).container.innerHTML.replace(/data-kind="[^"]*"/, ''));
    expect(new Set(drawings).size).toBe(kinds.length);
  });

  it('uses the coach screens\' words where they exist, and a word for every kind', () => {
    expect(blockKindWord('drill_round')).toBe('Drill');
    expect(blockKindWord('reset_minute')).toBe('Reset');
    expect(blockKindWord('teaching_minute')).toBe('Teaching');
    expect(blockKindWord('conditioning')).toBe('Conditioning');
    expect(blockKindWord('reflection')).toBe('Reflection');
    for (const kind of kinds) expect(blockKindWord(kind)).toMatch(/^[A-Z][a-z]+$/);
  });

  it('draws nothing and names nothing for a kind it does not know', () => {
    expect(blockKindWord('sparring')).toBeNull();
    expect(blockKindWord('toString')).toBeNull();
    expect(render(<BlockKindIcon kind="sparring" />).container.innerHTML).toBe('');
  });
});
