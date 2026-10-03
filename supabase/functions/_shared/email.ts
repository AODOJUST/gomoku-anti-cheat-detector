// _shared/email.ts -- the email verification code (§2.4) and the Resend transport, in one place.
//
// THREE flows ask the same three questions — 「这个邮箱的验证码是多少」/「他刚才是不是已经要过一个」
// /「用掉它」 — and a second copy of any of them is how 「注册说验证码错误」 and 「改邮箱说验证码错误」
// would start disagreeing about the same row. So the code is generated, mailed, looked up and spent
// here and nowhere else:
//
//   auth-send-code     issues one (rate limit + insert + mail)
//   auth-register      §2.5 step 2 — verifies and (step 6) consumes
//   auth-reset-password §2.6   — verifies and consumes
//   auth-change-email  §3.8    — verifies and consumes
//
// ---------------------------------------------------------------------------------------------
// WHY THE SPEC'S `Math.random()` IS NOT WHAT SHIPS
// ---------------------------------------------------------------------------------------------
// §2.4's sample draws the code with
//
//     String(Math.floor(100000 + Math.random() * 900000))
//
// which is the project's recurring 「规范示例值与公式不符时实现公式」 case in its familiar shape: the
// REQUIREMENT is 「6 位数字验证码」 and the sample is one way to reach it. `Math.random()` is not a
// CSPRNG — V8's xorshift128+ state is recoverable from a handful of outputs, and more to the point
// this is a value that gates ACCOUNT CREATION and PASSWORD RESET. It is drawn from
// `crypto.getRandomValues` below, by rejection sampling so all 900 000 values are equally likely.
// The observable contract (§2.3's 「6 位数字」, §2.4's 「10 分钟内有效」) is unchanged.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { fail, HttpStatus } from "./errors.ts";

/** §2.4 「10 分钟内有效」 — the TTL the mail body quotes and the query filters on. */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_TTL_MINUTES = 10;
/** §2.4 step 1 「同一邮箱 60 秒内只能发一次」. */
export const EMAIL_CODE_RESEND_MS = 60 * 1000;
/** §2.3 「6 位数字」 — the same shape `extension/auth.js`'s EMAIL_CODE_RE carries. */
export const EMAIL_CODE_RE = /^\d{6}$/;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAIL_SUBJECT = "Your Baishen verification code";

/** A row of public.email_codes (004_email_codes.sql). */
export interface EmailCodeRow {
  id: string;
  email: string;
  code: string;
  expires_at: string;
  used: boolean;
  created_at: string;
}

/** The smallest and largest code §2.3 allows: 100000–999999, i.e. 900 000 values. */
const CODE_MIN = 100000;
const CODE_SPAN = 900000;

/**
 * A uniform 6-digit code.
 *
 * Rejection sampling rather than `% CODE_SPAN` on a raw 32-bit draw: `2^32 % 900000 !== 0`, so the
 * fold biases the low end of the range. Values at or above the biased tail are discarded and
 * redrawn — the same technique `_shared/codes.ts` uses for the activation alphabet, and for the
 * same reason.
 */
export function generateEmailCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x100000000 / CODE_SPAN) * CODE_SPAN; // exclusive upper bound
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return String(CODE_MIN + (value % CODE_SPAN));
}

/**
 * §2.4's `from`, with the operator able to override it.
 *
 * It has to be overridable: Resend refuses to send from a domain the account has not verified, and
 * `baishen.app` is verified by whoever runs the product, not by whoever clones this repository. A
 * deployment that has not set `MAIL_FROM` therefore gets the spec's literal address and a clear
 * `EMAIL_FAILED` from Resend instead of a silent no-op.
 */
export function mailFrom(): string {
  const configured = Deno.env.get("MAIL_FROM");
  return configured && configured.trim() !== "" ? configured.trim() : "白身 <noreply@baishen.app>";
}

/** §2.4's body, with the TTL read from the constant that the query also filters on. */
export function codeEmailHtml(code: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your verification code</title>
</head>
<body style="margin:0;padding:0;background:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e6e8eb;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f1115;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#171a21;border-radius:12px;overflow:hidden;">
        <tr>
          <td style="padding:32px 40px 8px;">
            <div style="font-size:20px;font-weight:700;letter-spacing:0.5px;">Baishen <span style="color:#7aa2ff;">·</span> 白身</div>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px 0;font-size:16px;line-height:1.5;">
            Your verification code is
          </td>
        </tr>
        <tr>
          <td style="padding:16px 40px;">
            <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#ffffff;background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;padding:16px 0;text-align:center;">${code}</div>
          </td>
        </tr>
        <tr>
          <td style="padding:0 40px 24px;font-size:14px;line-height:1.6;color:#9aa3b2;">
            This code expires in ${EMAIL_CODE_TTL_MINUTES} minutes. If you didn't request it, you can safely ignore this email.
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;border-top:1px solid #232733;font-size:12px;color:#6b7280;">
            © Baishen · Gomoku anti-cheat detector
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export type SendResult = { ok: true } | { ok: false; message: string };

/**
 * Hand the code to Resend.
 *
 * Never throws: a mail failure is an `EMAIL_FAILED` answer, not a 500, because it is a DEPLOYMENT
 * problem the operator has to fix (an unverified sender domain, a revoked key, a quota) and the
 * generic catch-all would report it as 「稍后再试」 — which is the one sentence that never helps.
 * The provider's own message is passed along for the server log and for the operator's console.
 */
export async function sendEmailCode(to: string, code: string): Promise<SendResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, message: "RESEND_API_KEY is not set" };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: mailFrom(),
        to,
        subject: MAIL_SUBJECT,
        html: codeEmailHtml(code),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, message: `Resend ${res.status}: ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? "network" };
  }
}

export type IssueResult =
  | { ok: true; id: string }
  | { ok: false; response: Response };

/**
 * §2.4 steps 1–4: refuse a repeat, draw a code, store it, mail it.
 *
 * Two details worth stating because they are choices, not transcription:
 *
 *   * The rate-limit probe is `.order(created_at desc).limit(1).maybeSingle()`, not §2.4's
 *     `.single()`. `.single()` raises PGRST116 when it matches no row, which would turn 「还没发过」
 *     into a 500 — and the pseudocode's own comment expects a falsy `recent`, not a throw.
 *
 *   * A FAILED SEND DELETES THE ROW IT JUST WROTE. Otherwise a Resend outage would leave a code in
 *     the table that the operator never received, and the 60-second rate limit would then refuse
 *     the retry the operator is about to make. The mail half failing must not cost the operator a
 *     minute of their life.
 */
export async function issueEmailCode(sb: SupabaseClient, email: string): Promise<IssueResult> {
  const since = new Date(Date.now() - EMAIL_CODE_RESEND_MS).toISOString();
  const { data: recent, error: recentError } = await sb
    .from("email_codes")
    .select("id")
    .eq("email", email)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (recentError) throw recentError;
  if (recent) {
    return {
      ok: false,
      response: fail("RATE_LIMITED", HttpStatus.CONFLICT, "A code was sent less than 60 seconds ago"),
    };
  }

  const code = generateEmailCode();
  const { data: inserted, error: insertError } = await sb
    .from("email_codes")
    .insert({ email, code, expires_at: new Date(Date.now() + EMAIL_CODE_TTL_MS).toISOString() })
    .select("id")
    .single();
  if (insertError) throw insertError;
  const id = String((inserted as { id: string }).id);

  const sent = await sendEmailCode(email, code);
  if (!sent.ok) {
    // Roll the row back so the retry is not rate-limited by a mail that never arrived.
    const { error: undoError } = await sb.from("email_codes").delete().eq("id", id);
    if (undoError) console.error("email_codes rollback failed:", undoError);
    console.error(`auth-send-code: Resend refused ${email}: ${sent.message}`);
    return {
      ok: false,
      response: fail("EMAIL_FAILED", HttpStatus.INTERNAL_SERVER_ERROR,
        "Could not send the verification email"),
    };
  }

  return { ok: true, id };
}

/**
 * §2.5 step 2 / §2.6 / §3.8: the newest UNUSED, UNEXPIRED row matching (email, code).
 *
 * Returns the row rather than a boolean because every caller needs its `id` to spend it, and
 * returning it here is what keeps 「查一次」 and 「用掉它」 from being two different queries that
 * disagree about which row they mean.
 */
export async function takeEmailCode(
  sb: SupabaseClient,
  email: string,
  code: string,
): Promise<EmailCodeRow | null> {
  const { data, error } = await sb
    .from("email_codes")
    .select("*")
    .eq("email", email)
    .eq("code", code)
    .eq("used", false)
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as EmailCodeRow | null) ?? null;
}

/** §2.5 step 6 — a code is single-use, exactly like an activation code. */
export async function markEmailCodeUsed(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from("email_codes").update({ used: true }).eq("id", id);
  if (error) throw error;
}
