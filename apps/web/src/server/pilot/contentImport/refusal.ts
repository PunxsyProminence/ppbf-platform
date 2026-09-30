// A REFUSAL is the engine saying no on purpose: the wrong account, a stale
// plan, a blocked package, a caller that forgot its transaction. It is a
// separate class from an ordinary Error so a caller (the seed CLI now, the
// upload route later) can tell "the import was refused, nothing was written"
// from "something broke" without parsing messages. The code is a stable token
// for tests and logs; the message says what to do in plain English.

export type ContentImportRefusalCode =
  | 'ORGANIZATION_NOT_FOUND'
  | 'ACTOR_NOT_FOUND'
  | 'ACTOR_INACTIVE'
  | 'ACTOR_DELETED'
  | 'ACTOR_PLATFORM_OWNER'
  | 'ACTOR_ROLE_NOT_ALLOWED'
  | 'ACTOR_NOT_A_MEMBER'
  | 'ACTOR_NOT_PLATFORM_OWNER'
  | 'NOT_IN_TRANSACTION'
  | 'PLAN_BLOCKED'
  | 'STALE_PLAN';

export class ContentImportRefusal extends Error {
  readonly code: ContentImportRefusalCode;

  constructor(code: ContentImportRefusalCode, message: string) {
    super(`CONTENT_IMPORT_${code}: ${message}`);
    this.name = 'ContentImportRefusal';
    this.code = code;
  }
}
