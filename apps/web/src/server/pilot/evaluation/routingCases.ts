// routingCases.ts -- the offline routing evaluation set for SHADOW.
//
// Each case is a question someone might type, the role asking it, an optional
// manual tier, and what classifyRequest (shadowClassifier.ts) should decide.
// Every message here is invented for this file: no live data, no real person's
// words, no child's text.
//
// WHAT "ROUTING" MEANS HERE. The tier (Quick Round or Heavy Bag) picks the
// model; the topic does not pick anything at request time, but it is stored
// as the message topic, the review-ticket category and the profile's
// recent_topics, which are written back into later prompts. A wrong topic is
// therefore a wrong statement about the person, made again on every turn.
//
// An expectation states only the fields the case is about. A case that fails
// on today's code is still a case: the baseline records it as failing, and the
// change that fixes it flips it in the same diff.

import type { PilotRole } from '../contracts';
import type { ShadowTier } from '../shadowClassifier';

export interface RoutingCase {
  id: string;
  role: PilotRole;
  message: string;
  manualTier?: ShadowTier;
  expect: {
    tier?: ShadowTier;
    topic?: string;
    /** For a word-inside-a-word defect: the topic the stray match produced, which must not be chosen. */
    topicNot?: string;
    /** Exact, to two decimals: the score is a fixed heuristic, so any move is a change worth seeing. */
    complexity?: number;
    manualOverrideOffered?: boolean;
  };
  /** Why the case exists, in one line. */
  note: string;
}

export const ROUTING_CASES: readonly RoutingCase[] = [
  // ── Tier ──────────────────────────────────────────────────────────────────
  {
    id: 'tier-short-athlete-question-is-quick',
    role: 'athlete',
    message: 'How do I warm up?',
    expect: { tier: 'quick_round' },
    note: 'A one-line question stays on the fast model.',
  },
  {
    id: 'tier-concussion-question-is-heavy',
    role: 'coach',
    message: 'What are concussion recovery protocols?',
    expect: { tier: 'heavy_bag' },
    note: 'A high-risk term lifts the question to the deep model.',
  },
  {
    id: 'tier-weight-cut-question-is-heavy',
    role: 'coach',
    message: 'Is cutting weight the week of a bout a good idea?',
    expect: { tier: 'heavy_bag' },
    note: 'Weight cutting is in the high-risk list.',
  },
  {
    id: 'tier-long-multi-part-coach-question-is-heavy',
    role: 'coach',
    message: `${'Detailed context about the athlete and the camp. '.repeat(20)}`
      + 'Compare and contrast the multi-step trade-offs, the edge cases, the nuance, '
      + 'the conflicting goals and the exceptions before you decide.',
    expect: { tier: 'heavy_bag', manualOverrideOffered: false },
    note: 'Length plus several complexity keywords reach Heavy Bag without an override.',
  },
  {
    id: 'tier-boundary-coach-question-offers-override',
    role: 'coach',
    message: 'Compare pressure versus counterpunching for a southpaw, the trade-off with his conditioning this camp, '
      + 'and the edge cases and nuance of his footwork against taller opponents.',
    expect: { tier: 'quick_round', complexity: 0.45, manualOverrideOffered: true },
    note: 'Between the thresholds: Quick Round by default, with escalation offered to a coach.',
  },
  {
    id: 'tier-boundary-athlete-question-offers-no-override',
    role: 'athlete',
    message: `${'Context about my camp and my sparring. '.repeat(15)}`
      + 'Compare pressure versus counterpunching: the trade-off, the edge cases, the nuance, '
      + 'the conflicting advice and the exceptions.',
    expect: { tier: 'quick_round', complexity: 0.45, manualOverrideOffered: false },
    note: 'Between the thresholds too, but an athlete is never offered the Heavy Bag escalation.',
  },

  // ── Manual tier ───────────────────────────────────────────────────────────
  {
    id: 'manual-coach-heavy-request-honored',
    role: 'coach',
    message: 'What is a warm-up?',
    manualTier: 'heavy_bag',
    expect: { tier: 'heavy_bag' },
    note: 'A coach may ask for the deep model.',
  },
  {
    id: 'manual-org-admin-heavy-request-honored',
    role: 'organization_admin',
    message: 'What is a warm-up?',
    manualTier: 'heavy_bag',
    expect: { tier: 'heavy_bag' },
    note: 'So may an organization admin.',
  },
  {
    id: 'manual-athlete-heavy-request-not-honored',
    role: 'athlete',
    message: 'What is a warm-up?',
    manualTier: 'heavy_bag',
    expect: { tier: 'quick_round' },
    note: 'An athlete cannot escalate.',
  },
  {
    id: 'manual-parent-heavy-request-not-honored',
    role: 'parent',
    message: 'What is training?',
    manualTier: 'heavy_bag',
    expect: { tier: 'quick_round' },
    note: 'Nor can a parent.',
  },
  {
    id: 'manual-coach-quick-request-wins-over-complexity',
    role: 'coach',
    message: 'Is cutting weight the week of a bout a good idea?',
    manualTier: 'quick_round',
    expect: { tier: 'quick_round' },
    note: 'Asking for the quick answer is a downgrade anyone may make.',
  },
  {
    id: 'manual-athlete-quick-request-honored',
    role: 'athlete',
    message: 'How do I warm up?',
    manualTier: 'quick_round',
    expect: { tier: 'quick_round' },
    note: 'No role gate on a downgrade.',
  },

  // ── Topic: what each topic should catch ───────────────────────────────────
  {
    id: 'topic-technique-form',
    role: 'athlete',
    message: 'How should I fix my form?',
    expect: { topic: 'technique' },
    note: 'Plain technique word.',
  },
  {
    id: 'topic-technique-stance',
    role: 'athlete',
    message: 'What stance should a southpaw use?',
    expect: { topic: 'technique' },
    note: 'Plain technique word.',
  },
  {
    id: 'topic-training-workout',
    role: 'athlete',
    message: 'What should my workout be this week?',
    expect: { topic: 'training' },
    note: 'Plain training word.',
  },
  {
    id: 'topic-training-drills-plural',
    role: 'athlete',
    message: 'How many rounds of drills should I do?',
    expect: { topic: 'training' },
    note: 'A plural still counts.',
  },
  {
    id: 'topic-training-trained-past-tense',
    role: 'coach',
    message: 'He trained hard all week, what next?',
    expect: { topic: 'training' },
    note: 'A past tense still counts.',
  },
  {
    id: 'topic-recovery-recover',
    role: 'athlete',
    message: 'How can I recover faster?',
    expect: { topic: 'recovery' },
    note: 'Plain recovery word.',
  },
  {
    id: 'topic-recovery-sleep',
    role: 'athlete',
    message: 'How much sleep do I need after sparring?',
    expect: { topic: 'recovery' },
    note: 'Plain recovery word.',
  },
  {
    id: 'topic-medical-pain',
    role: 'athlete',
    message: 'I have pain in my shoulder',
    expect: { topic: 'medical' },
    note: 'Plain medical word.',
  },
  {
    id: 'topic-mindset-focused',
    role: 'athlete',
    message: 'How do I stay focused during a fight?',
    expect: { topic: 'mindset' },
    note: 'Plain mindset word.',
  },
  {
    id: 'topic-strategy-plan',
    role: 'athlete',
    message: 'What is the plan for my next fight?',
    expect: { topic: 'strategy' },
    note: 'Plain strategy word.',
  },
  {
    id: 'topic-competition-competition',
    role: 'athlete',
    message: 'When is the next competition?',
    expect: { topic: 'competition' },
    note: 'Plain competition word.',
  },
  {
    id: 'topic-safety-safe',
    role: 'parent',
    message: 'Is it safe to spar twice a week?',
    expect: { topic: 'safety' },
    note: 'Plain safety word.',
  },
  {
    id: 'topic-equipment-headgear',
    role: 'athlete',
    message: 'Should I wear headgear?',
    expect: { topic: 'equipment' },
    note: 'Headgear is gear.',
  },
  {
    id: 'topic-no-topic-word-falls-back-to-role',
    role: 'coach',
    message: 'Who is on the card this Thursday?',
    expect: { topic: 'strategy' },
    note: 'No topic word: the coach default applies.',
  },

  // ── Topic: a topic word inside another word is not that topic ─────────────
  // Each message below contains a topic word in the middle of a longer word.
  // `topicNot` is the topic that stray match produced; where the right topic is
  // reachable from the listed words, `topic` states it as well.
  {
    id: 'topic-wrestling-is-not-rest',
    role: 'athlete',
    message: 'What wrestling moves help on the mat?',
    expect: { topicNot: 'recovery' },
    note: '"rest" inside "wrestling" filed a wrestling question under recovery.',
  },
  {
    id: 'topic-interesting-is-not-rest',
    role: 'athlete',
    message: 'Any interesting combinations to try?',
    expect: { topicNot: 'recovery' },
    note: '"rest" inside "interesting".',
  },
  {
    id: 'topic-performance-is-competition-not-form',
    role: 'athlete',
    message: 'How do I improve my performance in the ring?',
    expect: { topic: 'competition', topicNot: 'technique' },
    note: '"form" inside "performance" reached technique before "perform" (competition) was checked.',
  },
  {
    id: 'topic-information-is-not-form',
    role: 'parent',
    message: 'Can you give me more information about the program?',
    expect: { topicNot: 'technique' },
    note: '"form" inside "information".',
  },
  {
    id: 'topic-strain-is-not-train',
    role: 'coach',
    message: 'My athlete pulled a muscle and it is a strain, what helps?',
    expect: { topicNot: 'training' },
    note: '"train" inside "strain".',
  },
  {
    id: 'topic-distance-is-not-stance',
    role: 'coach',
    message: 'How do I keep my distance from a taller opponent?',
    expect: { topicNot: 'technique' },
    note: '"stance" inside "distance".',
  },
  {
    id: 'topic-upset-is-not-set',
    role: 'parent',
    message: 'My son is upset after losing',
    expect: { topicNot: 'training' },
    note: '"set" inside "upset".',
  },
  {
    id: 'topic-report-is-not-rep',
    role: 'coach',
    message: 'Where do I report the weigh-in numbers?',
    expect: { topicNot: 'training' },
    note: '"rep" inside "report".',
  },
  {
    id: 'topic-obsession-is-not-session',
    role: 'parent',
    message: 'My kid has an obsession with boxing videos',
    expect: { topicNot: 'training' },
    note: '"session" inside "obsession".',
  },
  {
    id: 'topic-fundamentals-is-not-mental',
    role: 'coach',
    message: 'How do I teach fundamentals to beginners?',
    expect: { topicNot: 'mindset' },
    note: '"mental" inside "fundamentals".',
  },
  {
    id: 'topic-prevent-is-not-event',
    role: 'athlete',
    message: 'How do I prevent cuts?',
    expect: { topicNot: 'competition' },
    note: '"event" inside "prevent".',
  },
  {
    id: 'topic-meeting-is-not-meet',
    role: 'parent',
    message: 'What time is the parents meeting?',
    expect: { topicNot: 'competition' },
    note: '"meet" inside "meeting".',
  },
  {
    id: 'topic-painting-is-not-pain',
    role: 'parent',
    message: 'Is painting the gym walls on the list?',
    expect: { topicNot: 'medical' },
    note: '"pain" inside "painting".',
  },
  {
    id: 'topic-injury-prevention-is-safety',
    role: 'coach',
    message: 'What is good injury prevention for shoulders?',
    expect: { topic: 'safety' },
    note: '"injury prevention" is listed under safety but "injury" (medical) was always checked first.',
  },

  // ── Topic: known vocabulary gaps ──────────────────────────────────────────
  // The right topic for each of these is not reachable from the listed words.
  // They are here so a vocabulary or model change shows what it fixes; they are
  // expected to fail until one does.
  {
    id: 'gap-strain-is-medical',
    role: 'athlete',
    message: 'I pulled a muscle and it is a strain, what helps?',
    expect: { topic: 'medical' },
    note: '"strain" is not a listed medical word.',
  },
  {
    id: 'gap-upset-after-losing-is-mindset',
    role: 'parent',
    message: 'My son is upset after losing',
    expect: { topic: 'mindset' },
    note: '"upset" is not a listed mindset word.',
  },
  {
    id: 'gap-wrestling-moves-is-technique',
    role: 'athlete',
    message: 'What wrestling moves help on the mat?',
    expect: { topic: 'technique' },
    note: 'No wrestling vocabulary; "moves" is not "movement".',
  },
  {
    id: 'gap-sparring-is-training',
    role: 'parent',
    message: 'How often should a beginner go sparring?',
    expect: { topic: 'training' },
    note: '"sparring" is not a listed word in any topic.',
  },

  // ── Complexity: a keyword inside another word adds nothing ────────────────
  {
    id: 'complexity-plain-short-coach-question',
    role: 'coach',
    message: 'The reach on my jab is short',
    expect: { complexity: 0.2 },
    note: 'Reference score for the two cases below.',
  },
  {
    id: 'complexity-extension-is-not-tension',
    role: 'coach',
    message: 'The extension on my jab is short',
    expect: { complexity: 0.2 },
    note: '"tension" inside "extension" added a complexity keyword.',
  },
  {
    id: 'complexity-show-different-strengthen-is-not-a-condition',
    role: 'coach',
    message: 'Show me a different way to strengthen my legs',
    expect: { complexity: 0.2 },
    note: '"how" in "show", "if" in "different" and "then" in "strengthen" read as if/then logic.',
  },
];
