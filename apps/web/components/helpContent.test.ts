// Lane N4-02: the Help Center must not call a built page a placeholder, and
// must not list a planned one as live. Each pin below names the page that
// proves the claim, so a page that changes can be checked against its line.

import { guideSections, plannedCapabilityGuides } from './helpContent';

function guide(id: string) {
  const found = guideSections.find((section) => section.id === id);
  if (!found) throw new Error(`no guide ${id}`);
  return found;
}

function planned(id: string) {
  const found = plannedCapabilityGuides.find((section) => section.id === id);
  if (!found) throw new Error(`no planned guide ${id}`);
  return found;
}

test('video, compliance and progression pages that read real records are not stamped FRONT-END PLACEHOLDER', () => {
  // /coach/video-analysis, /athlete/video-analysis, /admin/compliance-center,
  // /board/compliance-monitoring and the three progression pages all fetch
  // real APIs; only the automation on top of them is planned.
  for (const id of ['planned-ai-video', 'planned-compliance', 'planned-progression']) {
    expect(planned(id).currentStatus).not.toMatch(/FRONT-END PLACEHOLDER/);
    expect(planned(id).currentStatus).toMatch(/^PLANNED \(/);
  }
});

test('the publication workflow is roadmap with no screen: its mock page was deleted (lane N4-04)', () => {
  expect(planned('planned-publication').currentStatus).toBe('PLANNED | NOT BUILT');
  expect(planned('planned-publication').whereItAppears).toBe('No screen yet.');
  for (const section of [...guideSections, ...plannedCapabilityGuides]) {
    expect(JSON.stringify(section)).not.toMatch(/\/source-control/);
  }
});

test('the Revenue & Funding center tabs are roadmap, not listed as active', () => {
  // components/RevenueFundingCenter.tsx makes no request; its rows are fixed.
  const admin = guide('admin-guide');
  expect(admin.activeNow).not.toMatch(/Revenue & Funding/);
  expect(admin.placeholderOrPlanned).toMatch(/Revenue & Funding center tabs are planned \(roadmap\)/);
});

test('public interest submissions are described as saved, not front-end only', () => {
  // src/server/pilot/publicInterest.ts inserts each submission; staff review
  // them at /admin/public-interest.
  expect(guide('public-portal-guide').placeholderOrPlanned).not.toMatch(/front-end only/);
  expect(guide('public-portal-guide').placeholderOrPlanned).toMatch(/saved/);
});

test('the parent guide names the live task feed and still lists every Parent Hub section stamped PLANNED', () => {
  // ParentHub.tsx stamps family goals and resources PLANNED | NOT YET
  // IMPLEMENTED (A-Q15: roadmap; F-019 "C: Keep all": the note stays until
  // the thing is built -- PH-06 for family goals).
  const parent = guide('parent-guide').placeholderOrPlanned;
  expect(parent).toMatch(/Coach tasks with a due date show on the Messages tab/);
  // The weekly list on the Parent Floor is built (WO-PH-02); it is not planned.
  expect(parent).toMatch(/on the Parent Floor/);
  expect(parent).not.toMatch(/weekly support checklist/);
  // Home assignments are built (WO-PH-03).
  expect(parent).toMatch(/Home assignments show on the Assignments tab/);
  // Progress milestones are built (WO-PH-09).
  expect(parent).toMatch(/The Progress tab shows earned milestones/);
  expect(parent).not.toMatch(/progress milestones/);
  // Parent observations are built (WO-PH-04).
  expect(parent).toMatch(/Parent observations are written down and read back on the Observations tab/);
  expect(parent).not.toMatch(/feed yet: [^.]*parent observations/);
  for (const section of ['family goals', 'resources']) {
    expect(parent).toContain(section);
  }
  // FC-05: the coaches read observations (F-073).
  expect(parent).toMatch(/Observations tab, and the coaches can read them/);
  // Replies to coach messages are built (#1542, FC-03).
  expect(parent).toMatch(/has its own reply box/);
  expect(parent).not.toMatch(/feed yet: [^.]*reply to coach/);
});

test('the athlete guide does not call live pages placeholders', () => {
  expect(guide('athlete-guide').placeholderOrPlanned).not.toMatch(/are placeholders/);
});
