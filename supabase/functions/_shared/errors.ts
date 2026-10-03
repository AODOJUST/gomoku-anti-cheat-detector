// _shared/errors.ts -- the single response envelope the extension parses.
//
// Contract the client depends on EXACTLY:
//   success -> HTTP 200, body is the payload object itself
//   failure -> HTTP 4xx/5xx, body is { "error": "<CODE>", "message": "<optional>" }
//
// The error codes below are the complete allowed set; nothing may emit a code that
// is not in this list, and they must be spelled exactly like this on the wire.

import { corsHeaders } from "./cors.ts";

/** All error codes the client knows how to branch on. */
export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "BANNED"
  | "INVALID_CODE"
  | "CODE_REVOKED"
  | "CODE_ALREADY_USED"
  | "DEVICE_LIMIT"
  | "NOT_FOUND"
  | "INTERNAL"
  // --- 1.0.1 §2.3 / §2.4 / §2.6 / §3.7 / §3.8 -------------------------------------------------
  // Every one of these is a FAILURE THE OPERATOR CAN ACT ON, and the client's `cloudErrText`
  // words them individually. That is why they are codes rather than `BAD_REQUEST` with a message:
  // a bare 400 used to reach the operator as 「网络错误，请稍后重试」, which was the one sentence
  // that never helps — and during the 2026-10-03 bring-up it covered three unrelated faults at
  // once. The client no longer guesses: an unlisted code is reported by its own name
  // (`HTTP_<status>`), so a bare 400 is at least searchable. Naming a code is still how the
  // operator gets told WHO can fix it.
  | "BAD_USERNAME"
  | "BAD_EMAIL"
  | "BAD_EMAIL_CODE"
  | "WEAK_PASSWORD"
  | "USERNAME_TAKEN"
  | "EMAIL_TAKEN"
  | "BAD_CREDENTIALS"
  | "INVALID_EMAIL_CODE"
  | "RATE_LIMITED"
  // The mail provider refused or is not configured. Distinct from INTERNAL because it is a
  // DEPLOYMENT problem the operator (not the end user) has to fix, and generic 500s get lost.
  | "EMAIL_FAILED";

/** HTTP status constants used across the functions. */
export const HttpStatus = {
  OK: 200,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  METHOD_NOT_ALLOWED: 405,
  INTERNAL_SERVER_ERROR: 500,
} as const;

/** Serialises any payload to a JSON success response. */
export function json(body: unknown, status: number = HttpStatus.OK): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Serialises the failure envelope { error, message }. */
export function fail(
  code: ErrorCode,
  status: number,
  message?: string,
): Response {
  return json(message === undefined ? { error: code } : { error: code, message }, status);
}

/** Convenience: 400 with an optional human hint. */
export function badRequest(message?: string): Response {
  return fail("BAD_REQUEST", HttpStatus.BAD_REQUEST, message);
}

/** Convenience: 405 for a non-POST call on a POST-only function. */
export function methodNotAllowed(): Response {
  return fail("BAD_REQUEST", HttpStatus.METHOD_NOT_ALLOWED, "Method not allowed");
}

/** Convenience: the generic 401 used when no/invalid bearer token is supplied. */
export function unauthorized(message?: string): Response {
  return fail("UNAUTHORIZED", HttpStatus.UNAUTHORIZED, message);
}

/** Convenience: 403 for a non-admin caller hitting an admin function. */
export function forbidden(message?: string): Response {
  return fail("FORBIDDEN", HttpStatus.FORBIDDEN, message);
}

/** Convenience: the catch-all for unexpected server errors -- never leaks internals. */
export function internal(message?: string): Response {
  return fail("INTERNAL", HttpStatus.INTERNAL_SERVER_ERROR, message);
}
