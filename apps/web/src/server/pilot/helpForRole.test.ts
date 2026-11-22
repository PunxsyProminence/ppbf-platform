import { plainHelpFor } from './helpForRole';

/* Lane AS-8 (Overwatch Q12 A on #2020; OD-2026-11-20-001): the athlete's help
   names the three things the workspace says, in their ruled words, instead of
   "check-ins". */
test("the athlete's workspace help names I'm here, How I feel today and Start training", () => {
  const workspace = plainHelpFor('athlete')?.topics.find((topic) => topic.title === 'Your workspace');
  expect(workspace?.text).toBe("Your dashboard is your athlete workspace: I'm here, How I feel today, Start training, session notes and goals.");
  expect(workspace?.text).not.toMatch(/check-ins/);
});
