/* build/package.js — §8.4's last step: zip build/release/ into a loadable archive.
 *
 * WHY THIS DOES NOT SHELL OUT
 *   The alternative is `python _tools/_pack-zip.py`, and that is what the hand-run releases used —
 *   but `_tools/` is deliberately NOT in the git repository (the repository tracks the extension
 *   itself), so a build script that depends on it works on exactly one machine. §11.3 asks for a
 *   `build/package.js` that a contributor can run after `npm install && npm run build`, so the zip
 *   writer lives here, in ~60 lines, with no dependency at all.
 *
 * WHY THE DIRECTORY ENTRIES ARE WRITTEN EXPLICITLY
 *   A bare file list makes some unzip UIs flatten `locale/` and `engine/` into the root. The
 *   extension is loaded UNPACKED, so a flattened tree is not a cosmetic problem — manifest.json's
 *   `locale/zh-CN.js` and the engine's `rapfi.data` would 404 and the extension would come up
 *   half-dead. The original hand-made 0.5.x zips listed the directories, and so does this.
 *
 * WHY `manifest.json` MUST BE AT THE ARCHIVE ROOT
 *   The extension is loaded from the archive root, so the archive's contents are the extension
 *   directory's contents — NOT an `extension/` folder inside the zip. Getting this wrong produces
 *   an archive that Chrome refuses with "Manifest file is missing or unreadable".
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ------------------------------------------------------------------------------------------------
// CRC-32 (IEEE 802.3), the checksum every zip entry carries. Built once, lazily: the table is 1 KB
// and most invocations of this file are `--dry-run`.
// ------------------------------------------------------------------------------------------------
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ t[(c ^ buf[i]) & 0xFF];
  return (c ^ (-1)) >>> 0;
}

/** MS-DOS date/time, which is what the zip format stores (2-second resolution, 1980 epoch). */
function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
  };
}

/**
 * Write a zip from a list of {rel, abs, dir} entries.
 *
 * Deflate rather than store: the payload is 40 MB of WASM and `.data`, and the engine binaries do
 * not compress, but the locale tables and the obfuscated JS do. compresslevel 6 is zlib's default
 * and the same level `_pack-zip.py` used, so archive sizes stay comparable across releases.
 */
function zipFromEntries(entries, outFile, opts) {
  const o = opts || {};
  const when = dosDateTime(o.date || new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  const push = (buf) => { chunks.push(buf); offset += buf.length; };

  entries.forEach((e) => {
    const nameBuf = Buffer.from(e.rel, 'utf8');
    if (e.dir) {
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6);
      h.writeUInt16LE(0, 8);          // method 0 = stored
      h.writeUInt16LE(when.time, 10); h.writeUInt16LE(when.date, 12);
      h.writeUInt32LE(0, 14); h.writeUInt32LE(0, 18); h.writeUInt32LE(0, 22);
      h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
      central.push({ name: nameBuf, crc: 0, comp: 0, raw: 0, off: offset, method: 0, time: when.time, date: when.date, dir: true });
      push(Buffer.concat([h, nameBuf]));
      return;
    }
    const raw = fs.readFileSync(e.abs);
    const deflated = zlib.deflateRawSync(raw, { level: 6 });
    const crc = crc32(raw);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 6);
    h.writeUInt16LE(8, 8);          // method 8 = deflate
    h.writeUInt16LE(when.time, 10); h.writeUInt16LE(when.date, 12);
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(deflated.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    central.push({ name: nameBuf, crc: crc, comp: deflated.length, raw: raw.length, off: offset, method: 8, time: when.time, date: when.date, dir: false });
    push(Buffer.concat([h, nameBuf, deflated]));
  });

  const cdStart = offset;
  central.forEach((c) => {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);   // version made by
    h.writeUInt16LE(20, 6);   // version needed
    h.writeUInt16LE(0, 8);
    h.writeUInt16LE(c.method, 10);
    h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.comp, 20);
    h.writeUInt32LE(c.raw, 24);
    h.writeUInt16LE(c.name.length, 28);
    h.writeUInt16LE(0, 30); h.writeUInt16LE(0, 32);
    h.writeUInt16LE(0, 34);  // disk number
    h.writeUInt16LE(0, 36);  // internal attrs
    h.writeUInt32LE(c.dir ? 0x10 : 0, 38);  // external attrs: the directory bit
    h.writeUInt32LE(c.off, 42);
    push(Buffer.concat([h, c.name]));
  });
  const cdSize = offset - cdStart;

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  push(eocd);

  fs.writeFileSync(outFile, Buffer.concat(chunks));
  return { entries: entries.length, bytes: offset };
}

/**
 * Walk a release directory into zip entries, writing the directory entries explicitly.
 *
 * The name list is sorted, so two builds of the same tree produce byte-identical archives — which
 * is what makes "did the build change anything?" a question with an answer.
 */
function collect(releaseDir) {
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name !== '.git')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    entries.forEach((e) => {
      const abs = path.join(dir, e.name);
      const rel = path.relative(releaseDir, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        out.push({ rel: rel + '/', abs: abs, dir: true });
        return walk(abs);
      }
      out.push({ rel: rel, abs: abs, dir: false });
    });
  };
  walk(releaseDir);
  return out;
}

module.exports = { crc32: crc32, dosDateTime: dosDateTime, zipFromEntries: zipFromEntries, collect: collect };

if (require.main === module) {
  const EXT = path.join(__dirname, '..');
  const RELEASE = path.join(__dirname, 'release');
  if (!fs.existsSync(RELEASE)) {
    console.error('build/package.js: run build/copy-static.js and build/obfuscate.js first (no ' + RELEASE + ')');
    process.exit(1);
  }
  let ver = process.argv[2];
  if (!ver) ver = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
  const outFile = process.argv[3] || path.join(__dirname, 'baishen-v' + ver + '.zip');
  const r = zipFromEntries(collect(RELEASE), outFile);
  console.log(outFile + '  (' + r.entries + ' entries, ' + (r.bytes / 1048576).toFixed(1) + ' MB)');
}
