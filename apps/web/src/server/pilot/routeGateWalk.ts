// The route walker shared by routeGateDeclaration.convention.test.ts and
// apiRouteInventory.convention.test.ts. It reads every route.ts under app/api,
// finds every exported HTTP handler, and reports which gate helpers each
// handler reaches -- following calls through same-file function bodies, not
// across modules. The parser and its recogniser sets were written for the
// gate-declaration test and are documented there; this file only moves them
// where a second consumer can reach them, and adds the mechanical facts the
// committed inventory pins (role literals, URL path, the write heuristic).

import fs from 'node:fs';
import path from 'node:path';

export const WEB_ROOT = path.resolve(__dirname, '../../..');
export const API_ROOT = path.join(WEB_ROOT, 'app', 'api');

export const HTTP_METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'] as const;

/**
 * Gates that answer "who is the caller". All seven are in http.ts / auth.ts;
 * the last six are the deliberate exceptions requirePrincipal's own header
 * names -- the PIN-change route, the two sign-out routes (pinned to those
 * files by signOutGate.convention.test.ts), the session-read route, the
 * Microsoft-only tier for privileged operations, (BASE04-D004) the credential
 * tier that also admits a local PIN session the server itself attested, and
 * (CL-A7) the any-adult-session tier for coach authoring.
 */
export const SESSION_GATES = new Set([
  'requirePrincipal',
  'requirePrincipalAllowingPinChange',
  'requirePrincipalForSignOut',
  'requireMicrosoftAuthenticatedPrincipal',
  'requireMicrosoftOrAttestedLocalPinPrincipal',
  'requireStaffSessionPrincipal',
  'resolvePrincipal',
]);

/**
 * Gates that answer "may this caller do this". Each was read before being
 * listed, and each refuses the ACTOR -- on their role, their relationship to
 * the subject, or both.
 *
 *   requireRole                     access.ts / http.ts -- the canonical gate
 *   requireAnnotator                annotatorGate.ts:51 -- wraps requireRole
 *   requireResearchBridgeAccess     researchBridgeAuth.ts:77 -- app-role token
 *   assertActorCanAccessAthlete     access.ts:343 -- the central relationship
 *                                   gate; 92 non-test files call it
 *   accessibleAthleteIds            access.ts -- the batched form of the above
 *   athleteIdsForCoach              access.ts -- "my athletes", actor-scoped
 *   assertCoachAssignedToAthlete    access.ts:77 -- assignment or live coverage
 *   assertAthleteUpdateAllowed      access.ts:518 -- field-level, by actor role
 *   assertViewerMayReachSubject     profileDb.ts:323 -- self, else the above
 *   assertActorCanAccessIntakeCase  intake.ts:390 -- subject, admin, or author
 *   assertCanManageBoardSeats       boardSeats.ts:209 -- admin or the President
 *   assertCanAuthorRabbitHoles      rabbitHoles.ts:449 -- coach or admin
 *   assertCanManageRabbitHole       rabbitHoles.ts:465 -- author or admin
 *   assertShadowAuthority           shadowAuthority.ts:107 -- actor + mode
 *   assertConversationAccess        shadowConversations.ts:133 -- owner + subject
 *   authorizeVideoScanReview        videoScanReview.ts:92 -- admin or uploader
 *
 * Adding a name here is a claim that the function refuses somebody. Read it
 * first, and say in the commit which line does the refusing.
 */
export const AUTHORIZATION_GATES = new Set([
  'requireRole',
  'requireAnnotator',
  'requireResearchBridgeAccess',
  'assertActorCanAccessAthlete',
  'accessibleAthleteIds',
  'athleteIdsForCoach',
  'assertCoachAssignedToAthlete',
  'assertAthleteUpdateAllowed',
  'assertViewerMayReachSubject',
  'assertActorCanAccessIntakeCase',
  'assertCanManageBoardSeats',
  'assertCanAuthorRabbitHoles',
  'assertCanManageRabbitHole',
  'assertShadowAuthority',
  'assertConversationAccess',
  'authorizeVideoScanReview',
]);

/**
 * Helpers that, when reached, mean the handler applied the coach-reach rule:
 * a coach sees only athletes assigned to them or under live coverage
 * (assertActorCanAccessAthlete and its batched / coach-scoped forms).
 */
export const COACH_REACH_GATES = new Set([
  'assertActorCanAccessAthlete',
  'accessibleAthleteIds',
  'athleteIdsForCoach',
  'assertCoachAssignedToAthlete',
  'assertViewerMayReachSubject',
]);

export function collectRouteFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectRouteFiles(full));
    } else if (entry.name === 'route.ts' || entry.name === 'route.tsx') {
      found.push(full);
    }
  }
  return found.sort();
}

/** Forward slashes always; path.relative returns backslashes on Windows. */
export function relative(filePath: string): string {
  return path.relative(WEB_ROOT, filePath).split(path.sep).join('/');
}

/** 'app/api/pilot/x/[id]/route.ts' -> '/api/pilot/x/[id]'. */
export function urlPathOf(rel: string): string {
  return '/' + rel.replace(/^app\//, '').replace(/\/route\.tsx?$/, '');
}

/**
 * Blank out comments and the CONTENTS of string, template and regex literals,
 * replacing each removed character with a space so every offset still lines up
 * with the original source. Template interpolations are left intact.
 */
export function blankLiterals(source: string): string {
  const out = source.split('');
  const n = source.length;
  let i = 0;
  let prevSignificant = '';
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = source[i];
    const d = source[i + 1];

    if (c === '/' && d === '/') {
      let j = i + 2;
      while (j < n && source[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
      continue;
    }

    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === c || source[j] === '\n') break;
        j += 1;
      }
      blank(i + 1, j);
      i = Math.min(n, j + 1);
      prevSignificant = c;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { out[j] = ' '; out[j + 1] = ' '; j += 2; continue; }
        if (source[j] === '`') break;
        if (source[j] === '$' && source[j + 1] === '{') {
          j += 2;
          let braces = 1;
          while (j < n && braces > 0) {
            if (source[j] === '{') braces += 1;
            else if (source[j] === '}') braces -= 1;
            j += 1;
          }
          continue;
        }
        if (out[j] !== '\n') out[j] = ' ';
        j += 1;
      }
      out[i] = ' ';
      if (j < n) out[j] = ' ';
      i = Math.min(n, j + 1);
      prevSignificant = '`';
      continue;
    }

    if (c === '/' && (prevSignificant === '' || /[=(,:;[!&|?{}+\-*%^~<>]/.test(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '\n') break;
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { closed = true; break; }
        j += 1;
      }
      if (closed) {
        blank(i, j + 1);
        i = j + 1;
        prevSignificant = '/';
        continue;
      }
    }

    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }

  return out.join('');
}

function matchDelimiter(blanked: string, open: number, openChar: string, closeChar: string): number {
  let depth = 0;
  for (let i = open; i < blanked.length; i += 1) {
    if (blanked[i] === openChar) depth += 1;
    else if (blanked[i] === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export type Span = readonly [start: number, end: number];

/** The body span of every named function-ish binding in the file. */
export function collectFunctionBodies(blanked: string): Map<string, Span> {
  const bodies = new Map<string, Span>();

  const declaration = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(blanked)) !== null) {
    const span = bodyAfterParameters(blanked, match.index + match[0].length - 1);
    if (span) bodies.set(match[1], span);
  }

  const assignment = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\s*\*?\s*[A-Za-z_$\w]*\s*)?\(/g;
  while ((match = assignment.exec(blanked)) !== null) {
    if (bodies.has(match[1])) continue;
    const parenOpen = match.index + match[0].length - 1;
    const span = /\bfunction\b/.test(match[0])
      ? bodyAfterParameters(blanked, parenOpen)
      : arrowBodyAfterParameters(blanked, parenOpen);
    if (span) bodies.set(match[1], span);
  }

  return bodies;
}

function bodyAfterParameters(blanked: string, parenOpen: number): Span | null {
  const parenClose = matchDelimiter(blanked, parenOpen, '(', ')');
  if (parenClose === -1) return null;
  const braceOpen = blanked.indexOf('{', parenClose);
  if (braceOpen === -1) return null;
  const braceClose = matchDelimiter(blanked, braceOpen, '{', '}');
  if (braceClose === -1) return null;
  return [braceOpen, braceClose + 1] as const;
}

/**
 * The body of `const name = (params) => ...`, or null when what follows the
 * parentheses is not an arrow function at all (`const body = (await
 * request.json()) as {...}` is not one).
 *
 * Only a return type may sit between the parameters and the arrow. A block
 * body is the braces that directly follow the arrow; an expression body runs
 * to the end of its statement. It is never "the next brace in the file": that
 * reading gave an expression-bodied helper the body of whichever function was
 * declared after it, so every handler calling the helper was credited with
 * that function's gates and role lists.
 */
function arrowBodyAfterParameters(blanked: string, parenOpen: number): Span | null {
  const parenClose = matchDelimiter(blanked, parenOpen, '(', ')');
  if (parenClose === -1) return null;

  let depth = 0;
  let angle = 0;
  let arrowEnd = -1;
  const limit = Math.min(blanked.length, parenClose + 400);
  for (let i = parenClose + 1; i < limit; i += 1) {
    const c = blanked[i];
    if (c === '=' && blanked[i + 1] === '>') {
      if (depth === 0 && angle === 0) { arrowEnd = i + 2; break; }
      i += 1; // an arrow inside the return type, e.g. `): (() => void) =>`
    } else if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (c === '<') angle += 1;
    else if (c === '>') angle = Math.max(0, angle - 1);
    else if (c === ';' && depth === 0) return null;
  }
  if (arrowEnd === -1) return null;

  let bodyStart = arrowEnd;
  while (bodyStart < blanked.length && /\s/.test(blanked[bodyStart])) bodyStart += 1;
  if (blanked[bodyStart] === '{') {
    const braceClose = matchDelimiter(blanked, bodyStart, '{', '}');
    return braceClose === -1 ? null : [bodyStart, braceClose + 1] as const;
  }
  depth = 0;
  for (let i = bodyStart; i < blanked.length; i += 1) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') {
      depth -= 1;
      if (depth < 0) return [bodyStart, i] as const;
    } else if (c === ';' && depth === 0) return [bodyStart, i] as const;
  }
  return null;
}

export interface Handler {
  method: string;
  span: Span;
}

export const HANDLER_SIGNATURE = new RegExp(
  `(?:^|\\n)\\s*export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS.join('|')})\\s*(?:<[^>(]*>)?\\s*\\(`,
  'g',
);

export function findHandlers(blanked: string): Handler[] {
  const found: Handler[] = [];
  const pattern = new RegExp(HANDLER_SIGNATURE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(blanked)) !== null) {
    const span = bodyAfterParameters(blanked, match.index + match[0].length - 1);
    if (span) found.push({ method: match[1], span });
  }
  return found;
}

/** Every identifier called inside a span: `name(` and `obj.name(` alike. */
export function calledNames(blanked: string, [start, end]: Span): string[] {
  const names: string[] = [];
  const pattern = /([A-Za-z_$][\w$]*)\s*(?:<[^<>()]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  const slice = blanked.slice(start, end);
  while ((match = pattern.exec(slice)) !== null) names.push(match[1]);
  return names;
}

/**
 * Every name reachable from a handler, following calls through same-file
 * function bodies to any depth, plus the spans visited (the handler's own and
 * every same-file helper it reached), so a caller can read literals out of
 * exactly the code the handler runs.
 */
export function reachableNames(
  blanked: string,
  bodies: Map<string, Span>,
  span: Span,
): { reached: Set<string>; spans: Span[] } {
  const reached = new Set<string>();
  const visited = new Set<string>();
  const spans: Span[] = [span];
  const walk = (current: Span): void => {
    for (const name of calledNames(blanked, current)) {
      reached.add(name);
      const body = bodies.get(name);
      if (body && !visited.has(name)) {
        visited.add(name);
        spans.push(body);
        walk(body);
      }
    }
  };
  walk(span);
  return { reached, spans };
}

function trimSpan(blanked: string, [start, end]: Span): Span {
  let a = start;
  let b = end;
  while (a < b && /\s/.test(blanked[a])) a += 1;
  while (b > a && /\s/.test(blanked[b - 1])) b -= 1;
  return [a, b] as const;
}

/** The offset of every comma in the text that sits inside no bracket of any kind. */
function topLevelCommas(blankedText: string): number[] {
  const found: number[] = [];
  let depth = 0;
  for (let i = 0; i < blankedText.length; i += 1) {
    const c = blankedText[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) found.push(i);
  }
  return found;
}

/**
 * Every name a parameter list binds anywhere in the file. Deliberately
 * over-inclusive -- a type named inside a parameter list counts too -- because
 * the only use is to refuse to resolve a role constant that a parameter of the
 * same name could be shadowing where requireRole is called.
 */
function parameterNames(blanked: string): Set<string> {
  const names = new Set<string>();
  const take = (text: string): void => {
    for (const word of text.matchAll(/[A-Za-z_$][\w$]*/g)) names.add(word[0]);
  };
  const functionOpen = /\bfunction\b\s*\*?\s*[A-Za-z_$\w]*\s*(?:<[^>(]*>)?\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = functionOpen.exec(blanked)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchDelimiter(blanked, open, '(', ')');
    if (close !== -1) take(blanked.slice(open + 1, close));
  }
  for (const arrow of blanked.matchAll(/\(([^()]*)\)\s*(?::[^=;{}]*)?=>/g)) take(arrow[1]);
  for (const arrow of blanked.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) names.add(arrow[1]);
  return names;
}

/** What may follow the closing bracket of an array constant that is still just that array. */
const ARRAY_CONSTANT_TAIL = /^[ \t]*(?:as\s+const)?[ \t]*(?:satisfies\s+[^;\n]+?)?[ \t]*;?[ \t]*(?:\r?\n|$)/;

/**
 * Module-level array constants in the file, e.g.
 * `const ADMIN_ROLES = ['organization_admin', 'admin'] as const;`, resolved to
 * their string elements. A spread of another same-file constant
 * (`[...ADMIN_ROLES, 'coach']`) is followed.
 *
 * A constant is resolved only when the walker can be sure which array a use of
 * its name means. It must be declared with `const` at column 0, found in the
 * BLANKED text (so a declaration inside a comment or a string is not one); the
 * closing bracket must end the declaration (`.filter(...)` after it makes it a
 * different array); the name must be bound exactly once by const/let/var and by
 * no parameter list; and nothing may push, unshift, splice, pop, shift or fill
 * it. Anything else is left out, and a call that names it comes back as
 * '<NAME>' -- "look here" rather than a wrong list pinned as the right one.
 * A destructured local of the same name is not detected.
 */
export function collectArrayConstants(source: string, blanked: string = blankLiterals(source)): Map<string, string[]> {
  const bound = new Map<string, number>();
  for (const binding of blanked.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    bound.set(binding[1], (bound.get(binding[1]) ?? 0) + 1);
  }
  const shadowed = parameterNames(blanked);
  const mutated = new Set<string>();
  for (const call of blanked.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*(?:push|unshift|splice|pop|shift|fill)\s*\(/g)) {
    mutated.add(call[1]);
  }

  const bodies = new Map<string, Span>();
  const pattern = /(?:^|\n)(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*\[/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(blanked)) !== null) {
    const name = match[1];
    const open = match.index + match[0].length - 1;
    const close = matchDelimiter(blanked, open, '[', ']');
    if (close === -1) continue;
    if (!ARRAY_CONSTANT_TAIL.test(blanked.slice(close + 1))) continue;
    if (bound.get(name) !== 1 || shadowed.has(name) || mutated.has(name)) continue;
    bodies.set(name, [open + 1, close] as const);
  }

  const resolved = new Map<string, string[]>();
  const resolve = (name: string, seen: Set<string>): string[] | null => {
    if (resolved.has(name)) return resolved.get(name) as string[];
    const body = bodies.get(name);
    if (body === undefined || seen.has(name)) return null;
    seen.add(name);
    const items = resolveArrayBody(source, blanked, body, (inner) => resolve(inner, seen));
    if (items) resolved.set(name, items);
    return items;
  };
  for (const name of bodies.keys()) resolve(name, new Set());
  return resolved;
}

/**
 * The elements of an array literal body (the span between its brackets) as
 * role names. Structure is read from the blanked text, so a comment between
 * elements and a trailing comma are nothing; the value of a quoted string is
 * read from the original source. `...NAME` or bare `NAME` is looked up through
 * `lookup`; an element that cannot be resolved -- a template literal, a call,
 * a cast -- makes the whole array unresolvable (null).
 */
function resolveArrayBody(
  source: string,
  blanked: string,
  [start, end]: Span,
  lookup: (name: string) => string[] | null,
): string[] | null {
  const out: string[] = [];
  let from = start;
  for (const to of [...topLevelCommas(blanked.slice(start, end)).map((i) => start + i), end]) {
    const segmentStart = from;
    const [a, b] = trimSpan(blanked, [from, to]);
    from = to + 1;
    if (a === b) {
      // Nothing but a comment or a trailing comma -- unless a template literal
      // was blanked away whole, backticks included.
      if (source.slice(segmentStart, to).includes('`')) return null;
      continue;
    }
    const quote = blanked[a];
    if ((quote === "'" || quote === '"') && b - a >= 2 && blanked[b - 1] === quote && blanked.slice(a + 1, b - 1).trim() === '') {
      out.push(source.slice(a + 1, b - 1));
      continue;
    }
    const ref = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)$/.exec(blanked.slice(a, b));
    const inner = ref ? lookup(ref[1]) : null;
    if (!inner) return null;
    out.push(...inner);
  }
  return out;
}

/** One role list -- an array literal or a same-file constant -- sorted, de-duplicated and comma-joined; null if it cannot be read. */
function resolveRoleList(source: string, blanked: string, span: Span, constants: Map<string, string[]>): string | null {
  const [a, b] = trimSpan(blanked, span);
  let items: string[] | null = null;
  if (blanked[a] === '[' && matchDelimiter(blanked, a, '[', ']') === b - 1) {
    items = resolveArrayBody(source, blanked, [a + 1, b - 1] as const, (name) => constants.get(name) ?? null);
  } else if (/^[A-Za-z_$][\w$]*$/.test(blanked.slice(a, b))) {
    items = constants.get(blanked.slice(a, b)) ?? null;
  }
  return items ? [...new Set(items)].sort().join(',') : null;
}

/** The `?` and `:` of a conditional expression that spans the whole argument, if it is one. */
function topLevelTernary(blanked: string, [start, end]: Span): { question: number; colon: number } | null {
  let depth = 0;
  let question = -1;
  for (let i = start; i < end; i += 1) {
    const c = blanked[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (depth !== 0) continue;
    else if (c === '?' && question === -1) {
      // `?.` and `??` are not the conditional operator.
      if (blanked[i + 1] === '.' || blanked[i + 1] === '?') { i += 1; continue; }
      question = i;
    } else if (c === ':' && question !== -1) return { question, colon: i };
  }
  return null;
}

/**
 * The role arrays passed to requireRole inside the given spans. Returns each
 * distinct array as a sorted, de-duplicated, comma-joined list of role names.
 * An inline literal and a same-file constant (including spreads of one) both
 * resolve, and a conditional between two such lists yields both. An argument
 * that cannot be resolved -- an imported constant, a computed expression, a
 * name collectArrayConstants would not vouch for -- comes back as the
 * expression wrapped in angle brackets, e.g. '<READ_ROLES>', so the inventory
 * says where to look rather than guessing.
 */
export function requireRoleLiterals(source: string, blanked: string, spans: Span[]): string[] {
  const constants = collectArrayConstants(source, blanked);
  const found = new Set<string>();
  // requireRole as a whole identifier: not preceded by a character that could
  // be part of a longer name. (A plain word boundary would accept `$requireRole`.)
  const callPattern = /(?:^|[^\w$])requireRole\s*\(/g;
  for (const [start, end] of spans) {
    const slice = blanked.slice(start, end);
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(slice)) !== null) {
      const openAt = start + match.index + match[0].length - 1;
      const closeAt = matchDelimiter(blanked, openAt, '(', ')');
      if (closeAt === -1) continue;
      const commas = topLevelCommas(blanked.slice(openAt + 1, closeAt)).map((i) => openAt + 1 + i);
      if (commas.length === 0) continue;
      // The second argument only: up to a third argument or a trailing comma.
      const argument = trimSpan(blanked, [commas[0] + 1, commas.length > 1 ? commas[1] : closeAt]);
      const ternary = topLevelTernary(blanked, argument);
      const lists = ternary
        ? [
          resolveRoleList(source, blanked, [ternary.question + 1, ternary.colon], constants),
          resolveRoleList(source, blanked, [ternary.colon + 1, argument[1]], constants),
        ]
        : [resolveRoleList(source, blanked, argument, constants)];
      if (lists.every((list): list is string => list !== null)) {
        for (const list of lists) found.add(list);
      } else {
        found.add(`<${source.slice(argument[0], argument[1]).replace(/\s+/g, ' ')}>`);
      }
    }
  }
  return [...found].sort();
}

export interface WalkedHandler {
  /** 'app/api/.../route.ts#METHOD' -- the key both convention tests use. */
  id: string;
  file: string;
  method: string;
  path: string;
  /** Session gates reached, in recogniser order. */
  sessionGates: string[];
  /** Authorization gates reached, in recogniser order. */
  authorizationGates: string[];
  /** requireRole role arrays reached (see requireRoleLiterals). */
  roleLiterals: string[];
  /** A COACH_REACH_GATES helper is reached from the handler. */
  coachReachGate: boolean;
  /** Method is not GET/HEAD/OPTIONS, or the file carries an SQL write verb. */
  writesLikely: boolean;
  /** Module specifiers the file imports from, for the reader who wants to follow a gate one module deeper. */
  imports: string[];
}

export function walkApiRoutes(root: string = API_ROOT): WalkedHandler[] {
  const handlers: WalkedHandler[] = [];

  for (const filePath of collectRouteFiles(root)) {
    const rel = relative(filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    const blanked = blankLiterals(source);
    const bodies = collectFunctionBodies(blanked);
    const fileHasSqlWrite = /\b(insert\s+into|update\s+[a-z_]+\.[a-z_]+\s+set|delete\s+from)\b/i.test(source);
    const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);

    for (const handler of findHandlers(blanked)) {
      const { reached, spans } = reachableNames(blanked, bodies, handler.span);
      const reachedList = [...reached];
      handlers.push({
        id: `${rel}#${handler.method}`,
        file: rel,
        method: handler.method,
        path: urlPathOf(rel),
        sessionGates: [...SESSION_GATES].filter((name) => reached.has(name)),
        authorizationGates: [...AUTHORIZATION_GATES].filter((name) => reached.has(name)),
        roleLiterals: requireRoleLiterals(source, blanked, spans),
        coachReachGate: reachedList.some((name) => COACH_REACH_GATES.has(name)),
        writesLikely: !['GET', 'HEAD', 'OPTIONS'].includes(handler.method) || fileHasSqlWrite,
        imports,
      });
    }
  }

  return handlers;
}
