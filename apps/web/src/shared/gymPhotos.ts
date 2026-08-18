/**
 * THE GYM'S OWN PHOTOGRAPHS — the room, the ring, the bags, the door, the
 * people who coach.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT A TABLE, AND WHY IT IS NOT THE PORTRAIT PIPELINE
 * ---------------------------------------------------------------------------
 *
 * The platform already has a photo pipeline: pilot.account_profiles carries a
 * member's portrait, profilePhotoPolicy.ts validates the upload, and
 * profileVisibility.ts decides who may see the face. That pipeline is built
 * around ONE question -- how does this viewer stand to this subject -- and it
 * answers 'plate' for a minor whenever the viewer is anything other than the
 * child, their own coach, or their guardian.
 *
 * A dashboard photo module is a wider audience than a profile page. Everyone
 * signed in to the gym sees the same module, so the honest relationship for it
 * is at best 'organization_staff', and decidePortrait() refuses a minor's face
 * to organization_staff by design. There is therefore NO reading of
 * profileVisibility.ts under which a member's uploaded portrait may be rotated
 * onto a shared surface, and this module does not try to find one.
 *
 * So the gym's photography is a different thing with a different source:
 * pictures OF THE BUILDING, taken by the gym, placed by a person. No athlete
 * media, no member uploads, no faces of children -- ever, by construction:
 * there is no code path from this file to pilot.account_profiles, and
 * gymPhotos.test.ts asserts that the module never mentions it.
 *
 * ---------------------------------------------------------------------------
 * HOW A PHOTOGRAPH ACTUALLY GETS HERE
 * ---------------------------------------------------------------------------
 *
 * Two paths, one release rule -- a person who can see the picture decides:
 *
 *   1. THE MANIFEST (this file). Drop the file into apps/web/public/gym/ and
 *      set that slot's `file` below. No migration, no storage account, no
 *      review queue -- the act of committing a file IS the release decision,
 *      made by a person who can see what is in the picture, which is the only
 *      review a photograph can honestly get (the same argument
 *      profileVisibility.ts makes about portraits).
 *   2. THE ADMIN UPLOAD (/admin/gym-photos). An admin uploads a photograph
 *      for a slot from the dashboard; it is stored org-scoped in private blob
 *      storage (EXIF/GPS stripped, same policy family as portraits) and takes
 *      the frame over whatever this manifest names. Clicking upload in front
 *      of the actual picture is the same release decision by the same kind of
 *      person -- it just doesn't require a git client.
 *
 * WHAT THE SLOTS HOLD TODAY: commissioned placeholder ILLUSTRATIONS, by owner
 * decision (2026-08-06) -- drawn in the design system's own palette, building
 * only, visibly labeled "PLACEHOLDER ILLUSTRATION" inside the image, and named
 * as illustrations in the alt text. They exist so the wall reads as a wall
 * while the real photographs are being taken, and each one is expected to be
 * REPLACED by a real photograph via either path above. The standing rules are
 * unchanged: no stock photography, no fake-photorealistic imagery, and no
 * people -- not even drawn ones.
 */

/** Where a slot is allowed to appear. A slot names its surfaces; a surface asks for its slots. */
export type GymPhotoSurface = 'public' | 'dashboard';

export interface GymPhotoSlot {
  /** Stable key. Used for React keys and by tests; never rendered. */
  readonly key: string;
  /** What the frame says while it is empty. A label, not an apology. */
  readonly title: string;
  /** One line under the title, in the gym's voice, empty or full. */
  readonly caption: string;
  /**
   * The file name under apps/web/public/gym/, or null while nobody has taken
   * the picture yet. Never a URL: a slot cannot point at another origin, and it
   * cannot point at the portrait route, which is session-scoped by design.
   */
  readonly file: string | null;
  /**
   * Alt text for when the slot is filled. Written now rather than later so a
   * photograph cannot arrive without one -- an empty alt on a content image is
   * how a screen reader user gets told nothing at all.
   */
  readonly alt: string;
  readonly surfaces: readonly GymPhotoSurface[];
}

/**
 * The building, not the people in it.
 *
 * Each caption is written to be true while the frame is EMPTY as well as once
 * it is full, because the empty state is the one nearly everybody will see and
 * a caption that only makes sense beside a photograph reads as a broken page.
 */
export const GYM_PHOTO_SLOTS: readonly GymPhotoSlot[] = [
  {
    key: 'entrance',
    title: 'The front door',
    caption: '220 N Jefferson St. What you are looking for when you pull up the first time.',
    file: 'entrance.svg',
    alt: 'Illustration of the entrance to the gym at 220 N Jefferson St, Punxsutawney — a placeholder until the real photograph is taken.',
    surfaces: ['public'],
  },
  {
    key: 'floor',
    title: 'The floor',
    caption: 'The room itself, on an ordinary night. Not staged, not empty on purpose.',
    file: 'floor.svg',
    alt: 'Illustration of the main training floor of the gym — a placeholder until the real photograph is taken.',
    surfaces: ['public', 'dashboard'],
  },
  {
    key: 'ring',
    title: 'The ring',
    caption: 'Most people who train here never step in it. It is still the middle of the room.',
    file: 'ring.svg',
    alt: 'Illustration of the boxing ring — a placeholder until the real photograph is taken.',
    surfaces: ['public', 'dashboard'],
  },
  {
    key: 'bags',
    title: 'The bags',
    caption: 'Heavy bags, speed bag, double end. Where most of the work actually happens.',
    file: 'bags.svg',
    alt: 'Illustration of the heavy bags along the wall — a placeholder until the real photograph is taken.',
    surfaces: ['public', 'dashboard'],
  },
  {
    key: 'wraps-bench',
    title: 'Where you wrap up',
    caption: 'Bench, hooks, and whoever is already sitting there when you walk in.',
    file: 'wraps-bench.svg',
    alt: 'Illustration of the bench where athletes wrap their hands — a placeholder until the real photograph is taken.',
    surfaces: ['public', 'dashboard'],
  },
  {
    key: 'wall',
    title: 'The wall',
    caption: 'Whatever is taped, pinned, or written up there this month.',
    file: 'wall.svg',
    alt: 'Illustration of the gym wall with notices pinned to it — a placeholder until the real photograph is taken.',
    surfaces: ['dashboard'],
  },
];

export interface GymStaffCard {
  readonly key: string;
  readonly name: string;
  readonly role: string;
  /**
   * Null until somebody writes one. NOTHING IN THIS FIELD MAY BE INVENTED: the
   * only claims allowed here are ones the public page already makes and a
   * parent could check by walking in and asking. A fabricated coaching history
   * on a youth sports page is not a copy problem, it is a safeguarding one.
   */
  readonly bio: string | null;
  /** Same rule as a gym slot: a file name under public/gym/, or null. */
  readonly photo: string | null;
  readonly alt: string;
}

/**
 * The people, by name.
 *
 * ONE entry, because the platform knows of exactly one coach by name --
 * /public has said "Jason Neale is head coach" since the Phase 1 rewrite. Every
 * other coach is a person nobody has typed in yet, and inventing a roster of
 * plausible-sounding names to make a section look populated would be a lie on
 * the page a parent reads before deciding whether to trust this gym with their
 * kid.
 *
 * A staff photograph is an ADULT doing a public-facing job, which is the one
 * case profileVisibility.ts already treats as showable -- but that decision is
 * about members inside the app, and this is the open internet, so the release
 * here is the same physical one as every other slot: a person put the file in
 * the folder.
 */
export const GYM_STAFF_CARDS: readonly GymStaffCard[] = [
  {
    key: 'head-coach',
    name: 'Jason Neale',
    role: 'Head Coach',
    bio: 'Runs the floor most nights. Ask to meet him before you commit to anything — that is the right way round, and he would rather you did.',
    photo: null,
    alt: 'Jason Neale, head coach.',
  },
];

/** Where a filled slot's bytes live. Static, same-origin, no session involved. */
export const GYM_PHOTO_BASE_PATH = '/gym';

/**
 * The src for a filled slot, or null.
 *
 * Returns null for anything that is not a plain file name, so a slot cannot be
 * pointed at another origin, at a parent directory, or at an API route by an
 * edit that looks harmless in review.
 */
export function gymPhotoSrc(file: string | null): string | null {
  if (typeof file !== 'string') return null;
  const trimmed = file.trim();
  if (!trimmed) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes(':')) return null;
  if (trimmed.startsWith('.')) return null;
  return `${GYM_PHOTO_BASE_PATH}/${trimmed}`;
}

/** The slots one surface asks for, in catalogue order. */
export function gymPhotoSlotsFor(surface: GymPhotoSurface): readonly GymPhotoSlot[] {
  return GYM_PHOTO_SLOTS.filter((slot) => slot.surfaces.includes(surface));
}

/** The slots that actually have a photograph behind them right now. */
export function filledGymPhotoSlots(
  slots: readonly GymPhotoSlot[] = GYM_PHOTO_SLOTS,
): readonly GymPhotoSlot[] {
  return slots.filter((slot) => gymPhotoSrc(slot.file) !== null);
}
