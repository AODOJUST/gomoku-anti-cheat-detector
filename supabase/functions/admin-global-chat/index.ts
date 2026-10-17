// admin-global-chat — §2.3.2's single 「聊天室状态」 switch (1.0.6 三号).
//
// POST { chat_enabled: boolean }   Authorization: Bearer <admin jwt>
//   -> 200 { ok: true, settings: { chat_enabled } }
//   -> 400 { error: 'BAD_REQUEST' }   the key is missing, or the value is not a boolean
//   -> 401 { error: 'UNAUTHORIZED' }
//   -> 403 { error: 'FORBIDDEN' }
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// THIS ENDPOINT REPLACES `admin-global-mute`, AND DELETES ONE OF ITS TWO KEYS
// ---------------------------------------------------------------------------------------------
// The previous cut honoured §2.3.2's two names (`chat_enabled`, `global_mute`) as two rows, and
// `chat-send` treated either one being "off" as 「所有人不能发消息」. That worked, but it shipped a
// panel in which an operator could tick 「允许发言」 AND 「全体禁言」 at the same time — two controls
// that contradict each other, and the UI had no answer to 「那聊天室到底能不能发」.
//
// So the pair is collapsed into ONE flag with ONE meaning:
//
//     chat_enabled = true   → 所有已激活用户可以发言
//     chat_enabled = false  → 全体禁言，仅可查看历史消息
//
// `global_mute` is gone: 022 deletes its row, `chat-send` no longer reads it, and nothing in the
// console can write it any more. Keeping the row without a reader would have left a value that
// *looks* like a live switch to anyone reading the table.
//
// ⚠⚠ WHY A NEW SLUG RATHER THAN A NEW BODY ON THE OLD ONE. A Function's name is its API surface:
// `admin-global-mute` would be a name that no longer describes what it does, and the next reader of
// `config.toml` would have to open the file to find that out. The old slug is deleted from the
// project; any client still calling it gets a 404, which is the honest answer for an endpoint that
// no longer exists (and only the operator's own console ever called it).
//
// The response carries the value READ BACK from the database rather than echoed from the request:
// the console paints from the response, so a partial write cannot leave the switch showing what the
// operator clicked instead of what is stored.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  internal,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";

/**
 * The one key this endpoint owns. Kept as a list so a typo cannot quietly add a second row, and so
 * the "which key" question has a single answer in this file.
 */
const KEYS = ["chat_enabled"] as const;
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
      // stored type is jsonb and every reader tests `!== false`, so `"false"` would mean 「开启」
      // while looking like a disable in the panel.
      if (typeof body[key] !== "boolean") {
        return badRequest(`${key} must be a boolean`);
      }
      patch[key] = body[key] as boolean;
    }
    if (Object.keys(patch).length === 0) {
      return badRequest(`Provide: ${KEYS.join(", ")}`);
    }

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

    // Default for a missing row, matching 009's seed and `chat-send`'s own default（未设 = 开着）.
    const settings: Record<string, boolean> = { chat_enabled: true };
    for (const row of (data ?? []) as { key: string; value: unknown }[]) {
      if (row.key in settings) settings[row.key] = row.value !== false;
    }

    return json({ ok: true, settings });
  } catch (err) {
    console.error("admin-global-chat failed:", err);
    return internal("Could not update the settings");
  }
});
