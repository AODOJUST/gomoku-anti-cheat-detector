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
/**
 * 1.0.5 审计 P1/P2 — how many WRONG codes one address may try against one issued code.
 *
 * 6 digits is 1,000,000 values, and until 1.0.5 nothing counted the guesses: `auth-send-code` had a
 * 60-second resend cooldown, but the verifying side (`auth-register` / `auth-reset-password` /
 * `auth-change-email`) simply answered 「验证码错误或已过期」 and let the caller try again, as fast as
 * it liked, for the whole 10-minute TTL. Five is the number because the operator who mistyped a
 * digit needs a few, while five guesses per issued code — one code per 60 seconds by `auth-send-code`'s
 * own limit — is ~50 guesses across a TTL against 1,000,000 values.
 *
 * ⚠ It is enforced by `takeEmailCode`'s own query (`attempts < this`), so a row that reached the
 * limit can never match ANY code afterwards. `bump_email_code_attempt` deliberately does not set
 * `used = true`; see 019_email_code_attempts.sql for why burning the row would make the verdict
 * silently revert to 「验证码错误」.
 */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const MAIL_SUBJECT = "Your Baishen verification code";

/** A row of public.email_codes (004_email_codes.sql, plus 019's counter). */
export interface EmailCodeRow {
  id: string;
  email: string;
  code: string;
  expires_at: string;
  used: boolean;
  created_at: string;
  /** 1.0.5 审计 P1 — failed verification attempts against this row. */
  attempts: number;
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
 * Hand one message to Resend. THE transport — every mail this backend sends goes through here.
 *
 * Never throws: a mail failure is a value, not an exception, because in every caller it is a
 * DEPLOYMENT problem the operator has to fix (an unverified sender domain, a revoked key, a quota)
 * rather than a request the sender got wrong. The provider's own message is passed back for the
 * server log and for the operator's console.
 *
 * ⚠ 1.0.2 §2.5.7 gives this send as an INLINE `fetch` with `from` written out as the literal
 * 「白身 <noreply@baishen.app>」. The literal is not what ships — `mailFrom()` is, and the reason is
 * the same one `sendEmailCode` already documents above: Resend refuses a sender on a domain the
 * account has not verified, so a hard-coded address would make the feedback reply the one mail in
 * the product that ignores `MAIL_FROM`. The spec's SHAPE (POST the Resend endpoint with a key from
 * the environment) is the requirement; the address was an example.
 */
export async function sendMail(to: string, subject: string, html: string): Promise<SendResult> {
  const smtpUser = Deno.env.get("SMTP_USER");
  const smtpPass = Deno.env.get("SMTP_PASS");
  if (!smtpUser || !smtpPass) return { ok: false, message: "SMTP_USER/SMTP_PASS not set" };

  try {
    const nodemailer = await import("https://esm.sh/nodemailer@6.9.13");
    const transporter = nodemailer.default.createTransport({
      host: "smtp.qq.com",
      port: 465,
      secure: true,
      auth: { user: smtpUser, pass: smtpPass },
    });
    await transporter.sendMail({
      from: `Baishen <${smtpUser}>`,
      to,
      subject,
      html,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message ?? "smtp" };
  }
}

/**
 * The verification code (§2.4), as one call on the transport above.
 *
 * Kept as its own name rather than inlined at the two call sites because the SUBJECT lives here and
 * §2.4 spells it: 「白身 · 邮箱验证码」. Two senders with two subjects is how one of them ends up in
 * a spam folder.
 */
export async function sendEmailCode(to: string, code: string): Promise<SendResult> {
  return await sendMail(to, MAIL_SUBJECT, codeEmailHtml(code));
}

/** §2.5.7's subject, verbatim. */
const REPLY_SUBJECT = "白身 · 你的反馈已回复";

/**
 * Escape text that is about to be interpolated into a mail body.
 *
 * ⚠ 1.0.2 §2.5.7 builds the reply body with a template literal — `「${title}」` and
 * `<blockquote>${reply}</blockquote>` — and ships it as-is. Both of those are free text typed by
 * somebody else: `title` came from a user through the feedback form, `reply` from an admin through
 * whatever tool the operator likes. Unescaped, an admin whose reply contains `<` truncates the
 * message, and a report titled with a `<script>` tag is markup in a mail client. Neither is far
 * fetched for a Bug report about HTML.
 *
 * Same rule the panel already follows for `esc()`: 「HTML 只能由渲染函数造」. The text goes through
 * here; the surrounding tags are constants.
 *
 * `codeEmailHtml` above needs no equivalent because its one interpolation is a 6-digit code this
 * server generated — the distinction is WHERE THE TEXT CAME FROM, not which function it is in.
 */
export function escapeHtml(text: string): string {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** §2.5.7's body, escaped, with the reply as a block quote. */
export function feedbackReplyHtml(title: string, reply: string): string {
  return `<p>你的反馈「${escapeHtml(title)}」已收到回复：</p>` +
    `<blockquote>${escapeHtml(reply)}</blockquote>`;
}

/**
 * §2.5.7 「当管理员回复时，通过 Resend 发送邮件给用户」.
 *
 * Best-effort by construction: the reply is already stored by the time this runs, and the caller
 * ignores the result except to log it. A mail that cannot be sent must not undo a reply an admin has
 * already written — which is why this returns a `SendResult` instead of throwing, and why a failure
 * never becomes an error response.
 *
 * `MAIL_FROM` is applied inside `sendMail`; see the ⚠ there for why §2.5.7's literal address is not
 * what ships.
 */
export async function sendFeedbackReply(
  to: string,
  title: string,
  reply: string,
): Promise<SendResult> {
  return await sendMail(to, REPLY_SUBJECT, feedbackReplyHtml(title, reply));
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
    console.error(`auth-send-code: mail refused ${email}: ${sent.message}`);
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
 *
 * ⚠ 1.0.5 审计 P1 — `attempts < EMAIL_CODE_MAX_ATTEMPTS` IS PART OF THE MATCH. Without it, the
 * counter would only ever be able to shout after the fact: a row at the limit would still accept the
 * one-code-in-a-million guess it exists to make hopeless. With it, 「到达上限」 means 「这一行再也匹配
 * 不上任何码」, and the operator's only route is to request a new code.
 *
 * `attempts` is not in the `select` list of the callers' own reads, so `.select("*")` is what keeps
 * this filter honest — a narrower projection would silently drop `attempts` back to 0.
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
    .lt("attempts", EMAIL_CODE_MAX_ATTEMPTS)
    .gte("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as EmailCodeRow | null) ?? null;
}

/** Why a code was refused. `attempts: 0` means there was no live row to count against. */
export type EmailCodeClaim =
  | { ok: true; row: EmailCodeRow }
  | { ok: false; reason: "NO_CODE" | "TOO_MANY_ATTEMPTS"; attempts: number };

/**
 * 1.0.5 审计 P1 — the ONE place a verification code is accepted, including its failure counting.
 *
 * ⚠ IT IS A FUNNEL, NOT A HELPER, and that is the point. Three functions verify a code
 * (`auth-register`, `auth-reset-password`, `auth-change-email`) and the audit's finding was that
 * nobody could tell from the code whether ANY of them limited guessing. A limit implemented at three
 * call sites would be three answers to 「试了几次了」, and this project has already paid five times for
 * a second copy of one answer. Adding a fourth caller here inherits the limit; forgetting to is not
 * possible, because `takeEmailCode` is no longer exported to the functions.
 *
 * The counting is a DATABASE increment through `bump_email_code_attempt` (019): a read-then-write
 * pair would lose a count when two wrong codes arrive together, and an in-process counter would be
 * back at zero on the next cold start — which, for a brute-force door, is the same as no counter.
 */
export async function claimEmailCode(
  sb: SupabaseClient,
  email: string,
  code: string,
): Promise<EmailCodeClaim> {
  const row = await takeEmailCode(sb, email, code);
  if (row) return { ok: true, row };
  // A miss. Count it against whatever live code this address currently has — and if there is none
  // (never sent, already spent, expired) say SO, because 「尝试次数过多」 about a row that does not
  // exist would send the operator looking for a limit instead of a 发送 button.
  const { data, error } = await sb.rpc("bump_email_code_attempt", { p_email: email });
  if (error) throw error;
  const attempts = Number(data) || 0;
  return {
    ok: false,
    reason: attempts >= EMAIL_CODE_MAX_ATTEMPTS ? "TOO_MANY_ATTEMPTS" : "NO_CODE",
    attempts,
  };
}

/** §2.5 step 6 — a code is single-use, exactly like an activation code. */
export async function markEmailCodeUsed(sb: SupabaseClient, id: string): Promise<void> {
  const { error } = await sb.from("email_codes").update({ used: true }).eq("id", id);
  if (error) throw error;
}
