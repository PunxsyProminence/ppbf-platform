import fs from 'node:fs';
import path from 'node:path';

import {
  SPARRING_SYMPTOMS,
  SPARRING_SYMPTOM_CONTEXTS,
  SPARRING_SYMPTOM_ESCALATION_SEVERITY,
  SPARRING_SYMPTOM_KEYS,
  SPARRING_SYMPTOM_MESSAGE,
  canonicalSymptoms,
  sparringSymptomSentLine,
} from './sparringSymptoms';

// The list the athlete taps and the list the database admits are one list: read the shipped SQL
// rather than restate it, so a symptom added on one side only fails here.
const MIGRATION = fs.readFileSync(
  path.resolve(__dirname, '../../../../infra/azure/pilot_slice_postgres_athlete_self_report_measures_migration.sql'),
  'utf8',
);

function quotedList(after: RegExp): string[] {
  const match = MIGRATION.match(after);
  if (!match) throw new Error(`not found: ${after}`);
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

describe('the sparring symptom list', () => {
  test('is exactly the list the database admits, in the same order', () => {
    expect(SPARRING_SYMPTOM_KEYS).toEqual(quotedList(/symptoms <@ array\[([^\]]+)\]/));
    expect([...SPARRING_SYMPTOM_CONTEXTS]).toEqual(quotedList(/context in \(([^)]+)\)/));
  });

  test('every item has words a child can read, each once', () => {
    for (const symptom of SPARRING_SYMPTOMS) expect(symptom.label.trim()).not.toBe('');
    expect(new Set(SPARRING_SYMPTOMS.map((symptom) => symptom.label)).size).toBe(SPARRING_SYMPTOMS.length);
  });

  test('a flag is never a score: one fixed severity, and ticks are kept in list order, each once', () => {
    expect(SPARRING_SYMPTOM_ESCALATION_SEVERITY).toBe('high');
    expect(canonicalSymptoms(['ringing', 'headache', 'ringing'])).toEqual(['headache', 'ringing']);
  });

  test("the fixed message is the ruled sentence, and the sent line follows the gym's recipient", () => {
    expect(SPARRING_SYMPTOM_MESSAGE).toBe("Tell your coach now, and follow the gym's rules for head knocks.");
    expect(sparringSymptomSentLine('coach')).toBe('Your coach has been sent this.');
    expect(sparringSymptomSentLine('organization_admin')).toBe('Gym staff have been sent this.');
  });
});
