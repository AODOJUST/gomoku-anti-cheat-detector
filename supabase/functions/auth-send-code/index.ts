// auth-send-code -- §2.4: mail a 6-digit verification code to an address.
//
// POST { email }
//   -> 200 { ok: true }
//   -> 409 { error: 'RATE_LIMITED' }      同一邮箱 60 秒内只能发一次
//   -> 500 { error: 'EMAIL_FAILED' }       Resend refused (see _shared/email.ts)
//
// Used by all three flows that need a mailbox proven — 注册 (§2.3), 忘记密码 (§2.6) and 更换邮箱
// (§3.8) — and it serves them without knowing which is which. That is on purpose:
//
//   * It does NOT check whether the address already has an account. Signing up with a taken address
//     then fails at `auth-register` (EMAIL_TAKEN) and 忘记密码 with an unknown address fails at
//     `auth-reset-password` (NOT_FOUND) — but both of those need the code, and the code needs the
//     mailbox. So the check can safely happen AFTER proof of control, and doing it here instead
//     would turn this endpoint into 「这个邮箱注册过白身吗」, answerable by anyone about anyone.
//   * It does not require a session, for the same reason `auth-validate-code` does not: the person
//     registering has no account yet.
//
// The Resend key never leaves the server (§2.2) and the generated code is never echoed in the
// response — not even on failure.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { EMAIL_RE, serviceClient } from "../_shared/client.ts";
import { issueEmailCode } from "../_shared/email.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const raw = body.email;
    if (typeof raw !== "string" || raw.trim() === "") return badRequest("Missing email");
    const email = raw.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return fail("BAD_EMAIL", 400, "Invalid email address");

    const sb = serviceClient();
    const issued = await issueEmailCode(sb, email);
    if (!issued.ok) return issued.response;

    return json({ ok: true });
  } catch (err) {
    console.error("auth-send-code failed:", err);
    return internal("Could not send the verification email");
  }
});
