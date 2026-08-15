PPBF SHADOW — PHASE D WORK ORDER (DRAFT · HOLD)

STATUS: DRAFT. DO NOT EXECUTE.
Inert until ALL are true: (1) Phase B merged (machine drafts ride the
same DraftObservation path); (2) the behavior registry is ratified AND
Jason has ratified a video-mapping table for it; (3) Jason confirms the
recording/consent workflow for athletes — including guardians for
minors — as an owner/safeguarding matter this order does NOT design;
(4) Jason explicitly hands this order to the implementation lane.
Possession is not authorization.

Repository: PunxsyProminence/ppbf-platform
Work from current origin/main in a fresh dedicated branch.

MISSION

Build the Phase D video pipeline per Stack v1.1 §2.9 and Gate Ledger
G-D1: browser-side pose estimation producing MACHINE-source draft
observations at the AI-interpretation tier. Its ceiling is permanent:
propose-only. Video becomes an independent observer whose every claim a
human must confirm.

PRE-CHANGE STATEMENT (condensed)

Decision modeled: none — a third propose-only producer. Evidence:
pretrained pose models (MediaPipe/MoveNet class); zero SHADOW training
data required. Empirical: pose estimation is established; kinematic-
feature→behavior mappings are NOT validated for PPBF and enter only as
ratified config proposing drafts. Policy: the mapping table; retention
rules; consent workflow (owner's, upstream of this order). Heuristic:
feature definitions, revisable config. Abstention: no ratified mapping →
extraction runs, proposes nothing, reason-coded. Human ratification:
every machine draft requires a coach confirm event; corroboration counts
only after confirmation.

BUILD — FIVE COMPONENTS

1. On-device pose extraction (browser, MediaPipe/TF.js class model).
   Frames are processed on the device. By default NO frame, image, or
   raw video leaves the device — only derived kinematic features and,
   where explicitly enabled, short clips under the retention config.

2. Kinematic feature computation as reviewable, versioned config
   (e.g., guard height, hand-return timing, stance width, exit
   footwork patterns). Feature definitions are engineering constructs,
   not truths; version every change.

3. Mapping table → draft proposals. The Jason-ratified table maps
   feature patterns to candidate behavior codes from the registry.
   Output = DraftObservation with source = MACHINE, tier =
   AI-interpretation, model + feature-config + mapping-table versions in
   provenance. No ratified table → no proposals, reason code. Machine
   drafts follow the identical confirm gate as human-note extraction and
   are structurally incapable of reaching engines unconfirmed.

4. Corroboration linkage. A confirmed machine draft that shares an
   observational unit with a human observation populates the
   video-corroboration evidence dimension — after confirmation only.
   "Video disagrees with coach" becomes a recorded, reviewable fact,
   never an auto-resolution: both records persist.

5. Storage & separation. Optional clip retention to Blob under an
   owner-set retention policy; clips referenced by athlete code, key
   held separately. V-source stays excluded from live human-agreement
   statistics (#357 rule).

HARD BANS (this order and permanently, absent a dedicated owner-opened
safeguarding lane)
- NO head-impact, concussion, injury, pain, or medical inference of any
  kind from video — this is D10-adjacent territory and is out of scope
  by standing order.
- NO face recognition, identity inference, emotion inference, or
  biometric processing beyond pose kinematics.
- NO fatigue-state inference from video presented as fact.
- NO raw-video upload by default; no frames to any third-party service.
- NO machine observation entering any engine, stratum, or baseline
  without a human confirm event.

AUTHORIZED WIDENINGS (everything else stays denied)
- SCHEMA: additive-only — machine-draft provenance fields, mapping-table
  registry, clip references + retention metadata. Itemized in the PR.
- STORAGE: Blob container for opt-in clips under retention policy.
- NO new external HTTP beyond existing Azure storage. NO auth changes.
  NO deploy changes. NO D10 contact.

TESTS / ACCEPTANCE (adversarial)
- Unconfirmed machine draft → provably blocked from engines.
- Mapping table absent/unratified version → zero proposals, reason code.
- Browser build network audit → no frame egress paths exist.
- V-source record → excluded from human inter-rater statistics.
- Machine-vs-human disagreement → both records persist; nothing
  auto-resolves.
- Banned-inference guard: no code path or config can emit medical,
  impact, identity, or emotion constructs (lint/grep-level check).
- Retention policy enforced: expired clips purge; features persist.
- Full gate green; exact counts matching CI.

DELIVERABLE
Files mapped to spec/ledger sections; migration review; feature and
mapping config versioning documented; exact test counts; ambiguities
deferred. Open a PR. Never push main. Never merge. Jason merges after
algorithm-lane cross-review.

Do not deploy production.
