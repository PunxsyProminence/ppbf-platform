# PPBF AI Release Control (retired 2026-09-21)

This was the release-control lane's coordination record for 2026-08-19 to
2026-08-28. Its full text is kept verbatim in
`docs/archive/2026-09-21_AI_RELEASE_CONTROL_before_condense.md`. Nothing in it
describes current state: production has deployed several times since
(successful `deploy-production` runs on 2026-09-17, 09-18 and 09-19, checked
2026-09-21), and the separate release-control lane is not staffed
(OD-2026-08-29-006).

Where its live content went:

- **The release procedure, and who may run it** -> `docs/AI_DELIVERY_PIPELINE.md`.
  That now includes four rules that existed only here: every protected run needs
  its own approval; the smoke probes do not tie the image to the revision, the
  revision-digest assertion does; production seeding reads production's own seed
  account; a schema check is run, not grepped.
- **Deployed state** -> live evidence (`AGENT_KERNEL.md`, "Your lane's state is
  not the system's state").
- **Two open owner questions** (training holds at check-in and drill
  assignment; SHADOW near-miss text in athlete/parent chats) ->
  `docs/current/ACTIVE_WORK.md`, BLOCKED.

Deferred items it listed on 2026-08-28, carried here without re-checking:

- coach roster row click (held for #606, which has since closed);
- #602's `path.relative` Windows separators (the guard fails loud, not open;
  CI runs on ubuntu-latest);
- rendering of UNKNOWN-method historical RPE (measure production data first),
  the track-assignments silent autosave, and the athlete "Messages 0" tile.
