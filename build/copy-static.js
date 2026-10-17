/* build/copy-static.js — §8.4: everything that must NOT be touched, moved into build/release/.
 *
 * The release tree is not "the source tree minus the .js files" — it is an EXPLICIT exclusion list
 * over the source tree, because the failure mode of the other direction is silent: a new dev-only
 * directory that nobody remembered to filter would be published to whoever installs the unpacked
 * extension, and the first sign of it is a reviewer asking why the source repo is in the zip.
 *
 * The exclusion list has three kinds of entries, and they are kept apart on purpose:
 *
 *   DEV-ONLY     build/, node_modules/, package.json, package-lock.json — the obfuscation toolchain
 *   NOT-CLIENT   supabase/ (migrations + Edge Functions) and docs/ (operator and user guides). These
 *                are NOT secrets — this repository is public, so the schema and the RLS policies are
 *                readable on GitHub either way, and pretending otherwise would be the kind of
 *                security theatre §8.5 refuses to engage in. They are excluded because they are not
 *                part of the CLIENT: an unpacked install is a directory a user opens, and finding
 *                PostgreSQL migration files in it invites the reasonable question of whether the
 *                extension is doing something it did not mention.
 *   NEVER        .git/ — `extension/` IS the repository root, so a naive copy ships the entire
 *                history, including every secret ever committed by accident. That one IS secrecy.
 *
 * Sourcemaps are written by obfuscate.js to build/sourcemaps/ (§8.4 「sourcemap 上传到私密位置」),
 * which is inside `build/`, so they are excluded by the first rule rather than by a rule of their
 * own — one fewer thing to remember.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const EXCLUDE_DIRS = ['build', 'node_modules', '.git', 'supabase', 'docs'];
const EXCLUDE_FILES = ['package.json', 'package-lock.json'];

/**
 * Collect the files to copy, as {rel, abs} pairs. `rel` always uses '/' so the callers can print
 * it (and so a zip entry name is platform-independent).
 *
 * A .js file is copied here ONLY if the strategy map leaves it verbatim — obfuscate.js writes the
 * rest. Both scripts therefore have to agree, and they agree through `levelFor()` rather than by
 * each keeping its own list.
 */
function collect(srcDir, opts) {
  const o = opts || {};
  const obf = o.strategy || require('./obfuscate.js');
  const out = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const abs = path.join(dir, e.name);
      const rel = path.relative(srcDir, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (EXCLUDE_DIRS.indexOf(e.name) >= 0) return;
        return walk(abs);
      }
      if (EXCLUDE_FILES.indexOf(rel) >= 0) return;
      if (/\.js$/.test(e.name) && obf.levelFor(rel)) return;  // obfuscate.js writes it
      if (/\.map$/.test(e.name)) return;                      // a stray sourcemap never ships
      out.push({ rel: rel, abs: abs });
    });
  };
  walk(srcDir);
  return out;
}

function run(srcDir, outDir, opts) {
  const o = opts || {};
  const list = collect(srcDir, o);
  if (!o.dryRun) {
    fs.mkdirSync(outDir, { recursive: true });
    list.forEach((e) => {
      const dest = path.join(outDir, e.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      // Explicitly NOT chmod +x, NOT symlink-preserving: these are data files for a browser.
      fs.copyFileSync(e.abs, dest);
    });
  }
  return list;
}

module.exports = { EXCLUDE_DIRS: EXCLUDE_DIRS, EXCLUDE_FILES: EXCLUDE_FILES, collect: collect, run: run };

if (require.main === module) {
  const EXT = path.join(__dirname, '..');
  const OUT = path.join(__dirname, 'release');
  const dry = process.argv.indexOf('--dry-run') >= 0;
  const list = run(EXT, OUT, { dryRun: dry });
  console.log('copy-static: ' + list.length + ' files' + (dry ? ' (dry run)' : ''));
  list.forEach((e) => console.log('  ' + e.rel));
}
