// profile-update -- edit the user-writable profile fields, and store an uploaded avatar.
//
// POST { username?, bio?, avatarUrl?, avatarData? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, user }
//
// Only username / bio / avatar_url are writable. An email change is deliberately NOT handled here:
// it needs a verified-address flow and its own endpoint (`auth-change-email`, §3.8), and accepting
// it through this door would let a client move a login identifier without proving control of it.
//
// ---------------------------------------------------------------------------------------------
// TWO WAYS TO SET AN AVATAR, ON PURPOSE
// ---------------------------------------------------------------------------------------------
// `avatarUrl`   — 1.0.0's contract: a URL that must already live under the public bucket. Kept
//                 as-is so a deployed 1.0.0 client keeps working.
// `avatarData`  — 1.0.1 §3.6: a data URL holding the 256×256 JPEG the client just compressed. This
//                 function uploads it and derives the URL itself.
//
// The second exists because the alternative was a third outbound route in `cloud.js` (a direct
// Storage PUT from the extension), which 1.0.0 deliberately narrowed to `call`/`rest`
// (「路由只有一个门」), and because it would put the bucket's write policy on the critical path of
// 「换个头像」. The server already holds the service-role key and already knows the user's id, so the
// path `avatars/{user_id}.jpg` is decided in exactly one place — here — which is what §3.6 asks in
// as many words.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed, unauthorized } from "../_shared/errors.ts";
import { AVATAR_BUCKET, requireUser, serviceClient, toPublicUser, type UserRow } from "../_shared/client.ts";

const USERNAME_MIN = 1;
const USERNAME_MAX = 32;
const BIO_MAX = 300;
const AVATAR_URL_MAX = 1024;

/**
 * §3.6's 「大小 ≤ 2MB」, measured on the DECODED bytes.
 *
 * The client enforces the same number before compressing (`GMProfile.AVATAR_MAX_BYTES`). Two copies
 * is the shape §2.3's table asks for by listing every rule twice (前端校验 / 后端校验) — the client's
 * copy exists so the operator is told before a 3 MB upload, this one exists because a client is not
 * a validator.
 */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** §3.6 「格式：jpg / png / webp」. Encoded as the data URL's media type. */
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
// ⚠ `AVATAR_BUCKET` IS IMPORTED, NOT DECLARED HERE — see its note in `_shared/client.ts`. 1.0.5's
// account purge removes the same object, and two copies of a bucket name is how one of them ends up
// wrong (which fails as 「图片没被删掉」, not as an error).

/**
 * The prefix every `avatarUrl` must live under. Configured with `PUBLIC_AVATAR_PREFIX`
 * (e.g. https://<ref>.supabase.co/storage/v1/object/public/avatars/). Falls back to the
 * conventional Supabase Storage public bucket path for this project.
 */
function avatarPrefix(): string {
  const configured = Deno.env.get("PUBLIC_AVATAR_PREFIX");
  if (configured && configured.trim() !== "") return configured.trim();
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  // Built from the constant rather than retyped: this string used to be a second spelling of the
  // bucket name sitting three lines below the first one.
  return `${url}/storage/v1/object/public/${AVATAR_BUCKET}/`;
}

type ParsedAvatar = { ok: true; value: { bytes: Uint8Array; contentType: string } };
type ParsedAvatarError = { ok: false; response: Response };

/**
 * Decode `data:image/<type>;base64,<payload>`.
 *
 * `atob` then a byte loop rather than `Uint8Array.from(atob(...), c => c.charCodeAt(0))`: the direct
 * form is one allocation per character on a 100 KB avatar, and this file runs on every profile
 * edit.
 */
function parseAvatarData(raw: unknown): ParsedAvatar | ParsedAvatarError {
  if (typeof raw !== "string" || raw === "") return { ok: false, response: badRequest("Invalid avatarData") };

  const match = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=]+)$/.exec(raw);
  if (!match) return { ok: false, response: badRequest("avatarData must be a base64 image data URL") };

  const contentType = match[1].toLowerCase();
  if (AVATAR_TYPES.indexOf(contentType) < 0) {
    return { ok: false, response: badRequest("Avatar must be a jpg, png or webp image") };
  }

  // 4 base64 characters per 3 bytes; reject on the ENCODED length first so an oversized payload is
  // never decoded — the point of a size limit is not to allocate the thing it refuses.
  if (match[2].length > Math.ceil(AVATAR_MAX_BYTES / 3) * 4) {
    return { ok: false, response: badRequest("Avatar must be at most 2MB") };
  }

  let binary: string;
  try { binary = atob(match[2]); }
  catch { return { ok: false, response: badRequest("avatarData is not valid base64") }; }

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytes.length === 0) return { ok: false, response: badRequest("avatarData is empty") };
  if (bytes.length > AVATAR_MAX_BYTES) {
    return { ok: false, response: badRequest("Avatar must be at most 2MB") };
  }

  return { ok: true, value: { bytes, contentType } };
}

type UploadResult = { ok: true; url: string } | { ok: false; response: Response };

/** Put the bytes at §3.6's path and return the public URL to store on the row. */
async function uploadAvatar(
  sb: ReturnType<typeof serviceClient>,
  userId: string,
  avatar: { bytes: Uint8Array; contentType: string },
): Promise<UploadResult> {
  const path = `${userId}.jpg`;

  // `upsert: true` is the whole point — §3.6 names ONE path per user, so a second upload replaces
  // the first rather than failing on a collision.
  const { error } = await sb.storage.from(AVATAR_BUCKET).upload(path, avatar.bytes, {
    contentType: avatar.contentType,
    upsert: true,
  });
  if (error) {
    // A missing bucket is the single most likely first-run failure, and it is the operator's to
    // fix (Dashboard → Storage → New bucket, public). Saying so beats a generic 500.
    if (/bucket/i.test(error.message ?? "")) {
      console.error(`profile-update: storage bucket '${AVATAR_BUCKET}' is missing: ${error.message}`);
      return {
        ok: false,
        response: fail("INTERNAL", 500, `Storage bucket '${AVATAR_BUCKET}' does not exist`),
      };
    }
    throw error;
  }

  const publicUrl = sb.storage.from(AVATAR_BUCKET).getPublicUrl(path).data.publicUrl;
  // ⚠ Cache-busting IS required here, not cosmetic: the path is constant by design, so the CDN and
  // the browser would keep serving the previous avatar — the operator would change their picture
  // and see the old one, forever, with no way to tell that the upload worked. A timestamp query is
  // the smallest thing that makes a fixed path a moving target.
  return { ok: true, url: `${publicUrl}?v=${Date.now()}` };
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

    // Shape-checked before the session is resolved: decoding is free of side effects, and a
    // malformed payload should not cost a database round trip to find out.
    let avatar: { bytes: Uint8Array; contentType: string } | null = null;
    if (body.avatarData !== undefined) {
      const parsed = parseAvatarData(body.avatarData);
      if (!parsed.ok) return parsed.response;
      avatar = parsed.value;
    }

    if (Object.keys(patch).length === 0 && !avatar) {
      return badRequest("Nothing to update");
    }

    const sb = serviceClient();

    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    if (!caller.row) return unauthorized("Account not found");
    if (caller.deletedAt) return unauthorized("Account has been deleted");

    // The upload needs the user id, which is why it happens after `requireUser` and not before.
    if (avatar) {
      const uploaded = await uploadAvatar(sb, caller.id, avatar);
      if (!uploaded.ok) return uploaded.response;
      // The derived URL wins over any `avatarUrl` in the same request: it is the one the server
      // just created for this user, and letting the body override it afterwards would be a way to
      // store an arbitrary URL through the upload door.
      patch.avatar_url = uploaded.url;
    }

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
