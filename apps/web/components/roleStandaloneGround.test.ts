import { isFamilyGround } from './roleGround';
import type { ClubRole } from './roleRoutes';

/* Staff surfaces stand on ink leather and the family-facing side on warm
   canvas. RoleStandaloneView derives that from allowedRoles rather
   than taking a prop, so the ground cannot drift from the audience — these
   cases pin the rule that makes the derivation safe. */
describe('isFamilyGround', () => {
  it('puts parent/guardian surfaces on the family ground', () => {
    expect(isFamilyGround(['parent'])).toBe(true);
  });

  it('keeps athlete surfaces on ink — the floor kiosk (Law 5, PAGE_MAP)', () => {
    // The golden-era pass moved athlete routes off the family branch: the
    // athlete dashboard is the floor kiosk, ink by PAGE_MAP, with room walls.
    expect(isFamilyGround(['athlete'])).toBe(false);
    expect(isFamilyGround(['athlete', 'parent'])).toBe(false);
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
