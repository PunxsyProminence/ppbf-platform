PPBF SHADOW — PHASE C WORK ORDER (DRAFT · HOLD)

STATUS: DRAFT. DO NOT EXECUTE.
Inert until ALL are true: (1) #358, #355, #357 merged after algorithm-lane
cross-review; (2) capture digitization (vocabulary v0 machine contract +
transcription import) is live; (3) Phase B merged; (4) the Gate &
Activation Ledger is adopted and its G-C minimums are on the policy sheet
(signed or explicitly deferred); (5) Jason explicitly hands this order to
the implementation lane. Possession is not authorization.

Repository: PunxsyProminence/ppbf-platform
Work from current origin/main in a fresh dedicated branch.

MISSION

Build the COMPLETE Phase C machinery, dataless and dormant, per Stack
v1.1 §2.8 + §10 and the Gate Ledger (G-C1..G-C4). The deliverable is the
machine that trains, shadows, wraps, and queues — NOT a trained model.
The first training run happens later, when G-C1's sensor trips and its
minimum is signed. If labeled data already exceeds the signed minimum at
execution time, the first run may execute — its output still lands in
shadow mode only.

PRE-CHANGE STATEMENT (condensed, per session protocol)

Decision modeled: none new — Phase C adds no decision authority. It adds
a learned proposer confined to shadow mode behind a signed gate.
Evidence: whatever confirmed observations exist at run time. Empirical:
GBT+SHAP, split-conformal, and uncertainty sampling are established
methods; nothing here validates PPBF-specific models. Policy: every gate
minimum, activation, and label definition. Heuristic: proposed minimums
in the ledger, unsigned. Abstention: no labels → training refuses with
reason code; ambiguous conformal set → abstain; unsigned activation →
zero advisory output regardless of model quality. Human ratification:
G-C1 disagreement-log review + signature is the ONLY path to any
user-visible learned output.

BUILD — SIX COMPONENTS

1. Label & feature assembly
   Feature and label definitions live as REVIEWABLE, VERSIONED CONFIG
   built from confirmed observations only (never drafts, never research
   content). Expect these definitions to be revised against real data —
   design for cheap change. Label provenance recorded per row.

2. Training harness (ephemeral)
   LightGBM (or XGBoost) training as an ephemeral job — no standing
   compute, no AML workspace. Every trained artifact carries: data
   snapshot id, feature/label config version, training config, metrics,
   SHAP global summary. Refuses to run below the signed G-C1 minimum,
   with reason code.

3. ONNX inference path
   Export to ONNX; inference via onnxruntime-node inside the existing
   server. No new services. Every prediction record carries per-row SHAP
   attributions and model version.

4. Shadow-mode comparator (G-C1 armed behavior)
   Runs the learned model alongside the existing rule-based classifier
   on live inputs. Logs agreements/disagreements with full context.
   ZERO user-visible output. There is no code path from the model to any
   coach-facing surface except through the activation flag, which ships
   OFF and can only be set by the signed-activation mechanism.

5. Conformal wrapper (G-C2)
   Split-conformal prediction sets over the shadow model using a held-out
   calibration split. Ambiguous set ⇒ ABSTAIN, by construction. The
   wrapper is the only form in which the model may EVER surface
   post-activation — point predictions without sets are not servable.

6. Active-learning queue (G-C3) + gate sensors
   Uncertainty-sampling queue rendering a labeling-priority list for
   coaches (propose-only; armed is its ceiling). Plus: sensors and
   notifications for G-C1..G-C4 per the ledger, and the Gate Board data
   the product lane renders. Sensors count confirmed observations and
   labels only — research content and drafts never increment a sensor.

AUTHORIZED WIDENINGS (explicit; everything else stays denied)
- SCHEMA: additive-only — labels, model registry, prediction/disagreement
  logs, queue items, gate-state records. Migrations itemized in the PR.
- COMPUTE: ephemeral training job configuration only.
- NO new external HTTP. NO auth changes. NO deploy changes. NO touching
  promotion logic, policy module internals, D10, or existing heuristics.

HOUSE RULES
AGENTS.md permanents apply. Additionally: no blended or universal scores;
SHAP present on every prediction record; abstention everywhere data or
signatures are missing; PR-only; Jason merges after cross-review.

TESTS / ACCEPTANCE (adversarial)
- Below-minimum training attempt → refusal with reason code.
- Trained model present + activation unsigned → zero advisory output on
  every surface; test proves the flag is the only path.
- Shadow disagreement → logged with context, never surfaced.
- Conformal ambiguous set → abstain; point-prediction serving path does
  not exist.
- Draft/unconfirmed observations and research-tier content in features →
  build fails (provenance check).
- Queue item → renders as suggestion only; labels require a human event.
- Gate sensors ignore research ingestion entirely (#345 regression).
- D10 firewall grep intact. Full gate green; exact counts matching CI.

DELIVERABLE
Files mapped to spec/ledger sections; migration review; config-version
scheme documented; exact test counts; ambiguities deferred to owner.
Open a PR. Never push main. Never merge. Jason merges after
algorithm-lane cross-review.

Do not deploy production.
