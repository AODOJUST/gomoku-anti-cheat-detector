// admin-set-role -- §2.2.3's two super-only rows: 任命普通管理员 / 罢免普通管理员.
//
// POST { user_id, role }   Authorization: Bearer <jwt>       role: 'admin' | 'user'
//   -> 200 { ok: true, user: { id, role } }
//   -> 400 { error: 'BAD_REQUEST' }   self, or not a role this endpoint may set
//   -> 403 { error: 'FORBIDDEN' }     not a super admin
//   -> 404 { error: 'NOT_FOUND' }     no such account
//
// ---------------------------------------------------------------------------------------------
// WHY ONE ENDPOINT AND NOT `admin-demote-user`
// ---------------------------------------------------------------------------------------------
// The 1.0.5 定稿's §五 实现清单 names `admin-demote-user`, and §2.2.3's table has TWO super-only
// rows: 「罢免普通管理员」 and 「任命普通管理员」. They are the same operation with opposite signs —
// one write to one column, one authority, one audit line — so they are one endpoint. Two Functions
// would mean the self-protection and super-admin-protection rules written twice, and this repo has
// paid six times for one rule living in two places. The slug therefore differs from the 定稿's
// sketch on purpose (the standing rule: 实现要求, 写明与示例的差异).
//
// ---------------------------------------------------------------------------------------------
// THE THREE REFUSALS, AND WHY THEY ARE HERE RATHER THAN IN AN RLS POLICY
// ---------------------------------------------------------------------------------------------
// §2.2.4 sketches a `super_admin_demote` UPDATE policy. 011 §3 already does
// `revoke select` + `revoke update` on `users` and re-grants exactly `update (hide_country,
// manual_status)`, so no authenticated client can write `role` through PostgREST at all — the
// policy would be a door with no handle, and 「策略存在」 paper over 「没有第二个入口」. Promotion and
// demotion are therefore service-role writes, and the rules live here where they can also answer
// with a sentence:
//
//   * 不能给自己降级 — the one action that can lock the last super admin out of their own console.
//   * 不能改另一个超级管理员的角色 — §2.2.1's 「不向其他管理员发放」. A super admin demoting another
//     super admin is not a moderation action, it is a power struggle the spec never contemplates,
//     and quietly allowing it would make the role's scarcity a convention.
//   * 只能设成 'admin' 或 'user' — `'super_admin'` is REFUSED here on purpose. §2.2.1/§2.2.6 say the
//     elevation is granted once, by hand, in Studio (`update users set role = 'super_admin' where
//     email = …`); an endpoint that could mint one would turn 「隐藏」 into 「没写在界面上」.
//
// ⚠ `is_admin` IS NOT WRITTEN HERE. 017's trigger derives it from `role`, so this file names one
// column and the flag lands on its own — the alternative (writing both) is the second spelling that
// migration exists to make impossible.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, HttpStatus, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireSuperAdmin, roleAsSeenBy, serviceClient, toRole } from "../_shared/client.ts";

/** §2.2.3's two rows. `'super_admin'` is absent BY DESIGN — see the header. */
const SETTABLE_ROLES = ["admin", "user"];

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireSuperAdmin(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const userId = typeof body.user_id === "string" ? body.user_id.trim() : "";
    if (userId === "") return badRequest("Missing user_id");
    const role = String(body.role ?? "");
    if (SETTABLE_ROLES.indexOf(role) < 0) {
      return badRequest("role must be 'admin' or 'user'");
    }
    if (userId === caller.id) {
      return badRequest("You cannot change your own role");
    }

    // The target's CURRENT role decides whether this is allowed at all, so it is read first. One
    // query rather than an UPDATE … RETURNING, because the refusal needs the old value and a failed
    // UPDATE would have already been a no-op.
    const { data: target, error: readError } = await sb
      .from("users")
      .select("id,role")
      .eq("id", userId)
      .maybeSingle();
    if (readError) throw readError;
    if (!target || typeof target.id !== "string") {
      return fail("NOT_FOUND", HttpStatus.NOT_FOUND, "User not found");
    }
    if (toRole(target.role) === "super_admin") {
      return badRequest("A super administrator's role cannot be changed");
    }

    // ⚠ `-` IS THE id, NOTHING ELSE IS WRITTEN. `role` alone: 017's BEFORE trigger sets `is_admin`
    // from it, which is why the trigger is declared `update of role, is_admin`.
    const { error: writeError } = await sb
      .from("users")
      .update({ role: role })
      .eq("id", userId);
    if (writeError) throw writeError;

    console.log(`audit: super admin ${caller.id} set role=${role} for user ${userId}`);

    // §2.2.5 — the answer carries the role AS THE CALLER MAY SEE IT. For an ordinary admin's id this
    // is the flattened `'admin'`, so the response cannot be used to probe the hierarchy either.
    return json({ ok: true, user: { id: userId, role: roleAsSeenBy(role, false) } });
  } catch (err) {
    console.error("admin-set-role failed:", err);
    return internal("Could not change role");
  }
});
