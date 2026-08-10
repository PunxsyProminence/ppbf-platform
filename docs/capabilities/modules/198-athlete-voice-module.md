# Module 198 — Athlete Voice Module

| Field | Value |
|-------|-------|
| Status | **DRAFT** |
| Active | false |
| Promotion required | true |
| Category | Strongest Additions Now (`strongestAdditionsNow`) |
| Source | `2.0.0-draft-merged` |
| Parent original-25 | _unmapped_ |

## Intent
Athlete Voice owns the bridge from the feedback box to the escalation
ladder: when an athlete's submission routes to safeguarding, an
`athlete_voice` escalation is filed so the platform's only notification
surface carries the alarm and not just the queue. It must never restate,
quote, or hint at the submission's words outside the safeguarding triage
queue; it must never surface a disclosure-driven escalation — or its
existence — to a coach; and it must never let any observable difference in
the submit response reveal how a submission was classified.

## Boundaries
- Does **not** auto-approve progression, medical, or board decisions.
- Does **not** expose athlete-level data to board / public aggregates without suppression rules.
- Does **not** invent metrics that are not stored by the platform.
- Does **not** own intake, classification, or triage — those belong to the
  feedback system (`feedback.ts`, `feedbackSafetyScan.ts`), which this
  module deliberately leaves untouched.

## Dependencies
- Upstream: feedback system (submission id + safeguarding route), safety-language scan (severity cues, in-process only)
- Downstream: escalation ladder (`pilot.safety_escalations`, `/admin/escalations`), board count summary (aggregate only)
- Related original-25 capability: escalation ladder (#194)

## Acceptance criteria
- [x] Data model / tables named — `pilot.safety_escalations` gains `source_type = 'athlete_voice'`; `source_id` carries the `pilot.feedback_submissions` id; no new table
- [x] API surface listed — none new; `POST /api/pilot/feedback/submit` files as a side effect, `GET /api/pilot/escalations` serves the rows (admin), coach scope excludes them
- [x] Roles that may read / write — filed by system on athlete submissions only; readable by organization_admin/admin; **never** coach; board sees counts only through the k-anonymity summary
- [x] Safety / refusal cases — non-disclosing reason/metadata (no body, no cues); oracle-safe filing (every outcome swallowed, reply byte-identical); accounts without an athlete row skip filing (queue-only, the pre-#198 behavior); 42P01 pre-migration window degrades to queue-only
- [x] Audit events — none beyond the escalation row itself: an audit event naming the submission would put the disclosure pointer on a coach-readable stream
- [x] UI surface — `/admin/escalations` renders the rows ("Athlete Voice"); the reason text directs the reader to the safeguarding triage queue

## Implementation notes
Built 2026-08-06 on PR #238 (branch-constrained session). Severity maps scan
cues in process — crisis/active-harm/grooming cues file `critical`, all
other safeguarding files `high` — and the cue ids are drift-tested against
the real scanner. The escalation cascades on athlete delete while the
submission survives account deletion: the escalation is the alarm, the
submission is the record.

## Audit log
| Date | Actor | Note |
|------|-------|------|
| 2026-08-03 | scaffold-script | Stub created from PPBF_CAPABILITIES.json |
| 2026-08-06 | session B (remote) | Implemented on PR #238: athlete_voice source_type, athleteVoice.ts, submit-route wiring, coach-scope exclusion. Status stays DRAFT pending promotion review. |
