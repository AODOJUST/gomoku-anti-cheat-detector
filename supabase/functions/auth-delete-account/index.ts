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
import { requireUser, serviceClient } from "../_shared/client.ts";

/** How long a soft-deleted account is retained before the cron purge removes it. */
const PURGE_AFTER_DAYS = 30;

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

    // PURGE JOB (not executed here): a Supabase Cron / pg_cron job must hard-delete
    // rows 30 days after deletion. The SQL the scheduled job should run is:
    //
    //   select cron.schedule(
    //     'purge-deleted-users',
    //     '0 3 * * *',
    //     $$ delete from public.users
    //        where deleted_at is not null
    //          and deleted_at < now() - interval '30 days' $$
    //   );
    //
    // The users -> devices / samples / archives / badges foreign keys all use
    // ON DELETE CASCADE, so removing the users row cleans the rest up atomically.
    // See supabase/README.md for how to enable it.

    return json({ ok: true, purgeAt });
  } catch (err) {
    console.error("auth-delete-account failed:", err);
    return internal("Account deletion failed, please try again");
  }
});
