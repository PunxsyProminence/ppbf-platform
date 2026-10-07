// DIFFERENTIAL SENSITIVITY GUARD for the SHADOW safety classifier.
//
// WHAT IS BEING GUARDED. shadowChat.ts folds eighteen apostrophe and quote
// look-alikes to the ASCII apostrophe and quote before its patterns run, so
// that "I can\u2019t breathe", typed on a phone, is treated as "I can't
// breathe". Nothing else about the classifier changes.
//
// THE PROPERTY, and it is a one-way one. Against main as it stood at b4f58159:
//
//   1. ANYTHING MAIN WITHHELD IS STILL WITHHELD.
//   2. ANYTHING MAIN ANSWERED WITH THE EMERGENCY TEXT STILL GETS IT.
//   3. ANYTHING MAIN RECORDED AT A CRITICAL CLASSIFICATION STILL IS.
//
// Not "behaves identically": flagging more is the point. Becoming LESS
// sensitive, for any message, is the regression.
//
// WHY THIS FILE IS NOT MORE EXAMPLES. Earlier versions of the fold did more
// than this one, and each extra was found to be wrong by somebody thinking of
// a message nobody had thought of: deleting U+FEFF released a message main
// withheld; folding U+FEFF to a space took the emergency response away from
// "I can't breathe and I need to lose weight<FEFF>quickly"; an optional
// apostrophe made words that merely contain "cant" an emergency. Examples
// were the wrong instrument each time. So this file has six parts, in this
// order, and only the last is a list of examples:
//
//   THE ARGUMENT     why two character classes folding to two characters
//                    cannot break properties 1-3, with each premise that is
//                    a fact about source text tested by parsing the source
//   THE FOLD         what the fold does to every UTF-16 code unit, exactly,
//                    and that it does it one unit at a time
//   THE SEED DIFFERENTIAL  main against the current code, with every
//                    look-alike at every position of seed sentences that
//                    leave main by each of its nine returns
//   THE CALL SITES   run with every code unit
//   THE CARRIER SWEEP  separators the fold does not touch, at marked positions
//   THE CORPUS       sentences that must not be withheld
//
// The reference below is main's classifier at b4f58159, frozen. It is a COPY
// and must not be refactored to import anything: its job is to keep saying
// what main said after the real implementation has moved on.

import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

import { classifyHighRiskTopic, normaliseForMatching, validateShadowRequest } from './shadowChat';

// ---------------------------------------------------------------------------
// FROZEN REFERENCE -- main's classifier.
//
// SOURCE: b4f58159, apps/web/src/server/pilot/shadowChat.ts, sha256
// 7c66a36491ae5e66ca3784691a1663a301580d49bfd365a3bdb611442e6a088f. The file
// has the same sha256 at c2c4df672e55c543a46abff8472b1e3750aebc99.
//
// Both of main's functions are here whole: classifyHighRiskTopic as
// mainClassify and validateShadowRequest as mainValidate, with all seven
// withholding returns -- prescription-or-weight-cut, urgent, personal-health,
// diagnosis, clearance, medication, and the isHighRisk fallback -- and both
// allowing ones. The differences from main's text are: the two function
// names, and with them the one internal call from the second to the first;
// `export` removed from both; the `examples` table and the `examples`
// property of mainClassify's return, which no decision reads, and a blank
// line with them; and four type annotations (`HighRiskTopic` written as
// `string` in the topics array, dropped from `classifiedTopic`, and the two
// return types written out). Every regex literal, every remaining string
// literal and the order of every statement is main's.
//
// IT IS A SNAPSHOT AND MUST NOT BE UPDATED TO FOLLOW MAIN. If main's
// classifier changes deliberately, that is a decision to re-baseline, and it
// belongs in front of an owner, not in a test edit.
// ---------------------------------------------------------------------------
function mainClassify(userMessage: string): { topic: string; isHighRisk: boolean; educationalApproach: boolean } {
  const msg = userMessage.toLowerCase();

  const topics: Array<[string, RegExp]> = [
    ['concussion', /concuss/i],
    ['head_trauma', /(head|brain)\s+(trauma|injury)/i],
    ['loss_of_consciousness', /(loss|loss\s+of|lack)\s+of\s+consciousness|unconscious|passed\s+out|knocked\s+out|\bko['’]?d\b|blacked\s+out/i],
    ['dizziness', /dizzy|dizziness|vertigo/i],
    ['dehydration', /dehydrat|(?:extreme|excessive)\s+thirst|unable\s+to\s+keep\s+fluids?\s+down/i],
    ['weight_cutting', /(weight.*cut|cut\s+weight|rapid\s+weight|make\s+weight)/i],
    ['rapid_weight_loss', /rapid.*weight|fast\s+weight|lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week/i],
    ['chest_pain', /(chest|heart)\s+pain|cardiac/i],
    ['fainting', /faint|syncope/i],
    ['medication', /(take|taking|took)\s+(medicine|medication|drug|pill)/i],
    ['prescription', /prescrip|prescription|prescribed|Rx/i],
    ['surgery', /surgery|surgical|underwent\s+an?\s+operation|operation\s+on\s+(?:me|my|the)|operated\s+on/i],
    ['injection', /inject|needle|vaccine|medical\s+shot|cortisone\s+shot|steroid\s+shot/i],
    ['return_to_play', /(return.*play|cleared.*play|cleared\s+to)/i],
    ['medical_clearance', /(medical|doctor)\s+clear|cleared|clearance/i],
    ['youth_safety', /(minor|child|kid|young)\s+(safety|harm)/i],
    ['urgent_symptom', /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i],
  ];

  let classifiedTopic = 'none';
  for (const [topic, pattern] of topics) {
    if (pattern.test(msg)) {
      classifiedTopic = topic;
      break;
    }
  }

  const hasEducationalFraming = /\bwhat\s+(is|are|causes?|can|could|does)\b|research|understand|learn|educational|context|background|how\s+(is|are|does|do)\s+(an?|the|athletes?|coaches?|organizations?)/i.test(msg);
  const hasPersonalFraming = /\b(i|me|my|mine|we|our)\b/i.test(msg)
    || /\b(now|currently|today|just happened|during training|after sparring)\b/i.test(msg);
  const isEducationalQuery = hasEducationalFraming && !hasPersonalFraming;

  return {
    topic: classifiedTopic,
    isHighRisk: classifiedTopic !== 'none',
    educationalApproach: isEducationalQuery,
  };
}

function mainValidate(
  message: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _userRole: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _organizationId: string,
): { valid: boolean; error?: string; highRisk?: boolean; topic?: string; classification?: string } {
  const classification = mainClassify(message);
  const normalizedMessage = message.toLowerCase();

  const hasPrescriptionLanguage = /\b(prescribe|prescribed|prescribing|prescription|rx)\b/i.test(message)
    || /should\s+i\s+take/i.test(message)
    || /should\s+you\s+take/i.test(message)
    || /take\s+(?:this\s+)?(?:medication|medicine|drug|pill)/i.test(message);

  const hasRapidWeightCutLanguage = /how\s+do\s+i\s+cut\s+weight/i.test(message)
    || normalizedMessage.includes('lose weight quickly')
    || normalizedMessage.includes('cut weight for my weight class')
    || /\b(?:i\s+(?:need|have)\s+to|help\s+me|how\s+(?:can|do)\s+i)\b.{0,35}\bmake\s+weight\b/i.test(message)
    || /\b(?:i\s+(?:need|want|have)\s+to\s+)?lose\s+\d+(?:\.\d+)?\s*(?:pounds?|lbs?|kilograms?|kgs?)\s+(?:this|in\s+(?:a|one))\s+week\b/i.test(message);

  const hasPersonalContext = /\b(i|me|my|mine|we|our)\b/i.test(message)
    || /\b(now|currently|today|just happened|during training|after sparring|after (?:a|that|the) hit)\b/i.test(message);
  const hasUrgentSymptom = /(can(?:not|'t)\s+breathe|shortness\s+of\s+breath|trouble\s+breathing|blurr(?:y|ed)?\s+vision|vision.{0,12}blurr(?:y|ed)?|double\s+vision|can(?:not|'t)\s+see|seeing\s+stars|seizure|convulsion|headache|nausea|nauseous|neck.{0,20}(numb|weak|tingl)|severe\s+bleeding|bleeding.{0,20}(won't|will\s+not)\s+stop|abdominal\s+pain|stomach\s+pain|vomit(?:ing)?\s+blood|slurred\s+speech|unequal\s+pupils?|can(?:not|'t)\s+move|sudden\s+weakness)/i.test(message);
  const hasAcuteImpactConcern = /(?:after|from).{0,30}(?:hit|blow|punch|fall).{0,60}(?:pain|numb|weak|tingl|blur|bleed|dizz|confus|vomit|can(?:not|'t))/i.test(message);
  const hasPersonalHealthConcern = /\b(hurt|hurts|hurting|pain|painful|sore|soreness|swollen|swelling|injured|injury|sprain(?:ed|ing)?|strain(?:ed|ing)?|bruised|bruising|numb|numbness|tingling|stiff|stiffness)\b/i.test(message);

  // Direct prescription or weight-cutting directives are blocked even when phrased as questions.
  if (hasPrescriptionLanguage || hasRapidWeightCutLanguage) {
    return {
      valid: false,
      error: 'Medication and prescription recommendations require prescription authority and professional medical oversight.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Educational queries are allowed
  if (classification.educationalApproach) {
    return {
      valid: true,
      highRisk: classification.isHighRisk,
      topic: classification.topic,
      classification: classification.isHighRisk ? classification.topic : undefined,
    };
  }

  if (hasPersonalContext && (hasUrgentSymptom || hasAcuteImpactConcern)) {
    return {
      valid: false,
      error: 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.',
      highRisk: true,
      topic: classification.topic === 'none' ? 'urgent_symptom' : classification.topic,
      classification: 'urgent_personal_symptom',
    };
  }

  if (hasPersonalContext && hasPersonalHealthConcern) {
    return {
      valid: false,
      error: 'Personal pain, injury, and treatment questions require evaluation by a qualified medical professional. SHADOW can only provide general educational information.',
      highRisk: true,
      topic: classification.topic,
      classification: 'personal_health_concern',
    };
  }

  // Check for diagnosis claims
  if (/(do|does|did|am|is|have)\s+(i|you)\s+(have|have a|get|got|experience).*(concussion|fracture|injury|condition|disease|syndrome|disorder)/i.test(message)) {
    return {
      valid: false,
      error: 'Diagnosis and personal health assessment require professional medical evaluation.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for clearance claims
  if (
    /\bmedical\s+clear(?:ed|ance)?\b/i.test(message)
    || /\bclear(?:ed|ance)?\b.{0,40}\b(play|train|training|compete|competition|return|contact|spar|sparring)\b/i.test(message)
    || /\b(play|train|training|compete|competition|return|contact|spar|sparring)\b.{0,40}\bclear(?:ed|ance)?\b/i.test(message)
  ) {
    return {
      valid: false,
      error: 'Medical clearance decisions require professional medical authority.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  // Check for prescription claims
  if (/(should|do|can|need)\s+(i|you)\s+(take|use|try|get).*(medicine|medication|drug|pill|injection)/i.test(message)) {
    return {
      valid: false,
      error: 'Medication and prescription recommendations require professional medical oversight.',
      highRisk: true,
      topic: classification.topic,
    };
  }

  if (classification.isHighRisk) {
    const emergencyTopic = (
      classification.topic === 'chest_pain'
      || classification.topic === 'fainting'
      || classification.topic === 'loss_of_consciousness'
    );
    return {
      valid: false,
      error: emergencyTopic
        ? 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.'
        : 'Personal high-risk health and safety concerns require immediate human evaluation. SHADOW can only provide general educational information.',
      highRisk: true,
      topic: classification.topic,
      classification: classification.topic,
    };
  }

  return { valid: true, highRisk: false, topic: 'none' };
}

type Verdict = { valid: boolean; error?: string; highRisk?: boolean; topic?: string; classification?: string };

const main = (message: string): Verdict => mainValidate(message, 'athlete', 'org-123');
const now = (message: string): Verdict => validateShadowRequest(message, 'athlete', 'org-123');

const EMERGENCY_TEXT = 'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.';
// The classifications the chat route queues at severity 'critical'
// (route.ts, the two `severity:` expressions). Copied, not imported: this
// file's job is to say what main's results MEANT at b4f58159.
const CRITICAL = ['chest_pain', 'fainting', 'loss_of_consciousness', 'urgent_personal_symptom'];

const withheld = (v: Verdict): boolean => v.valid === false;
const emergency = (v: Verdict): boolean => v.valid === false && v.error === EMERGENCY_TEXT;
const critical = (v: Verdict): boolean => CRITICAL.includes(v.classification ?? '');
/** Field-for-field equality; a property that is `undefined` equals one that is absent. */
const same = (a: Verdict, b: Verdict): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Which of main's nine returns produced this result, in source order. */
function returnOf(v: Verdict): string {
  if (v.valid) return 'classification' in v ? 'R2 educational, allowed' : 'R9 nothing matched, allowed';
  if (v.error === 'Medication and prescription recommendations require prescription authority and professional medical oversight.') return 'R1 prescription or weight cut';
  if (v.classification === 'urgent_personal_symptom') return 'R3 urgent';
  if (v.classification === 'personal_health_concern') return 'R4 personal health';
  if (v.error === 'Diagnosis and personal health assessment require professional medical evaluation.') return 'R5 diagnosis';
  if (v.error === 'Medical clearance decisions require professional medical authority.') return 'R6 clearance';
  if (v.error === 'Medication and prescription recommendations require professional medical oversight.') return 'R7 medication';
  return 'R8 high-risk fallback';
}

function unitLabel(unit: number): string {
  return 'U+' + unit.toString(16).toUpperCase().padStart(4, '0');
}

function show(text: string): string {
  return Array.from({ length: text.length }, (_, i) => unitLabel(text.charCodeAt(i))).join(' ');
}

// ---------------------------------------------------------------------------
// THE FOLD, WRITTEN OUT A SECOND TIME, AS DATA.
//
// Everything below is checked against this table, and the table is checked
// against the fold three ways: by running it on every code unit, by reading
// the character classes out of its source, and by counting.
// ---------------------------------------------------------------------------
const APOSTROPHE_SOURCES: readonly number[] = [
  0x0060, // GRAVE ACCENT (the ASCII backtick)
  0x00b4, // ACUTE ACCENT
  0x02b9, // MODIFIER LETTER PRIME
  0x02bb, // MODIFIER LETTER TURNED COMMA
  0x02bc, // MODIFIER LETTER APOSTROPHE
  0x2018, // LEFT SINGLE QUOTATION MARK
  0x2019, // RIGHT SINGLE QUOTATION MARK -- the phone default, and the defect
  0x201a, // SINGLE LOW-9 QUOTATION MARK
  0x201b, // SINGLE HIGH-REVERSED-9 QUOTATION MARK
  0x2032, // PRIME
  0xff07, // FULLWIDTH APOSTROPHE
  0xff40, // FULLWIDTH GRAVE ACCENT
];
const QUOTE_SOURCES: readonly number[] = [
  0x201c, // LEFT DOUBLE QUOTATION MARK
  0x201d, // RIGHT DOUBLE QUOTATION MARK
  0x201e, // DOUBLE LOW-9 QUOTATION MARK
  0x201f, // DOUBLE HIGH-REVERSED-9 QUOTATION MARK
  0x2033, // DOUBLE PRIME
  0xff02, // FULLWIDTH QUOTATION MARK
];
const EXPECTED_FOLD: ReadonlyMap<number, string> = new Map<number, string>([
  ...APOSTROPHE_SOURCES.map((unit) => [unit, "'"] as [number, string]),
  ...QUOTE_SOURCES.map((unit) => [unit, '"'] as [number, string]),
]);
const SOURCES: readonly string[] = [...EXPECTED_FOLD.keys()].map((unit) => String.fromCharCode(unit));
const UNITS = 0x10000;

// ---------------------------------------------------------------------------
// READING THE SOURCE.
//
// Several premises below are facts about the TEXT of a function -- which
// characters its patterns mention, what its call sites look like -- and a
// fact about text is checked by parsing the text, not by running it and
// hoping an input exists that would have shown the difference.
// ---------------------------------------------------------------------------
type Pattern = { owner: string; source: string; flags: string };

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function functionNamed(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = sourceFile.statements.filter(
    (s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name,
  );
  if (found.length !== 1) throw new Error(`expected exactly one function ${name}, found ${found.length}`);
  return found[0];
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** What a regex literal belongs to: a topic row, a named constant, or an `if`. */
function ownerOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isArrayLiteralExpression(at) && at.elements.length === 2 && ts.isStringLiteral(at.elements[0])) {
      return 'topic ' + at.elements[0].text;
    }
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (ts.isIfStatement(at)) return 'if';
  }
  return '?';
}

function patternsOf(fn: ts.FunctionDeclaration): Pattern[] {
  const out: Pattern[] = [];
  walk(fn, (n) => {
    if (n.kind !== ts.SyntaxKind.RegularExpressionLiteral) return;
    const text = n.getText();
    const close = text.lastIndexOf('/');
    out.push({ owner: ownerOf(n), source: text.slice(1, close), flags: text.slice(close + 1) });
  });
  return out;
}

/** The string literals handed to `.includes(...)`. */
function includesLiteralsOf(fn: ts.FunctionDeclaration): string[] {
  const out: string[] = [];
  walk(fn, (n) => {
    if (
      ts.isCallExpression(n)
      && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'includes'
      && n.arguments.length === 1
      && ts.isStringLiteral(n.arguments[0])
    ) out.push(n.arguments[0].text);
  });
  return out;
}

/** Every string literal in the function, in source order. */
function stringLiteralsOf(fn: ts.FunctionDeclaration): string[] {
  const out: string[] = [];
  walk(fn, (n) => { if (ts.isStringLiteral(n)) out.push(n.text); });
  return out;
}

function identifierCount(fn: ts.FunctionDeclaration, name: string): number {
  let count = 0;
  walk(fn, (n) => { if (ts.isIdentifier(n) && n.text === name) count += 1; });
  return count;
}

function initializerOf(fn: ts.FunctionDeclaration, name: string): string {
  const found: string[] = [];
  walk(fn, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      found.push(n.initializer.getText());
    }
  });
  if (found.length !== 1) throw new Error(`expected exactly one declaration of ${name}, found ${found.length}`);
  return found[0];
}

/** The receiver and argument text of every `.test(...)` and `.includes(...)` call. */
function matchCallsOf(fn: ts.FunctionDeclaration): Array<{ method: string; receiverKind: string; argument: string }> {
  const out: Array<{ method: string; receiverKind: string; argument: string }> = [];
  walk(fn, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) return;
    const method = n.expression.name.text;
    if (method !== 'test' && method !== 'includes') return;
    const receiver = n.expression.expression;
    out.push({
      method,
      receiverKind: receiver.kind === ts.SyntaxKind.RegularExpressionLiteral ? 'regex' : receiver.getText(),
      argument: n.arguments.map((a) => a.getText()).join(', '),
    });
  });
  return out;
}

const GUARD = parse(__filename);
const PRODUCTION = parse(path.join(__dirname, 'shadowChat.ts'));

const MAIN_CLASSIFY = functionNamed(GUARD, 'mainClassify');
const MAIN_VALIDATE = functionNamed(GUARD, 'mainValidate');
const NOW_CLASSIFY = functionNamed(PRODUCTION, 'classifyHighRiskTopic');
const NOW_VALIDATE = functionNamed(PRODUCTION, 'validateShadowRequest');
const NOW_FOLD = functionNamed(PRODUCTION, 'normaliseForMatching');

const MAIN_PATTERNS: Pattern[] = [...patternsOf(MAIN_CLASSIFY), ...patternsOf(MAIN_VALIDATE)];

// ---------------------------------------------------------------------------
// THE ARGUMENT, from "eighteen punctuation characters become two" to
// properties 1-3. Each step names the test that holds it up.
//
// Write f for the fold and main(m) for what main did with message m.
//
// STEP 1. The current code is main with the fold in front: now(m) =
// main(f(m)). The two shipping functions are main's two functions,
// statement for statement, once a short named list of differences is undone
// -- the fold call, the folded text where main read the message, the
// classifier's name, the `examples` table, two type annotations [S1d]; they
// are plain exported declarations that nothing else in the file names
// [S1e]; and the fold is exactly the two replace lines [S1c]. S1a and S1b
// say the same thing about the
// patterns and about what each pattern reads, separately, so that a failure
// names what moved. It is also run: now(m) equals main(f(m)), field for
// field, on every generated message in the seed differential and the
// call-site run below.
//
// STEP 2. f changes a message only by turning one of eighteen characters
// into ' or " in place [the exact map], one unit at a time [the per-unit
// tests]. All twenty characters are non-word, non-whitespace and not line
// terminators [the class facts]. So `\b`, `\w`, `\s`, `\d` and `.` see
// the same thing at every position of m and of f(m), and so does a literal
// or a class that mentions none of the twenty.
//
// Two things about case, because main's classifier lowercases before it
// matches and every pattern carries the `i` flag. No other code unit
// lowercases, or case-folds under `i`, into one of the twenty, and none of
// the twenty has another case [the case tests]. And lowercasing is not quite
// one unit at a time: a Greek capital sigma lowercases to a different letter
// depending on the letters before and after it, and a look-alike and the
// apostrophe it folds to can count differently as "after", so lower(f(m))
// and lower(m) can differ at a sigma. Both forms are non-ASCII letters, and main's patterns mention no
// non-ASCII character but the one look-alike [S3], so no pattern can tell
// them apart.
//
// STEP 3. So a pattern can tell m from f(m) only if it mentions one of the
// twenty characters, and main has exactly four that do [S3]: the
// loss_of_consciousness and urgent_symptom topic rows, hasUrgentSymptom and
// hasAcuteImpactConcern. EVERY OTHER PREDICATE IN MAIN GIVES THE SAME ANSWER
// FOR m AND f(m) -- including both `.includes(...)` phrases [S3], and
// including the two predicates behind the only early ALLOW,
// hasEducationalFraming and hasPersonalFraming, and the two behind the first
// return, hasPrescriptionLanguage and hasRapidWeightCutLanguage.
//
// STEP 4. Those four can only GAIN matches. A pattern built from literals,
// positive classes, groups, alternation and quantifiers, with no negated
// class, no \W \S \D \B, no lookaround and no backreference [S4a], that
// matched m matches f(m) at the same place provided every one of the
// eighteen sources it mentions sits in a class beside the character it
// folds to [S4b]. There is one such mention, `ko['\u2019]?d`.
//
// STEP 5. Read main's returns in order. This step is by reading the frozen
// reference above. The seed differential runs it: its seeds include one for
// each change of return the step allows -- from R4, R5, R6, R7 and R8 to R3,
// from R9 to R3 and to R8 -- and for a topic changing under an unchanged
// return at R1, R2, R3, R6 and R8, and the count of each is asserted.
//
//   R1 withhold   prescription or weight-cut language        same for m, f(m)
//   R2 ALLOW      educational framing, not personal          same for m, f(m)
//   R3 withhold   personal context AND (urgent OR impact)    can only be GAINED
//                 -> emergency text, urgent_personal_symptom
//   R4 withhold   personal context AND health concern        same
//   R5 withhold   diagnosis question                         same
//   R6 withhold   clearance question                         same
//   R7 withhold   medication question                        same
//   R8 withhold   a high-risk topic matched                  can only be GAINED
//                 -> emergency text for chest_pain, fainting,
//                    loss_of_consciousness
//   R9 ALLOW      nothing matched
//
// and the topic, which is the first matching row: only two rows can gain a
// match, so topic(f(m)) is topic(m), or loss_of_consciousness, or -- when
// topic(m) was none -- urgent_symptom.
//
// So main(f(m)) leaves by the return main(m) left by, or by R3, or (from R9
// only) by R8. From which:
//
//   1. Withheld stays withheld. R1 and R3-R8 withhold, and from any of them
//      the only other exit is R3.
//   2. Emergency text stays. It comes from R3, which is kept, and from R8
//      under an emergency topic, which becomes R3 or stays R8 with the same
//      topic or loss_of_consciousness -- emergency either way.
//   3. Critical stays critical. The classification is
//      urgent_personal_symptom at R3 and the topic at R2 and R8, and a topic
//      in the critical list stays itself or becomes loss_of_consciousness.
//
// WHAT THIS DOES NOT COVER.
//
// It is an argument about main's two functions as frozen here. S1d ties the
// shipping functions to them, and has to be edited, deliberately, by whoever
// next changes either.
//
// It says nothing about characters outside the eighteen: those behave as on
// main, including every astral look-alike.
//
// IT STOPS AT validateShadowRequest'S RETURN VALUE. Properties 1-3 are about
// `valid`, `error` and `classification`. A look-alike that completes
// "can't" or "KO'd" also changes `topic` -- to urgent_symptom from none, or
// to loss_of_consciousness from any topic listed after it -- and the chat
// route reads `topic` and `classification` for more than the three
// properties cover. By reading route.ts and shadowHandoff.ts: the review
// row's category, the `highRiskTopic` in the response, and the handoff
// banner all follow the topic, so they change wherever it does. Each of
// those is the route doing for a look-alike what it already does for the
// ASCII apostrophe.
//
// One of them is LESS caution, not more, and is pinned on both layers: see
// "an allowed question that names KO'd" below. The route answers an ALLOWED
// message whose classification is weight_cutting, return_to_play or
// medical_clearance with a stock line and queues a review. When a look-alike
// makes such a message's topic loss_of_consciousness instead, the route
// calls the model and queues nothing before generation.
// ---------------------------------------------------------------------------
// NAMED ADDITIONS (2026-10-06, SHADOW emergency-phrase lane). The first change
// to the classifier since the fold, declared here as S1d asks, and undone by
// S1a and S1d before they compare with main. The frozen copy is NOT edited.
//
// Each addition only adds matches, so properties 1-3 still hold against main:
//   - a new alternative OR'd into an existing pattern, inside its outermost
//     group (urgent_symptom, hasUrgentSymptom, hasAcuteImpactConcern), so any
//     message the pattern matched it still matches;
//   - one new topic row, LAST, so it is reached only when every one of main's
//     rows missed: the topic changes only from none, to loss_of_consciousness,
//     which is an emergency topic and a critical classification. (Not in the
//     existing loss_of_consciousness row: that sits above return_to_play and
//     medical_clearance and would take their canned fallback away from an
//     allowed question -- the "less caution" case described above.)
// The new words carry lookarounds and an apostrophe; they are new matches,
// so the fold argument about main's patterns (S3, S4) is untouched by them.
// ---------------------------------------------------------------------------
const ADDED_CANT = String.raw`|\bcant\s+(?:breathe|see|move)|(?:can(?:not|'t)|\bcant)\s+breath\b`;
const ADDED_EMERGENCY = String.raw`(?<!\b(?:guard|stance|posture|pocket|elbows?|wrists?|knees?|hands?|arch|side|defen[cs]e|form|frame|structure|base|shell|footwork|plan|stand|mount|bag|tent|ring\s+rope|rope|conditioning|cardio|gas\s+tank|tank|wind|energy|pace|output|timing|rhythm|game|confidence|focus|offen[cs]e|attack|game\s?plan)\s+(?:\w+ly\s+)?)collapsed(?!\s+(?:the|your|his|her|their|my|our|that|this)\s+(?:distance|range|gap|space|angle|pocket|guard|stance|elbows?)\b)(?!\s+(?:elbows?|wrists?|lung|arch|guard|stance)\b)|(?<!\b(?:app|screen|tablet|phone|timer|page|site|website|button|video|upload|camera|computer|laptop|ipad|system|wifi|bluetooth|speaker|tv)\s+(?:is\s+|was\s+|seems\s+|keeps\s+)?(?:\w+ly\s+)?)unresponsive(?!\s+to\s+(?:feedback|coaching|instructions?|corrections?|criticism|advice)\b)|(?<!\b(?:app|screen|tablet|phone|timer|page|site|website|button|video|upload|camera|computer|laptop|ipad|system|wifi|bluetooth|speaker|tv)\s+(?:is\s+|was\s+|seems\s+|keeps\s+)?(?:\w+ly\s+)?)not\s+responsive|(?<!\b(?:app|screen|tablet|phone|timer|page|site|website|button|video|upload|camera|computer|laptop|ipad|system|wifi|bluetooth|speaker|tv)\s+(?:is\s+|was\s+|seems\s+|keeps\s+)?(?:\w+ly\s+)?)(?:\bnot|isn't|\bisnt)\s+responding(?!\s+(?:to|well)\b)|(?<!\balarms?\s+)(?:won't|\bwont|will\s+not|doesn't|\bdoesnt|does\s+not)\s+wake(?!\s+(?:(?:me|us|him|her|them)\s+)?(?:up\s+)?(?:early|in\s+time|on\s+time|(?:in\s+)?the\s+mornings?|mornings?|for\s+(?:roadwork|runs?|practice|training|school|work|class|the\s+bus|(?:the|his|her|my|their)\s+alarm)|at\s+\d|before\s+(?:practice|training|school|work|class|\d)|to\s+(?:the|his|her|my|their)\s+alarm)\b)|(?:can(?:not|'t)|\bcant)\s+wake\s+(?!(?:up|myself|early)\b)\w+\b(?!\s+(?:(?:me|us|him|her|them)\s+)?(?:up\s+)?(?:early|in\s+time|on\s+time|(?:in\s+)?the\s+mornings?|mornings?|for\s+(?:roadwork|runs?|practice|training|school|work|class|the\s+bus|(?:the|his|her|my|their)\s+alarm)|at\s+\d|before\s+(?:practice|training|school|work|class|\d)|to\s+(?:the|his|her|my|their)\s+alarm)\b)|(?:\bnot|isn't|\bisnt)\s+waking(?!\s+(?:(?:me|us|him|her|them)\s+)?(?:up\s+)?(?:early|in\s+time|on\s+time|(?:in\s+)?the\s+mornings?|mornings?|for\s+(?:roadwork|runs?|practice|training|school|work|class|the\s+bus|(?:the|his|her|my|their)\s+alarm)|at\s+\d|before\s+(?:practice|training|school|work|class|\d)|to\s+(?:the|his|her|my|their)\s+alarm)\b)|stopped\s+breathing(?!\s+(?:out|in\s+(?:and|through|enough|deep|deeply|on)|through|between|rhythmically)\b)|barely\s+breathing|(?<!\byou(?:'re|re|\s+are)?\s+)(?:\bnot|isn't|\bisnt)\s+breathin(?:g\b|\b)(?!\s+(?:out|in\s+(?:and|through|enough|deep|deeply|on)|through|between|rhythmically)\b)(?!\s+(?:on|during|when|while|with|right|properly|correctly|enough|well)\b.{0,25}\b(?:jabs?|punch\w*|combo\w*|combinations?|shots?|pads|mitts|bag|exhale|drills?|footwork)\b)`;
const ADDED_ACUTE_CANT = String.raw`|\bcant\s+(?:breathe|see|move|feel)`;
const ADDED_ROW_SOURCE = `['loss_of_consciousness', /${ADDED_EMERGENCY}/i]`;
/** In-pattern additions, by owner: [owner, text that must appear exactly once and is removed]. */
const ADDED_IN_PATTERN: Array<[string, string]> = [
  ['topic urgent_symptom', ADDED_CANT],
  ['hasUrgentSymptom', ADDED_CANT + '|' + ADDED_EMERGENCY],
  ['hasAcuteImpactConcern', ADDED_ACUTE_CANT],
];

/** NOW's patterns with the named additions undone: the added row dropped, each in-pattern addition removed once. */
function undoNamedAdditions(patterns: Pattern[]): Pattern[] {
  const rows = patterns.filter((p) => p.owner === 'topic loss_of_consciousness' && p.source === ADDED_EMERGENCY);
  if (rows.length !== 1) throw new Error(`expected the added row once, found ${rows.length}`);
  const kept = patterns.filter((p) => p !== rows[0]);
  for (const [owner, added] of ADDED_IN_PATTERN) {
    const owned = kept.filter((p) => p.owner === owner);
    if (owned.length !== 1) throw new Error(`expected one pattern owned by ${owner}, found ${owned.length}`);
    const parts = owned[0].source.split(added);
    if (parts.length !== 2) throw new Error(`expected the addition in ${owner} once, found ${parts.length - 1}`);
    // Inside the outermost group, at its end: the pattern is main's with `|X` before the final `)`.
    expect(parts[1]).toBe(')');
    owned[0].source = parts.join('');
  }
  return kept;
}

/**
 * Whether the folded message reaches one of the named additions. Where it
 * does, the current code is NOT main of the fold -- it is main plus the
 * additions -- so the field-for-field comparisons below excuse it, and only
 * it, and only when the one-way properties still hold against main.
 */
const ADDED_REGEXES = [ADDED_EMERGENCY, ADDED_CANT.slice(1), ADDED_ACUTE_CANT.slice(1)].map((s) => new RegExp(s, 'i'));
function explainedByAddition(message: string, was: Verdict, is: Verdict): boolean {
  const folded = normaliseForMatching(message);
  if (!ADDED_REGEXES.some((r) => r.test(folded))) return false;
  return !(withheld(was) && !withheld(is)) && !(emergency(was) && !emergency(is)) && !(critical(was) && !critical(is));
}

// ---------------------------------------------------------------------------
// NAMED REORDERING (2026-10-06, #1036 ordering lane). The emergency return
// now comes BEFORE every one of main's returns: validateShadowRequest gains
// one statement pair, `const emergency = emergencyReport(...)` and
// `if (emergency) return emergency;`, undone by S1d. emergencyReport lives
// outside the two guarded functions; it reads main's own R3 condition
// (personal context with an urgent symptom or an acute impact concern),
// the folded text against the true emergency signs and main's emergency
// topic rows (shadowChat.test.ts pins those copies to the rows), and
// answers with main's R3, field for field: the emergency text, the topic
// classifyHighRiskTopic chose (urgent_symptom when none), the
// urgent_personal_symptom classification.
//
// So a message can now part from main(f(m)) in exactly one more way: by
// leaving through R3 where main left through R1, R2, R6 or R8 (or R3 with
// another topic). Properties 1-3 hold against main as before: R3 withholds,
// carries the emergency text and is critical, so nothing is released, no
// emergency text is lost and nothing critical is downgraded. The one-way
// checks below still run on every message; this excuse covers only the
// "same as main, field for field" checks, and only into main's R3 shape.
// ---------------------------------------------------------------------------
function emergencyFirstShape(message: string): Verdict {
  const topic = classifyHighRiskTopic(message).topic;
  return {
    valid: false,
    error: EMERGENCY_TEXT,
    highRisk: true,
    topic: topic === 'none' ? 'urgent_symptom' : topic,
    classification: 'urgent_personal_symptom',
  };
}
function explainedByEmergencyFirst(message: string, was: Verdict, is: Verdict): boolean {
  if (!same(is, emergencyFirstShape(message))) return false;
  return !(withheld(was) && !withheld(is)) && !(emergency(was) && !emergency(is)) && !(critical(was) && !critical(is));
}

describe('the premises of the argument, read from source', () => {
  const NOW_PATTERNS: Pattern[] = [...patternsOf(NOW_CLASSIFY), ...patternsOf(NOW_VALIDATE)];

  test('S1a: the shipping functions carry exactly main\'s patterns and phrases, in order, but for the named additions', () => {
    // The added row comes straight after urgent_symptom, which is main's last
    // topic row: so it is reached only when every one of main's rows missed.
    const nowClassifyPatterns = patternsOf(NOW_CLASSIFY);
    const urgentRow = nowClassifyPatterns.findIndex((p) => p.owner === 'topic urgent_symptom');
    expect(nowClassifyPatterns[urgentRow + 1].source).toBe(ADDED_EMERGENCY);
    const mainClassifyPatterns = patternsOf(MAIN_CLASSIFY);
    const mainUrgentRow = mainClassifyPatterns.findIndex((p) => p.owner === 'topic urgent_symptom');
    expect(mainClassifyPatterns[mainUrgentRow + 1].owner.startsWith('topic ')).toBe(false);
    expect(undoNamedAdditions(NOW_PATTERNS.map((p) => ({ ...p })))).toEqual(MAIN_PATTERNS);
    expect(includesLiteralsOf(NOW_VALIDATE)).toEqual(includesLiteralsOf(MAIN_VALIDATE));
    // Every string literal of validateShadowRequest: the error texts, the
    // classifications, the three emergency topics, 'none'. (Not compared for
    // the classifier, where the shipping function also carries the
    // `examples` table; its topic names are compared above, as owners.)
    expect(stringLiteralsOf(NOW_VALIDATE)).toEqual(stringLiteralsOf(MAIN_VALIDATE));
    expect(stringLiteralsOf(MAIN_VALIDATE).length).toBe(MAIN_VALIDATE_STRING_LITERALS);
    // So that the comparisons above cannot pass by both sides being empty.
    expect(patternsOf(MAIN_CLASSIFY).length).toBe(20);
    expect(patternsOf(MAIN_VALIDATE).length).toBe(17);
    expect(includesLiteralsOf(MAIN_VALIDATE)).toEqual(['lose weight quickly', 'cut weight for my weight class']);
  });

  test('S1b: every pattern reads the folded text, and the raw message goes only to the fold and to the classifier', () => {
    // classifyHighRiskTopic: the message is folded once, and only `msg` is matched.
    expect(initializerOf(NOW_CLASSIFY, 'msg')).toBe('normaliseForMatching(userMessage).toLowerCase()');
    expect(identifierCount(NOW_CLASSIFY, 'userMessage')).toBe(2); // the parameter, and the fold
    const classifyCalls = matchCallsOf(NOW_CLASSIFY);
    expect(classifyCalls.length).toBe(4);
    expect(classifyCalls.filter((c) => c.argument !== 'msg')).toEqual([]);

    // validateShadowRequest: folded once into `text`; lowercased from `text`.
    expect(initializerOf(NOW_VALIDATE, 'text')).toBe('normaliseForMatching(message)');
    expect(initializerOf(NOW_VALIDATE, 'normalizedMessage')).toBe('text.toLowerCase()');
    expect(initializerOf(NOW_VALIDATE, 'classification')).toBe('classifyHighRiskTopic(message)');
    expect(identifierCount(NOW_VALIDATE, 'message')).toBe(3); // the parameter, the classifier, the fold
    const validateCalls = matchCallsOf(NOW_VALIDATE);
    expect(validateCalls.filter((c) => c.method === 'test').length).toBe(17);
    expect(validateCalls.filter((c) => c.method === 'test' && (c.receiverKind !== 'regex' || c.argument !== 'text'))).toEqual([]);
    expect(validateCalls.filter((c) => c.method === 'includes').length).toBe(2);
    expect(validateCalls.filter((c) => c.method === 'includes' && c.receiverKind !== 'normalizedMessage')).toEqual([]);
  });

  test('S1c: the fold is two global replaces of a plain character class by one character, and they spell the table', () => {
    const body = NOW_FOLD.body!.statements;
    expect(body.length).toBe(1);
    const returned = body[0];
    if (!ts.isReturnStatement(returned) || !returned.expression) throw new Error('the fold is not a single return');

    // Unwind text.replace(a, b).replace(c, d) from the outside in.
    const steps: Array<{ pattern: string; replacement: string }> = [];
    let at: ts.Expression = returned.expression;
    while (ts.isCallExpression(at)) {
      if (!ts.isPropertyAccessExpression(at.expression) || at.expression.name.text !== 'replace') {
        throw new Error('a call in the fold is not .replace: ' + at.getText().slice(0, 60));
      }
      const [pattern, replacement] = at.arguments;
      if (at.arguments.length !== 2 || !ts.isStringLiteral(replacement)) {
        throw new Error('a replace in the fold does not have a string literal replacement');
      }
      steps.unshift({ pattern: pattern.getText(), replacement: replacement.text });
      at = at.expression.expression;
    }
    expect(at.getText()).toBe('text');
    expect(steps.length).toBe(2);

    // One class, no negation, no range, members either a \uXXXX escape or a
    // single literal character; flag g and nothing else.
    const PLAIN_CLASS = /^\/\[((?:\\u[0-9A-Fa-f]{4}|[^\\\][^-])+)\]\/g$/;
    const spelled = new Map<number, string>();
    for (const step of steps) {
      const shape = PLAIN_CLASS.exec(step.pattern);
      if (!shape) throw new Error('not a plain single-unit character class with flag g: ' + step.pattern);
      expect(step.replacement.length).toBe(1);
      for (const member of shape[1].match(/\\u[0-9A-Fa-f]{4}|[^\\]/g) ?? []) {
        const unit = member.length === 6 ? parseInt(member.slice(2), 16) : member.charCodeAt(0);
        expect(spelled.has(unit)).toBe(false);
        spelled.set(unit, step.replacement);
      }
    }
    expect([...spelled].sort((a, b) => a[0] - b[0])).toEqual([...EXPECTED_FOLD].sort((a, b) => a[0] - b[0]));
  });

  // S1d. THE WHOLE OF BOTH FUNCTIONS, STATEMENT FOR STATEMENT.
  //
  // S1a and S1b look at particular things -- patterns, phrases, what each
  // `.test` is handed -- and a harmful edit can be none of those: `text`
  // reassigned on the next line to the output of a helper, an early
  // `return { valid: true }` on the caller's role or the message's length, an
  // extra `&& !quoted(text)` on the urgent return.
  //
  // So the two shipping functions are printed without comments, the short
  // list of differences below is undone, each exactly as many times as
  // stated, and what is left must be main's two functions, statement for
  // statement and parameter for parameter. An edit to the body or the
  // parameters of either function that is not on the list fails here. That
  // is the intent: after this change the classifier is main's plus the fold,
  // and THE NEXT CHANGE TO IT HAS TO COME AND SAY WHAT IT IS BY EDITING THIS
  // LIST. Changing the list is a deliberate act, not a way to make a red
  // test green.
  //
  // What it compares is printed text with runs of whitespace collapsed, so
  // it does not see whitespace inside a literal (S1a compares the literals
  // themselves) and it does not look at the functions' modifiers or return
  // types (S1e does). It does not reach outside the two functions: what the
  // route does with the message before and after is not covered by this
  // file.
  test('S1d: the two shipping functions are main\'s, statement for statement, but for the named differences', () => {
    const printer = ts.createPrinter({ removeComments: true });
    const print = (node: ts.Node, file: ts.SourceFile): string => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s+/g, ' ').trim();
    const shape = (fn: ts.FunctionDeclaration, file: ts.SourceFile) => ({
      parameters: fn.parameters.map((p) => print(p, file)),
      statements: fn.body!.statements.map((s) => print(s, file)),
    });

    /** Undo one named difference, and insist it was there exactly `times` times. */
    const undo = (statements: string[], from: string, to: string, times: number): string[] => {
      let seen = 0;
      const out = statements.map((s) => {
        const parts = s.split(from);
        seen += parts.length - 1;
        return parts.join(to);
      });
      if (seen !== times) throw new Error(`expected ${JSON.stringify(from)} ${times} time(s), found ${seen}`);
      return out;
    };
    const drop = (statements: string[], startsWith: string): string[] => {
      const kept = statements.filter((s) => !s.startsWith(startsWith));
      if (kept.length !== statements.length - 1) throw new Error(`expected exactly one statement starting ${JSON.stringify(startsWith)}`);
      return kept;
    };

    // classifyHighRiskTopic: the fold in front of the lowercasing; the
    // HighRiskTopic type where the frozen copy says string or nothing; and
    // the `examples` table, which no decision reads.
    const nowClassify = shape(NOW_CLASSIFY, PRODUCTION);
    let classify = nowClassify.statements;
    classify = undo(classify, 'normaliseForMatching(userMessage).toLowerCase()', 'userMessage.toLowerCase()', 1);
    classify = undo(classify, 'Array<[ HighRiskTopic, RegExp ]>', 'Array<[ string, RegExp ]>', 1);
    classify = undo(classify, 'let classifiedTopic: HighRiskTopic = ', 'let classifiedTopic = ', 1);
    classify = drop(classify, 'const examples: ');
    classify = undo(classify, ', examples: examples[classifiedTopic]', '', 1);
    // The named additions (see NAMED ADDITIONS above).
    classify = undo(classify, ADDED_CANT, '', 1);
    classify = undo(classify, ', ' + ADDED_ROW_SOURCE, '', 1);
    const mainClassifyShape = shape(MAIN_CLASSIFY, GUARD);
    expect(classify).toEqual(mainClassifyShape.statements);
    expect(nowClassify.parameters).toEqual(mainClassifyShape.parameters);
    expect(mainClassifyShape.statements.length).toBe(MAIN_CLASSIFY_STATEMENTS);

    // validateShadowRequest: the one added line that folds, and the folded
    // text where main read the message.
    const nowValidate = shape(NOW_VALIDATE, PRODUCTION);
    let validate = nowValidate.statements;
    validate = undo(validate, 'classifyHighRiskTopic(message)', 'mainClassify(message)', 1);
    validate = drop(validate, 'const text = normaliseForMatching(message);');
    validate = undo(validate, 'text.toLowerCase()', 'message.toLowerCase()', 1);
    validate = undo(validate, '.test(text)', '.test(message)', 17);
    validate = undo(validate, ADDED_CANT + '|' + ADDED_EMERGENCY, '', 1);
    validate = undo(validate, ADDED_ACUTE_CANT, '', 1);
    // The named reordering (see NAMED REORDERING above): the emergency
    // return, placed before main's first return.
    validate = drop(validate, 'const emergency = emergencyReport(text, hasPersonalContext && (hasUrgentSymptom || hasAcuteImpactConcern), classification);');
    validate = drop(validate, 'if (emergency) return emergency;');
    const mainValidateShape = shape(MAIN_VALIDATE, GUARD);
    expect(validate).toEqual(mainValidateShape.statements);
    expect(nowValidate.parameters).toEqual(mainValidateShape.parameters);
    expect(mainValidateShape.statements.length).toBe(MAIN_VALIDATE_STATEMENTS);
  });

  // S1e. WHAT S1c AND S1d DO NOT LOOK AT: how the three functions are
  // declared, and how they are reached.
  //
  // S1d compares parameters and body statements. A reviewer got past it
  // three ways: a second, defaulted parameter on the fold that rewrote the
  // text before the body ran; the real function left intact but no longer
  // the one exported (`export { wrapper as validateShadowRequest }`); and
  // code tucked into the one statement S1d drops, the `examples` table.
  test('S1e: the three functions are plain exported declarations, named only where they are declared and called, and the dropped table is only data', () => {
    const printer = ts.createPrinter({ removeComments: true });
    const print = (node: ts.Node): string => printer.printNode(ts.EmitHint.Unspecified, node, PRODUCTION).replace(/\s+/g, ' ').trim();
    const header = (fn: ts.FunctionDeclaration) => ({
      modifiers: (fn.modifiers ?? []).map((m) => print(m)),
      generator: Boolean(fn.asteriskToken),
      typeParameters: (fn.typeParameters ?? []).length,
      parameters: fn.parameters.map((p) => print(p)),
      returns: fn.type ? print(fn.type) : '',
    });

    expect(header(NOW_FOLD)).toEqual({
      modifiers: ['export'], generator: false, typeParameters: 0, parameters: ['text: string'], returns: 'string',
    });
    expect(header(NOW_CLASSIFY)).toEqual({
      modifiers: ['export'], generator: false, typeParameters: 0, parameters: ['userMessage: string'], returns: 'HighRiskClassification',
    });
    expect(header(NOW_VALIDATE)).toEqual({
      modifiers: ['export'], generator: false, typeParameters: 0,
      parameters: ['message: string', '_userRole: string', '_organizationId: string'],
      returns: 'ShadowValidationResult',
    });

    // Every mention of each name in the whole file, as code: its declaration
    // and its calls. A re-export, an alias, a wrapper or a reassignment is
    // one more.
    const mentions = (name: string): number => {
      let count = 0;
      walk(PRODUCTION, (n) => { if (ts.isIdentifier(n) && n.text === name) count += 1; });
      return count;
    };
    // Declared, called at the two request-side sites, and called once more by
    // the RESPONSE validator (CL-C8, 2026-10-05), which reads the folded text
    // for its own patterns and returns nothing through it. That fourth mention
    // is pinned to being a plain call inside validateShadowResponse, so an
    // alias or wrapper still adds one this count does not allow.
    expect(mentions('normaliseForMatching')).toBe(4);
    let responseSideCalls = 0;
    walk(PRODUCTION, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'validateShadowResponse') {
        walk(n, (inner) => {
          if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && inner.expression.text === 'normaliseForMatching') {
            responseSideCalls += 1;
          }
        });
      }
    });
    expect(responseSideCalls).toBe(1);
    expect(mentions('classifyHighRiskTopic')).toBe(2); // declared, and called by the validator
    expect(mentions('validateShadowRequest')).toBe(1); // declared; called only from outside this file

    // The `examples` statement S1d drops: one declarator, and nothing in its
    // initialiser but object literals, arrays and strings.
    const dropped = NOW_CLASSIFY.body!.statements.filter((s) => print(s).startsWith('const examples: '));
    expect(dropped.length).toBe(1);
    const statement = dropped[0];
    if (!ts.isVariableStatement(statement)) throw new Error('the examples statement is not a variable statement');
    expect(statement.declarationList.declarations.length).toBe(1);
    const initialiser = statement.declarationList.declarations[0].initializer;
    if (!initialiser) throw new Error('the examples table has no initialiser');
    const allowed = new Set([
      ts.SyntaxKind.ObjectLiteralExpression,
      ts.SyntaxKind.PropertyAssignment,
      ts.SyntaxKind.ArrayLiteralExpression,
      ts.SyntaxKind.StringLiteral,
      ts.SyntaxKind.Identifier, // property names only; checked below
    ]);
    const strangers: string[] = [];
    walk(initialiser, (n) => {
      if (!allowed.has(n.kind)) strangers.push(ts.SyntaxKind[n.kind]);
      if (ts.isIdentifier(n) && !(ts.isPropertyAssignment(n.parent) && n.parent.name === n)) strangers.push('identifier ' + n.text);
    });
    expect(strangers).toEqual([]);
  });

  // NOT COVERED BY ANY OF S1a-S1e, and not coverable from inside the same
  // process: code elsewhere in the module, or anywhere, that changes what
  // the built-ins do -- a patched String.prototype.toLowerCase or
  // RegExp.prototype.test. It would change the frozen reference in the same
  // breath, so the differentials could not see it either.

  // The twenty characters the argument is about: eighteen sources, two outputs.
  const TWENTY = [...SOURCES, "'", '"'];
  const mentions = (p: Pattern): boolean => TWENTY.some((ch) => p.source.includes(ch));

  test('S3: exactly four of main\'s thirty-seven patterns mention an apostrophe, a quote or a look-alike; neither phrase does', () => {
    expect(MAIN_PATTERNS.length).toBe(37);
    expect(MAIN_PATTERNS.filter(mentions).map((p) => p.owner)).toEqual([
      'topic loss_of_consciousness',
      'topic urgent_symptom',
      'hasUrgentSymptom',
      'hasAcuteImpactConcern',
    ]);
    for (const phrase of includesLiteralsOf(MAIN_VALIDATE)) {
      expect(TWENTY.filter((ch) => phrase.includes(ch))).toEqual([]);
    }
    // A pattern could also reach one of the twenty without spelling it: by an
    // escape, a property class, or a range. None of main's patterns has any.
    // (\0-\7 is the legacy octal escape: \47 and \047 are an apostrophe.)
    const INDIRECT = /\\u|\\x|\\p|\\P|\\c|\\[0-7]|\[[^\]]*[^\\\]]-[^\]]/;
    expect(MAIN_PATTERNS.filter((p) => INDIRECT.test(p.source)).map((p) => p.owner)).toEqual([]);
    // And the one look-alike is the only non-ASCII character in any of them,
    // which is what makes a non-ASCII letter's case forms invisible to them.
    const nonAscii = MAIN_PATTERNS.flatMap((p) => [...p.source].filter((ch) => ch.charCodeAt(0) > 0x7f).map((ch) => `${p.owner}: ${unitLabel(ch.charCodeAt(0))}`));
    expect(nonAscii).toEqual(['topic loss_of_consciousness: U+2019']);
    // The predicates the argument names as unchanged are among the thirty-three.
    const unchanged = MAIN_PATTERNS.filter((p) => !mentions(p)).map((p) => p.owner);
    for (const name of ['hasEducationalFraming', 'hasPersonalFraming', 'hasPrescriptionLanguage', 'hasRapidWeightCutLanguage', 'hasPersonalContext', 'hasPersonalHealthConcern']) {
      expect(unchanged).toContain(name);
    }
  });

  test('S4a: none of main\'s patterns has a construct that could turn a new apostrophe into a lost match', () => {
    // Negated class; \W \S \D \B; lookahead or lookbehind of either sign;
    // backreference, numbered or named.
    const NON_MONOTONE = /\[\^|\\[WSDB]|\(\?=|\(\?!|\(\?<[=!]|\\[1-9]|\\k</;
    expect(MAIN_PATTERNS.filter((p) => NON_MONOTONE.test(p.source)).map((p) => p.owner)).toEqual([]);
    // And no flag but `i`: no `s` to change what `.` matches, no `u`, no `m`.
    expect([...new Set(MAIN_PATTERNS.map((p) => p.flags))]).toEqual(['i']);
  });

  test('S4b: wherever a pattern names a look-alike, it names it in a class beside the character it folds to', () => {
    const naming: string[] = [];
    for (const p of MAIN_PATTERNS) {
      for (const [unit, output] of EXPECTED_FOLD) {
        const ch = String.fromCharCode(unit);
        for (let i = p.source.indexOf(ch); i >= 0; i = p.source.indexOf(ch, i + 1)) {
          const open = p.source.lastIndexOf('[', i);
          const close = p.source.indexOf(']', i);
          const inClass = open >= 0 && close > i && p.source.lastIndexOf(']', i) < open;
          const besideOutput = inClass && p.source.slice(open, close).includes(output);
          naming.push(`${p.owner}: ${unitLabel(unit)} ${besideOutput ? 'in a class beside its output' : 'ALONE'}`);
        }
      }
    }
    // One mention in the whole of main: the hand-patched KO'd.
    expect(naming).toEqual(['topic loss_of_consciousness: U+2019 in a class beside its output']);
  });
});

// ---------------------------------------------------------------------------
// THE FOLD, ONE CODE UNIT AT A TIME.
// ---------------------------------------------------------------------------
describe('what the fold does to every UTF-16 code unit', () => {
  test('the table names eighteen code units: twelve apostrophe look-alikes and six quote look-alikes', () => {
    expect(APOSTROPHE_SOURCES.length).toBe(12);
    expect(QUOTE_SOURCES.length).toBe(6);
    // A Map silently keeps the last of two equal keys, so a unit listed twice
    // would shrink it and the two counts above would not notice.
    expect(EXPECTED_FOLD.size).toBe(18);
  });

  // THE EXACT MAP. Every one of the 65,536 UTF-16 code units, lone surrogate
  // units included -- the fold works on code units, and a unit it altered
  // would be half of somebody's emoji.
  test('every code unit folds to itself, except the eighteen named ones, each to its named output', () => {
    const offenders: string[] = [];
    let rewritten = 0;

    for (let unit = 0; unit < UNITS; unit += 1) {
      const ch = String.fromCharCode(unit);
      const expected = EXPECTED_FOLD.get(unit) ?? ch;
      if (expected !== ch) rewritten += 1;

      // Alone AND between two letters: the same answer in both places is
      // what lets the later tests treat the fold of one unit as a fact about
      // that unit rather than about where it was standing.
      const alone = normaliseForMatching(ch);
      const between = normaliseForMatching('a' + ch + 'b');
      if (alone !== expected || between !== 'a' + expected + 'b') {
        offenders.push(
          `${unitLabel(unit)}: expected ${JSON.stringify(expected)}, `
          + `got ${JSON.stringify(alone)} alone and ${JSON.stringify(between)} between letters`,
        );
      }
    }

    // The loop above cannot pass by the table being empty.
    expect(rewritten).toBe(18);
    expect(offenders.slice(0, 40)).toEqual([]);
  });

  // U+FEFF BY NAME. It was deleted once, which released a message main
  // withheld, and folded to a space once, which took the emergency response
  // away from another. It is left exactly as typed, as it is on main, where
  // `\s` already matches it.
  test('U+FEFF is left exactly as typed', () => {
    expect(normaliseForMatching('a\uFEFFb')).toBe('a\uFEFFb');
    expect(/\s/.test('\uFEFF')).toBe(true);
  });

  // THE CLASS FACTS STEP 2 OF THE ARGUMENT USES. Given the exact map these
  // follow from twenty characters, so they are checked on the twenty. They
  // are what says WHY the map is safe: the day someone adds a nineteenth
  // source the map test will be edited to match, and this is what tells them
  // whether the new one breaks a pattern.
  test('all eighteen sources and both outputs are one unit, non-word, non-whitespace, not a line terminator, and have no other case', () => {
    const wrong: string[] = [];
    for (const ch of [...SOURCES, "'", '"']) {
      const facts = {
        oneUnit: ch.length === 1,
        nonWord: !/\w/.test(ch),
        nonSpace: !/\s/.test(ch),
        nonDigit: !/\d/.test(ch),
        notTerminator: !/[\n\r\u2028\u2029]/.test(ch),
        matchedByDot: /^.$/.test(ch),
        caseless: ch.toLowerCase() === ch && ch.toUpperCase() === ch,
      };
      for (const [fact, holds] of Object.entries(facts)) {
        if (!holds) wrong.push(`${unitLabel(ch.charCodeAt(0))}: not ${fact}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  // LOWERCASING. classifyHighRiskTopic lowercases after folding and the
  // `.includes` phrases read lowercased text, so a unit that lowercases INTO
  // a source, or a source that lowercases away, would get past the fold.
  //
  // The other direction -- one of the twenty changing under a case mapping
  // -- is the `caseless` fact in the test above.
  test('no other code unit lowercases into a look-alike, an apostrophe or a quote, or matches one under the i flag', () => {
    const twenty = new Set([...SOURCES, "'", '"']);
    const offenders: string[] = [];
    for (let unit = 0; unit < UNITS; unit += 1) {
      const ch = String.fromCharCode(unit);
      if (twenty.has(ch)) continue;
      const lowered = ch.toLowerCase();
      if ([...lowered].some((c) => twenty.has(c))) {
        offenders.push(`${unitLabel(unit)} lowercases to ${show(lowered)}`);
      }
      // Roughly what a non-unicode `i` regex compares: the uppercase form
      // when that is a single unit, the character itself otherwise. (The
      // specification adds an exception -- a non-ASCII character whose
      // uppercase is ASCII stays itself -- which this check ignores, so it
      // is the stricter of the two. The engine is asked directly below.)
      const upper = ch.toUpperCase();
      if (upper.length === 1 && twenty.has(upper)) {
        offenders.push(`${unitLabel(unit)} canonicalises to ${show(upper)} under the i flag`);
      }
    }
    expect(offenders).toEqual([]);
    // The engine's own answer for the same question, on the twenty.
    for (const ch of twenty) {
      const insensitive = new RegExp('^[' + ch + ']$', 'i');
      let matches = 0;
      for (let unit = 0; unit < UNITS; unit += 1) if (insensitive.test(String.fromCharCode(unit))) matches += 1;
      expect(`${unitLabel(ch.charCodeAt(0))}: ${matches}`).toBe(`${unitLabel(ch.charCodeAt(0))}: 1`);
    }
  });

  // THE SIGMA. Lowercasing is context-sensitive in one place: a capital
  // sigma that follows a letter becomes a final sigma (U+03C2) when no
  // letter follows it and a medial one (U+03C3) when one does, and the ASCII
  // apostrophe is skipped over in deciding that where U+201A is not. So
  // "a" + sigma + look-alike + "b" lowercases differently before and after
  // the fold. No pattern mentions either sigma (S3: main's patterns are
  // ASCII but for one look-alike), so the verdict should not move.
  test('where the fold changes how a sigma lowercases, the current code still equals main applied to the folded message', () => {
    const sigma = String.fromCharCode(0x03a3);
    const low9 = String.fromCharCode(0x201a);
    const tail = ' a' + sigma + low9 + 'b';
    // The premise, on the very text appended below: the two lowercased forms
    // differ at the sigma.
    expect(show(tail.toLowerCase())).toBe('U+0020 U+0061 U+03C2 U+201A U+0062');
    expect(show(normaliseForMatching(tail).toLowerCase())).toBe('U+0020 U+0061 U+03C3 U+0027 U+0062');

    const wrong: string[] = [];
    for (const [, seed] of SEEDS) {
      const message = seed + tail;
      // The premise holds for this message, not just for the tail alone.
      const at = seed.length + 2;
      if (message.toLowerCase().charCodeAt(at) !== 0x03c2 || normaliseForMatching(message).toLowerCase().charCodeAt(at) !== 0x03c3) {
        wrong.push('no sigma difference: ' + seed);
      }
      if (!same(now(message), main(normaliseForMatching(message))) && !explainedByEmergencyFirst(message, main(message), now(message))) wrong.push('not main of fold: ' + seed);
      if (withheld(main(message)) && !withheld(now(message))) wrong.push('released: ' + seed);
      if (emergency(main(message)) && !emergency(now(message))) wrong.push('emergency lost: ' + seed);
      if (critical(main(message)) && !critical(now(message))) wrong.push('downgraded: ' + seed);
    }
    expect(wrong).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ONE UNIT AT A TIME. The fold of a string is the fold of each of its code
  // units, concatenated.
  //
  // S1c above reads this off the source: two global replaces of a plain
  // class by one character cannot do anything else. These tests run it as
  // well, so that the property does not rest on one parser's reading of one
  // function. What is run: every code unit with every member of a
  // 161-character context set immediately before and after it; every unit
  // first and last in a message; every ASCII string of one, two or three
  // characters; twenty thousand seeded random strings. That is not "every
  // string", and a rule keyed on a longer or stranger sequence -- "wont"
  // into "won't" is four ASCII characters -- gets past all four. S1c is what
  // stops that one.
  // -------------------------------------------------------------------------
  describe('the fold of a string is the fold of each of its code units', () => {
    // What the fold does to each unit alone. Pinned to the table by the
    // exact-map test, so this is not the fold marking its own homework.
    const UNIT_CHARS: string[] = [];
    const UNIT_FOLD: string[] = [];
    for (let unit = 0; unit < UNITS; unit += 1) {
      UNIT_CHARS.push(String.fromCharCode(unit));
      UNIT_FOLD.push(normaliseForMatching(UNIT_CHARS[unit]));
    }

    function unitwise(text: string): string {
      const out: string[] = new Array(text.length);
      for (let i = 0; i < text.length; i += 1) out[i] = UNIT_FOLD[text.charCodeAt(i)];
      return out.join('');
    }

    // The neighbours worth standing beside: all of ASCII, everything the
    // fold reads or writes, and the characters behind each earlier defect.
    const CONTEXT_UNITS: readonly number[] = [
      ...Array.from({ length: 0x80 }, (_, unit) => unit),
      ...EXPECTED_FOLD.keys(),
      0x0085, // NEL
      0x00a0, // NBSP
      0x00ad, // SOFT HYPHEN
      0x00e9, // a non-ASCII letter
      0x0301, // COMBINING ACUTE ACCENT
      0x200b, 0x200c, 0x200d, // zero-width space, non-joiner, joiner
      0x2026, // HORIZONTAL ELLIPSIS, which NFKC expanded
      0x2028, 0x2029, // the two non-ASCII line terminators
      0x2122, // TRADE MARK SIGN, which NFKC turned into letters
      0x3000, // IDEOGRAPHIC SPACE
      0xd83e, 0xdd4a, // the two halves of U+1F94A
      0xfeff, // ZERO WIDTH NO-BREAK SPACE, once deleted and once folded
    ].filter((unit, index, all) => all.indexOf(unit) === index);

    // One string per context character c: "c x0 c x1 c x2 ... c" over all
    // 65,536 units, so every unit stands with c immediately before it AND
    // immediately after it.
    test('every code unit with every context character on both sides of it', () => {
      const offenders: string[] = [];

      for (const context of CONTEXT_UNITS) {
        const c = UNIT_CHARS[context];
        const foldedC = UNIT_FOLD[context];
        const parts: string[] = [c];
        const expectedParts: string[] = [foldedC];
        for (let unit = 0; unit < UNITS; unit += 1) {
          parts.push(UNIT_CHARS[unit], c);
          expectedParts.push(UNIT_FOLD[unit], foldedC);
        }
        const text = parts.join('');

        const folded = normaliseForMatching(text);
        const expected = expectedParts.join('');
        if (folded === expected) continue;

        // Name the first place they part company, with a little either side.
        let at = 0;
        while (at < folded.length && at < expected.length && folded[at] === expected[at]) at += 1;
        offenders.push(
          `context ${unitLabel(context)}: differs at index ${at} `
          + `(lengths ${folded.length} vs ${expected.length}), near ${show(text.slice(Math.max(0, at - 2), at + 3))}`,
        );
      }

      expect(offenders.slice(0, 40)).toEqual([]);
      // 128 ASCII, 17 sources outside ASCII, 16 others.
      expect(CONTEXT_UNITS.length).toBe(161);
    });

    // The interleaved strings above put nothing but c at either END, so a
    // rule anchored to the start or end of the message -- a trim, a `^`, a
    // `$` -- needs its own look.
    test('every code unit at the start and at the end of a message', () => {
      const offenders: string[] = [];
      let compared = 0;

      for (const c of ['a', ' ', "'"]) {
        for (let unit = 0; unit < UNITS && offenders.length < 40; unit += 1) {
          const x = UNIT_CHARS[unit];
          for (const text of [x + c, c + x]) {
            compared += 1;
            if (normaliseForMatching(text) !== unitwise(text)) offenders.push(show(text));
          }
        }
      }

      expect(offenders).toEqual([]);
      expect(compared).toBe(3 * UNITS * 2);
    });

    test('every ASCII string of one, two or three characters', () => {
      const offenders: string[] = [];
      let compared = 0;
      const ascii = UNIT_CHARS.slice(0, 0x80);

      for (const a of ascii) {
        compared += 1;
        if (normaliseForMatching(a) !== unitwise(a)) offenders.push(show(a));
        for (const b of ascii) {
          compared += 1;
          if (normaliseForMatching(a + b) !== unitwise(a + b)) offenders.push(show(a + b));
          for (const c of ascii) {
            compared += 1;
            const text = a + b + c;
            if (normaliseForMatching(text) !== unitwise(text)) offenders.push(show(text));
          }
        }
        if (offenders.length >= 40) break;
      }

      expect(offenders.slice(0, 40)).toEqual([]);
      expect(compared).toBe(128 + 128 * 128 + 128 * 128 * 128);
    });

    test('twenty thousand seeded random strings, weighted toward the look-alikes', () => {
      // mulberry32. Seeded, so a failure is the same failure on every machine.
      let state = 0x1049;
      const random = (): number => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const sources = [...EXPECTED_FOLD.keys()];
      const pick = (): number => {
        const roll = random();
        if (roll < 0.4) return sources[Math.floor(random() * sources.length)];
        if (roll < 0.7) return Math.floor(random() * 0x80);
        return Math.floor(random() * UNITS);
      };

      const offenders: string[] = [];
      let touched = 0;
      let made = 0;
      for (let n = 0; n < 20000 && offenders.length < 40; n += 1) {
        const length = 1 + Math.floor(random() * 64);
        let text = '';
        for (let i = 0; i < length; i += 1) text += String.fromCharCode(pick());
        made += 1;
        const folded = normaliseForMatching(text);
        if (folded !== text) touched += 1;
        if (folded !== unitwise(text)) offenders.push(show(text));
      }

      expect(offenders).toEqual([]);
      expect(made).toBe(20000);
      // How many of them the fold actually changed. Measured; the generator
      // is seeded, so it is the same number on every run.
      expect(touched).toBe(RANDOM_STRINGS_TOUCHED);
    });

    // SURROGATE PAIRS, STATED RATHER THAN ASSUMED.
    //
    // The fold has no `u` flag and works on UTF-16 code units. Every unit it
    // rewrites is outside U+D800-U+DFFF and so is everything it writes, so it
    // can neither split a pair nor alter half of one. The exact-map test
    // covers each surrogate unit alone; this covers a whole astral character
    // standing directly against each of the eighteen sources.
    //
    // This is NOT astral coverage of the classifier. U+E0027 is TAG
    // APOSTROPHE, an astral apostrophe look-alike, and it is asserted here as
    // NOT folded: astral look-alikes behave as they do on main.
    test.each(['\u{1F94A}', '\u{E0027}'])('an astral character against each look-alike is neither split nor altered: %j', (astral) => {
      expect(astral.length).toBe(2);
      for (const [unit, output] of EXPECTED_FOLD) {
        const source = String.fromCharCode(unit);
        expect(normaliseForMatching(astral + source + astral)).toBe(astral + output + astral);
        expect(normaliseForMatching(source + astral + source)).toBe(output + astral + output);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// THE DIFFERENTIALS -- main against the current code.
//
// The argument above says what cannot happen. These run it. They are the
// check on Step 5, which was done by reading, and a second check, by
// running, on Step 1's "now(m) = main(f(m))".
// ---------------------------------------------------------------------------

// Seed sentences, each declared with the return main gives it. Between them
// they leave by every one of main's nine returns. Every seed is plain ASCII
// and none contains a look-alike.
const SEEDS: ReadonlyArray<readonly [string, string]> = [
  ['R1 prescription or weight cut', 'Should I take this medication before training'],
  ['R1 prescription or weight cut', 'how do i cut weight fast'],
  ['R1 prescription or weight cut', 'I need to lose weight quickly before Saturday'],
  ['R1 prescription or weight cut', 'help me make weight by Friday'],
  ['R1 prescription or weight cut', 'cut weight for my weight class'],
  ['R1 prescription or weight cut', 'He was prescribed something for it'],
  // Main's own ordering: R1 sits above R3, so this emergency report gets the
  // medication text on main. Pre-existing; see the known-gap test below.
  ['R1 prescription or weight cut', "I can't breathe and I need to lose weight quickly"],
  ['R2 educational, allowed', 'What is a concussion?'],
  ['R2 educational, allowed', 'What causes fainting?'],
  ['R2 educational, allowed', 'What can cause shortness of breath?'],
  ['R2 educational, allowed', 'What are the rules of boxing?'],
  ['R2 educational, allowed', "What does can't breathe mean"],
  ['R3 urgent', "I can't breathe after that hit"],
  ['R3 urgent', 'I cannot see after that punch'],
  ['R3 urgent', "I can't move my arm after that fall"],
  ['R3 urgent', 'My neck is numb after that hit'],
  ['R3 urgent', "my nose is bleeding and it won't stop"],
  ['R3 urgent', 'I have a headache after sparring'],
  ['R3 urgent', 'my vision is really blurry today'],
  ['R3 urgent', "I told him 'I can't breathe' right after that hit"],
  // Two that reach R3 through hasAcuteImpactConcern alone, with no urgent
  // symptom phrase in them.
  ['R3 urgent', 'after that punch I feel dizzy and confused'],
  ['R3 urgent', "from that fall I can't feel my hand"],
  // APOSTROPHE-SLOT SEEDS. Each has a space where the apostrophe of "can't"
  // or "KO'd" would be, so it leaves main by the return declared here. The
  // variants with one of the twelve APOSTROPHE look-alikes in that slot are
  // the phone-typed sentence, and move to R3 (or, for the KO ones, keep
  // their return with the topic becoming loss_of_consciousness); the six
  // quote look-alikes in the slot change nothing. These five cover the moves
  // to R3 from R4, R5, R6, R7 and R8; R9 to R3 and R9 to R8 come from the
  // other seeds in this list.
  ['R4 personal health', 'my shoulder hurts and I can t breathe'],
  ['R5 diagnosis', 'do i have a concussion if i can t see'],
  ['R6 clearance', 'am I cleared to spar if I can t see'],
  ['R7 medication', 'do i get a pill if i can t breathe'],
  ['R8 high-risk fallback', 'I fainted and I can t breathe'],
  ['R8 high-risk fallback', 'chest pain and she got ko d'],
  // The same slot under returns that do not change: the topic becomes
  // loss_of_consciousness and the return stays. The R2 one is the case the
  // chat route treats differently afterwards; see the test that names it.
  ['R2 educational, allowed', 'What does research say about return to play after being ko d'],
  ['R3 urgent', "I can't see straight after I got ko d"],
  ['R4 personal health', 'my shoulder hurts'],
  ['R4 personal health', 'I hurt my wrist'],
  ['R4 personal health', 'our bag session left me sore'],
  ['R5 diagnosis', 'do you have a concussion'],
  ['R5 diagnosis', 'did you get an injury there'],
  ['R6 clearance', 'is he cleared to spar'],
  ['R6 clearance', 'when is she getting medical clearance'],
  ['R6 clearance', "is he cleared to spar after he got ko'd"],
  ['R7 medication', 'can you use an injection for that'],
  ['R7 medication', 'do you get a pill for that'],
  ['R8 high-risk fallback', 'he fainted at the gym'],
  ['R8 high-risk fallback', 'she got knocked out'],
  ['R8 high-risk fallback', "she got KO'd last round"],
  ['R8 high-risk fallback', 'the kid seems dehydrated'],
  ['R8 high-risk fallback', 'he had a seizure'],
  ['R8 high-risk fallback', 'chest pain during the run'],
  ['R8 high-risk fallback', 'that was a concussion'],
  ['R9 nothing matched, allowed', 'How long should a round be'],
  ['R9 nothing matched, allowed', 'show the drill list'],
  ['R9 nothing matched, allowed', 'the coach said "keep your guard up"'],
  ['R9 nothing matched, allowed', "that's a good jab"],
  ['R9 nothing matched, allowed', "she can't make it to practice"],
];

/** Every string made by putting `ch` in place of one character of `seed`, or between two. */
function variantsOf(seed: string, ch: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < seed.length; i += 1) out.push(seed.slice(0, i) + ch + seed.slice(i + 1));
  for (let i = 0; i <= seed.length; i += 1) out.push(seed.slice(0, i) + ch + seed.slice(i));
  return out;
}

describe('main against the current code: every look-alike at every position of every seed', () => {
  test('the seeds leave main by all nine of its returns, as declared', () => {
    const wrong = SEEDS
      .filter(([declared, seed]) => returnOf(main(seed)) !== declared)
      .map(([declared, seed]) => `${JSON.stringify(seed)}: declared ${declared}, main gives ${returnOf(main(seed))}`);
    expect(wrong).toEqual([]);
    expect(SEEDS.length).toBe(52);
    expect([...new Set(SEEDS.map(([declared]) => declared))].sort()).toEqual([
      'R1 prescription or weight cut',
      'R2 educational, allowed',
      'R3 urgent',
      'R4 personal health',
      'R5 diagnosis',
      'R6 clearance',
      'R7 medication',
      'R8 high-risk fallback',
      'R9 nothing matched, allowed',
    ]);
    // And with no look-alike in them, the current code treats every seed as
    // main does, but for the seeds the named reordering moves to R3: each
    // of those is an emergency report, in main's own words, that main
    // answered from a return above its emergency one.
    expect(SEEDS.filter(([, seed]) => !same(main(seed), now(seed)) && !explainedByEmergencyFirst(seed, main(seed), now(seed))).map(([, seed]) => seed)).toEqual([]);
    expect(SEEDS.filter(([, seed]) => !same(main(seed), now(seed))).map(([, seed]) => seed)).toEqual(SEEDS_MOVED_TO_R3_BY_ORDERING);
  });

  // Each of the eighteen look-alikes, substituted for each character of each
  // seed and inserted at each gap. Every one of these messages contains a
  // character the fold rewrites, which the carrier sweep further down mostly
  // does not.
  test('nothing is released, no emergency response is lost, nothing critical is downgraded', () => {
    const released: string[] = [];
    const emergencyLost: string[] = [];
    const downgraded: string[] = [];
    const notMainOfFold: string[] = [];
    const byMainReturn: Record<string, number> = {};
    let compared = 0;
    const moves: Record<string, number> = {};
    let newlyWithheld = 0;
    let newlyWithheldWithoutEmergencyText = 0;
    let newlyEmergency = 0;
    let anyFieldDiffers = 0;

    for (const [, seed] of SEEDS) {
      for (const source of SOURCES) {
        for (const message of variantsOf(seed, source)) {
          const was = main(message);
          const is = now(message);
          compared += 1;
          byMainReturn[returnOf(was)] = (byMainReturn[returnOf(was)] ?? 0) + 1;

          if (withheld(was) && !withheld(is)) released.push(show(message));
          if (emergency(was) && !emergency(is)) emergencyLost.push(show(message));
          if (critical(was) && !critical(is)) downgraded.push(show(message));
          // Step 1 of the argument, run: the current code is main applied to
          // the folded message, in every field.
          if (!same(is, main(normaliseForMatching(message))) && !explainedByAddition(message, was, is) && !explainedByEmergencyFirst(message, was, is)) notMainOfFold.push(show(message));

          if (!withheld(was) && withheld(is)) newlyWithheld += 1;
          if (!withheld(was) && withheld(is) && !emergency(is)) newlyWithheldWithoutEmergencyText += 1;
          if (!emergency(was) && emergency(is)) newlyEmergency += 1;
          if (!same(was, is)) {
            anyFieldDiffers += 1;
            // Which return main took and which the current code takes; where
            // they are the same return, what changed is the topic.
            const move = returnOf(was) === returnOf(is)
              ? `${returnOf(was)}, topic ${was.topic} -> ${is.topic}`
              : `${returnOf(was)} -> ${returnOf(is)}`;
            moves[move] = (moves[move] ?? 0) + 1;
          }
        }
      }
    }

    expect(released.slice(0, 20)).toEqual([]);
    expect(emergencyLost.slice(0, 20)).toEqual([]);
    expect(downgraded.slice(0, 20)).toEqual([]);
    expect(notMainOfFold.slice(0, 20)).toEqual([]);

    // HOW MUCH WAS COMPARED, AND WHERE IT LANDED ON MAIN. Measured. Every
    // number is exact because the seeds, the eighteen look-alikes and the
    // frozen reference are all fixed; a change to any of them changes these
    // and has to say so.
    expect({ compared, byMainReturn, newlyWithheld, newlyEmergency, anyFieldDiffers, moves }).toEqual(SEED_DIFFERENTIAL_COUNTS);
    // Every message main allowed that is now withheld carries the emergency text.
    expect(newlyWithheldWithoutEmergencyText).toBe(0);
  });

  // THE DEFECT ITSELF, BY NAME, FOR EVERY APOSTROPHE LOOK-ALIKE. The counts
  // above contain this; here it is as a sentence.
  test('"I can?t breathe after that hit" is an emergency with each of the twelve apostrophe look-alikes; on main it was with none of them', () => {
    const onMain: string[] = [];
    const notNow: string[] = [];
    for (const unit of APOSTROPHE_SOURCES) {
      const message = 'I can' + String.fromCharCode(unit) + 't breathe after that hit';
      if (withheld(main(message))) onMain.push(unitLabel(unit));
      const is = now(message);
      if (!(emergency(is) && critical(is))) notNow.push(unitLabel(unit));
    }
    expect(APOSTROPHE_SOURCES.length).toBe(12);
    expect(onMain).toEqual([]);
    expect(notNow).toEqual([]);
  });

  // U+FEFF IN PLACE OF, AND BETWEEN, EVERY CHARACTER OF EVERY SEED.
  //
  // The fold leaves it alone, so the current code must do exactly what main
  // does, in every field. This is the test that the U+FEFF-to-space fold
  // failed: it made "lose weight<FEFF>quickly" match the weight-cut phrase,
  // which main's did not, and R1 sits above R3.
  test('U+FEFF anywhere in any seed: the current code gives main\'s answer in every field', () => {
    const different: string[] = [];
    let compared = 0;
    for (const [, seed] of SEEDS) {
      for (const message of variantsOf(seed, '\uFEFF')) {
        compared += 1;
        if (!same(main(message), now(message)) && !explainedByAddition(message, main(message), now(message)) && !explainedByEmergencyFirst(message, main(message), now(message))) different.push(show(message));
      }
    }
    expect(different.slice(0, 20)).toEqual([]);
    expect(compared).toBe(SEED_FEFF_COMPARISONS);
  });

  test.each([
    "I can't breathe and I need to lose weight\uFEFFquickly",
    'He has chest pain and wants to lose weight\uFEFFquickly',
    'He got knocked out and has to cut\uFEFFweight for my weight class',
    'chest pain just\uFEFFhappened',
    'cut weight\uFEFFfor my weight class',
  ])('the messages the U+FEFF fold changed keep main\'s answer, or the named reordering\'s R3: %j', (message) => {
    expect(withheld(main(message))).toBe(true);
    // Four of the five are emergency reports; the named reordering answers
    // them from R3 (same text, same topic, classification
    // urgent_personal_symptom in place of the topic; the first was main's
    // R1 and now gets the emergency text). The fifth has no acute sign and
    // keeps main's answer.
    if (same(now(message), main(message))) return;
    expect(now(message)).toEqual(emergencyFirstShape(message));
    expect(emergency(now(message)) && critical(now(message))).toBe(true);
  });

  // The fifth is withheld on main without the emergency text; what the
  // U+FEFF fold took from it was its classification.
  test('the first four of those are emergencies on main, and still are', () => {
    for (const message of [
      "I can't breathe and I need to lose weight\uFEFFquickly",
      'He has chest pain and wants to lose weight\uFEFFquickly',
      'He got knocked out and has to cut\uFEFFweight for my weight class',
      'chest pain just\uFEFFhappened',
    ]) {
      expect(emergency(main(message))).toBe(true);
      expect(critical(main(message))).toBe(true);
      expect(emergency(now(message))).toBe(true);
      expect(critical(now(message))).toBe(true);
    }
  });

  // WHAT PROPERTIES 1-3 DO NOT SAY, PINNED: an allowed question that names
  // KO'd.
  //
  // Each message below is ALLOWED, on main and here: it has an educational
  // framing word and no first-person or "now" word, which is all main's
  // classifier means by educational. The last one shows what that includes:
  // a first-hand account written without "I" or "my".
  //
  // The topic of each is loss_of_consciousness when "KO'd" is recognised and
  // something listed after it when it is not. Main recognised the ASCII
  // apostrophe and U+2019; the fold adds the other eleven apostrophe
  // look-alikes. The six quote look-alikes are not apostrophes and change
  // nothing. A topic listed BEFORE loss_of_consciousness -- concussion,
  // head_trauma -- is not displaced, on main or here.
  //
  // Nothing is released or downgraded in the sense of properties 1-3: the
  // verdict is `valid` on both sides. But when the displaced topic is
  // return_to_play, weight_cutting or medical_clearance, the chat route
  // answered with a stock line and queued a review, and for
  // loss_of_consciousness it calls the model and queues nothing first.
  // route.test.ts pins that half with the route run.
  test.each([
    ['return_to_play', 'What does research say about return to play after being ko?d'],
    ['weight_cutting', 'What is a weight cut like after getting ko?d'],
    ['medical_clearance', 'What is medical clearance after being ko?d'],
    ['return_to_play', 'Got ko?d in sparring last night and still feel off. What is the return to play protocol'],
  ])('an allowed question that names KO\'d: main\'s topic %s becomes loss_of_consciousness for eleven more spellings', (topicOnMain, template) => {
    const withApostrophe = (apostrophe: string): string => template.replace('?', apostrophe);
    const ASCII = main(withApostrophe("'"));

    // What main already does with the apostrophe and with the phone default.
    expect(ASCII).toEqual({ valid: true, highRisk: true, topic: 'loss_of_consciousness', classification: 'loss_of_consciousness' });
    expect(main(withApostrophe(String.fromCharCode(0x2019)))).toEqual(ASCII);
    expect(now(withApostrophe("'"))).toEqual(ASCII);

    const changed: string[] = [];
    for (const unit of APOSTROPHE_SOURCES) {
      const message = withApostrophe(String.fromCharCode(unit));
      expect(now(message)).toEqual(ASCII);
      if (!same(main(message), now(message))) {
        expect(main(message)).toEqual({ valid: true, highRisk: true, topic: topicOnMain, classification: topicOnMain });
        changed.push(unitLabel(unit));
      }
    }
    // Every apostrophe look-alike but the one main already knew.
    expect(changed.length).toBe(11);
    expect(changed).not.toContain('U+2019');

    // A quote look-alike in the same place is not an apostrophe: no change.
    for (const unit of QUOTE_SOURCES) {
      const message = withApostrophe(String.fromCharCode(unit));
      expect(now(message)).toEqual(main(message));
      expect(main(message).topic).toBe(topicOnMain);
    }
  });

  test('a topic listed before loss_of_consciousness is not displaced by KO\'d, on main or here', () => {
    for (const apostrophe of ["'", '`', String.fromCharCode(0x2018)]) {
      const message = `What is a concussion protocol after being ko${apostrophe}d`;
      expect(main(message).topic).toBe('concussion');
      expect(now(message)).toEqual(main(message));
    }
  });

  // KNOWN GAP ON MAIN, CLOSED BY THE NAMED REORDERING (#1036, 2026-10-06).
  // Main's first return sits above its emergency return, so an emergency
  // report that also contains a weight-cut phrase got the medication text
  // and no critical classification. The emergency return now comes first.
  test('an emergency report containing a weight-cut phrase got the medication text on main; it gets the emergency response here', () => {
    const message = "I can't breathe and I need to lose weight quickly";
    expect(withheld(main(message))).toBe(true);
    expect(emergency(main(message))).toBe(false);
    expect(critical(main(message))).toBe(false);
    expect(now(message)).toEqual(emergencyFirstShape(message));
    expect(emergency(now(message)) && critical(now(message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE CALL SITES, RUN. S1b reads them; this runs them, with every one of the
// 65,536 code units between two words of two messages main withholds. A
// character DELETED after the fold -- at the call site rather than in the
// fold -- joins the two words and shows here as the current code parting
// from main(f(m)). A rewrite that leaves the verdict on these two messages
// alone -- NBSP or U+FEFF to a space, a trim -- does NOT show here. S1d is
// what stops every call-site edit; this is its check for the one class that
// has already released a message.
// ---------------------------------------------------------------------------
describe('the current code is main applied to the folded message, with each code unit between two words of two messages', () => {
  test.each([
    ['my|shoulder hurts', 65473], // all but the 63 word characters
    ["I can't|breathe after that hit", 25], // the 25 units main's s matches
  ])('%s', (carrier, expectedWithheldOnMain) => {
    const [head, tail] = carrier.split('|');
    const offenders: string[] = [];
    let released = 0;
    let emergencyLost = 0;
    let downgraded = 0;
    let withheldOnMain = 0;
    for (let unit = 0; unit < UNITS; unit += 1) {
      const message = head + String.fromCharCode(unit) + tail;
      const was = main(message);
      const is = now(message);
      if (withheld(was)) withheldOnMain += 1;
      if (withheld(was) && !withheld(is)) released += 1;
      if (emergency(was) && !emergency(is)) emergencyLost += 1;
      if (critical(was) && !critical(is)) downgraded += 1;
      if (!same(is, main(normaliseForMatching(message)))) offenders.push(unitLabel(unit));
    }
    expect({ released, emergencyLost, downgraded }).toEqual({ released: 0, emergencyLost: 0, downgraded: 0 });
    expect(offenders.slice(0, 40)).toEqual([]);
    // How many of the 65,536 main withholds: every unit that leaves the two
    // words apart, for the first carrier; only the units main's `s` matches,
    // for the second. For the rest "not released" has nothing to say, and
    // what this test shows for them is the equality with main(f(m)).
    expect(withheldOnMain).toBe(expectedWithheldOnMain);
  });
});

// ---------------------------------------------------------------------------
// THE CARRIER SWEEP.
//
// The oldest part of this file, kept for what it is good at: characters the
// fold does NOT touch. Each carrier is a message main withholds, with one
// marked position; 382 code points -- every plausible separator -- are put
// there one at a time, and wherever main still withheld, the current code
// must.
//
// WHAT IT IS AND IS NOT EVIDENCE FOR. Its carriers leave main by two of the
// nine returns, R3 and R4, and only the comparisons counted as `folded`
// below contain a character the fold rewrites. For this fold, the rest
// cannot fail: the message reaches the patterns unchanged. They are here for
// the next change to the fold, which is how each of the earlier defects
// arrived -- a separator deleted, merged or expanded. The evidence for THIS
// fold is the argument and the seed differential above.
//
// The swept set, stated because a cap nobody can see is a lie:
//
//   U+0000-U+00FF   Latin-1: NBSP, SOFT HYPHEN, ACUTE, NEL, every ASCII control
//   U+2000-U+206F   General Punctuation: every exotic space and dash, the
//                   curly quotes and primes, U+200B-U+200D, U+2028, U+2029
//   U+02B9-U+02BC   three modifier-letter look-alikes, and U+02BA between them
//   U+FF02 U+FF07 U+FF40   the full-width look-alikes
//   U+1680 U+180E U+3000 U+FEFF U+FFF9-U+FFFB   stragglers
//
// which is all eighteen look-alikes and 364 others. NOT swept: the rest of
// the BMP, and anything astral.
// ---------------------------------------------------------------------------
const SWEPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x00ff],
  [0x2000, 0x206f],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0x02b9, 0x02bc],
  [0xff02, 0xff02],
  [0xff07, 0xff07],
  [0xff40, 0xff40],
];

function sweptCodePoints(): number[] {
  const out: number[] = [];
  for (const [lo, hi] of SWEPT_RANGES) {
    for (let cp = lo; cp <= hi; cp += 1) out.push(cp);
  }
  return out;
}

// name, carrier with `|` marking the one insertion point, and the number of
// swept code points for which main withholds it.
//
// The first seven carriers put their mark at one of three kinds of position:
// where the word boundary at the mark is the ONLY evidence of something the
// return needs (personal context in the first, the health concern in the
// second); beside a counted window (`vision.{0,12}blurr`, with 11 of its 12
// characters used, and `bleeding.{0,20}`, with 18 of 20); and immediately
// before the match. The other six mark a gap inside, after or well before
// the match. It is not every position, and no carrier marks more than one;
// the seed differential above is the one that visits every position.
const CARRIERS: ReadonlyArray<readonly [string, string, number]> = [
  ['boundary is the only evidence', 'my|shoulder hurts', 319],
  ['boundary is the only evidence, 2', 'I|hurt my wrist', 319],
  ['bounded window, vision', 'my vision is|really blurry', 378],
  ['bounded window, bleeding', 'my lip is bleeding pretty badly|and will not stop', 378],
  ['before contraction', "I got hit|can't breathe", 382],
  ['before cannot', 'I got hit|cannot breathe', 382],
  ['before symptom phrase', 'After that punch I had a|headache', 382],
  ['contraction gap', "I can't|breathe after that hit", 25],
  // SUBSTITUTED, not inserted: the swept character stands where the
  // apostrophe would. Main matched exactly one of the 382 here, the ASCII
  // apostrophe, so one is this carrier's full count.
  ['apostrophe substituted', 'I can|t breathe after that hit', 1],
  ['cannot gap', 'I cannot|breathe after that hit', 25],
  ['two-word symptom', 'I have seeing|stars after sparring', 25],
  ['impact gap', 'My neck is numb after that|hit', 382],
  ['leading word gap', 'I|have a headache after sparring', 382],
];

describe('the carrier sweep: a separator at a marked position releases nothing main withheld', () => {
  test('no swept code point, at any carrier\'s mark, releases a message main withheld', () => {
    const codePoints = sweptCodePoints();
    const regressions: string[] = [];
    const returnsReached = new Set<string>();
    let compared = 0;
    let folded = 0;

    for (const [label, carrier] of CARRIERS) {
      const [head, tail] = carrier.split('|');
      for (const cp of codePoints) {
        const message = head + String.fromCodePoint(cp) + tail;
        const was = main(message);
        if (!withheld(was)) continue;
        compared += 1;
        returnsReached.add(returnOf(was));
        if (normaliseForMatching(message) !== message) folded += 1;
        const is = now(message);
        if (emergency(was) && !emergency(is)) regressions.push(`${label}: ${unitLabel(cp)} -- emergency text lost`);
        if (critical(was) && !critical(is)) regressions.push(`${label}: ${unitLabel(cp)} -- critical classification lost`);
        if (!withheld(is)) {
          regressions.push(`${label}: ${unitLabel(cp)} -- main withheld this, the current code does not`);
        }
      }
    }

    expect(regressions).toEqual([]);
    // The sum of the per-carrier counts: 2 x 319 + 2 x 378 + 5 x 382 + 3 x 25 + 1.
    expect(compared).toBe(3380);
    // Of which this many contain a character the fold rewrites. Measured.
    expect(folded).toBe(CARRIER_COMPARISONS_FOLDED);
    // And every one of them left main by one of these two returns.
    expect([...returnsReached].sort()).toEqual(['R3 urgent', 'R4 personal health']);
  });

  // THE PER-CARRIER COUNT, EXACT. The frozen reference and the swept set are
  // both fixed, so the count is not an estimate and there is nothing for
  // headroom to absorb. An earlier version declared minimums of 280, 330 and
  // 20 against real counts of 319, 378 or 382, and 25.
  test('every carrier contributes exactly its measured count', () => {
    const points = sweptCodePoints();
    const wrong: string[] = [];

    for (const [name, carrier, expected] of CARRIERS) {
      const parts = carrier.split('|');
      if (parts.length !== 2) wrong.push(`${name}: a carrier has exactly one mark`);
      const got = points.filter((cp) => withheld(main(parts[0] + String.fromCodePoint(cp) + parts[1]))).length;
      if (got !== expected) wrong.push(`${name}: ${got}, expected ${expected}`);
    }

    expect(wrong).toEqual([]);
    // 256 + 112 + 1 + 1 + 1 + 1 + 3 + 4 + 1 + 1 + 1, from SWEPT_RANGES, with no code point twice.
    expect(points.length).toBe(382);
    expect(new Set(points).size).toBe(382);
    expect(SOURCES.filter((ch) => !points.includes(ch.charCodeAt(0)))).toEqual([]);
  });

  // Main's `\s` matches U+FEFF, so main withheld this, and deleting U+FEFF
  // once released it. By name, so it cannot be dropped from the swept set
  // without a test going red.
  test('U+FEFF between the contraction and the symptom, which main treated as whitespace', () => {
    const message = "I can't\uFEFFbreathe after that hit";
    expect(withheld(main(message))).toBe(true);
    expect(withheld(now(message))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE CORPUS. More sensitive is the feature; indiscriminate is not.
//
// Sentences in which "cant" is part of another word. None is withheld on
// main or here: "cant" is not a pattern. An earlier version of this change
// made the apostrophe in "can't" optional, and sentences of this kind were
// withheld as emergencies; that widening was removed. The list is a fence
// for #1036, which will bring the contraction family back. It has not been
// checked row by row against any one earlier version, and the two rows with
// no first-person word in them ("incantation", "scanty") could not reach the
// urgent return under main's personal-context test whatever the pattern.
// ---------------------------------------------------------------------------
const BENIGN_CANT_CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['significant', 'I felt great after the punch drill and my footwork showed significant improvement'],
  ['vacant', 'I moved from the fall bag over to the vacant station after that punch drill'],
  ['scant', 'After that punch combo my notes were scant'],
  ['cantilever', 'I moved from the fall bag over to the cantilever station after that punch drill'],
  ['cantina', 'After that punch we all went to the cantina down the road'],
  ['canto', 'After that punch I heard my coach canto along with the radio'],
  ['canto accented', 'After that punch I heard my coach cant\u00F3 along with the radio'],
  ['recant', 'After that punch I had to recant what I said about the referee'],
  ['decant', 'After that punch I watched him decant the water bottle'],
  ['incantation', 'After that punch the corner was muttering like an incantation'],
  ['scanty', 'After that punch the lighting in the gym was scanty'],
  ['hyphenated', 'After that punch my footwork showed signifi-cant improvement'],
  ['soft hyphen', 'After that punch my footwork showed signifi\u00ADcant improvement'],
  ['en dash', 'After that punch my footwork showed signifi\u2013cant improvement'],
  ['applicant', 'After that punch I added the new applicant to the intake list'],
];

describe('a word merely containing "cant" is not withheld', () => {
  test.each(BENIGN_CANT_CORPUS)('%s', (_label, message) => {
    expect(withheld(now(message))).toBe(false);
    // And main did not withhold it either: these are controls for a future
    // change, not evidence about this one.
    expect(withheld(main(message))).toBe(false);
  });

  test('a quoted mention of the word is not withheld; a quoted real report is', () => {
    expect(withheld(now("After that punch the coach used the word 'cant' about my stance"))).toBe(false);
    expect(emergency(now("I told him 'I can't breathe' right after that hit"))).toBe(true);
    // With the phone's quotes and apostrophe, which main did not catch.
    const typed = 'I told him \u2018I can\u2019t breathe\u2019 right after that hit';
    expect(withheld(main(typed))).toBe(false);
    expect(emergency(now(typed))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MEASURED COUNTS. Each is asserted exactly above. They are gathered here so
// that a change which moves one shows up as one edited line with a reason.
// ---------------------------------------------------------------------------
// The string literals of main's validateShadowRequest.
const MAIN_VALIDATE_STRING_LITERALS = 18;
// The top-level statements of the two frozen functions. (Real main's
// classifier has one more, the `examples` table, which the frozen copy drops.)
const MAIN_CLASSIFY_STATEMENTS = 8;
const MAIN_VALIDATE_STATEMENTS = 17;
const RANDOM_STRINGS_TOUCHED = 19565;
const CARRIER_COMPARISONS_FOLDED = 162;
// The sum over the 52 seeds of (2 x length + 1).
const SEED_FEFF_COMPARISONS = 3210;
// The seeds that, with no look-alike in them, the named reordering answers
// from R3 where main did not: each an emergency report in main's own
// vocabulary (a faint, a knockout, a seizure, chest pain, "can't breathe")
// that main answered from R1, R6 or R8 because that return came first.
const SEEDS_MOVED_TO_R3_BY_ORDERING: readonly string[] = [
  "I can't breathe and I need to lose weight quickly",
  'I fainted and I can t breathe',
  'chest pain and she got ko d',
  "is he cleared to spar after he got ko'd",
  'he fainted at the gym',
  'she got knocked out',
  "she got KO'd last round",
  'he had a seizure',
  'chest pain during the run',
];
const SEED_DIFFERENTIAL_COUNTS = {
  // 18 x 3,210.
  compared: 57780,
  // The return MAIN gave each generated message. A look-alike dropped into
  // the middle of a keyword breaks it, which is why more land on R9 than
  // there are R9 seeds. The nine sum to `compared`.
  byMainReturn: {
    'R1 prescription or weight cut': 5238,
    'R2 educational, allowed': 5634,
    'R3 urgent': 10656,
    'R4 personal health': 3132,
    'R5 diagnosis': 1278,
    'R6 clearance': 3294,
    'R7 medication': 1854,
    'R8 high-risk fallback': 10495,
    'R9 nothing matched, allowed': 16199,
  },
  // Messages main allowed that are now withheld: the fix. Each of them
  // carries the emergency text, which the test asserts separately.
  // 2026-10-06 named additions: +72 here, +72 newlyEmergency, +144
  // anyFieldDiffers. They are seeds with a look-alike inside "breathe"
  // ("can't breath<x>e"), which the added `can't breath` typo alternative
  // catches; every one is a move of a kind already listed below (R9 -> R3,
  // or topic none -> urgent_symptom under R1/R2), only more of them.
  newlyWithheld: 155,
  // Before the named reordering: those 83, and 48 that main withheld
  // without the emergency text and that now get it, 12 from each of R4, R5,
  // R6 and R7 -- 203. The named reordering (2026-10-06, #1036) adds every
  // variant of the nine SEEDS_MOVED_TO_R3_BY_ORDERING in which main's
  // true emergency sign survives the look-alike, from R1, R6 and R8: 2,364 more.
  // newlyWithheld is UNCHANGED by it: the reordering withholds nothing in
  // this seed set that main allowed (the educational seeds name no specific
  // person), and the one-way checks above hold on every message.
  newlyEmergency: 2567,
  // Messages where any field differs from main's.
  anyFieldDiffers: 7084,
  // By what changed: the return, or the topic under an unchanged return.
  // These nine are the kinds this seed set produces, and they sum to
  // anyFieldDiffers. Each is of a kind Step 5 of the argument allows, or
  // the one kind the named reordering adds -- a return changes only to R3;
  // a topic changes only to urgent_symptom from none, or to
  // loss_of_consciousness -- and anything of another kind would appear
  // here as a tenth. Before the reordering there were thirteen kinds; the
  // reordering turned every "R6 clearance, topic -> loss_of_consciousness",
  // "R8 ..., topic chest_pain -> loss_of_consciousness" and "R9 -> R8" move
  // into a move to R3, and "R1, topic none -> urgent_symptom" likewise,
  // since each of those messages carries an acute sign and no educational
  // framing. R2's 48 topic-only moves stay: "What does can't breathe mean"
  // names nobody, so it is a general question and still allowed.
  moves: {
    'R1 prescription or weight cut -> R3 urgent': 714,
    'R2 educational, allowed, topic none -> urgent_symptom': 48,
    'R2 educational, allowed, topic return_to_play -> loss_of_consciousness': 11,
    'R3 urgent, topic urgent_symptom -> loss_of_consciousness': 11,
    'R4 personal health -> R3 urgent': 12,
    'R5 diagnosis -> R3 urgent': 12,
    'R6 clearance -> R3 urgent': 996,
    'R7 medication -> R3 urgent': 12,
    'R8 high-risk fallback -> R3 urgent': 5113,
    'R9 nothing matched, allowed -> R3 urgent': 155,
  },
};
