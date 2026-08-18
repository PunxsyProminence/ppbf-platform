// #440/#439 shipped two new pilot.safety_escalations source_types
// ('compliance_violation', 'video_scan') without touching this page, which
// kept its own separate source_type union and label map -- so escalations
// of those types (and the pre-existing 'incident') rendered a blank Source
// cell instead of a label. The page now imports SafetyEscalationSourceType
// from escalationLadder.ts instead of re-declaring it, and SOURCE_LABEL
// (the object the Source column actually reads, `{SOURCE_LABEL[item.
// source_type]}`) is typed Record<SafetyEscalationSourceType, string>, so a
// future new source_type missing a label fails `npx tsc --noEmit`. This
// file asserts the same property at runtime against the real canonical
// value list, so the suite also catches it if that type-level guard is
// ever loosened (e.g. widened to Record<string, string>).
//
// No `@jest-environment jsdom` docblock here on purpose: this only needs
// the plain values, not a rendered DOM, and escalationLadder.ts pulls in
// 'pg' (via db.ts/boardSummary.ts) at module scope -- 'pg' references
// TextEncoder, which this repo's jsdom test environment does not provide,
// so importing it under `@jest-environment jsdom` throws before any test
// runs. escalationLadder.test.ts avoids the same trap by mocking './db';
// staying in the default 'node' environment sidesteps it entirely here.

import { SAFETY_ESCALATION_SOURCE_TYPES } from '@/src/server/pilot/escalationLadder';
import { SOURCE_LABEL } from './page';

describe('SOURCE_LABEL', () => {
  test.each(SAFETY_ESCALATION_SOURCE_TYPES)('%s has a non-blank label', (sourceType) => {
    expect(SOURCE_LABEL[sourceType]).toBeTruthy();
  });

  test('has exactly one label per canonical source_type -- no stale or missing keys', () => {
    expect(Object.keys(SOURCE_LABEL).sort()).toEqual([...SAFETY_ESCALATION_SOURCE_TYPES].sort());
  });
});
