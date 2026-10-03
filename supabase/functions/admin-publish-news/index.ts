// admin-publish-news — §2.4.5: publish a 更新日志 / 公告 entry.
//
// POST { category, title, content, lang?, translations?, is_pinned? }   Authorization: Bearer <jwt>
//   -> 200 { ok: true, id }
//   -> 400 { error: 'BAD_REQUEST' }         unknown category, blank title/content, malformed body
//   -> 400 { error: 'CONTENT_TOO_LONG' }
//   -> 403 { error: 'FORBIDDEN' }           not an admin
//   -> 500 { error: 'INTERNAL' }
//
// ---------------------------------------------------------------------------------------------
// §2.4.5 SAYS THE PUBLISHING SURFACE MAY BE SUPABASE STUDIO, AND THIS FUNCTION IS STILL NEEDED
// ---------------------------------------------------------------------------------------------
// §2.4.5 recommends Studio (「简单直接」) and marks the in-extension form 可选; §实现清单 lists this
// function unconditionally. Both are satisfiable at once, and the reason the Function is the load
// bearing half is the `translations` field: §2.4.4's multi-language entry is a JSONB OBJECT with a
// shape (`{ "<lang>": { title, content } }`), and a row typed into Studio is a hand-written JSON
// blob with whatever shape the operator remembered. This validates it. Publishing through Studio
// after this function exists is still fine — Studio runs as the service role and bypasses RLS — it
// simply gets no validation, which is the operator's call to make.
//
// ⚠ NEWS ROWS ARE IMMUTABLE HERE ON PURPOSE. There is no `admin-update-news`, because 005_community.sql
// creates no UPDATE policy either. A 更新日志 entry is a record of what shipped: correcting a typo is
// worth a second entry, and silently rewriting history is what a versioned changelog exists to
// prevent. An announcement that was wrong is corrected by publishing a new one — which is also what
// §2.4.1's 「有新闻价值的事」 implies about how they read in §2.4.4's list.
//
// ⚠ AND THE AUTHOR IS THE CALLER, NOT THE REQUEST. `author_id` comes from the verified token; there
// is no field for it. §2.4.4's card prints 「· 管理员」 from the row being published by an admin at
// all, so a spoofable author would be the only thing on the card that could lie.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  fail,
  HttpStatus,
  internal,
  json,
  methodNotAllowed,
} from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";
import {
  NEWS_CATEGORIES,
  NEWS_CONTENT_MAX,
  NEWS_DEFAULT_LANG,
  NEWS_TITLE_MAX,
} from "../_shared/community.ts";

/**
 * A language tag: `zh-CN`, `ja`, `zh-Hant`, `pt-BR` …
 *
 * Deliberately NOT checked against the thirteen locales the UI ships. §2.4.4's fallback is 「无对应
 * translation 时显示原文」, so a tag nobody can render is not an error — it is simply an entry that
 * falls back, and the day that language is added the entry is already there. Validating against the
 * list would instead make a publisher's typo indistinguishable from a future language.
 *
 * Bounded to 2–8 chars per subtag and at most three subtags so a 4 KB "language code" cannot be
 * stored in a column the room reads on every page.
 */
const LANG_RE = /^[A-Za-z]{2,8}(-[A-Za-z]{2,8}){0,2}$/;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    // §6.3 / §2.4.3 — the is_admin check reads the database row inside `requireAdmin`; a
    // client-supplied admin flag is never consulted, and a non-admin gets 403 from there.
    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;
    const { caller } = auth;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    // §2.4.2's `category`: 「'changelog' | 'announcement'」. Stored, and the client filters on it, so
    // the set is an identity value — the same shared array the filter buttons are built from.
    const category = typeof body.category === "string" ? body.category : "";
    if (NEWS_CATEGORIES.indexOf(category) === -1) {
      return badRequest(`category must be one of: ${NEWS_CATEGORIES.join(", ")}`);
    }

    const rawTitle = body.title;
    if (typeof rawTitle !== "string" || rawTitle.trim() === "") return badRequest("Missing title");
    const title = rawTitle.trim();

    const rawContent = body.content;
    if (typeof rawContent !== "string" || rawContent.trim() === "") {
      return badRequest("Missing content");
    }
    const content = rawContent.trim();

    if (title.length > NEWS_TITLE_MAX) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `title may be at most ${NEWS_TITLE_MAX} characters`);
    }
    if (content.length > NEWS_CONTENT_MAX) {
      return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
        `content may be at most ${NEWS_CONTENT_MAX} characters`);
    }

    // §2.4.2's `lang` defaults to 'zh-CN'; an EMPTY STRING is treated as absent rather than stored,
    // because `''` is a language nothing can match and it would make §2.4.4's fallback the only way
    // the original ever renders — indistinguishable from a missing translation.
    const rawLang = body.lang;
    if (rawLang !== undefined && rawLang !== null && typeof rawLang !== "string") {
      return badRequest("Invalid lang");
    }
    const lang = (typeof rawLang === "string" ? rawLang.trim() : "") || NEWS_DEFAULT_LANG;
    if (!LANG_RE.test(lang)) return badRequest("Invalid lang");

    // §2.4.4's optional translations. Shape-checked to the millimetre, because this is the one
    // field whose value the client indexes by key at render time: a `translations` holding a string
    // instead of an object would not fail here, it would fail inside `newsText` on a reader's
    // machine, and only for the readers of that one language.
    const translations: Record<string, { title: string; content: string }> = {};
    const rawTr = body.translations;
    if (rawTr !== undefined && rawTr !== null) {
      if (typeof rawTr !== "object" || Array.isArray(rawTr)) {
        return badRequest("translations must be an object keyed by language");
      }
      for (const [code, value] of Object.entries(rawTr as Record<string, unknown>)) {
        if (!LANG_RE.test(code)) return badRequest(`Invalid translations key: ${code}`);
        const v = value as { title?: unknown; content?: unknown } | null;
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          return badRequest(`translations.${code} must be { title, content }`);
        }
        if (typeof v.title !== "string" || typeof v.content !== "string") {
          return badRequest(`translations.${code} must be { title, content }`);
        }
        const tTitle = v.title.trim();
        const tContent = v.content.trim();
        if (tTitle === "" || tContent === "") {
          return badRequest(`translations.${code} must not be blank`);
        }
        if (tTitle.length > NEWS_TITLE_MAX || tContent.length > NEWS_CONTENT_MAX) {
          return fail("CONTENT_TOO_LONG", HttpStatus.BAD_REQUEST,
            `translations.${code} exceeds the title/content limits`);
        }
        translations[code] = { title: tTitle, content: tContent };
      }
    }

    // §2.4.2's `is_pinned`. Coerced rather than required: a caller that omits it means 「not pinned」,
    // and `=== true` means `"true"` (a string from a form) does NOT silently pin an entry to the top
    // of everybody's list.
    const isPinned = body.is_pinned === true;

    const { data, error } = await sb
      .from("news")
      .insert({
        author_id: caller.id,
        category,
        title,
        content,
        lang,
        translations,
        is_pinned: isPinned,
      })
      .select("id")
      .single();
    if (error) throw error;

    return json({ ok: true, id: String((data as { id: string }).id) });
  } catch (err) {
    console.error("admin-publish-news failed:", err);
    return internal("Could not publish the news item");
  }
});
