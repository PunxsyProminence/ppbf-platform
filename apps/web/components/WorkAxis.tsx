/**
 * THE WORK AXIS — Observe. Decide. Execute. Repeat.
 *
 * The four words appear at the foot of every approved mockup that shows a
 * whole screen (AF-01 The Bell, AF-09 Athlete Workspace, AF-M02 Mobile Bell),
 * and CLAUDE.md names them as the platform tagline. This is the one place
 * they are written down in code.
 *
 * WHY THIS IS NOT THE MOTTO STRIP THAT WAS REMOVED. A six-word motto used to
 * sit at --t-xs directly above the fold on four different workspaces; it was
 * taken out of all four (see AthleteWorkspace, CoachWorkspace, ParentHub,
 * RevenueFundingCenter) because it was small, repeated, and standing in front
 * of the work. Both objections are addressed here rather than argued with:
 * this renders at the FOOT of a page, after the work, and it never goes below
 * --t-sm -- it scales up toward the Law 5 kiosk size as the viewport allows.
 *
 * NO STEP IS EVER MARKED CURRENT. One mockup tints DECIDE. Highlighting a step
 * would be a claim about where somebody is in their day, and nothing in this
 * component knows that -- Law 1, brass is the chassis and never the message.
 * All four carry the same weight, always.
 *
 * The arrows are decoration between list items, so they are hidden from the
 * accessibility tree; an ordered list carries the sequence on its own.
 *
 * THE WORDS TAKE THE HOST'S INK, they do not name a colour. This foot hangs
 * on two grounds that are opposites: dark leather under the athlete and coach
 * workspaces, and cream paper under The Bell. A bone tint that reads on the
 * first is all but invisible on the second -- it was, in the first render --
 * so the type inherits whatever colour the page around it is already using
 * and drops its opacity to sit back. Mid brass is the one literal colour
 * here, because it holds against both.
 */

const STEPS = ['Observe.', 'Decide.', 'Execute.', 'Repeat.'] as const;

export default function WorkAxis({ className = '' }: { readonly className?: string }) {
  return (
    <footer
      className={`border-t border-[color:var(--brass-800)] pt-[var(--s4)] ${className}`.trim()}
    >
      <ol
        /* Named for the same reason the session-scripts block list is: this
           foot hangs on pages that carry lists of their own, and an
           unlabelled ordered list is indistinguishable from them -- to a
           screen reader, and to any test that reaches for listitems. */
        aria-label="The work axis"
        className="flex flex-wrap items-center justify-center gap-x-[var(--s3)] gap-y-[var(--s2)]"
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: 'clamp(var(--t-sm), 1.6vw, var(--t-md))',
          letterSpacing: '.14em',
        }}
      >
        {STEPS.map((step, index) => (
          <li key={step} className="flex items-center gap-x-[var(--s3)]">
            {index > 0 && (
              <span aria-hidden="true" className="text-[color:var(--brass-600)]">
                &rarr;
              </span>
            )}
            <span className="uppercase opacity-80">{step}</span>
          </li>
        ))}
      </ol>
    </footer>
  );
}
