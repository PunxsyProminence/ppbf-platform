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

/**
 * The server cannot serve this request at all, because something it requires
 * to run is absent. Not the caller's fault and not fixable by sending
 * different input, which is what separates it from every class above.
 *
 * It exists because the condition it names was being reported as a 400 with
 * the internal detail attached. `requireEnv` throws a plain Error reading
 * "Missing required environment variable: <NAME>", and `jsonError`'s
 * compatibility branch routes anything beginning with "Missing" to 400 and
 * returns the message verbatim -- so a server with no database configured
 * answered an unauthenticated login with the name of an infrastructure
 * variable, under a status saying the athlete had typed something wrong.
 * Both halves came from inferring a contract out of spelling, which is the
 * failure this whole file exists to end.
 *
 * THE MESSAGE STAYS GENERIC, and that is the point rather than politeness.
 * A PilotError asserts its message was authored for the caller to read, so
 * anything carried here is disclosed on purpose. The missing variable's name
 * belongs in the server log, never in the body: whoever can fix it can read
 * the log, and whoever cannot has no use for it.
 */
export class ServiceUnavailableError extends PilotError {
  constructor(message: string, code?: string) {
    super(503, message, code);
  }
}

/** The one message a caller is given for any missing runtime configuration.
    Named so a test can pin it without restating it, and so no call site is
    tempted to write a more "helpful" one. */
export const SERVICE_UNAVAILABLE_MESSAGE = 'Service temporarily unavailable. Please try again later.';
