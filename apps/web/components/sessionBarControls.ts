/**
 * The session bar's control geometry, in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * These classes lived as constants inside GlobalRoleHeader, and the two
 * controls that render beside them -- FeedbackBox and SoundToggle -- could not
 * reach them. Both reasonably reached for `.btn btn--ghost` from ppbf.css
 * instead, and both then tried to correct its geometry with Tailwind:
 *
 *     className="btn btn--ghost min-h-[var(--tap)] text-[length:var(--t-xs)]"
 *
 * Neither override landed. ppbf.css is unlayered and Tailwind's utilities sit
 * in a cascade layer, so an unlayered `.btn { font-size: 15px; min-height:
 * 44px }` beats both -- the same asymmetry GlobalRoleHeader already documents
 * for `.room--*` beating `bg-[...]`. Measured on /coach/review-queue:
 *
 *     Sound off    15px    Alfa Slab One 700    44px tall
 *     Tell Us      15px    Alfa Slab One 700    44px tall
 *     Operations   11.8px  geistMono 400        55px tall
 *     Bell         11.8px  geistMono 400        55px tall
 *
 * So the two least important controls on the bar were the only ones speaking
 * in the display voice -- Law 4's "it gives orders" -- at 27% larger than
 * their siblings, on every authenticated route. Nothing chose that; it is
 * what the cascade did to two silently-lost overrides.
 *
 * The height failure was the worse half. FeedbackBox carries a long comment
 * explaining that its target was deliberately raised to --tap because it is
 * the control a child taps to say someone hurt them. That intent was real and
 * is kept here -- but it never took effect: the button shipped at 44px, the
 * smallest target on the bar, which is precisely what that comment was written
 * to prevent.
 *
 * Sharing the classes is what stops this recurring. Nothing here composes
 * `.btn`, so there is no unlayered rule left to outrank the geometry.
 */

/** Shared geometry: --tap tall, on the type ladder, focus ring visible on leather. */
const CONTROL =
  'inline-flex min-h-[var(--tap)] items-center rounded-[var(--r-sm)] border px-[var(--s4)] '
  + 'font-mono text-[length:var(--t-xs)] uppercase tracking-[0.14em] transition '
  + 'focus-visible:outline-none focus-visible:shadow-[var(--focus)]';

/** Navigation and preferences. The bar is chassis; chassis does not shout. */
export const CONTROL_QUIET =
  `${CONTROL} border-[color:rgb(var(--brass-400-rgb)_/_.32)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-200)] `
  + 'hover:border-[color:var(--brass-400)] hover:text-[color:var(--bone-100)]';

/**
 * One step up, for reporting harm.
 *
 * The distinction is carried by a brighter rim and a lit label, not by a
 * larger or heavier face. Findability here is a matter of the control being
 * the same shape in the same place on every route, at a full --tap target --
 * shouting in the display voice made the whole bar loud, which is how a bar
 * stops having anything that stands out at all.
 */
export const CONTROL_SAFEGUARD =
  `${CONTROL} border-[color:var(--brass-500)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-100)] `
  + 'hover:border-[color:var(--brass-300)] hover:bg-[rgba(0,0,0,.14)]';

/** Leaving. Rust rim, so it does not read as one more place to go. */
export const CONTROL_EXIT =
  `${CONTROL} border-[color:var(--rust-500)] bg-[rgba(0,0,0,.26)] text-[color:var(--bone-300)] `
  + 'hover:border-[color:var(--locked)] hover:text-[color:var(--bone-100)]';
