-- ---------------------------------------------------------------------------
-- Record WHY a SHADOW answer was withheld, not only THAT it was.
--
-- pilot.shadow_chat_messages.response_state has recorded 'filtered' since the
-- SHADOW runtime migration, and validateShadowResponse has always computed the
-- reasons it filtered on. Those reasons were never stored anywhere. Not here,
-- not on pilot.shadow_chat_audit, and the chat route emitted no telemetry on
-- the filter path -- so the complete database record of a withheld answer was
-- the single word 'filtered'.
--
-- The cost of that is on the record. Three separate over-filters were found in
-- validateShadowResponse on 2026-08-01/02, each by someone tripping over it:
-- a staging gate that happened to ask a question the validator mishandled, a
-- deliberate corpus sweep, and a gate failure reproduced by hand from source.
-- Diagnosing the last one meant reading the validator and re-deriving the
-- trigger, because no artifact of the decision survived it.
--
-- That matters more than a missing debug field, because an over-filter is the
-- defect nobody reports. A coach who asks a reasonable question and is told
-- "I can't safely provide that generated answer" does not file a bug -- they
-- conclude the tool is not useful and stop opening it, and that decision
-- appears in no queue anywhere.
--
-- WHY AN ARRAY, NOT A SINGLE REASON
--   One response commonly trips several rules at once -- an answer filtered as
--   a diagnostic claim is usually also missing deferral language. Storing the
--   first reason would attribute the withhold to whichever rule the validator
--   happens to evaluate earliest, which is an implementation detail, and would
--   quietly under-count every other rule.
--
-- WHY CODES, NOT THE SENTENCES
--   The reasons are English sentences written for a human, and they get
--   reworded. Grouping over prose splits one rule into two series the moment
--   someone clarifies a wording, which reads exactly like a rule that stopped
--   firing and a new one that started. SHADOW_FILTER_REASONS in shadowChat.ts
--   holds the code-to-sentence map, and the codes are append-only.
--
-- WHY NO CHECK CONSTRAINT ON THE VALUES
--   A constraint here would have to be widened by a migration every time a
--   validator rule is added, which puts a schema change in the path of a
--   safety fix -- the wrong thing to make slower. Unknown codes are a reporting
--   curiosity, not a data-integrity problem: the reader sees a code it does not
--   recognise rather than losing the row. shadowFilterReasonCodes.test.ts holds
--   the code set to its single definition instead.
--
-- Nullable, with no backfill. Rows written before this migration have no
-- reasons to recover, and inventing one would be worse than the gap: the check
-- script reports unattributed filtered messages as their own line rather than
-- letting them silently dilute a rule's share.
-- ---------------------------------------------------------------------------

alter table pilot.shadow_chat_messages
  add column if not exists filter_reasons text[] null;

-- Partial and GIN: the only question asked of this column is "among the
-- filtered messages, which rules fired", so indexing the ~99% of rows that were
-- never filtered would be paying for nothing. GIN because the lookup is
-- containment against an array, not equality on a scalar.
create index if not exists idx_shadow_chat_messages_filter_reasons
  on pilot.shadow_chat_messages using gin (filter_reasons)
  where response_state = 'filtered';
