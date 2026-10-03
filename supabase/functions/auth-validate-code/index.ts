// auth-validate-code -- §2.2 step one: 「这个激活码能用吗？」
//
// POST { code }
//   -> 200 { valid: true }
//   -> 200 { valid: false, reason: 'NOT_FOUND' | 'REVOKED' | 'ALREADY_USED' }
//
// This is a QUERY, not a command, and the contract reflects that: 「不存在」 is a normal answer to
// 「能不能用」, so it arrives as HTTP 200 with `valid: false` rather than as an error envelope. The
// client renders the three reasons in its own words (§2.2's 错误提示 table) — which is why the
// reason vocabulary is exactly those three strings and not the error codes the command endpoints
// use. `extension/auth.js:validateCode` maps them onto the same error codes, so step one and step
// two cannot report the same failure two different ways.
//
// It redeems nothing, writes nothing, and — deliberately — does not need a session: it is called
// by somebody who has no account yet. The response therefore carries no user data of any kind.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { serviceClient } from "../_shared/client.ts";
import { isValidCodeShape, normalizeCode } from "../_shared/codes.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const rawCode = body.code;
    if (typeof rawCode !== "string" || rawCode.trim() === "") {
      return badRequest("Missing activation code");
    }

    const code = normalizeCode(rawCode);
    // A malformed code can never exist, so it is reported as NOT_FOUND rather than as a format
    // error. Two reasons: the client already refuses a malformed code before calling (so this is
    // only reachable by a hand-made request), and answering 「shape is wrong」 would turn the
    // endpoint into an oracle for which strings could have been codes.
    if (!isValidCodeShape(code)) return json({ valid: false, reason: "NOT_FOUND" });

    const sb = serviceClient();
    const { data: codeRow, error } = await sb
      .from("activation_codes")
      .select("code, revoked, redeemed_by")
      .eq("code", code)
      .maybeSingle();
    if (error) throw error;
    if (!codeRow) return json({ valid: false, reason: "NOT_FOUND" });

    // Order matters and is §2.2's: a revoked code that was also used reports REVOKED, because
    // 「已被撤销」 is the fact the operator has to act on (ask for a new one).
    if (codeRow.revoked === true) return json({ valid: false, reason: "REVOKED" });
    if (codeRow.redeemed_by) return json({ valid: false, reason: "ALREADY_USED" });

    return json({ valid: true });
  } catch (err) {
    console.error("auth-validate-code failed:", err);
    return internal("Could not validate the activation code");
  }
});
