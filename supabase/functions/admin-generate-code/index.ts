// admin-generate-code -- mint a batch of fresh activation codes.
//
// POST { count, note? }   Authorization: Bearer <jwt>
//   -> 200 { codes: [...] }
//
// Admin only: requireAdmin re-verifies the caller's JWT and reads users.is_admin from
// the database on every single call. A client-supplied is_admin is never consulted.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import { requireAdmin, serviceClient } from "../_shared/client.ts";
import { generateCode } from "../_shared/codes.ts";

const MIN_COUNT = 1;
const MAX_COUNT = 100;
const NOTE_MAX = 500;
/** Per-code retry budget when a freshly generated code collides with an existing one. */
const MAX_INSERT_ATTEMPTS = 5;

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const sb = serviceClient();

    const auth = await requireAdmin(req, sb);
    if (auth.response) return auth.response;
    const caller = auth.caller;

    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    const rawCount = body.count;
    if (typeof rawCount !== "number" || !Number.isInteger(rawCount)) {
      return badRequest("count must be an integer");
    }
    if (rawCount < MIN_COUNT || rawCount > MAX_COUNT) {
      return badRequest(`count must be between ${MIN_COUNT} and ${MAX_COUNT}`);
    }

    let note: string | null = null;
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== "string") return badRequest("Invalid note");
      if (body.note.length > NOTE_MAX) return badRequest(`note must be at most ${NOTE_MAX} characters`);
      note = body.note === "" ? null : body.note;
    }

    const created: string[] = [];
    for (let i = 0; i < rawCount; i++) {
      let inserted = false;
      for (let attempt = 0; attempt < MAX_INSERT_ATTEMPTS && !inserted; attempt++) {
        const code = generateCode();
        const { error } = await sb
          .from("activation_codes")
          .insert({ code, issued_by: caller.id, note });
        if (!error) {
          created.push(code);
          inserted = true;
        } else if (error.code !== "23505") {
          // Anything other than a unique collision is a real failure.
          throw error;
        }
        // 23505 => collision (astronomically unlikely); loop and draw a new code.
      }
      if (!inserted) {
        throw new Error("Exhausted retries generating a unique activation code");
      }
    }

    return json({ codes: created });
  } catch (err) {
    console.error("admin-generate-code failed:", err);
    return internal("Could not generate activation codes");
  }
});
