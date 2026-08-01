// The authoring picker offers keys; the server refuses keys that are not in
// the vocabulary its anchor_type names, and nothing in the schema catches that
// failing. So a picker that drifted from the server's lists would hand a coach
// a topic that cannot be published, and a lesson already stored under a key the
// picker forgot would render with no topic at all. Both directions are checked
// here rather than left to whoever notices first.

import {
  RABBIT_HOLE_ANCHOR_TYPES as SERVER_ANCHOR_TYPES,
  RABBIT_HOLE_AUDIENCES as SERVER_AUDIENCES,
  RABBIT_HOLE_CLOSED_ANCHOR_KEYS as SERVER_CLOSED_KEYS,
} from '@/src/server/pilot/rabbitHoles';
import { RABBIT_HOLE_ANCHOR_TYPES as COMPONENT_ANCHOR_TYPES } from './RabbitHole';
import {
  ANCHOR_KEY_OPTIONS,
  ANCHOR_TYPE_LABELS,
  AUTHORABLE_ANCHOR_TYPES,
  RABBIT_HOLE_AUDIENCE_OPTIONS,
  anchorKeyLabel,
  anchorLabel,
  audienceLabel,
} from './rabbitHoleAnchorLabels';

// Only the vocabularies are wanted from the server module; the driver behind
// them has no place in a client-module test.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

test('every anchor type the server admits has a readable name here', () => {
  expect(Object.keys(ANCHOR_TYPE_LABELS).sort()).toEqual([...SERVER_ANCHOR_TYPES].sort());
  expect([...COMPONENT_ANCHOR_TYPES].sort()).toEqual([...SERVER_ANCHOR_TYPES].sort());

  // A blank label would leave a lesson's topic rendering as nothing.
  for (const label of Object.values(ANCHOR_TYPE_LABELS)) {
    expect(label.trim().length).toBeGreaterThan(0);
  }
});

test('the pickable anchor types are exactly the ones whose keys are constants', () => {
  expect([...AUTHORABLE_ANCHOR_TYPES].sort()).toEqual(Object.keys(SERVER_CLOSED_KEYS).sort());
  expect(Object.keys(ANCHOR_KEY_OPTIONS).sort()).toEqual(Object.keys(SERVER_CLOSED_KEYS).sort());
});

test('each pickable vocabulary offers exactly the keys the server will accept', () => {
  for (const anchorType of AUTHORABLE_ANCHOR_TYPES) {
    const offered = ANCHOR_KEY_OPTIONS[anchorType].map((option) => option.key);
    expect(offered).toEqual([...SERVER_CLOSED_KEYS[anchorType]]);

    // Every offered key reads as something other than the raw slug, or as the
    // slug because the slug IS the platform's name for it -- never as blank.
    for (const option of ANCHOR_KEY_OPTIONS[anchorType]) {
      expect(option.label.trim().length).toBeGreaterThan(0);
    }
  }
});

test('the audience picker offers exactly the audiences the server admits', () => {
  expect([...RABBIT_HOLE_AUDIENCE_OPTIONS].sort()).toEqual([...SERVER_AUDIENCES].sort());
  for (const audience of RABBIT_HOLE_AUDIENCE_OPTIONS) {
    expect(audienceLabel(audience)).not.toEqual(audience);
  }
});

test('a lesson anchored to an organization-scoped vocabulary still names its topic', () => {
  // A drill id and a compliance rule slug cannot be enumerated client-side, so
  // the key itself is what the surface says. It must not render blank.
  expect(anchorKeyLabel('drill', 'drill-slip-rope-01')).toBe('drill-slip-rope-01');
  expect(anchorLabel('drill', 'drill-slip-rope-01')).toBe('Drill: drill-slip-rope-01');
  expect(anchorLabel('compliance_rule', 'annual-background-check')).toBe(
    'Compliance rule: annual-background-check',
  );
});

test('a key that has left its vocabulary reads as the key rather than as nothing', () => {
  expect(anchorKeyLabel('gap_type', 'not-a-gap-type')).toBe('not-a-gap-type');
  expect(anchorLabel('gap_type', 'technique')).toBe('Progression gap type: Technique');
});
