# Documentation

This folder contains project documentation, architecture decisions, and guides.

## SHADOW Canonical Docs

- SHADOW_AUTHORITY_MODEL.md
- SHADOW_EVENT_MODEL.md
- SHADOW_PHASE1_HARDENING_CHECKLIST.md
- SHADOW_V1_BUILD_PROMPT_FOR_VS.md

## Agent handoffs

Standing briefs for an agent picking up one lane of this platform. Collision
control for all of them is `AI_COLLABORATION.md`.

**Start with `capabilities/NETWORK_STATUS.md`** whichever lane you are on: what
the capability audit found, what has already merged, what is in flight, and what
is deliberately parked. It exists so nobody spends an afternoon on something
that merged this morning. For whose files not to touch it sends you to the open
PR list, which stays current; a copied table would not.

- `HANDOFF_VISUALS.md` — the visual layer: design-system conformance, refusal
  states, and the outstanding illustration assets.
- `HANDOFF_RESEARCH.md` — the questions code cannot close: clearance
  requirements, waiver contents, formula validity, and whether the youth safety
  thresholds already in production are defensible.
- `EXTERNAL_AUDIT_PROMPTS.md` — for a model with no repository access, where
  the point is that it has no stake in believing us.