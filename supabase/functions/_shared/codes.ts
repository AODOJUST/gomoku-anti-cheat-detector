// _shared/codes.ts -- activation-code generation and shape validation.
//
// Wire format: BS-XXXX-XXXX-XXXX-XXXX
//   prefix "BS", then 16 Base32 characters grouped 4x4 with hyphens.
//   (The literal example string is 22 characters long; the spec's prose says 23, which
//   double-counts one separator. We follow the literal pattern, since that is what the
//   extension validates against.)
//
// The alphabet deliberately omits the confusable glyphs I, O, 0 and 1.

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_PREFIX = "BS";
export const CODE_GROUPS = 4;
export const CODE_GROUP_LENGTH = 4;
export const CODE_BODY_LENGTH = CODE_GROUPS * CODE_GROUP_LENGTH; // 16

/** Matches the exact wire format, uppercase only. */
export const CODE_REGEX = /^BS-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** Trim + uppercase so a hand-typed code still matches. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** True when `raw` is a syntactically valid activation code. */
export function isValidCodeShape(raw: string): boolean {
  return CODE_REGEX.test(normalizeCode(raw));
}

/**
 * Draw `count` uniform characters from CODE_ALPHABET.
 *
 * The product spec's sample code used `bytes[i] % alphabet.length`, which biases the
 * early characters whenever 256 is not a clean multiple of the alphabet size. This
 * implementation uses rejection sampling instead: any byte that falls in the biased
 * tail `256 - (256 % length)` is discarded and redrawn, so every character is exactly
 * uniform.
 *
 * Note: the current alphabet is 32 characters and 256 % 32 === 0, so the rejection
 * range is empty today -- the loop simply documents and preserves correctness if the
 * alphabet is ever changed to a length that does not divide 256.
 */
function randomChars(count: number): string {
  const alphabetLength = CODE_ALPHABET.length;
  const rejectionThreshold = 256 - (256 % alphabetLength); // exclusive upper bound
  const out: string[] = [];
  const buffer = new Uint8Array(count);

  while (out.length < count) {
    crypto.getRandomValues(buffer);
    for (let i = 0; i < buffer.length && out.length < count; i++) {
      const byte = buffer[i];
      if (byte >= rejectionThreshold) {
        // Biased value -- reject and redraw rather than folding it in.
        continue;
      }
      out.push(CODE_ALPHABET[byte % alphabetLength]);
    }
  }

  return out.join("");
}

/**
 * Produce one activation code in BS-XXXX-XXXX-XXXX-XXXX form.
 */
export function generateCode(): string {
  const body = randomChars(CODE_BODY_LENGTH);
  const groups: string[] = [];
  for (let i = 0; i < CODE_BODY_LENGTH; i += CODE_GROUP_LENGTH) {
    groups.push(body.slice(i, i + CODE_GROUP_LENGTH));
  }
  return `${CODE_PREFIX}-${groups.join("-")}`;
}
