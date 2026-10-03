/* build/obfuscate.js — §8 混淆：三层配置 + 逐文件策略 + 两条 MV3 硬闸门.
 *
 * §8.1 asks for a per-file strategy (核心重度 / 数据结构中度 / UI 轻度 / 桥接不动), §8.2 gives the
 * two configs, §8.3 lists the options that MUST be off and the two that MUST stay on. This file is
 * the machine-readable form of all three, so the build cannot drift from the 定稿 by someone
 * editing a flag in passing.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THERE ARE THREE CONFIGS AND NOT TWO
 * ---------------------------------------------------------------------------------------------
 * §8.2 defines `heavy` and `light`, and then §8.1's table — the table is what actually assigns the
 * files — marks 开局表 / 数据结构 / 翻译表 / 站点配置 as **中度** and §8.2's strategy map refers to
 * `'medium'`. There is no `medium` in §8.2. That is the 「规范示例值与公式不符」 case this project
 * implements the FORMULA for and writes down: medium is defined here as the tier between the two —
 * the string array from heavy, the control-flow work from light — and the disagreement is recorded
 * in CHANGELOG.md and in verify-062 rather than being resolved by picking whichever was easier.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE BRIDGES ARE NOT IN THE MAP AT ALL
 * ---------------------------------------------------------------------------------------------
 * `hook.js` runs in the page's MAIN world and is injected BY PATH from manifest.json, and
 * `worker.js` is loaded by `importScripts` from a string the engine builds at runtime. Renaming
 * anything inside either one, or renaming the file, breaks the ONLY link between the extension and
 * the page — and it breaks it silently, at runtime, on a site we do not control. §8.1 says
 * 「不混淆」 for both. They are not "light": they are absent from the strategy map, so a future
 * contributor adding a level to the map cannot accidentally catch them.
 *
 * The same reasoning covers `manifest.json` (Chrome reads it before any of our code runs), and
 * `offscreen.html` / `viewer.html` (their `<script src>` lists are the load order the whole
 * extension depends on — see verify-062 §9).
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------------------------------------
// §8.2's two configs, verbatim, plus the medium tier §8.1's table needs.
// ------------------------------------------------------------------------------------------------
const configs = {
  heavy: {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: true,
    splitStringsChunkLength: 10,
    stringArray: true,
    stringArrayCallsTransform: true,
    // base64, NOT the rc4 encoder §8.3 bans by name — rc4 costs a measurable amount of CPU on a
    // path that runs per-hand, and this extension's whole job is to be fast enough to stay out
    // of the way of the game.
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.75,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  },
  // The tier §8.2 forgot. See the header: §8.1's table hands 开局表 / 数据结构 / 翻译表 / 站点配置
  // to 「中度」 and §8.2's own strategy map names `medium`, so it has to exist.
  medium: {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    log: false,
    numbersToExpressions: true,
    renameGlobals: false,
    selfDefending: false,
    simplify: true,
    splitStrings: false,
    stringArray: true,
    stringArrayCallsTransform: false,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.6,
    transformObjectKeys: true,
    unicodeEscapeSequence: false,
  },
  light: {
    compact: true,
    controlFlowFlattening: false,
    deadCodeInjection: false,
    debugProtection: false,
    disableConsoleOutput: false,
    identifierNamesGenerator: 'hexadecimal',
    // 关键：保持跨文件通信 (§8.3)
    renameGlobals: false,
    selfDefending: false,
    stringArray: true,
    stringArrayEncoding: ['base64'],
    stringArrayThreshold: 0.4,
  },
};

// §8.1's table, as data. Every key is a file that ships; hook.js / worker.js / manifest.json are
// deliberately absent — see the header for why that is stronger than marking them 'none'.
const fileStrategy = {
  'app.js': 'heavy',        // 核心检测算法
  'learn.js': 'heavy',      // 学习算法
  'openings.js': 'medium',  // 开局表
  'storage.js': 'medium',   // 数据结构
  'i18n.js': 'medium',      // 翻译表
  'sites.js': 'medium',     // 站点配置
  'viewer.js': 'light',     // UI 逻辑
  'content.js': 'light',    // 与页面通信，字符串不能变
  'background.js': 'light', // Service Worker 入口
};

// §8.1 says 「locale/*.js 中度」. A directory rule rather than twelve identical map entries: the
// locale set grows with the UI language list, and a new language that silently shipped UNobfuscated
// because nobody remembered to add it here is exactly the kind of gap this project keeps finding.
const dirStrategy = {
  'locale/': 'medium',
};

// Named for the reason they are named: §8.1 marks both 不混淆, and the REASON (a path that must
// survive) is what makes them a different category from a 'light' file.
const SKIP = ['hook.js', 'worker.js', 'manifest.json'];

/** The level for one extension-relative path, or null = copy verbatim. */
function levelFor(rel) {
  const norm = rel.split(path.sep).join('/');
  if (SKIP.indexOf(norm) >= 0) return null;
  if (Object.prototype.hasOwnProperty.call(fileStrategy, norm)) return fileStrategy[norm];
  for (const dir of Object.keys(dirStrategy)) {
    if (norm.indexOf(dir) === 0) return dirStrategy[dir];
  }
  return null;
}

/**
 * §8.3's 「必须关闭」/「必须保留」, asserted on the OUTPUTS rather than trusted to the config.
 *
 * Config flags are the intent; the emitted file is the fact. `selfDefending` and `debugProtection`
 * both synthesise function bodies at runtime, and MV3's `extension_pages` CSP allows neither — the
 * failure mode is not a warning, it is "the Service Worker never starts", which reads as a broken
 * extension with no console error the user can report.
 */
const FORBIDDEN = [
  { re: /\beval\s*\(/, why: 'eval is banned by the MV3 CSP' },
  { re: /new\s+Function\s*\(/, why: 'new Function is banned by the MV3 CSP' },
];

function assertNoEval(code, rel) {
  const stripped = String(code).split('\n').filter((l) => l.trim().indexOf('//') !== 0).join('\n');
  FORBIDDEN.forEach((f) => {
    if (f.re.test(stripped)) {
      throw new Error('[obfuscate] ' + rel + ': ' + f.why + ' (' + f.re + ' matched)');
    }
  });
}

/**
 * §8.3's last bullet — 「所有 chrome.runtime.onMessage 的 type 字符串不变」.
 *
 * A message type that gets renamed is worse than a message type that fails to compile: the sender
 * and the receiver disagree silently and the feature just never happens. The obfuscator's string
 * array can move string literals, so this checks that every `type: 'x'` literal in the source still
 * appears verbatim in the output.
 */
function assertMessageTypes(src, out, rel) {
  const re = /type:\s*'([A-Za-z0-9_.:-]{3,})'/g;
  const types = new Set();
  let m;
  while ((m = re.exec(src)) !== null) types.add(m[1]);
  const missing = [];
  types.forEach((t) => { if (out.indexOf(t) < 0) missing.push(t); });
  if (missing.length) {
    throw new Error('[obfuscate] ' + rel + ': message type(s) lost by obfuscation: ' + missing.join(', '));
  }
  return types.size;
}

/** Obfuscate one source string at the given level. Returns { code, sourceMap }. */
function obfuscate(src, rel, opts) {
  const o = opts || {};
  const level = o.level;
  if (!level) return { code: src, sourceMap: null, level: null };
  if (!Object.prototype.hasOwnProperty.call(configs, level)) {
    throw new Error('[obfuscate] ' + rel + ': unknown level ' + JSON.stringify(level));
  }
  const JavaScriptObfuscator = require('javascript-obfuscator');
  const result = JavaScriptObfuscator.obfuscate(src, Object.assign({}, configs[level], {
    // §8.4: 「sourcemap 上传到私密位置」. Emitted next to the file (build/obfuscate.js writes them
    // to build/sourcemaps/) and NEVER into build/release/ — copy-static.js's exclusion list is what
    // enforces that, and it is a list rather than a filter on purpose.
    sourceMap: !!o.sourceMap,
    sourceMapMode: 'separate',
    inputFileName: rel,
  }));
  const code = result.getObfuscatedCode();
  assertNoEval(code, rel);
  assertMessageTypes(src, code, rel);
  return {
    code: code,
    sourceMap: o.sourceMap ? result.getSourceMap() : null,
    level: level,
  };
}

/**
 * The whole build step: obfuscate every .js under srcDir into outDir, copying paths verbatim.
 * Kept separate from the CLI so a suite can run it against a two-file fixture.
 */
function run(srcDir, outDir, opts) {
  const o = opts || {};
  const written = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const abs = path.join(dir, e.name);
      const rel = path.relative(srcDir, abs).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (rel === 'build' || rel === 'node_modules' || rel === '.git') return;
        return walk(abs);
      }
      if (!/\.js$/.test(e.name)) return;
      const level = levelFor(rel);
      const out = path.join(outDir, rel);
      if (!level) { written.push({ rel: rel, level: null, skipped: true }); return; }
      const res = obfuscate(fs.readFileSync(abs, 'utf8'), rel, { level: level, sourceMap: !!o.sourceMap });
      if (o.dryRun) { written.push({ rel: rel, level: level, bytes: res.code.length }); return; }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, res.code, 'utf8');
      if (res.sourceMap) {
        const mapDir = o.mapDir || path.join(outDir, '..', 'sourcemaps');
        fs.mkdirSync(path.join(mapDir, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(mapDir, rel + '.map'), res.sourceMap, 'utf8');
      }
      written.push({ rel: rel, level: level, bytes: res.code.length });
    });
  };
  walk(srcDir);
  return written;
}

module.exports = {
  configs: configs,
  fileStrategy: fileStrategy,
  dirStrategy: dirStrategy,
  SKIP: SKIP,
  FORBIDDEN: FORBIDDEN,
  levelFor: levelFor,
  obfuscate: obfuscate,
  assertNoEval: assertNoEval,
  assertMessageTypes: assertMessageTypes,
  run: run,
};

if (require.main === module) {
  const EXT = path.join(__dirname, '..');
  const OUT = path.join(__dirname, 'release');
  const dry = process.argv.indexOf('--dry-run') >= 0;
  const list = run(EXT, OUT, { dryRun: dry, sourceMap: process.argv.indexOf('--sourcemap') >= 0 });
  list.forEach((e) => console.log('  ' + (e.level || 'verbatim') + '\t' + e.rel));
  console.log('obfuscate: ' + list.length + ' files' + (dry ? ' (dry run)' : ''));
}
