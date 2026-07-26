import { normalizeTrackAssignments } from './trackAssignments';

describe('normalizeTrackAssignments', () => {
  test.each([null, undefined, [], 'invalid'])(
    'keeps a missing or malformed assignment payload empty: %p',
    (input) => {
      expect(normalizeTrackAssignments(input)).toEqual({});
    },
  );

  test('keeps only explicit, known tracks and never invents a default', () => {
    expect(normalizeTrackAssignments({
      ' athlete-1 ': ['usa_boxing', 'not-a-track'],
      'athlete-2': [],
      'athlete-3': 'non_contact',
      '': ['non_contact'],
    })).toEqual({
      'athlete-1': ['usa_boxing'],
      'athlete-2': [],
      'athlete-3': [],
    });
  });
});
