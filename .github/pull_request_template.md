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

## Evidence applicability

<!-- For every MATERIAL claim -- authorization, safety, privacy, safeguarding,
     data integrity, a race, a deployment -- copy the block below and fill it
     in. A green result is evidence only for the property and execution path it
     actually exercised. Contract, ladder and worked examples:
     docs/current/EVIDENCE_APPLICABILITY.md

### EVIDENCE APPLICABILITY - <short label>

- CLAIM:
- PROPERTY:
- INSTRUMENT:
- SUBJECT:            full 40-char SHA / branch / environment / run id
- EXECUTION PATH:     the production path the instrument actually ran
- POSITIVE CONTROL:
- NEGATIVE CONTROL:   the mutation watched to fail, or "none - <why not>"
- EVIDENCE LEVEL:     NONE CODE_READ TYPECHECK UNIT INTEGRATION REAL_DATABASE
                      BROWSER LOCAL_RUNTIME STAGING PRODUCTION HUMAN_OBSERVATION
- BLIND SPOTS:        what this does NOT establish
- VERDICT:            APPLICABLE | PARTIAL | UNVERIFIED | RETRACTED

     If you cannot establish a claim with an applicable instrument, write
     UNVERIFIED. Not "likely", "should", or "CI will probably cover it". -->

## Scope declaration

- Files touched match the ticket's allowed list: yes / no (explain)
- Contested files (guardrails §3) touched: none / list + why
- Safety invariants (guardrails §4) affected: none / list + how extended

## Out of scope / not done

<!-- What the ticket asked for that this PR does not deliver, and why. -->
