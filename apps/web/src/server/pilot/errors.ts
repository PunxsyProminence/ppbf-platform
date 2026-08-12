/*
  Typed errors that carry their own HTTP status and are safe to disclose.

  WHY THIS EXISTS

  `jsonError` derived status from string prefixes on `Error.message`
  ('Unauthorized' -> 401, 'Missing' -> 400, ...). Anything unmatched became a
  500 with the message replaced by "Internal server error" -- correct as a
  default, because a raw message can carry connection strings, SQL or stack
  detail. The problem was never the redaction. It was that a load-bearing
  contract was expressed as a string prefix and enforced by comment, so a
  validation message could stop being disclosed by being reworded.

  It happened. `pinPolicy.ts` documents the convention in its own header and
  then breaks it eleven lines later: 'That PIN is too easy to guess...' begins
  with "That", so an athlete who picks 111111 gets "Internal server error"
  instead of the reason. Its sibling checks all begin with "PIN" and work.

  THE DISCLOSURE RULE, WHICH IS THE WHOLE POINT OF THE TYPE

  Throwing a PilotError asserts: this message was authored for the caller to
  read, and I have checked it carries no internal detail. A plain `Error`
  keeps meaning "redact me". So the boundary is not a style preference --
  converting an internal fault (a failed write, a driver error, "Unable to
  record X.") to a PilotError is how internals leak. When unsure, leave it a
  plain Error: the cost is an opaque 500, which is the status quo, and the
  cost of getting it wrong in the other direction is disclosure.

  This generalises what `jsonError` already did correctly by type for
  MedicalStatusBlockedError, GuardianConsentMissingError and
  ShadowRuntimeUnavailableError, rather than inventing a new mechanism.
*/

export class PilotError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /**
     * The ALL_CAPS machine code, when the throw site had one. It belongs
     * here rather than in the message prefix -- several existing messages
     * read `SAFETY_FLAG_NOT_FOUND: prose`, which put the code exactly where
     * the status matcher was looking and the prose exactly where nobody
     * would see it.
     */
    readonly code?: string,
  ) {
    super(message);
    // Subclasses report their own name, so a log line says ValidationError
    // rather than PilotError for all four.
    this.name = new.target.name;
  }
}

/** A precondition the caller can fix by sending different input. */
export class ValidationError extends PilotError {
  constructor(message: string, code?: string) {
    super(400, message, code);
  }
}

/** The caller is authenticated but not permitted. */
export class ForbiddenError extends PilotError {
  constructor(message: string, code?: string) {
    super(403, message, code);
  }
}

/**
 * The addressed resource does not exist.
 *
 * Note the deliberate exception already in `http.ts`: routes where a distinct
 * 404-vs-403 would disclose that a record exists use `hiddenNotFound()`
 * instead, so the two cases are indistinguishable. Do not replace those with
 * this -- they are hiding the difference on purpose.
 */
export class NotFoundError extends PilotError {
  constructor(message: string, code?: string) {
    super(404, message, code);
  }
}

/**
 * A state conflict, or a precondition on a *different* resource than the one
 * addressed -- the reasoning `http.ts` already records for
 * GuardianConsentMissingError, where 400 would misdescribe whose fault it is
 * and 403 would misdescribe what is missing.
 */
export class ConflictError extends PilotError {
  constructor(message: string, code?: string) {
    super(409, message, code);
  }
}
