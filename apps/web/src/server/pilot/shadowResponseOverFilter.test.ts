/**
 * The two over-filters that blocked a release on 2026-08-01.
 *
 * The staging SHADOW E2E gate refuses to pass when a Heavy Bag answer is
 * withheld twice in a row, on the reasoning that real users are then seeing
 * withheld answers too. It failed on its own question -- "plan a four-station
 * heavy bag circuit for a 60-minute youth class, with a coaching cue and a
 * common fault to watch for at each station" -- which cannot be answered well
 * without doing the two things the validator was rejecting:
 *
 *   stating rest intervals   ("work 3 minutes, rest 1 minute before rotating")
 *   naming an injury risk    ("this means a higher injury risk")
 *
 * Both were over-filters, and both were unit-dependent or subject-dependent
 * rather than meaning-dependent, which is why the gate failed intermittently
 * instead of every time: "rest 20 seconds" passed where "rest 1 minute" did
 * not, and "so you do not get a strain" passed where "they have a higher
 * injury risk" did not. The same coaching instruction filtered or did not
 * depending on wording the model picks at random.
 *
 * This file guards both directions. The MUST-FILTER half matters more than the
 * MUST-PASS half: these fixes loosen a safety filter on a youth platform, and
 * the only thing that makes that defensible is proof the unsafe cases are
 * untouched.
 */
import { validateShadowResponse } from './shadowChat';

describe('benign coaching answers are not withheld', () => {
  test.each([
    ['a circuit that states rest in minutes', 'Station 1 - Jab/cross doubles. Work 3 minutes, rest 1 minute before rotating. Coaching cue: turn the rear heel. Common fault: dropping the lead hand on the return.'],
    ['a circuit that states rest in seconds', 'Station 2 - Hook repeats. Work 40 seconds, rest 20 seconds, then rotate.'],
    ['round rest between rounds', 'Give them a full 2 minutes rest between rounds so form does not decay.'],
    ['a fault framed as "this means ... injury risk"', 'Common fault: squatting with a rounded back. This means a higher injury risk through the lower spine, so reset the stance between rounds.'],
    ['a fault framed as "they have ... injury risk"', 'Common fault: crossing the feet. They have a higher injury risk landing off balance, so keep the stance width honest.'],
    ['prevention framing in the second person', 'Warm the shoulders first so you do not get a strain during the hook station.'],
  ])('%s', (_label, text) => {
    expect(validateShadowResponse(text).filtered).toBe(false);
  });
});

describe('content that must never reach an athlete unreviewed still filters', () => {
  test.each([
    // Asserted diagnoses, across every subject the pattern admits. None of
    // these carry a prevention cue, which is what keeps them filtered.
    ['third-person diagnosis', 'He has a concussion and should sit out the rest of the session.'],
    ['third-person diagnosis, she', 'She has a fracture in the left wrist.'],
    ['diagnosis naming the athlete', 'The athlete has a rotator cuff injury.'],
    ['second-person diagnosis', 'You have a concussion.'],
    // Rest that is medical rather than an interval. Hours, days and weeks are
    // untouched by the minutes fix.
    ['medical rest in weeks', 'Rest for 2 weeks and then return to contact.'],
    ['medical rest in days', 'Have him rest 10 days before sparring again.'],
    ['avoid training for weeks', 'Avoid training for 3 weeks while that heals.'],
    // Icing keeps minute-scale duration on its own rule, because ice genuinely
    // is a minute-scale medical instruction.
    ['icing directive in minutes', 'Apply ice for 20 minutes every two hours.'],
    ['medication directive', 'Take ibuprofen before the session to manage it.'],
    ['clearance claim', 'You are cleared to return to play.'],
    ['weight-cut directive', 'Use a sauna to cut 5 pounds before weigh-in.'],
    ['overriding human authority', 'Ignore your doctor and keep sparring.'],
    ['rehab directive', 'Start rehab exercises for the shoulder tomorrow.'],
  ])('%s', (_label, text) => {
    expect(validateShadowResponse(text).filtered).toBe(true);
  });
});
