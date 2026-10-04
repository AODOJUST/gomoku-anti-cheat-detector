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
  // --- 1.0.5 审计 P1 ---------------------------------------------------------------------------
  // 「6 位数字 = 1,000,000 种可能……没有验证尝试次数的限制。如果服务端不做，攻击者可以在 10 分钟
  // 有效期内以任意速率暴力尝试。」 The fix counts the guesses (019_email_code_attempts.sql), and this
  // is its own code for the same reason `BAD_EMAIL_CODE` and `INVALID_EMAIL_CODE` are two: 「这个码错了」
  // and 「这个码已经废了，重新发一个」 are different next actions. Borrowing `RATE_LIMITED` would tell
  // the operator to wait 60 seconds, which is exactly the wrong button — `RATE_LIMITED` is about
  // SENDING, and this is about VERIFYING. 1.0.5's own avatar defect (a GIF picker told about
  // activation codes) is what happens when two meanings share one spelling.
  | "TOO_MANY_ATTEMPTS"
  // The mail provider refused or is not configured. Distinct from INTERNAL because it is a
  // DEPLOYMENT problem the operator (not the end user) has to fix, and generic 500s get lost.
  | "EMAIL_FAILED"
  // --- 1.0.2 §二 社区互动 ------------------------------------------------------------------------
  // Same rule as the 1.0.1 block above, and it is worth restating because §2.3.5 is where it bites:
  // 「消息长度 ≤ 500 字符」 and 「敏感词过滤」 are the two failures a user CAUSES and can FIX. Answered
  // as a bare 400 they would reach the operator as 「请求无效」 — which names neither the limit nor the
  // word — and the community view would look broken rather than strict. Naming the code is what lets
  // `cloudErrText` say which of the two happened, and `message` carries the specifics (the limit, the
  // term) that a code deliberately cannot.
  //
  // `NOT_ACTIVATED` is the odd one out: it is not user-fixable, it is defence in depth. §2.1 hides
  // the 社区 button from an unactivated operator, so this answer only reaches someone calling the
  // endpoint by hand — and it exists so that 「社区仅对已激活用户开放」 is a fact about the SERVER
  // rather than a fact about our button. It is 403 (the caller is authenticated, the resource is
  // forbidden) rather than 401, which would tell them to sign in again.
  | "NOT_ACTIVATED"
  | "CONTENT_TOO_LONG"
  | "CONTENT_REJECTED"
  // --- 1.0.3 §一/§二/§三 ---------------------------------------------------------------------
  // The same rule a third time, and this release is where it pays off most: 1.0.3 adds ten refusals
  // that are all 4xx for a caller who is signed in and behaving normally, and every one of them has
  // a DIFFERENT fix. Answered as `FORBIDDEN` they would reach the operator as one sentence
  // (「没有权限」) covering 「你被禁言到明天」「今天发了 20 个存档了」「这个分享 15 分钟前过期了」
  // 「投票已经关了」「对方把你拉黑了」 — five unrelated situations, five different next actions.
  //
  // ⚠ EACH ONE MUST HAVE A `cloudErrText` BRANCH. That is not a style note: 1.0.2 shipped
  // `NOT_ACTIVATED` with no branch and the community showed 「未知错误（NOT_ACTIVATED）」, which
  // `behave-064` caught on its first run. `verify-064`/`verify-065` enumerate this union from the
  // SOURCE and refuse to pass while any code lacks a sentence.
  | "MUTED"
  | "CHAT_DISABLED"
  | "SHARE_EXPIRED"
  | "QUOTA_EXCEEDED"
  | "FRIEND_EXISTS"
  | "NOT_FRIENDS"
  | "BLOCKED_BY_USER"
  | "VOTE_CLOSED"
  | "VOTE_ALREADY_CAST"
  | "TARGET_NOT_FOUND";

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
