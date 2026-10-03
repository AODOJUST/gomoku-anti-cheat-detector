// auth-check-available -- §2.3 「实时检查唯一性」, for the registration form's ✓/✕.
//
// POST { field: 'username' | 'email', value }
//   -> 200 { available: true | false }
//
// The form calls this on a 400 ms debounce while the operator is still typing, so the answer has to
// be cheap, additive-free, and identical to the one `auth-register` will give a few seconds later.
// That last property is why the two predicates live in `_shared/client.ts` (`usernameTaken` /
// `emailTaken`) rather than being written out here: the form saying 「可用」 and the submit saying
// 「已被占用」 is the exact contradiction §2.3's table invites by listing 唯一检查 in both its 前端
// and 后端 columns.
//
// It is not an oracle worth worrying about: 「alice」 and 「a@b.com」 are public facts about a public
// product, and answering them one at a time is the only way a signup form can work. What it
// deliberately does NOT answer is anything about an account beyond that — no ids, no dates, no
// 「这个邮箱注册过」 with a different shape from 「这个用户名被占了」.

import { serve } from "https://deno.land/std/http/server.ts";
import { handlePreflight } from "../_shared/cors.ts";
import { badRequest, fail, internal, json, methodNotAllowed } from "../_shared/errors.ts";
import {
  emailTaken,
  EMAIL_RE,
  serviceClient,
  USERNAME_RE,
  usernameTaken,
} from "../_shared/client.ts";

serve(async (req: Request): Promise<Response> => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return methodNotAllowed();

  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return badRequest("Invalid JSON body");

    // The field name is validated rather than interpolated: an unvalidated string here would let a
    // caller name any column and turn the endpoint into a read oracle for it.
    const field = body.field;
    if (field !== "username" && field !== "email") {
      return badRequest("field must be 'username' or 'email'");
    }

    if (typeof body.value !== "string") return badRequest("Missing value");
    const value = body.value.trim();

    // A value that could not be registered anyway is reported as BAD_FORMAT rather than as
    // "available" — otherwise the ✓ would light up for something the submit will refuse.
    if (field === "username" && !USERNAME_RE.test(value)) {
      return fail("BAD_USERNAME", 400, "Username must be 2-20 characters with no spaces");
    }
    if (field === "email" && !EMAIL_RE.test(value.toLowerCase())) {
      return fail("BAD_EMAIL", 400, "Invalid email address");
    }

    const sb = serviceClient();
    const taken = field === "username"
      ? await usernameTaken(sb, value)
      : await emailTaken(sb, value.toLowerCase());

    return json({ available: !taken });
  } catch (err) {
    console.error("auth-check-available failed:", err);
    return internal("Could not check availability");
  }
});
