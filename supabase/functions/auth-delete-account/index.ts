// auth-delete-account -- soft-delete the caller's account and force logout everywhere.
//
// POST { code? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, purgeAt }
//
// The delete is a soft delete: users.deleted_at is stamped, is_banned is left exactly
// as it was (a ban is an administrative fact and must not be laundered away by the
// account holder deleting themselves), and every devices row for the user is removed,
// which immediately invalidates the account on all other devices because auth-renew
// refuses a user whose deviceId is no longer registered.
//
// The `code` body field is accepted for forward compatibility with a step-up
// confirmation screen but is NOT required: the bearer token is what authorises the
// deletion, and demanding the activation code would lock out the exact users who lost
// it (the documented recovery path for them is admin-reissue-jwt).

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { PURGE_AFTER_DAYS, requireUser, serviceClient } from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    // Idempotent: stamping deleted_at twice just refreshes the purge clock.
    const deletedAtIso = new Date().toISOString();
    const { error: updateError } = await sb
      .from("users")
      .update({ deleted_at: deletedAtIso })
      .eq("id", caller.id);
    if (updateError) throw updateError;

    // Immediate logout on every device.
    const { error: deviceError } = await sb
      .from("devices")
      .delete()
      .eq("user_id", caller.id);
    if (deviceError) throw deviceError;

    const purgeAt = new Date(
      Date.parse(deletedAtIso) + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    // ⚠ 1.0.5 审计 P2 — THE PURGE IS NO LONGER A JOB SOMEBODY ELSE WAS SUPPOSED TO WRITE. Until
    // 1.0.5 this comment printed a `pg_cron` snippet for the operator to paste, and nothing in the
    // repository ever ran it: the audit's words were 「如果 cron 没有部署，被删除账户的数据**无限期
    // 保留**，与 PRIVACY.md §5 矛盾」. The job now EXISTS — it is section 4 of `friend-share-purge`,
    // the one maintenance Function the operator already has to schedule, and it reads the same
    // `PURGE_AFTER_DAYS` this endpoint just used to compute `purgeAt`. What is left for the operator
    // is documented in `supabase/README.md` §9 (one cron line + `PURGE_SECRET`), and `verify-067 §10`
    // fails if the two halves ever stop agreeing.
    //
    // The users -> devices / samples / archives / badges / friendships / chat_messages foreign keys
    // are all `on delete cascade`, so removing the `users` row cleans the local schema up atomically
    // — but it does NOT remove the GoTrue identity in `auth.users`, which is why the job goes through
    // the admin API first. See friend-share-purge's section 4.

    return json({ ok: true, purgeAt });
  } catch (err) {
    console.error("auth-delete-account failed:", err);
    return internal("Account deletion failed, please try again");
  }
});
