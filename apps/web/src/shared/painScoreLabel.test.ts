import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  PAIN_ESCALATION_LABEL,
  PAIN_REPORT_TRIGGER,
  isPainReportEscalation,
  isPainReportNearMiss,
  painScoreFromMetadata,
  painScoreLabel,
} from './painScoreLabel';

describe('painScoreLabel (#1528: the number only)', () => {
  test('a score reads N/10 and nothing else', () => {
    expect(painScoreLabel(2)).toBe('2/10');
    expect(painScoreLabel(10)).toBe('10/10');
  });

  test('no score says so, and never borrows a severity word', () => {
    expect(painScoreLabel(null)).toBe('Score not recorded');
    expect(painScoreLabel(undefined)).toBe('Score not recorded');
    expect(painScoreLabel(Number.NaN)).toBe('Score not recorded');
  });

  test('the score is read from metadata.severity_1_10 only when it is a number', () => {
    expect(painScoreFromMetadata({ severity_1_10: 7 })).toBe(7);
    expect(painScoreFromMetadata({ severity_1_10: '7' })).toBeNull();
    expect(painScoreFromMetadata({})).toBeNull();
    expect(painScoreFromMetadata(null)).toBeNull();
  });

  test('a pain near miss is told by its trigger', () => {
    expect(isPainReportNearMiss({ trigger: 'athlete_pain_report' })).toBe(true);
    expect(isPainReportNearMiss({ trigger: 'contact_clearance' })).toBe(false);
    expect(isPainReportNearMiss(undefined)).toBe(false);
  });

  test('a pain escalation is told by trigger or, for a repeated pattern, trigger_key', () => {
    expect(isPainReportEscalation({ trigger: 'athlete_pain_report' })).toBe(true);
    expect(isPainReportEscalation({ trigger_key: 'athlete_pain_report' })).toBe(true);
    expect(isPainReportEscalation({ trigger_key: 'contact_clearance' })).toBe(false);
    expect(isPainReportEscalation(null)).toBe(false);
    expect(PAIN_ESCALATION_LABEL).toBe('Pain report');
  });

  test('the trigger is the stored value painReportAlert.ts writes', () => {
    const source = readFileSync(path.join(__dirname, '../server/pilot/formulas/painReportAlert.ts'), 'utf8');
    expect(source).toContain(`const PAIN_REPORT_TRIGGER = '${PAIN_REPORT_TRIGGER}';`);
  });
});
