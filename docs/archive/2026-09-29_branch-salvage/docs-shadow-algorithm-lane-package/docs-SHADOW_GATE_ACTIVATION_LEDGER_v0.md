# SHADOW GATE & ACTIVATION LEDGER — v0 (DRAFT · MINIMUMS UNSIGNED)

**Purpose:** the operating contract for a complete, dormant build. Every component through Phase D exists in code; each sits behind a gate with a sensor. When a sensor's minimum is met, the component **ARMS automatically** — shadow runs, staging fills, charts compute, a notification fires, and a one-line ratification lands in Jason's queue. **ACTIVE always takes a signature.** That is not a limitation added here; it is the system's own standing law (injected/versioned/human-ratified policy; no hidden default thresholds; no AI output with automatic authority).

**Two rules that govern every gate:**
1. **Sensors count observations and measurements only.** Research content NEVER trips a gate (#345). Research feeds the Library at its tiers; the engines eat confirmed observations.
2. **Armed behaviors are all propose / abstain / notify class.** Nothing armed can write athlete truth, surface an advisory, or change a recommendation. Only signed activation does that — and some components (every propose-only producer) never have a higher mode than armed.

**Gate states (the Gate Board rows):** DORMANT → ARMED → AWAITING SIGNATURE → ACTIVE. Product lane renders this as a dashboard; each AWAITING row carries its one-click ratification.

| Gate | Component | Sensor (what is counted) | ARMED behavior (automatic, safe) | ACTIVATION (signature) | Proposed minimum — HEURISTIC · UNSIGNED | Never automatic |
|---|---|---|---|---|---|---|
| G-A1 | Recurrence + promotion (merged #337/#358 engines) | none — observe-only IS the armed state | evidence vectors, strata, posteriors accumulate; every promotion evaluation abstains with reason codes | policy sheet P1–P4 signed → promotion decisions possible | n/a (posture choice, not a count) | promotion without signed policy |
| G-A2 | Baselines & drift charts | per athlete-metric observation count | charts render, flagged "insufficient history" below minimum; no recency pressure emitted | P7/P8 signed → chart flags feed recency/fade | ≥ 8 obs per athlete-metric before a chart claims anything | chart output treated as fact below minimum |
| G-B1 | LLM note extraction | deployment gate only (Phase B merged + Azure resource) | drafts flow at AI tier; coach confirm required — this is its PERMANENT ceiling | none higher exists — propose-only forever | n/a | drafts entering engines unconfirmed |
| G-B2 | Lesson retrieval | ≥ 1 validated lesson embedded (self-gating) | suggestions render with provenance; human apply required — permanent ceiling | none higher exists | n/a | auto-apply |
| G-B3 | Recovery-package ingestion | package present in staging | staged with tag→tier mapping; owner release required — permanent ceiling | per-item owner release (standing) | n/a | staged items reaching recommendation surfaces |
| G-C1 | Shadow classifier (GBT+SHAP) | labeled rows per task from confirmed observations | notify → training run → shadow-mode comparator logs disagreements; ZERO user-visible output | Jason reviews disagreement log + signs → advisory output allowed | ≥ 500 labeled rows per task before first training run | any live/advisory output without the signed review; any output path bypassing shadow mode |
| G-C2 | Conformal wrapper | rides G-C1 (needs calibration split from same labels) | wraps shadow model; ambiguous prediction set = abstention by construction | activates with G-C1's signature | calibration split ≥ 100 held-out rows | serving point predictions without the set/abstention |
| G-C3 | Active-learning queue | shadow model exists + unlabeled pool > 0 | renders a labeling-priority list for coaches — propose-only by nature; armed = its ceiling | none higher exists | n/a | queue items auto-labeling anything |
| G-C4 | Paired sparring ratings (optional) | sparring outcome records exist | computes nothing until opted in | owner opt-in + scope signature | n/a | any rating feeding clearance or a blended score |
| G-D1 | Pose pipeline (browser) | operational, not statistical: consent workflow confirmed + registry video-mapping table ratified | on-device extraction produces MACHINE-source drafts at AI tier; confirm required — permanent ceiling | mapping-table ratification is the activation | n/a | frames leaving the device by default; machine drafts entering engines unconfirmed |
| G-355 | SCD intervention reports | per-intervention: phase data present (baseline rows, start event, post rows) | reports render with abstention states where data thin | SCD reporting thresholds signed on policy sheet | none proposed — post-pilot | "insufficient data" rendered as a verdict about the athlete |
| G-357 | Observer reliability stats | co-rated unit count | below minimum: "insufficient reliability data" abstention — a protocol statement, never an athlete statement | reliability minimum signed on policy sheet | none proposed — post-pilot | sparse co-rating converting into athlete evidence |

**Signature mechanics:** every "Proposed minimum" above is a policy-sheet entry (extend the existing sheet with a G-series block) — named, versioned, revisable, signed by Jason. Until signed, the sensor still counts and still notifies ("gate candidate met — minimum unsigned"), but nothing arms past its safe behavior. Signing a minimum is signing an operating value, not certifying science.

**Permanently outside this ledger:** D10 and the entire medically-sensitive gating path. No gate, no sensor, no armed mode, no activation exists for it here — it is a separate owner/safety workstream by standing order. Likewise: contact/sparring clearance, medical conclusions, and lesson→methodology promotion remain human-only regardless of any gate state.

**Jason's operating loop once this ships:** drop observations and measurements in → watch the Gate Board → sign what's AWAITING when the disagreement logs and abstention reports satisfy you → the piece goes ACTIVE. Research drops feed the Library and never touch the board.
