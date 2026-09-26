import {
  AUTO_CHECK_IN_NOTE_PATTERN,
  NO_ATHLETE_NOTE_PLACEHOLDER,
  isSystemCheckInNote,
} from './sessionNoteSemantics';

// These strings are not decoration: they are the difference between showing a
// coach something a child wrote and showing them something a slider wrote.
// The cases below are the ways that distinction has broken or could break --
// a constant quietly reworded so historical rows stop being recognised, an
// anchor dropped so a real note containing the phrase is swallowed, or the
// recognizer becoming stateful so the second call disagrees with the first.

describe('the stored strings are pinned, not merely referenced', () => {
  // Rewording either of these does not migrate anything. Every row already
  // carrying the old text silently stops being recognised as the system's and
  // starts reading as a sentence the athlete wrote.
  it('is the exact placeholder A-FIN-01 writes', () => {
    expect(NO_ATHLETE_NOTE_PLACEHOLDER).toBe('No athlete note provided at check-in.');
  });

  it('matches the three historical readiness bands and nothing else', () => {
    expect(AUTO_CHECK_IN_NOTE_PATTERN.source).toBe('^Auto check-in readiness (GREEN|YELLOW|RED)$');
  });
});

describe('system notes are recognised', () => {
  it('recognises the fixed no-note placeholder', () => {
    expect(isSystemCheckInNote(NO_ATHLETE_NOTE_PLACEHOLDER)).toBe(true);
  });

  it.each(['GREEN', 'YELLOW', 'RED'])('recognises the historical Auto check-in readiness %s', (band) => {
    expect(isSystemCheckInNote(`Auto check-in readiness ${band}`)).toBe(true);
  });
});

describe('an athlete’s own words are never treated as the system’s', () => {
  it.each([
    'Left shoulder still sore from Tuesday.',
    'ready to go',
    '',
    ' ',
  ])('treats %j as a human note', (note) => {
    expect(isSystemCheckInNote(note)).toBe(false);
  });

  // The pattern is anchored at both ends on purpose. Without the anchors a
  // child who wrote a sentence mentioning the band would have their note
  // silently classified as machine text and dropped from the coach's screen.
  it.each([
    'Auto check-in readiness GREEN today',
    'felt Auto check-in readiness GREEN',
    'Auto check-in readiness BLUE',
    'auto check-in readiness green',
    'No athlete note provided at check-in. But actually my knee hurts.',
  ])('does not swallow %j', (note) => {
    expect(isSystemCheckInNote(note)).toBe(false);
  });
});

// Guards the day somebody adds a /g flag: a global regex carries lastIndex
// between calls, so the same note would alternate between system and human
// and a coach's screen would flicker on re-render.
it('gives the same answer every time it is asked', () => {
  const note = 'Auto check-in readiness RED';
  expect([1, 2, 3].map(() => isSystemCheckInNote(note))).toEqual([true, true, true]);
});
