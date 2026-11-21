/**
 * HF2 (lane HF12). Ask SHADOW told athletes "No coach is notified" and "it
 * does not reach a coach". Ask SHADOW posts to /api/pilot/athlete/chat, which
 * forwards to the SHADOW chat route, where detectShadowDisclosure files a
 * safety alert: to the coach of record, any covering coach and the admins, or
 * to the admins only (shadowDisclosure.ts). So those words were false whenever
 * a disclosure was detected.
 *
 * The words themselves are Jason's call (Overwatch on PR 2059, Q3). These tests
 * pin what every version must say to be true, not the exact wording: an alert
 * CAN reach a coach or the gym office, and otherwise no coach sees it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ASK_SHADOW_HELP_LINE,
  ASK_SHADOW_SAFESPORT_LINE,
  ASK_SHADOW_SENT_LINE,
} from './askShadowWords';

const LINES: ReadonlyArray<[string, string]> = [
  ['ASK_SHADOW_SENT_LINE', ASK_SHADOW_SENT_LINE],
  ['ASK_SHADOW_HELP_LINE', ASK_SHADOW_HELP_LINE],
  ['ASK_SHADOW_SAFESPORT_LINE', ASK_SHADOW_SAFESPORT_LINE],
];

const WORKSPACE_SOURCE = readFileSync(path.join(__dirname, 'AthleteWorkspace.tsx'), 'utf8');

describe('every Ask SHADOW line is true when a safety alert is filed', () => {
  test.each(LINES)('%s says a coach or the gym office can be alerted', (_name, line) => {
    expect(line).toMatch(/\bcoach\b/i);
    expect(line).toMatch(/\bgym office\b/i);
    expect(line).toMatch(/\bcan (?:get an alert|be alerted)\b/i);
  });

  test.each(LINES)('%s says no coach sees it otherwise', (_name, line) => {
    expect(line).toMatch(/\bno coach sees it\b/i);
  });

  test.each(LINES)('%s does not say no coach is ever told', (_name, line) => {
    expect(line).not.toMatch(/no coach is notified|does not reach a coach|no coach is told/i);
  });

  test.each(LINES)('%s is plain text a screen can show', (_name, line) => {
    expect(line.trim()).toBe(line);
    expect(line).not.toMatch(/[<>{}]/);
  });
});

describe('AthleteWorkspace shows these lines and not the old ones', () => {
  test('the false sentences are gone from the athlete workspace', () => {
    expect(WORKSPACE_SOURCE).not.toMatch(/No coach is notified/);
    expect(WORKSPACE_SOURCE).not.toMatch(/does not reach a coach/);
    expect(WORKSPACE_SOURCE).not.toMatch(/no coach is notified\./);
  });

  test('it imports each line from askShadowWords', () => {
    expect(WORKSPACE_SOURCE).toMatch(/from '\.\/askShadowWords'/);
    for (const [name] of LINES) {
      // Imported and used at least once beyond the import.
      expect(WORKSPACE_SOURCE.split(name).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});
