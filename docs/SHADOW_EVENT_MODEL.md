# SHADOW Event Model

Purpose: define the canonical SHADOW event architecture before implementation work.

Scope: doctrine only. No code or schema implementation in this document.

## 1) Canonical Event Principle

SHADOW uses recursive observation doctrine:

- Every event may generate new observations.
- Every observation may generate new events.

This is a knowledge web, not a linear log.

## 2) Core Event Types and Definitions

1. Observation
Definition: a recorded fact, signal, condition, or state noticed by human or system.

2. Decision
Definition: a selected path among alternatives based on available evidence.

3. Action
Definition: an executed operation, intervention, or command.

4. Success
Definition: a confirmed positive outcome against intended criteria.

5. Failure
Definition: a confirmed negative, incomplete, or harmful outcome.

6. Correction
Definition: an adjustment created to mitigate or fix a detected issue.

7. Discovery
Definition: a newly identified pattern, insight, or relationship.

8. Question
Definition: an explicit request for understanding, guidance, or verification.

9. Knowledge Gap
Definition: an identified area where verified evidence is insufficient.

10. Research Request
Definition: a formal request to gather evidence for a knowledge gap.

11. Research Completion
Definition: closure event confirming research was performed and results recorded.

12. Recommendation
Definition: a proposed next action based on evidence and context.

13. Lesson Learned
Definition: durable insight extracted from success, failure, correction, or discovery.

14. Promotion Request
Definition: request to elevate data or decision output into operational truth.

15. Promotion Approval
Definition: authorized acceptance of a promotion request.

16. Promotion Rejection
Definition: authorized denial of a promotion request.

## 3) Event Relationships

SHADOW event relationships are many-to-many and recursive.

Required relationship semantics:

- parent event: the event that directly triggered this event
- root observation: the origin observation for a chain
- related events: linked sibling or cross-chain events
- derived event: event generated from another event

Canonical relationship examples:

- Observation -> Decision -> Action -> Success -> Lesson Learned
- Observation -> Decision -> Action -> Failure -> Correction -> Discovery -> Lesson Learned
- Question -> Knowledge Gap -> Research Request -> Research Completion -> Discovery
- Recommendation -> Action -> Success or Failure -> Lesson Learned
- Promotion Request -> Promotion Approval or Promotion Rejection

Recursive rule:

- Success may create new Observation.
- Failure may create new Observation.
- Correction may create new Observation.
- Discovery may create new Observation.
- Research Completion may create new Observation.

## 4) Event Lifecycle

Base lifecycle states:

1. Captured
2. Classified
3. Linked
4. Reviewed
5. Resolved or Ongoing
6. Retained

Lifecycle notes:

- Events can remain ongoing when they continue to generate related events.
- Resolution of one event does not close all descendant chains.
- A closed event can still be referenced by future observations.

## 5) Event Ownership

Ownership is required for accountability and routing.

Ownership dimensions:

- actor type: human, system, hybrid
- actor role: athlete, coach, parent, admin, board, volunteer, etc.
- organizational scope: organization, gym, program
- domain scope: athlete, goal, session, coach review, intake, governance, operations

Ownership rules:

- Every event must have an accountable owner context.
- Ownership can be reassigned only through explicit governance event.
- System-generated events must still have review ownership.

## 6) Event Source Confidence

Every event carries source confidence and verification status.

Source classes (examples):

- verified internal record
- coach-verified observation
- athlete self-report
- parent report
- uploaded document
- research source
- partner gym data
- video or sensor signal
- unknown source

Verification states:

- verified
- partially_verified
- unverified
- unknown

Truth rule:

- Knowledge without source is not organizational truth.

## 7) Event Promotion Rules

Promotion governs what becomes operational truth.

Promotion doctrine:

- No unverified event is auto-promoted to operational truth.
- Promotion requires explicit Promotion Request.
- Promotion requires authorized human review.
- Promotion outcome must be Promotion Approval or Promotion Rejection.
- Rejections should emit follow-up events (Correction, Research Request, or Knowledge Gap) when applicable.

Promotion readiness criteria (doctrine level):

- source confidence meets required threshold
- role and privacy boundaries are satisfied
- safety and governance checks are satisfied
- rationale and trace links are present

## 8) Event Retention and Memory Concepts

SHADOW preserves institutional memory through event retention and relationship integrity.

Retention principles:

- retain event lineage, not only latest state
- retain failures and corrections, not only successes
- retain rationale for decisions and promotions
- retain lessons learned as first-class knowledge outputs

Memory doctrine tie-in:

- the organization should never lose lessons it already paid for
- events must remain recoverable for training, governance, and improvement

## 9) Recursive Event Doctrine Summary

SHADOW event architecture is recursive and compounding:

- Every event may generate new observations.
- Every observation may generate new events.

This recursive model creates:

Observation loops -> Knowledge network -> Experience graph -> Expertise -> Institutional intelligence
