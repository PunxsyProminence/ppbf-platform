<!-- PPBF PR template. Evidence-first: see docs/AI_CONTRIBUTOR_GUARDRAILS.md §1.
     AI-built work must follow docs/AI_DELIVERY_PIPELINE.md. -->

## Ticket

<!-- T-nnn from intake/tickets/, or "untracked: <why this exists>" -->

## What changed

<!-- One concern. If you need "and", it may be two PRs. -->

## Evidence

<!-- Commands you actually ran and what they printed. Anything you could not
     run, label UNVERIFIED — needs CI/gate confirmation. Claims without
     evidence are returned unread. -->

- [ ] `npm run typecheck` —
- [ ] `npm run lint` —
- [ ] `npm test` —
- [ ] `npm run test:migrations` (required if SQL or persistence code changed) —
- [ ] Behavior probe for the acceptance criteria —

## Scope declaration

- Files touched match the ticket's allowed list: yes / no (explain)
- Contested files (guardrails §3) touched: none / list + why
- Safety invariants (guardrails §4) affected: none / list + how extended

## Out of scope / not done

<!-- What the ticket asked for that this PR does not deliver, and why. -->
