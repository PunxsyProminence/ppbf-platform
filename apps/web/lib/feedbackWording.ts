/**
 * What a person is told after they submit through the comment box, in one
 * place, because two surfaces have to agree about it and they did not.
 *
 * The acknowledgement is deliberately identical for every submission. A child
 * who writes that someone hurt them and a coach who writes that a button is
 * broken see exactly the same words -- if the wording differed, the response
 * itself would tell the submitter which route their message took, and a child
 * testing whether it is safe to say more would learn that the gym had noticed.
 * That is the one thing this box must never do.
 *
 * It also promises only what the platform can keep: that a person reads it.
 * Not that someone will reply, and not that a conversation will happen -- those
 * are the gym's to offer in person, and a promise the software cannot keep is
 * worse than no promise to a child deciding whether to trust it.
 *
 * The admin queue quotes this so a responder knows exactly what the submitter
 * was told. It used to state its own version, which said the child had been
 * promised someone would "come talk with them" -- a promise that was removed
 * from the acknowledgement and left standing on the responder's screen. The
 * responder then acted on a belief about the child's expectations that the
 * child had no reason to hold.
 *
 * This module is under lib/ rather than src/server/pilot/ so the client can
 * import it. src/server/pilot/feedback.ts re-exports it for server callers.
 */
export const FEEDBACK_ACKNOWLEDGEMENT =
  'Thank you for telling us. A person at the gym reads this.';
