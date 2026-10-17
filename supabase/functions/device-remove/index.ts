// device-remove -- §7.5's 「手动登出某台设备」, in the honest form this backend can offer:
// it releases the SLOT. See `_shared/client.ts`'s block comment for what it does not do and why.
//
// POST { id, deviceId? }              Authorization: Bearer <jwt>
//   -> 200 { ok: true, devices }      `devices` = the caller's list AFTER the delete, same
//                                     projection `profile-get` returns, so the screen repaints
//                                     from the server's answer rather than by editing the copy
//                                     it already had (a delete that silently missed would then
//                                     look like it worked).
//   -> 400 { error: 'BAD_REQUEST' }   `id` is not a uuid. Answering 500 would blame the server for
//                                     a malformed client value, and passing it to PostgREST as a
//                                     filter raises 22P02 — a database error where there is none.
//   -> 403 { error: 'FORBIDDEN' }    the row exists and belongs to somebody else.
//
// ---------------------------------------------------------------------------------------------
// WHY A DELETE ANSWERING 200 FOR A ROW THAT IS NOT THERE
// ---------------------------------------------------------------------------------------------
// Deleting is idempotent and this is a button an operator may press twice (or from two tabs), so
// 「已经没了」 and 「刚刚被我删掉了」 are the same outcome: the thing they asked for is true. Turning
// the second press into an error would be reporting a race as a failure — and the caller has no
// use for the difference, because the list comes back either way.
//
// ⚠ THE ONE CASE THAT IS *NOT* THAT: a row that exists and is NOT the caller's. That is not a
// missing row, it is somebody else's row, and the answer is 403 rather than a cheerful 200 —
// otherwise 「删别人的设备」 would look like it worked, and the only thing distinguishing it from
// success would be a list that did not change.
//
// ---------------------------------------------------------------------------------------------
// WHY THE OWNERSHIP CHECK IS A SEPARATE SELECT RATHER THAN `.eq("user_id", …)` ON THE DELETE
// ---------------------------------------------------------------------------------------------
// A scoped delete alone cannot tell the two zero-row cases apart, which is the distinction above.
// The select is also what makes the refusal correct under the service role: this client BYPASSES
// RLS (`devices_delete_self` in 002 would otherwise have scoped it for us), so 「这行是我的吗」 has
// to be asked or not at all.
//
// ⚠⚠ 1.0.7 续 —— THAT MECHANISM NOW LIVES IN `_shared/client.ts:releaseDeviceRow`, AND THIS FILE NO
// LONGER CONTAINS IT. The reason is the one this repo keeps re-learning: 1.0.7 added a SECOND caller
// for the same judgement (`auth-login`, releasing from the login screen where 「已达上限」 was a dead
// end), and a second caller is how a judgement becomes two copies that drift. So the ownership
// question was moved to the shared block and this function now only turns its three outcomes into
// the three answers documented at the top. `verify-069` pins the logic where it lives and pins that
// this endpoint still routes through it.
// ---------------------------------------------------------------------------------------------

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import {
  badRequest,
  fail,
  HttpStatus,
  internal,
  json,
  methodNotAllowed,
  unauthorized,
} from "../_shared/errors.ts";
import {
  listDevices,
  releaseDeviceRow,
  requireUser,
  serviceClient,
  toPublicDevice,
} from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();
    const auth = await requireUser(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    if (!caller.row) return unauthorized("Account not found");
    if (caller.deletedAt) return unauthorized("Account has been deleted");

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const id = typeof body.id === "string" ? body.id.trim() : "";

    // Same optional, non-authorising value `profile-get` takes: it only decides which row comes
    // back marked `current`.
    const currentDeviceId = typeof body.deviceId === "string"
      ? body.deviceId.trim().slice(0, 256)
      : "";

    // ⚠ THE JUDGEMENT IS NOT MADE HERE. `releaseDeviceRow` owns 「这行是谁的、删不删」 — the same
    // function `auth-login` calls, so the two doors cannot disagree about what a release means.
    // This endpoint's only job is to translate its three outcomes into the three answers above.
    const outcome = await releaseDeviceRow(sb, caller.id, id);
    if (outcome === "invalid") return badRequest("Missing or invalid device id");
    if (outcome === "foreign") return fail("FORBIDDEN", HttpStatus.FORBIDDEN, "Not your device");

    const rows = await listDevices(sb, caller.id);
    return json({ ok: true, devices: rows.map((r) => toPublicDevice(r, currentDeviceId)) });
  } catch (err) {
    console.error("device-remove failed:", err);
    return internal("Could not remove the device");
  }
});
