/**
 * WHICH PLATE A ROUTE STANDS IN FRONT OF.
 *
 * A room is reused heavily -- office covers 40 doors, floor 31 -- so a single
 * photographed wall repeats a great deal. When a room grows a second plate,
 * something has to decide which of its plates a given door shows. This is that
 * decision, and it is made from the route and from nothing else.
 *
 * DETERMINISTIC, NEVER RANDOM. `apps/web/public/plates/README.md` and
 * `docs/GROK-VISUAL-LANE.md` both state the rule and both state the reason: a
 * screen that changes appearance between loads breaks screenshot comparison,
 * breaks print reproducibility, and breaks a coach's sense of being on the page
 * they were on a moment ago. So there is no Math.random here, no Date, no
 * counter, no session id -- only a hash of the path. Same route, same wall,
 * every load, forever. plateVariant.test.ts fails if any of those appear.
 *
 * WHAT IT EMITS, AND WHY IT IS SHAPED THIS WAY.
 *
 * The obvious design is a per-room variant index: look up how many plates the
 * room has, reduce the hash to that count, emit the number. It was rejected
 * because the count would then live in TypeScript while the plate URLs live in
 * the PLATES section of `ppbf.css` -- and "plate URLs are declared once, in
 * ppbf.css" is a written rule that already cost one override sheet its life.
 * Adding `plate-01-office-02.jpg` would mean a new file, a declaration in the
 * sheet, AND a number bumped over here, with nothing but a test to notice when
 * the third step is forgotten.
 *
 * So the count is never sent. Instead the route's hash is reduced to EVERY
 * useful number of variants at once and the results are emitted as one token
 * list:
 *
 *     data-plate-variant="2of2 1of3 4of4 3of5 5of6"
 *
 * Read `2of2` as "the second of two". The stylesheet then picks the split it
 * needs -- a room with two plates matches on `~="2of2"`, a room with three on
 * `~="2of3"` and `~="3of3"` -- so the SHEET states how many plates a room has,
 * which is where the plate files are already named. Adding a plate stays a new
 * file plus one declaration, and nothing in this file changes, ever, for art.
 *
 * The whole cascade half of this -- why every such rule must be wrapped in
 * `:where()`, and why the orientation override has to come after them -- is
 * written out in the PLATES section of `design-system/ppbf.css` and enforced by
 * plateVariant.test.ts.
 */

/** The attribute PlateVariantGround writes and the PLATES block reads. */
export const PLATE_VARIANT_ATTRIBUTE = 'data-plate-variant';

/**
 * The splits emitted for every route.
 *
 * These are variant COUNTS a room could plausibly have, not variant indexes.
 * Two through six covers every set anyone has proposed; a seventh plate for one
 * room would add `7` here and cost one line. Nothing breaks while a number goes
 * unused -- a token no rule matches is inert -- so the list is allowed to run
 * ahead of the art rather than chase it.
 */
export const PLATE_SPLITS = [2, 3, 4, 5, 6] as const;

/**
 * FNV-1a (32-bit) with a murmur3 fmix32 finalizer.
 *
 * WHY THE FINALIZER, HONESTLY. FNV-1a's last operation is a multiply by an odd
 * prime, so bit 0 of its output is bit 0 of the accumulator before that
 * multiply: `hash % 2` is a parity of the path's bytes rather than a mixed
 * bit, and `of2` -- a room's first extra plate, the most likely variant to ever
 * exist -- is the split that would have shipped first.
 *
 * That is the theory. THE MEASUREMENT DOES NOT BACK IT UP: over the 108 real
 * doors, over 600 sequentially numbered paths, and over 64 paths differing in
 * one character, plain FNV-1a splits as evenly as the finalized version does
 * (49/59 against 55/53, 300/300 against 314/286). Removing fmix32 breaks no
 * test in plateVariant.test.ts and no distribution anybody would notice.
 *
 * It is kept anyway, and the claim is written down at its real strength: this
 * is insurance against a future route set, not a repair of a measured defect.
 * A structural dependence of the output's low bit on one input bit is worth
 * five instructions to remove even when today's inputs do not expose it. What
 * actually holds the mapping still is the pinned table in the test file -- not
 * this comment, and not the choice of mixer.
 *
 * Pure integer arithmetic via Math.imul: no dependency, and identical results
 * in Node and in every browser, which a float-based hash would not guarantee.
 */
function fnv1aWithAvalanche(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // murmur3 fmix32
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * The string the hash is actually taken of.
 *
 * `usePathname()` never carries a query or a fragment, but this function is
 * also the one a test or a future caller reaches for, and `/dashboard` and
 * `/dashboard?tab=2` must not be able to stand in different rooms -- a query
 * string is a state of one page, not a second page. The trailing slash is
 * stripped for the same reason.
 */
export function normalizePlateRoute(pathname: string): string {
  const withoutQuery = pathname.split('?')[0].split('#')[0];
  const withoutTrailingSlash = withoutQuery.length > 1
    ? withoutQuery.replace(/\/+$/, '')
    : withoutQuery;
  return withoutTrailingSlash === '' ? '/' : withoutTrailingSlash;
}

/** The route's 1-based slot in a split of `count` variants. */
export function plateVariantSlot(pathname: string, count: number): number {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`plateVariantSlot: a split must be a whole number of variants, got ${count}`);
  }
  return (fnv1aWithAvalanche(normalizePlateRoute(pathname)) % count) + 1;
}

/**
 * The value of `data-plate-variant` for a route, or `undefined` when there is
 * no route to derive one from.
 *
 * `undefined` rather than an empty string on purpose: React omits an attribute
 * whose value is undefined, so a page rendered without a router context -- a
 * unit test, a storybook, anything mounted outside Next -- carries no attribute
 * at all and every room falls back to its `-01` declaration. That is the second
 * rung of the plate ladder (offline -> gradient wall, no variant logic -> the
 * default plate, route-derived -> the variant), and it should be reached by
 * doing nothing rather than by handling an error.
 */
export function plateVariantTokens(pathname: string | null | undefined): string | undefined {
  if (typeof pathname !== 'string' || pathname.trim() === '') return undefined;
  const route = normalizePlateRoute(pathname);
  return PLATE_SPLITS.map((count) => `${plateVariantSlot(route, count)}of${count}`).join(' ');
}
