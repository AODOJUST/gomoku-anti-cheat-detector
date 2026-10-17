/* crypto.js — 1.0.5 §一.1.4. AES-256-GCM for the account tokens this extension parks on disk.
 *
 * ONLY TWO CALLERS EXIST: `auth.js` seals/unseals the JWTs of the accounts it remembers for
 * 「切换账号」. Nothing else here is encrypted, and that is deliberate — the goal §1.1.4 states is
 * 「提高门槛，不是安全边界」: an attacker who can read `chrome.storage.local` can also read this
 * script and the device key beside it. What the encryption buys is that a leaked storage dump, a
 * cloud-synced browser profile, or a backup archive no longer contains a *usable* bearer token.
 *
 * ⚠⚠ `deviceKey` IS EXACTLY 32 CHARACTERS, NOT 「32 随机字节」. §1.1.4's sketch does
 * `crypto.subtle.importKey('raw', enc.encode(deviceKey), 'AES-GCM', …)`, i.e. it TextEncoder-encodes
 * the key STRING and hands the bytes straight to AES. GCM accepts only 16 / 24 / 32-byte keys, so a
 * base64 of 32 random bytes (43 characters) throws
 *     DataError: AES key data must be 128, 192 or 256 bits
 * and every seal/unseal in the release would fail at runtime. The key therefore IS the 32-character
 * string — 32 ASCII characters are 32 bytes, which is where 「256」 in AES-256-GCM comes from. The
 * generator lives in storage.js (`getDeviceKey()`), which is the only module allowed to touch
 * `chrome.storage`; this file is pure and takes the key as an argument, exactly as §1.1.4 writes it.
 *
 * ⚠ The IV is 12 bytes and RANDOM PER CALL, never reused, never derived from the plaintext. GCM's
 * security collapses on nonce reuse under one key (an attacker XORs the two ciphertexts and gets
 * the XOR of the plaintexts), so the IV is generated inside the seal, next to nothing else, and is
 * carried beside the ciphertext rather than recomputed. 12 is GCM's canonical length — the one
 * value that needs no extra KDF pass over the derived nonce.
 */
(function (g) {
  'use strict';

  var IV_BYTES = 12;

  function subtle() {
    try { return (g.crypto && g.crypto.subtle) || null; } catch (e) { return null; }
  }

  /** False in a stripped harness (and on any non-secure context). `auth.js` reads it and refuses to
   *  remember a second account rather than storing a token in the clear. */
  function isAvailable() { return !!subtle(); }

  function randBytes(n) {
    var out = new Uint8Array(n);
    g.crypto.getRandomValues(out);
    return out;
  }

  async function importKey(deviceKey, usage) {
    var s = subtle();
    if (!s) throw new Error('NO_WEBCRYPTO');
    // ⚠ `'raw'` is argument #1 and it is NOT optional — omit it and the call throws
    // `importKey: 5 arguments required, but only 4 present`. (1.0.5 shipped exactly that bug into
    // hook.js's channel HMAC, where every signature silently failed and only the behaviour harness
    // caught it. Static assertions cannot see an argument count.)
    return s.importKey('raw', new TextEncoder().encode(String(deviceKey)), 'AES-GCM', false, [usage]);
  }

  function plainBytes(token) { return new TextEncoder().encode(String(token == null ? '' : token)); }

  /**
   * §1.1.4's `encryptToken`. Returns PLAIN ARRAYS, not typed arrays: this value goes into
   * `chrome.storage.local`, which is JSON-serialised, and a `Uint8Array` survives that trip as
   * `{"0":12,"1":…}` — readable by `new Uint8Array(obj)` only by accident of key ordering.
   *
   * The IV is returned the same way, beside the ciphertext, because `decryptToken` needs it and it
   * is not recoverable from anything else.
   */
  async function encryptToken(token, deviceKey) {
    var iv = randBytes(IV_BYTES);
    var key = await importKey(deviceKey, 'encrypt');
    var cipher = await subtle().encrypt({ name: 'AES-GCM', iv: iv }, key, plainBytes(token));
    return { iv: Array.prototype.slice.call(iv), data: Array.prototype.slice.call(new Uint8Array(cipher)) };
  }

  /**
   * §1.1.4's `decryptToken`. Returns `null` — not a throw — when the envelope is malformed or the
   * MAC does not verify, because both mean the same thing to the only caller: 「这个 token 拿不出来
   * 了」, which `auth.js` answers by asking for the password. A throw would make a key rotation or a
   * half-written profile look like a crash in the middle of the account list.
   *
   * A GCM tag failure is also the ONE honest signal that the device key changed (storage cleared,
   * another profile imported), and it is intentionally not distinguishable from corruption: telling
   * them apart would require storing a fingerprint of the key, which is a second copy of the secret.
   */
  async function decryptToken(envelope, deviceKey) {
    if (!envelope || typeof envelope !== 'object') return null;
    if (!Array.isArray(envelope.iv) || !Array.isArray(envelope.data)) return null;
    if (envelope.iv.length !== IV_BYTES) return null;
    try {
      var key = await importKey(deviceKey, 'decrypt');
      var plain = await subtle().decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(envelope.iv) },
        key,
        new Uint8Array(envelope.data));
      return new TextDecoder().decode(plain);
    } catch (e) {
      return null;
    }
  }

  g.GMCrypto = {
    available: isAvailable,
    encryptToken: encryptToken,
    decryptToken: decryptToken,
    IV_BYTES: IV_BYTES,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = g.GMCrypto;
})(typeof window !== 'undefined' ? window : self);
