import { IMAGERY_CONTENT_KEYS, SELF_TALK_CUE_KINDS } from '@/src/server/pilot/athleteMentalSkills';

import {
  CUE_KIND_LABELS,
  IMAGERY_AFTER,
  IMAGERY_SOURCE,
  IMAGERY_STEPS,
  SELF_TALK_EXPLAINER,
  VISIBILITY_LINES,
} from './content';

// The owner-approved wording, pinned verbatim (Jason, 2026-10-04, "Approve as
// written"). A failure here means the screen's words changed: that is a new
// question to Jason, not a test to update.

test('cue kinds match the server and carry both names', () => {
  expect(Object.keys(CUE_KIND_LABELS).sort()).toEqual([...SELF_TALK_CUE_KINDS].sort());
  expect(CUE_KIND_LABELS).toEqual({
    instructional: 'Technique (instructional)',
    motivational: 'Effort (motivational)',
  });
});

test('the self-talk explainer is the approved text', () => {
  expect(SELF_TALK_EXPLAINER).toBe(
    "Technique (instructional): a short reminder of how to do it, like 'hands home'. "
    + "Effort (motivational): a short push to keep going, like 'keep working'. "
    + 'Research reviews find technique cues help most with skill work and effort cues with hard, tiring work.',
  );
});

test('the imagery steps are the approved five, in order, then the log line', () => {
  expect(IMAGERY_STEPS).toEqual([
    'Pick ONE technique and say its name out loud (e.g. "jab").',
    'Stand still, hands up in your guard. No footwork, no punches.',
    'Close your eyes and picture yourself throwing that one technique, clean.',
    'Open your eyes and say the name again.',
    'Throw it once for real at working pace. Nothing else.',
  ]);
  expect(IMAGERY_AFTER).toBe('Then log how many minutes.');
});

test('the imagery content key is one the server accepts', () => {
  expect(IMAGERY_CONTENT_KEYS).toContain(IMAGERY_SOURCE.contentKey);
});

test('the who-can-see lines are the approved three', () => {
  expect(VISIBILITY_LINES).toEqual({
    athlete: 'Your coach and your guardian can see what you save here.',
    guardian: 'You see what your child saved, in their words. Their coach sees it too. Nothing here can be changed from this page.',
    coach: 'What the athlete saved, in their words. Their guardian sees the same. Read-only.',
  });
});
