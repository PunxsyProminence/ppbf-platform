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
    const span = bodyAfterParameters(blanked, match.index + match[0].length - 1, true);
    if (span) bodies.set(match[1], span);
  }

  return bodies;
}

function bodyAfterParameters(blanked: string, parenOpen: number, allowArrow = false): Span | null {
  const parenClose = matchDelimiter(blanked, parenOpen, '(', ')');
  if (parenClose === -1) return null;

  let braceOpen: number;
  if (allowArrow) {
    const tail = blanked.slice(parenClose + 1, parenClose + 400);
    const arrowAt = tail.indexOf('=>');
    const braceAt = tail.indexOf('{');
    if (arrowAt !== -1 && (braceAt === -1 || braceAt > arrowAt)) {
      braceOpen = blanked.indexOf('{', parenClose + 1 + arrowAt);
    } else if (braceAt !== -1) {
      braceOpen = parenClose + 1 + braceAt;
    } else {
      return null;
    }
  } else {
    braceOpen = blanked.indexOf('{', parenClose);
  }

  if (braceOpen === -1) return null;
  const braceClose = matchDelimiter(blanked, braceOpen, '{', '}');
  if (braceClose === -1) return null;
  return [braceOpen, braceClose + 1] as const;
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

/**
 * Module-level array constants in the file, e.g.
 * `const ADMIN_ROLES = ['organization_admin', 'admin'] as const;`, resolved to
 * their string elements. A spread of another same-file constant
 * (`[...ADMIN_ROLES, 'coach']`) is followed; anything else is kept verbatim.
 */
export function collectArrayConstants(source: string): Map<string, string[]> {
  const raw = new Map<string, string>();
  const pattern = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[([^\]]*)\]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) raw.set(match[1], match[2]);
  const resolved = new Map<string, string[]>();
  const resolve = (name: string, seen: Set<string>): string[] | null => {
    if (resolved.has(name)) return resolved.get(name) as string[];
    const body = raw.get(name);
    if (body === undefined || seen.has(name)) return null;
    seen.add(name);
    const items = resolveArrayBody(body, (inner) => resolve(inner, seen));
    if (items) resolved.set(name, items);
    return items;
  };
  for (const name of raw.keys()) resolve(name, new Set());
  return resolved;
}

/**
 * The elements of an array literal body as role names. A quoted string is
 * taken as-is; `...NAME` or bare `NAME` is looked up through `lookup`; an
 * element that cannot be resolved makes the whole array unresolvable (null).
 */
function resolveArrayBody(body: string, lookup: (name: string) => string[] | null): string[] | null {
  const out: string[] = [];
  for (const rawItem of body.split(',')) {
    const item = rawItem.trim();
    if (item.length === 0) continue;
    const quoted = /^['"`]([^'"`]*)['"`]$/.exec(item);
    if (quoted) { out.push(quoted[1]); continue; }
    const ref = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)$/.exec(item);
    if (ref) {
      const inner = lookup(ref[1]);
      if (!inner) return null;
      out.push(...inner);
      continue;
    }
    return null;
  }
  return out;
}

/**
 * The role arrays passed to requireRole inside the given spans, read from the
 * ORIGINAL source (the blanked copy has no string contents). Returns each
 * distinct array as a sorted, de-duplicated, comma-joined list of role names.
 * An inline literal and a same-file constant (including spreads of one) both
 * resolve; an argument that cannot be resolved -- an imported constant, a
 * computed expression -- comes back as the expression wrapped in angle
 * brackets, e.g. '<READ_ROLES>', so the inventory says where to look rather
 * than guessing.
 */
export function requireRoleLiterals(source: string, blanked: string, spans: Span[]): string[] {
  const constants = collectArrayConstants(source);
  const found = new Set<string>();
  const callPattern = /requireRole\s*\(/g;
  for (const [start, end] of spans) {
    const slice = blanked.slice(start, end);
    let match: RegExpExecArray | null;
    while ((match = callPattern.exec(slice)) !== null) {
      const openAt = start + match.index + match[0].length - 1;
      const closeAt = matchDelimiter(blanked, openAt, '(', ')');
      if (closeAt === -1) continue;
      const args = source.slice(openAt + 1, closeAt);
      const comma = topLevelComma(blanked.slice(openAt + 1, closeAt));
      if (comma === -1) continue;
      const second = args.slice(comma + 1).trim();
      const arrayMatch = /^\[([\s\S]*)\]$/.exec(second);
      const resolved = arrayMatch
        ? resolveArrayBody(arrayMatch[1], (name) => constants.get(name) ?? null)
        : (constants.get(second) ?? null);
      if (resolved) {
        found.add([...new Set(resolved)].sort().join(','));
      } else {
        found.add(`<${second.replace(/\s+/g, ' ')}>`);
      }
    }
  }
  return [...found].sort();
}

function topLevelComma(blankedArgs: string): number {
  let depth = 0;
  for (let i = 0; i < blankedArgs.length; i += 1) {
    const c = blankedArgs[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) return i;
  }
  return -1;
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
