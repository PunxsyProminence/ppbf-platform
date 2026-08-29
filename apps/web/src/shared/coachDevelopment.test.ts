/**
 * The shared coach-development vocabulary, and the two things it exists to
 * stop: the two client surfaces calling one state by two different names, and
 * a state this build does not know rendering as a state it does.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  COACH_DEVELOPMENT_GOAL_STATUSES,
  COACH_DEVELOPMENT_GOAL_STATUS_LABEL,
  COACH_DEVELOPMENT_TOPIC_PROMPTS,
  coachDevelopmentGoalStatusLabel,
} from './coachDevelopment';

describe('the goal status vocabulary', () => {
  test('every state has a label, and no label is blank', () => {
    for (const status of COACH_DEVELOPMENT_GOAL_STATUSES) {
      expect([status, COACH_DEVELOPMENT_GOAL_STATUS_LABEL[status]?.trim() || '']).toEqual([
        status,
        COACH_DEVELOPMENT_GOAL_STATUS_LABEL[status],
      ]);
      expect(COACH_DEVELOPMENT_GOAL_STATUS_LABEL[status].trim()).not.toBe('');
    }
  });

  test('the label map names these four states and no others', () => {
    expect(Object.keys(COACH_DEVELOPMENT_GOAL_STATUS_LABEL).sort())
      .toEqual([...COACH_DEVELOPMENT_GOAL_STATUSES].sort());
  });

  test('a known state is called what the map calls it', () => {
    expect(coachDevelopmentGoalStatusLabel('active')).toBe('Working on it');
    expect(coachDevelopmentGoalStatusLabel('cancelled')).toBe('Cancelled');
  });

  /* THE HONESTY CASE. A status from a newer server is shown as the word it
     arrived as. It is never reported as 'Draft' -- which would be this build
     inventing a state for a row it cannot read -- and never as nothing, which
     would render a goal with no state at all. */
  test('a state this build does not know is shown as itself, not as a known one', () => {
    expect(coachDevelopmentGoalStatusLabel('paused')).toBe('paused');
    expect(coachDevelopmentGoalStatusLabel('paused')).not.toBe('Draft');
  });

  test('a status that is missing entirely reads as Unknown, never as a state', () => {
    expect(coachDevelopmentGoalStatusLabel('')).toBe('Unknown');
    for (const status of COACH_DEVELOPMENT_GOAL_STATUSES) {
      expect(coachDevelopmentGoalStatusLabel('')).not.toBe(
        COACH_DEVELOPMENT_GOAL_STATUS_LABEL[status],
      );
    }
  });
});

describe('the topic prompts', () => {
  test('are the five the feature has always carried', () => {
    expect([...COACH_DEVELOPMENT_TOPIC_PROMPTS]).toEqual([
      'Boxing Technique Instruction',
      'Youth Development Psychology',
      'Injury Prevention Basics',
      'Class Management Skills',
      'Adaptive Coaching',
    ]);
  });
});

/*
 * THE POINT OF THE MODULE, held as a source assertion rather than a type one.
 *
 * A duplicated union does not fail to compile. Both client surfaces once
 * declared their own copy of the four statuses and their own copy of the row
 * shapes, and a fifth status added server-side would have compiled clean on
 * all three and rendered wrong on two. Types cannot catch a second declaration
 * of themselves, so this reads the files.
 */
describe('the vocabulary is declared once', () => {
  const files = {
    hub: 'components/CoachWorkspace.tsx',
    page: 'app/coach/development/page.tsx',
    server: 'src/server/pilot/coachDevelopment.ts',
  } as const;

  function source(relative: string): string {
    return readFileSync(resolve(__dirname, '../../', relative), 'utf8');
  }

  test.each(Object.entries(files))(
    '%s does not carry its own copy of the status union',
    (_name, relative) => {
      const text = source(relative);
      // The four states written out as a union or an array literal, in any order
      // of quoting -- which is how all three copies were spelled.
      const inlineUnion = /'draft'\s*\|\s*'active'|\[\s*'draft',\s*'active',\s*'completed',\s*'cancelled'\s*\]/;
      expect([relative, inlineUnion.test(text)]).toEqual([relative, false]);
    },
  );

  test('the two client surfaces import the vocabulary rather than restating it', () => {
    for (const relative of [files.hub, files.page]) {
      expect([relative, source(relative).includes("from '@/src/shared/coachDevelopment'")])
        .toEqual([relative, true]);
    }
  });

  test('the hub does not recite the topic list as prose', () => {
    const text = source(files.hub);
    // Two of the five, spelled out in a sentence, is what stood here.
    expect(text).not.toContain('Youth Development\n                    Psychology');
    expect(text).toContain('COACH_DEVELOPMENT_TOPIC_PROMPTS');
  });
});
