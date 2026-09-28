# PPBF AI Release Control (retired 2026-09-21)

This was the release-control lane's coordination record for 2026-08-19 to
2026-08-28. Its full text is kept verbatim in
`docs/archive/2026-09-21_AI_RELEASE_CONTROL_before_condense.md`. Nothing in it
describes current state: production has deployed several times since
(successful `deploy-production` runs on 2026-09-17, 09-18 and 09-19, checked
2026-09-21), and there is no separate release-control role
(OD-2026-08-29-006; OD-2026-09-28-001).

Where its live content went:

- **The release procedure, and who may run it** -> `docs/AI_DELIVERY_PIPELINE.md`.
  That now includes four rules that existed only here: every protected run needs
  its own approval; the smoke probes do not tie the image to the revision, the
  revision-digest assertion does; production seeding reads production's own seed
  account; a schema check is run, not grepped.
- **Deployed state** -> live evidence (`AGENT_KERNEL.md`, on deployed state).
- **Two open owner questions** (training holds at check-in and drill
  assignment; SHADOW near-miss text in athlete/parent chats) ->
  `docs/current/ACTIVE_WORK.md`, BLOCKED. The near-miss question has since been
  ruled on (OD-2026-09-26-002).
- **Deferred items it listed on 2026-08-28** -> `docs/current/ACTIVE_WORK.md`,
  PARKED row `BACKLOG-release-deferred-2026-08`; their original wording is in
  the archive copy named above.
