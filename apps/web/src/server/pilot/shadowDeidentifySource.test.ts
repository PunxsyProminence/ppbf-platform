/**
 * The retention purge script cannot import dataDeletion.ts, so the SHADOW
 * de-identification lives twice: namePattern and the chat-log statements in
 * scripts/pilot-cleanup-deleted-data.mjs and in dataDeletion.ts. The two
 * paths must leave the same thing behind (deletedAthleteSafetyScreens
 * pins that for the rows; this pins the text), so a change to one copy that
 * misses the other fails here rather than in production a year on.
 *
 * Compared: every SQL template literal and regex in each function, in order,
 * with the TypeScript annotations removed and whitespace collapsed.
 */

import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = fs.readFileSync(path.join(WEB_ROOT, 'scripts/pilot-cleanup-deleted-data.mjs'), 'utf8');
const FUNCTION = fs.readFileSync(path.join(WEB_ROOT, 'src/server/pilot/dataDeletion.ts'), 'utf8');

function block(source: string, start: string): string {
  const from = source.indexOf(start);
  if (from < 0) throw new Error(`missing ${start}`);
  const to = source.indexOf('\n}\n', from);
  return source.slice(from, to + 3);
}

/** Strips what TypeScript adds: `export`, parameter and return types, generics. */
function normalize(text: string): string {
  return text
    .replace(/^export /gm, '')
    .replace(/\): Promise<[^>]*(?:>[^>]*)?>\s*\{/g, ') {')
    .replace(/\): string \| null \{/g, ') {')
    .replace(/: (?:Array<[^>]*>|PoolClient|ShadowPurgeSubject\[\]|string(?: \| null)?)(?=[,)])/g, '')
    .replace(/new (Set|Map)<[^>]*(?:>[^>]*)?>\(/g, 'new $1(')
    .replace(/\(column: string\)/g, '(column)')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the two retention purge paths share one SHADOW de-identification', () => {
  test.each(['function namePattern(', 'async function deidentifyShadowChatAudit(', 'async function clearShadowProfileMentions('])(
    '%s is the same text in the script and in dataDeletion.ts',
    (start) => {
      const scriptCopy = normalize(block(SCRIPT, start));
      // Compared: every SQL statement and regex, in order. The surrounding
      // control flow differs by design (the script guards optional tables and
      // returns the script's count shape), so it is not compared.
      const functionCopy = normalize(block(FUNCTION, start));
      expect(sqlOf(functionCopy).length).toBeGreaterThan(0);
      expect(sqlOf(functionCopy)).toEqual(sqlOf(scriptCopy));
    },
  );
});

/** Every SQL template literal and regex in a block, in order. */
function sqlOf(text: string): string[] {
  return [...text.matchAll(/`[^`]*`|\/(?:\\.|[^/\n])+\/[gimsuy]*/g)].map((match) => match[0]);
}
