import { isFamilyGround } from './RoleStandaloneView';
import type { ClubRole } from './roleRoutes';

/* Law 6 assigns ink leather to staff surfaces and warm canvas to the
   family-facing side. RoleStandaloneView derives that from allowedRoles rather
   than taking a prop, so the ground cannot drift from the audience — these
   cases pin the rule that makes the derivation safe. */
describe('isFamilyGround', () => {
  it('puts athlete and guardian surfaces on the family ground', () => {
    expect(isFamilyGround(['athlete'])).toBe(true);
    expect(isFamilyGround(['parent'])).toBe(true);
    expect(isFamilyGround(['athlete', 'parent'])).toBe(true);
  });

  it('keeps every staff role on ink', () => {
    for (const role of ['coach', 'admin', 'platform_owner', 'board', 'staff', 'volunteer'] as ClubRole[]) {
      expect(isFamilyGround([role])).toBe(false);
    }
  });

  it('treats a mixed audience as staff', () => {
    // /coach/video-analysis admits coach and admin; /coach/decision-loop the
    // same. A page one staff member can open is a staff surface, so a single
    // staff role in the list is enough to decide the ground.
    expect(isFamilyGround(['parent', 'coach'])).toBe(false);
    expect(isFamilyGround(['athlete', 'admin'])).toBe(false);
  });

  it('defaults an empty list to ink rather than to the family ground', () => {
    // A misconfigured page must not land on the ground reserved for children's
    // records by accident. Ink is the safe default.
    expect(isFamilyGround([])).toBe(false);
  });
});
