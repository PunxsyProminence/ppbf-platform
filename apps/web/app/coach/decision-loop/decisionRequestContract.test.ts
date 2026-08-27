// A CONTROL MUST NOT REPORT AN EFFECT IT DOES NOT HAVE.
//
// The decision loop's "Record Decision" form sent a field the server does not
// read. `isMedicallySensitive` came off a checkbox labelled "Medically
// sensitive (checks medical status before allowing this decision)", and
// /api/pilot/shadow/decisions never mentioned it: its DecisionRequestBody
// declares four fields, the handler validates those four, and recordDecision
// takes no sensitivity parameter at all. So the box changed nothing in either
// direction -- and the label taught a coach that the clearance check was
// theirs to arm, on the surface where "is this child cleared to train" is
// decided.
//
// The server side of that hole was already closed: shadowDecisions.ts runs
// assertMedicalStatusAllowsRecommendation unconditionally, and
// shadowDecisions.test.ts pins it ("checks the medical status guard on every
// decision, whatever the topic"). What was left behind was the control, still
// on screen, still in the request body, still describing a gate it did not
// operate.
//
// This gate reads source rather than behaviour on purpose: the defect is not
// that a request fails, it is that a request carries a field nothing consumes,
// which no runtime assertion on the response can see. Same instrument as
// aiRuntimeIsolation.convention.test.ts and the other convention gates in this
// repository.

import fs from 'node:fs';
import path from 'node:path';

const WEB_ROOT = path.resolve(__dirname, '../../..');
const PAGE = path.join(WEB_ROOT, 'app', 'coach', 'decision-loop', 'page.tsx');
const ROUTE = path.join(WEB_ROOT, 'app', 'api', 'pilot', 'shadow', 'decisions', 'route.ts');

/**
 * Top-level keys of the object literal handed to JSON.stringify in the fetch
 * that POSTs to /api/pilot/shadow/decisions.
 *
 * Brace-counted rather than regex-matched to the closing paren, so a nested
 * object in the body (there is none today) would not silently truncate the
 * key set and make this gate pass by reading less than the page sends.
 */
function clientRequestFields(source: string): string[] {
  // The backtick is part of the anchor: the same page also GETs
  // `/api/pilot/shadow/decisions?athleteId=...`, and anchoring on the bare
  // path found that read first and then walked into the NEXT
  // JSON.stringify on the page -- the medical-status POST -- so the gate
  // would have graded a different request than the one it names.
  const anchor = source.indexOf('/api/pilot/shadow/decisions`');
  if (anchor === -1) {
    throw new Error('decision-loop page no longer POSTs to /api/pilot/shadow/decisions');
  }
  if (!/method:\s*'POST'/.test(source.slice(anchor, anchor + 400))) {
    throw new Error('the /api/pilot/shadow/decisions call this gate reads is no longer a POST');
  }
  const start = source.indexOf('JSON.stringify({', anchor);
  if (start === -1) {
    throw new Error('decision POST no longer carries a JSON.stringify body literal');
  }

  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) {
    throw new Error('decision POST body literal is unterminated');
  }

  const body = source.slice(open + 1, end);
  const fields: string[] = [];
  let nesting = 0;
  for (const line of body.split('\n')) {
    const key = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (nesting === 0 && key) fields.push(key[1]);
    // Shorthand (`athleteId,`) is a key too, and it names itself.
    const shorthand = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*$/.exec(line);
    if (nesting === 0 && shorthand) fields.push(shorthand[1]);
    nesting += (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
  }
  return [...new Set(fields)];
}

/**
 * Source with comments removed.
 *
 * The last assertion below is about CODE -- a state hook, a prop, a body
 * field. The page's own comment explaining why the removed checkbox was
 * removed necessarily names it, and a naive scan of the raw file would read
 * that explanation as the defect and forbid the repository from recording why
 * the control is gone.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The fields the route's own request contract declares it reads. */
function serverRequestFields(source: string): string[] {
  const match = /interface DecisionRequestBody \{([\s\S]*?)\}/.exec(source);
  if (!match) {
    throw new Error('shadow/decisions route no longer declares DecisionRequestBody');
  }
  return [...match[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)].map((m) => m[1]);
}

describe('coach decision-loop -> POST /api/pilot/shadow/decisions', () => {
  const pageSource = fs.readFileSync(PAGE, 'utf8');
  const routeSource = fs.readFileSync(ROUTE, 'utf8');
  const clientFields = clientRequestFields(pageSource);
  const serverFields = serverRequestFields(routeSource);
  const pageCode = withoutComments(pageSource);

  // Vacuity floors. An empty client field list or an empty server contract
  // would make the membership assertion below pass while proving nothing --
  // the same failure mode as an it.each over an empty array.
  test('both sides of the contract were actually parsed', () => {
    expect(clientFields.length).toBeGreaterThanOrEqual(3);
    expect(serverFields.length).toBeGreaterThanOrEqual(3);
    expect(clientFields).toContain('decisionText');
    expect(serverFields).toContain('decisionText');
    // Comment-stripping must not have eaten the page. If it had, the last
    // assertion would pass against an empty string and prove nothing.
    expect(pageCode).toContain('handleRecordDecision');
    expect(pageCode.length).toBeGreaterThan(pageSource.length / 2);
  });

  test('every field the form sends is a field the route reads', () => {
    const ignored = clientFields.filter((field) => !serverFields.includes(field));
    expect(ignored).toEqual([]);
  });

  // The specific control this gate was written for. The medical-status check
  // runs on every decision (shadowDecisions.ts, unconditional); nothing in the
  // request may claim to switch it on or off.
  test('no control offers to arm the medical-status check', () => {
    expect(pageCode).not.toMatch(/medicallySensitive/i);
  });
});
