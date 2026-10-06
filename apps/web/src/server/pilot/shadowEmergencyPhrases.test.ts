// SHADOW emergency vocabulary: phrases that must reach the emergency response
// the classifier already defines, and boxing/definition sentences that must not.
//
// THE GAP (SHADOW filters lane, 2026-10-06). "collapsed", "unresponsive",
// "won't wake up", "not breathing" and "cant" without an apostrophe were in
// no detector, so "Sam collapsed in the ring" was answered as an ordinary
// question. The fix adds them to the two places that already lead to the
// emergency text: the loss_of_consciousness topic row (reached with no
// personal context, so third person is covered) and hasUrgentSymptom (so a
// first-person report that also says "hurts" is not demoted to the
// personal-health answer). No new return, no new text.

import { validateShadowRequest } from './shadowChat';

const EMERGENCY =
  'Potential emergency: stop participation and contact local emergency services or an onsite licensed medical professional now.';
const CURLY = '’';

const check = (message: string) => validateShadowRequest(message, 'athlete', 'org-123');

describe('emergency phrases reach the emergency response', () => {
  test.each([
    // collapsed
    ['Sam collapsed in the ring'],
    ['The kid collapsed onto the canvas after the bell'],
    ['I collapsed after sparring'],
    ['I collapsed and my shoulder hurts'],
    // unresponsive
    ['He is unresponsive on the canvas'],
    ['My partner is unresponsive'],
    // won't wake up, with and without the apostrophe, straight and curly
    ["Jordan won't wake up"],
    [`Jordan won${CURLY}t wake up`],
    ['Jordan wont wake up'],
    ['She will not wake up after that knockout'],
    ["My son won't wake up"],
    ['my son wont wake up'],
    ["We can't wake him up"],
    ['coach cant wake her up'],
    // not breathing
    ['He is not breathing'],
    ["He isn't breathing"],
    [`He isn${CURLY}t breathing`],
    ['he isnt breathing'],
    ['She stopped breathing in the corner'],
    ['My teammate is not breathing'],
    ['The kid is not breathing after that hit'],
    // cant, no apostrophe, first person
    ['I cant breathe after that hit'],
    ['i cant see after that punch'],
    ['I cant move my legs'],
    ['after that hit i cant feel my arm'],
    // Adversarial review A, 2026-10-06: a first cut's exclusions swallowed these.
    ["he won't wake up at all"],
    ['he wont wake up for anything'],
    ['she wont wake up to her name'],
    ["he won't wake up until we shake him"],
    ['cant wake her up at all'],
    ["he's not waking up"],
    ['he isnt waking up'],
    ['he doesnt wake up'],
    ['i cant wake my son'],
    ["can't wake jake"],
    ['he stopped breathing on the canvas'],
    ['he stopped breathing during the round'],
    ["he's not breathing on his own"],
    ['he isnt breathing when i check'],
    ['hes not breathing right'],
    ["he's not breathing well"],
    ['not breathing properly'],
    ['he is barely breathing'],
    ['not breathin'],
    ['i cant breath'],
    ["i can't breath"],
    ['he is not responsive'],
    ['hes not responding'],
  ])('%s', (message) => {
    const result = check(message);
    expect(result.valid).toBe(false);
    expect(result.error).toBe(EMERGENCY);
  });

  // THIRD-PERSON "can't breathe" is withheld on main already, by the
  // urgent_symptom topic, with the high-risk handoff text rather than the
  // emergency text: urgent_symptom is not one of the three emergency topics.
  // Unchanged here (widening the emergency topics is ordering work, #1036);
  // asserted so the omitted apostrophe is seen to reach the same place.
  test.each([
    ["Sam can't breathe"],
    ['Sam cant breathe'],
  ])('withheld, third-person urgent symptom: %s', (message) => {
    const result = check(message);
    expect(result.valid).toBe(false);
    expect(result.topic).toBe('urgent_symptom');
  });
});

describe('boxing technique and definition sentences still pass', () => {
  test.each([
    // collapsed as technique
    ['His guard collapsed in the third round; how do I fix that?'],
    ['My stance collapsed when I threw the hook'],
    ['Your elbows collapsed on the body shot, keep them tight'],
    ['You collapsed the distance too early'],
    ['He collapsed the range with a step-in jab'],
    ['I collapsed on the couch after training, how should I recover?'],
    // breathing as technique
    ["You're not breathing out when you punch"],
    ['He is not breathing between combinations'],
    ['I am not breathing properly during rounds, any drills?'],
    ['She stopped breathing through her nose on the pads'],
    ['He is not breathing in through his nose on the jab'],
    ['That was a significant move on the pads'],
    ['The cantilever bag mount is loose'],
    ['He is not breathing on the jab, remind him to exhale'],
    ['You are not breathing when you throw combinations'],
    ['He is not responding to the feints, change the setup'],
    ["I can't wake early for roadwork, can we train at night?"],
    // Adversarial review B, 2026-10-06: coaching cues, gear, apps and alarms.
    ["Stop holding your breath, you're not breathing."],
    ["You're not breathing, relax your shoulders on the double jab"],
    ['my wrist collapsed on the hook'],
    ['his guard completely collapsed in round 2'],
    ['her knees collapsed inward on the squats'],
    ['how do I stop collapsed elbows'],
    ['my left side collapsed when I pivot'],
    ['the bag stand collapsed during class'],
    ['our sparring plan collapsed'],
    ['the app is unresponsive when I upload my video'],
    ['my tablet screen is unresponsive'],
    ['the timer is not responding'],
    ["my alarm won't wake me up for roadwork"],
    ["my son won't wake up in the morning for training"],
    ["I can't wake him up in the mornings for runs"],
    ['What is a collapsed lung?'],
    // waking as schedule
    ["I won't wake up early enough for roadwork"],
    ['He wont wake up for practice'],
    ["I can't wake him up in time for the bus"],
    // cant inside other words is not cant
    ['That was a significant improvement in your footwork'],
    ['The vacant ring is free for pad work'],
    // definitions
    ['What is the first aid for an athlete who collapsed?'],
    ['What does it mean if a fighter is unresponsive?'],
    // boxing language #1288 protects, on the request side too
    ['He pulled his punches in sparring, which is good for beginners.'],
    ['You broke your stance on the pivot; keep the rear heel up.'],
  ])('%s', (message) => {
    const result = check(message);
    expect(result.error).not.toBe(EMERGENCY);
    expect(result.valid).toBe(true);
  });
});
