/**
 * WHAT MAKES SHADOW LIBRARY MATERIAL SERVABLE, AS SQL.
 *
 * searchShadowLibrary is the bar: a source or document counts as evidence only
 * while a gym-wide search could actually return it. Two readers that are not
 * search have to answer the same question and used to answer it differently:
 *
 * - capability coverage (shadowLibrary.ts) counted any active source, so a
 *   rule read "covered" on material search would never serve;
 * - the rabbit-hole citation join (rabbitHoles.ts) checked approval and
 *   verification but not retraction suppression or athlete scope, so a lesson
 *   could go on naming a document pulled for retraction, or a document filed
 *   against one athlete, to every reader of the lesson.
 *
 * Both now read these two predicates, so the rule is written once.
 *
 * The predicates say what makes ONE row servable; how rows are joined is the
 * caller's, and it has to be search's join to mean what search means. Search
 * serves a source through the chunks that cite it (chunk.source_id), inside
 * the document each chunk sits in (chunk.document_id) -- never through the
 * document the source owns. In the research corpus those are different
 * sources: every document is owned by one programme source, and the chunks
 * cite hundreds of others. So capability coverage applies the document
 * predicate to the citing chunk's document, while the rabbit-hole join, which
 * cites a document rather than a source, applies the source predicate to that
 * document's owner.
 *
 * ALIAS CONTRACT. Each predicate is written against a fixed table alias -- `s`
 * for pilot.shadow_library_sources, `d` for pilot.shadow_library_documents --
 * because every caller already uses those aliases. They are module constants
 * interpolated into SQL, never input.
 *
 * Organization scoping is NOT part of either predicate. Which shelves a reader
 * may draw from (its own organization, the platform baseline, or both) is the
 * caller's decision; see libraryRetrievalOrganizationIds.
 */

/**
 * A source search can serve: active, approved, verified, and not suppressed
 * for retraction. suppressSource flips only retrieval_suppressed and leaves
 * the approvals standing, which is why the flag has to be read on its own.
 */
export const SERVABLE_LIBRARY_SOURCE_SQL = `s.status = 'active'
         and s.approval_state = 'approved'
         and s.verification_state = 'verified'
         and not coalesce(s.retrieval_suppressed, false)`;

/**
 * A document a GYM-WIDE search can serve: indexed, approved, verified, and
 * not scoped to one athlete. A document with a subject_id (and its chunks,
 * which inherit it) is served only to a search naming that athlete, so it is
 * never gym-wide evidence -- the same boundary searchShadowLibrary's 'scoped'
 * branch and listApprovedGlobalEvidenceForResearchBridge draw.
 */
export const SERVABLE_GYM_WIDE_LIBRARY_DOCUMENT_SQL = `d.subject_id is null
         and d.ingest_state = 'indexed'
         and d.index_completed_at is not null
         and d.approval_state = 'approved'
         and d.verification_state = 'verified'`;
