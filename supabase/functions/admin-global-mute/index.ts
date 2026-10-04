// admin-global-mute — §2.3.2's 「关闭聊天室」 and 「全体禁言」.
//
// POST { chat_enabled?: boolean, global_mute?: boolean }   Authorization: Bearer <admin jwt>
//   -> 200 { ok: true, settings: { chat_enabled, global_mute } }
//   -> 400 { error: 'BAD_REQUEST' }   neither key present, or a non-boolean value
//   -> 401 { error: 'UNAUTHORIZED' }
//   -> 403 { error: 'FORBIDDEN' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// WHY TWO KEYS ARE ONE ENDPOINT, AND WHY THEY ARE TWO KEYS
// ---------------------------------------------------------------------------------------------
// §2.3.2 lists 「关闭聊天室」 (`settings.chat_enabled = false`) and 「全体禁言」
// (`settings.global_mute = true`) as two rows of one table. They are two NAMES for one effect —
// 「所有人不能发消息」 — and the spec gives them separate flags anyway. ⇒ Both keys exist (a client
// reading the table finds the one it knows), and BOTH are consulted by `chat-send`, so setting
// either silences the room. Keeping a single flag would have been "cleaner" and would have made one
// of the spec's two controls a no-op on the server — a button that appears to work.
//
// The response always carries BOTH, read back from the database rather than echoed from the
// request: the 管理 panel renders two switches, and a partial update must not make the untouched
// one flicker or appear to change.
//
// ⚠§2.3.2 「「关闭聊天室/全体禁言」不影响历史回放与样本互动」. Nothing else in this release reads
// these keys — not `friend-share`, not `vote-cast`, not `report-submit`. See 009_reports.sql's
// closing note: a future reader tempted to "make the mute global" should read that sentence first.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  internal,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";

/** §2.3.3's two keys. The set is closed so a typo cannot add a third row nobody reads. */
const KEYS = ["chat_enabled", "global_mute"] as const;
type SettingKey = typeof KEYS[number];

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const patch: Partial<Record<SettingKey, boolean>> = {};
    for (const key of KEYS) {
      if (body[key] === undefined) continue;
      // A truthy-but-not-boolean value (`"false"`, 0, null) is refused rather than coerced: the
      // stored type is jsonb and every reader tests `=== true`, so `"false"` would mean 「开启」
      // while looking like a disable in the panel.
      if (typeof body[key] !== "boolean") {
        return badRequest(`${key} must be a boolean`);
      }
      patch[key] = body[key] as boolean;
    }
    if (Object.keys(patch).length === 0) {
      return badRequest(`Provide at least one of: ${KEYS.join(", ")}`);
    }

    // Upsert per key rather than read-modify-write of a whole row: a partial update touches only
    // the key it names, so two admins toggling different switches cannot overwrite each other.
    const nowIso = new Date().toISOString();
    for (const key of Object.keys(patch) as SettingKey[]) {
      const { error } = await sb
        .from("global_settings")
        .upsert({ key, value: patch[key], updated_at: nowIso }, { onConflict: "key" });
      if (error) throw error;
    }

    const { data, error: readError } = await sb
      .from("global_settings")
      .select("key, value")
      .in("key", KEYS as unknown as string[]);
    if (readError) throw readError;

    // Defaults for a missing row, matching 009's seed. A key that has never been written reads as
    // the value it would have had, rather than as `undefined` — the client tests `=== false`.
    const settings: Record<string, boolean> = { chat_enabled: true, global_mute: false };
    for (const row of (data ?? []) as { key: string; value: unknown }[]) {
      if (row.key in settings) settings[row.key] = row.value === true;
    }

    return json({ ok: true, settings });
  } catch (err) {
    console.error("admin-global-mute failed:", err);
    return internal("Could not update the settings");
  }
});
