// profile-get -- the caller's own profile, and (1.0.3) another member's 他人主页.
//
// GET  or  POST {}                    Authorization: Bearer <jwt>
//   -> 200 { user, sampleCount, badges, achievements, accuracy, friends }
//
// POST { user_id }                    Authorization: Bearer <jwt>
//   -> 200 { user, sampleCount, status }          §1.3's 他人主页
//   -> 404 { error: 'TARGET_NOT_FOUND' }          no such account, banned, or soft-deleted
//
// Reads only the caller's own data on the first form: sampleCount is a count over their
// non-deleted samples, and RLS would enforce the same scope even if this ran with the user's
// token instead of the service role.
//
// ---------------------------------------------------------------------------------------------
// 1.0.3 §1.3 — WHY THE 他人主页 GOES THROUGH HERE RATHER THAN PostgREST
// ---------------------------------------------------------------------------------------------
// Everything on §1.3.1's card except 「样本库：42 个」 is a column of `users`, and 011 §3 grants the
// client a narrowed `select` so it could be read straight off PostgREST. The COUNT is what settles
// it: `samples` is per-user under `samples_select_self` (002_rls.sql), so counting somebody else's
// rows is exactly what RLS forbids — and the alternatives were worse than an extra branch here:
//
//   * a policy admitting every member to `samples` — which publishes the ROWS to draw one NUMBER,
//     and those rows are a player's own games;
//   * a `security definer` counting function reachable over `/rest/v1/rpc` — a second outbound
//     route in `cloud.js` (which 1.0.0 narrowed to `call`/`rest` so that 「路由只有一个门」), and a
//     second place that decides what 「某人的样本数」 means.
//
// ⇒ the endpoint that already answers 「这是谁」 answers it for one more viewer. The response shape
// differs on purpose (see `toForeignUser`): the four reserved fields are the OWNER's dashboard and
// are not returned about anybody else, so a client cannot start rendering somebody's 徽章 by
// pointing this at their id.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  fail,
  HttpStatus,
  internal,
  json,
  methodNotAllowed,
  unauthorized,
} from "../_shared/errors.ts";
import {
  requireUser,
  serviceClient,
  toForeignUser,
  toPublicUser,
} from "../_shared/client.ts";// The one implementation of §3.2.1's three states, so a profile's dot is spelled the same way the
// friend list's and the room's are.
import { presenceState } from "../_shared/community.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST" && req.method !== "GET") {
    // Both verbs are allowed here; anything else is a client bug.
    return methodNotAllowed();
  }
  try {
    // Inside the try: `serviceClient()` reads `Deno.env` and throws when the service-role key is
    // absent, which must reach the catch as a 500 rather than as an unhandled rejection.
    const sb = serviceClient();

    // §1.3.1's card is readable by 「已激活」 AND by 未激活 (§1.8.1 「查看他人主页 ✅ 新增」), so the
    // gate is requireUser and nothing more. The WRITE half of a profile (§1.3.2's 添加好友 / 举报)
    // is where activation and the mute are checked, in those Functions.
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    if (!caller.row) return unauthorized("Account not found");
    if (caller.deletedAt) return unauthorized("Account has been deleted");

    // A GET cannot carry a body, so the target only ever arrives on the POST form. That is the same
    // split the two verbs already had (`GET` is what the 我的 page's first paint uses).
    const body = req.method === "POST"
      ? await req.json().catch(() => null) as Record<string, unknown> | null
      : null;
    const targetId = (body && typeof body.user_id === "string") ? body.user_id.trim() : "";

    // ---------------------------------------------------------------------------------------
    // §1.3 他人主页
    // ---------------------------------------------------------------------------------------
    // ⚠ `user_id` EQUAL TO THE CALLER IS THE OWN-PROFILE PATH, not a 404 or a special case. The
    // client's avatar menu offers 「访问主页」 on every avatar including one's own (§1.1.1), and
    // answering 「不能看自己的主页」 would be a rule nobody meant.
    if (targetId && targetId !== caller.id) {
      const { data: target, error: targetError } = await sb
        .from("users")
        .select("*")
        .eq("id", targetId)
        .maybeSingle();
      if (targetError) throw targetError;

      // Same three conditions `users_select_public` (011 §3) applies to the PostgREST route, so the
      // Function route cannot answer about an account RLS would hide.
      if (!target || target.deleted_at || target.is_banned === true) {
        return fail("TARGET_NOT_FOUND", HttpStatus.NOT_FOUND, "No such account");
      }

      const { count, error: countError } = await sb
        .from("samples")
        .select("id", { count: "exact", head: true })
        .eq("user_id", targetId)
        .is("deleted_at", null);
      if (countError) throw countError;

      // 1.0.5 安全审计 P0-2/P0-3 — the two per-reader rules, asked ONCE and answered by the one
      // definition of 「是不是好友」 (018's `are_friends`, a `security definer` SQL function, so
      // `_shared/client.ts` and the `user_directory` view cannot disagree about the pair test).
      // ⚠ `.rpc` needs the service role here: 018 revokes EXECUTE from `authenticated` on purpose —
      // 「谁是某人的好友」 must not become a question any client can ask about any pair.
      const { data: isFriend, error: friendError } = await sb
        .rpc("are_friends", { a: caller.id, b: targetId });
      if (friendError) throw friendError;

      const row = target as Parameters<typeof toForeignUser>[0];
      const now = Date.now();
      return json({
        user: toForeignUser(row, { self: false, friend: isFriend === true }),
        sampleCount: count ?? 0,
        // §1.3.1's 「[当前状态] 🟢 在线」, computed on the server so that §3.2.1's arithmetic is the
        // shared block's one function rather than a second copy in the view. ⚠ It is a
        // POINT-IN-TIME answer: the 他人主页 keeps it live afterwards from the Realtime presence
        // channel (§3.2.2) and this is what is drawn before that channel reports.
        status: presenceState(row.last_seen_at, row.manual_status, now),
      });
    }

    // ---------------------------------------------------------------------------------------
    // the caller's own profile
    // ---------------------------------------------------------------------------------------
    // 1.0.5 §三.1 — §3.2.2's 游戏统计 needs three more numbers than 1.0.3 returned: 回放存档
    // (archives), 检测对局 (the same count — §3.2.2's own table says 「同上」) and 好友
    // (accepted friendships). They are counted HERE rather than read off a view for the same reason
    // `sampleCount` already was: these are the OWNER's rows, and `samples_select_self` /
    // `archives_select_self` are exactly the policies a client-side count would have to fight.
    const { count, error: countError } = await sb
      .from("samples")
      .select("id", { count: "exact", head: true })
      .eq("user_id", caller.id)
      .is("deleted_at", null);
    if (countError) throw countError;

    const { count: archiveCount, error: archiveError } = await sb
      .from("archives")
      .select("id", { count: "exact", head: true })
      .eq("user_id", caller.id)
      .is("deleted_at", null);
    if (archiveError) throw archiveError;

    // §1.2.1 stores the pair un-ordered, so an accepted friendship is a row with EITHER column
    // equal to the caller. `or` is PostgREST's own filter and is written here once.
    const { count: friendCount, error: friendError } = await sb
      .from("friendships")
      .select("id", { count: "exact", head: true })
      .eq("status", "accepted")
      .or(`user_a.eq.${caller.id},user_b.eq.${caller.id}`);
    if (friendError) throw friendError;

    // §3.2.4's 徽章 — the `badges` table has existed since 001 and `admin-grant-badge` has been able
    // to write it since 1.0.0; 1.0.5 is the release that DRAWS it. Returned as rows so the view can
    // map each `badge_type` to its own label/glyph; an unknown type still reaches the client, which
    // renders it as a plain chip rather than dropping it (the table has no CHECK on the column —
    // 001 left `badge_type` free text, so 「未知类型」 is a real possibility and not a bug).
    const { data: badgeRows, error: badgeError } = await sb
      .from("badges")
      .select("badge_type,granted_at")
      .eq("user_id", caller.id)
      .order("granted_at", { ascending: true });
    if (badgeError) throw badgeError;

    // §5.2 of the product spec reserves achievements / accuracy for a later release. They are
    // returned as empty placeholders -- NOT omitted -- because the client renders each one greyed
    // out with a "coming soon" label and distinguishes "reserved, empty" from "field missing".
    //
    // ⚠ 1.0.3 SHIPS FRIENDS, AND THE `friends` PLACEHOLDER IS STILL EMPTY ON PURPOSE. The friend LIST
    // is read by the 好友列表 view straight off `friendships` + `users` under RLS (011 §6), because
    // that screen needs the other party's name, avatar, remark and status dot — i.e. it needs the
    // rows, and it joins two tables to get them. Filling this field too would be a SECOND answer to
    // 「我的好友是谁」, which is the defect this repo has paid for six times. `friendCount` above is a
    // NUMBER, which is what §3.2.2's 游戏统计 row asks for and is not a second list.
    return json({
      user: toPublicUser(caller.row),
      sampleCount: count ?? 0,
      archiveCount: archiveCount ?? 0,
      friendCount: friendCount ?? 0,
      badges: (badgeRows ?? []).map((b) => ({
        type: String((b as { badge_type?: unknown }).badge_type ?? ""),
        grantedAt: (b as { granted_at?: unknown }).granted_at ?? null,
      })),
      achievements: [],
      accuracy: null,
      friends: [],
    });
  } catch (err) {
    console.error("profile-get failed:", err);
    return internal("Could not load profile");
  }
});
