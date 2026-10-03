// profile-update -- edit the three user-writable profile fields.
//
// POST { username?, bio?, avatarUrl? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, user }
//
// Only username / bio / avatar_url are writable. An email change is deliberately NOT
// handled here: changing the login identity requires a verified-email flow (send a
// confirmation link to the new address, keep the old one until it is confirmed), which
// is a separate piece of work from a profile edit. Callers must go through that flow
// instead of expecting this endpoint to move the address.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed, unauthorized } from "../_shared/errors.ts";
import { requireUser, serviceClient, toPublicUser, type UserRow } from "../_shared/client.ts";

const USERNAME_MIN = 1;
const USERNAME_MAX = 32;
const BIO_MAX = 300;
const AVATAR_URL_MAX = 1024;

/**
 * The prefix every avatar URL must live under. Configured with `PUBLIC_AVATAR_PREFIX`
 * (e.g. https://<ref>.supabase.co/storage/v1/object/public/avatars/). Falls back to the
 * conventional Supabase Storage public bucket path for this project.
 */
function avatarPrefix(): string {
  const configured = Deno.env.get("PUBLIC_AVATAR_PREFIX");
  if (configured && configured.trim() !== "") return configured.trim();
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  return `${url}/storage/v1/object/public/avatars/`;
}

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const patch: Record<string, string | null> = {};

    if (body.username !== undefined) {
      if (typeof body.username !== "string") return badRequest("Invalid username");
      const username = body.username.trim();
      if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
        return badRequest(`username must be ${USERNAME_MIN}-${USERNAME_MAX} characters`);
      }
      patch.username = username;
    }

    if (body.bio !== undefined) {
      if (body.bio === null) {
        patch.bio = null; // explicit clear
      } else if (typeof body.bio !== "string") {
        return badRequest("Invalid bio");
      } else if (body.bio.length > BIO_MAX) {
        return badRequest(`bio must be at most ${BIO_MAX} characters`);
      } else {
        patch.bio = body.bio === "" ? null : body.bio;
      }
    }

    if (body.avatarUrl !== undefined) {
      if (body.avatarUrl === null || body.avatarUrl === "") {
        patch.avatar_url = null; // explicit clear
      } else if (typeof body.avatarUrl !== "string") {
        return badRequest("Invalid avatarUrl");
      } else {
        const avatarUrl = body.avatarUrl.trim();
        if (avatarUrl.length > AVATAR_URL_MAX) return badRequest("avatarUrl is too long");
        if (!avatarUrl.startsWith(avatarPrefix())) {
          return badRequest("avatarUrl must point at the configured public storage bucket");
        }
        patch.avatar_url = avatarUrl;
      }
    }

    if (Object.keys(patch).length === 0) {
      return badRequest("Nothing to update");
    }

    const sb = serviceClient();

    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    if (!caller.row) return unauthorized("Account not found");
    if (caller.deletedAt) return unauthorized("Account has been deleted");

    // Service-role write: the RLS update policy would scope this to the caller's row
    // anyway, and the column-level grant would already forbid touching is_admin.
    const { data: updated, error: updateError } = await sb
      .from("users")
      .update(patch)
      .eq("id", caller.id)
      .select("*")
      .single();
    if (updateError) throw updateError;

    return json({ ok: true, user: toPublicUser(updated as UserRow) });
  } catch (err) {
    console.error("profile-update failed:", err);
    return internal("Could not update profile");
  }
});
