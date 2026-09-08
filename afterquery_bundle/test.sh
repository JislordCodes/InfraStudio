#!/bin/bash
# Verifier entrypoint (canonical frame). Patching and grading live in
# tests/grader.py; this script owns the task-specific part: run the suites,
# write machine-readable reports under /logs/verifier/, and apply any report
# fixups before grading. Edit ONLY between the RUN TESTS markers.
set -uo pipefail
trap 'if [ ! -f /logs/verifier/reward.json ] && [ ! -f /logs/verifier/reward.txt ]; then mkdir -p /logs/verifier; echo -1 > /logs/verifier/reward.txt; fi' EXIT
log() { echo "[verifier] $*"; }
cd /app || { mkdir -p /logs/verifier; exit 6; }

python3 /tests/grader.py prepare || exit $?
[ -f /logs/verifier/reward.json ] && exit 0   # model.patch didn't apply -> graded 0

# Canonical raw-output log: send every suite's combined stdout+stderr here
# (use run_log, or pipe through tee -a "$RUN_LOG" when feeding a reporter) so
# the reason a test failed is never lost. Never silence a test run.
export RUN_LOG=/logs/verifier/run.log
: > "$RUN_LOG" 2>/dev/null || true
run_log() { echo "+ $*" >> "$RUN_LOG" 2>/dev/null; "$@" 2>&1 | tee -a "$RUN_LOG"; return "${PIPESTATUS[0]}"; }

# >>> RUN TESTS (task-specific) <<<
set +e
mkdir -p /logs/verifier

# The suite runs as two cooperating processes, plus a third layer of
# isolation inside the sandbox process itself:
#
#   1. A sandbox process per test file (written below) loads that file and
#      the implementation under test INSIDE A FRESH V8 CONTEXT (Node's `vm`
#      module) -- not merely a same-realm eval. Submitted code has no
#      `process`, no `require` to real built-ins, no `fs`, no
#      `child_process`, no `setTimeout`; the module graph behind the test
#      file is read from disk and transformed entirely before any of it
#      runs, so the sandbox's own require() is a closed lookup with nothing
#      left to reach out for. It resolves relative imports, tsconfig path
#      aliases, and real node_modules packages -- so a behaviorally correct
#      implementation using an installed dependency or its own path aliases
#      is accepted, not just the reference's own layout. Only the entry test
#      file itself may ever resolve the recording harness (describe/it/
#      expect) -- every module it imports gets a require() that flatly
#      refuses that specifier, so the implementation under test cannot
#      register or influence a result. Every primordial the harness itself
#      depends on (Object.keys, Array.prototype.push, JSON.stringify, ...)
#      is captured before any submitted code runs, so even a realm-local
#      monkeypatch cannot corrupt how an expectation gets recorded. The
#      sandbox never decides pass/fail and never writes a report -- it only
#      reports, per expectation, the value it observed.
#   2. The grading process (further below) spawns those sandboxes, re-
#      evaluates every recorded expectation itself, and writes the CTRF
#      reports. It never loads any submitted code, so nothing the
#      implementation does at import time -- in-realm or out -- can
#      influence a recorded status. It also runs one additional, purely
#      static check: the real TypeScript compiler against a small
#      conformance file that imports and uses the public API exactly as
#      instruction.md documents it, so an implementation that drops or
#      reshapes a promised exported type fails even if its runtime
#      behavior happens to satisfy every other assertion.
SPATIAL_CHILD_RUNNER=/tmp/spatial_test_sandbox.js
export SPATIAL_CHILD_RUNNER

cat > "$SPATIAL_CHILD_RUNNER" << 'SANDBOXEOF'
'use strict';
// ===========================================================================
// TEST EXECUTION SANDBOX (child process)
//
// Submitted code runs inside a fresh V8 context (Node's `vm` module), not
// merely a `new Function(...)` in this process's own realm. That distinction
// matters: a `new Function`-created function still shares this realm's
// `process`, its `require`, and -- critically -- its `Function` constructor,
// which is reachable from ANY function reference via `.constructor`, however
// "safe" that reference looks. A fresh vm context has none of that: no
// `process`, no `require`, no `fs`, no `child_process`, no `setTimeout`.
//
// The harder rule this design follows: no live function reference EVER
// crosses the host/sandbox boundary in either direction.
//   - Host -> sandbox: only plain strings (source code text, a path->source
//     map). The harness itself (describe/it/expect) is defined as VM-REALM
//     source and evaluated inside the sandbox, so it is never a host-realm
//     function handed in -- there is nothing whose `.constructor` reaches
//     this process's real `Function`/`process`.
//   - Sandbox -> host: only a single JSON string, read back after execution
//     completes. The host never holds or calls a sandbox-realm function.
//
// The whole module graph behind the test file is discovered and read on the
// host BEFORE any submitted code runs (via static specifier scanning), so
// the sandbox's `require` is just a lookup into a pre-built, read-only map
// keyed by absolute path -- it never touches the filesystem itself.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const $readFileSync = fs.readFileSync;
const $existsSync = fs.existsSync;
const $statSync = fs.statSync;
const $writeFileSync = fs.writeFileSync;
const $dirname = path.dirname;
const $join = path.join;
const $resolvePath = path.resolve;
const $stringify = JSON.stringify;

const TEST_FILE = process.argv[2];
const OUT_PATH = process.argv[3];
const HARNESS_KEY = '__spatial_test_framework_sentinel__';

function errMessage(e) {
  try { return e && e.message ? String(e.message) : String(e); }
  catch (_) { return 'unknown error'; }
}

// Resolves an absolute-ish base path to a real file, trying the usual
// TS/JS extensions and directory-index forms. Used as the final step by
// every resolution strategy below (relative import, tsconfig path alias,
// node_modules package entry).
function resolveExtensions(base) {
  // TypeScript's own "bundler"/"nodenext" moduleResolution guidance is to
  // write ESM-style import specifiers ending in .js/.jsx/.mjs/.cjs even when
  // the actual source on disk is .ts/.tsx/.mts/.cts -- the extension names
  // what the compiled output would be, not the source file. An implementation
  // following that (very common, ecosystem-standard) convention must resolve
  // here just as tsc itself would, so this tries the matching TS source
  // extension for an already-.js-style specifier BEFORE falling back to the
  // generic append/index strategies below.
  const jsToTs = { '.js': '.ts', '.jsx': '.tsx', '.mjs': '.mts', '.cjs': '.cts' };
  const candidates = [base];
  for (const jsExt of Object.keys(jsToTs)) {
    if (base.length > jsExt.length && base.slice(-jsExt.length) === jsExt) {
      candidates.push(base.slice(0, -jsExt.length) + jsToTs[jsExt]);
      break;
    }
  }
  candidates.push(
    base + '.ts', base + '.tsx', base + '.mts', base + '.cts',
    base + '.js', base + '.jsx', base + '.mjs', base + '.cjs',
    $join(base, 'index.ts'), $join(base, 'index.tsx'), $join(base, 'index.mts'),
    $join(base, 'index.js'), $join(base, 'index.mjs'), $join(base, 'index.cjs')
  );
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try { if ($existsSync(c) && $statSync(c).isFile()) return c; } catch (_) {}
  }
  return null;
}

function resolveFile(fromDir, spec) {
  return resolveExtensions($resolvePath(fromDir, spec));
}

// --- tsconfig.json `paths`/`baseUrl` alias resolution ---------------------
// Discovers the nearest tsconfig by walking up from the importing file, so
// an implementation that ships its own path aliases (e.g. `@spatial/*`) is
// honored exactly as `tsc`/bundlers would resolve it, not just plain
// relative imports.
function findUp(startDir, filename) {
  let dir = startDir;
  while (true) {
    const candidate = $join(dir, filename);
    try { if ($existsSync(candidate) && $statSync(candidate).isFile()) return candidate; } catch (_) {}
    const parent = $dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const _tsconfigCache = new Map();
function loadTsconfig(fromDir) {
  if (_tsconfigCache.has(fromDir)) return _tsconfigCache.get(fromDir);
  const found = findUp(fromDir, 'tsconfig.json') || findUp(fromDir, 'tsconfig.app.json');
  let result = { baseUrl: null, paths: null };
  if (found) {
    try {
      const raw = $readFileSync(found, 'utf8');
      // tsconfig.json commonly carries comments/trailing commas; strip the
      // common cases so JSON.parse can handle it.
      const jsonish = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:"])\/\/[^\n]*/g, '$1')
        .replace(/,(\s*[}\]])/g, '$1');
      const parsed = JSON.parse(jsonish);
      const co = (parsed && parsed.compilerOptions) || {};
      const root = $dirname(found);
      if (co.paths) {
        result = { baseUrl: $resolvePath(root, co.baseUrl || '.'), paths: co.paths };
      }
    } catch (_) { /* no usable tsconfig; fall through with no aliases */ }
  }
  _tsconfigCache.set(fromDir, result);
  return result;
}

function resolveViaTsconfigPaths(fromDir, spec) {
  const cfg = loadTsconfig(fromDir);
  if (!cfg.paths || !cfg.baseUrl) return null;
  const patterns = Object.keys(cfg.paths);
  for (let i = 0; i < patterns.length; i++) {
    const pattern = patterns[i];
    const star = pattern.indexOf('*');
    const targets = cfg.paths[pattern];
    if (star === -1) {
      if (spec !== pattern) continue;
      for (let t = 0; t < targets.length; t++) {
        const hit = resolveExtensions($resolvePath(cfg.baseUrl, targets[t]));
        if (hit) return hit;
      }
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (spec.length < prefix.length + suffix.length) continue;
    if (spec.indexOf(prefix) !== 0) continue;
    if (suffix && spec.slice(spec.length - suffix.length) !== suffix) continue;
    const matched = spec.slice(prefix.length, spec.length - suffix.length);
    for (let t = 0; t < targets.length; t++) {
      const hit = resolveExtensions($resolvePath(cfg.baseUrl, targets[t].replace('*', matched)));
      if (hit) return hit;
    }
  }
  return null;
}

// --- node_modules resolution (bare package specifiers) --------------------
// Standard Node algorithm: walk up from the importing file's directory,
// checking each ancestor's node_modules/<pkg>. If the package genuinely
// exists (present in the checked-out repository -- nothing is ever
// installed or downloaded here), it's read, transformed, and executed
// inside the SAME sandbox as everything else -- discovery only widens what
// gets found, it never bypasses the sandbox those files run in.
function resolveViaNodeModules(fromDir, spec) {
  if (spec.charAt(0) === '.' || spec.charAt(0) === '/') return null;
  let dir = fromDir;
  while (true) {
    const pkgDir = $join(dir, 'node_modules', spec);
    const pkgJsonPath = $join(pkgDir, 'package.json');
    try {
      if ($existsSync(pkgJsonPath) && $statSync(pkgJsonPath).isFile()) {
        let entry = 'index.js';
        try {
          const pkg = JSON.parse($readFileSync(pkgJsonPath, 'utf8'));
          if (typeof pkg.module === 'string') entry = pkg.module;
          else if (typeof pkg.main === 'string') entry = pkg.main;
        } catch (_) { /* malformed package.json -- fall back to index.js */ }
        const hit = resolveExtensions($resolvePath(pkgDir, entry));
        if (hit) return hit;
      }
    } catch (_) {}
    const direct = resolveExtensions(pkgDir);
    if (direct) return direct;
    const parent = $dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Single entry point used by the transform: try relative resolution, then
// tsconfig path aliases, then real node_modules -- in that order, matching
// how a bundler would prioritize them. Returns null (never throws) when
// nothing genuinely exists, which the sandbox's own require() then reports
// as a normal "module not available" failure -- same outcome as reality.
function resolveSpecifier(fromDir, spec) {
  if (spec.charAt(0) === '.' || spec.charAt(0) === '/') {
    return resolveFile(fromDir, spec);
  }
  const viaAlias = resolveViaTsconfigPaths(fromDir, spec);
  if (viaAlias) return viaAlias;
  return resolveViaNodeModules(fromDir, spec);
}

function eraseTypes(code) {
  const mod = require('module');
  if (typeof mod.stripTypeScriptTypes !== 'function') return null;
  try { return mod.stripTypeScriptTypes(code, { mode: 'transform', sourceMap: false }); }
  catch (e1) {
    try { return mod.stripTypeScriptTypes(code, { mode: 'strip', sourceMap: false }); }
    catch (e2) { return null; }
  }
}

// ===========================================================================
// stripTypeScript(source, ctx): type erasure + ESM->CJS rewrite.
//
// ctx = { resolve(spec) -> absPath|null, onDep(absPath), harnessKey }
//
// Every relative import/re-export specifier is resolved to an ABSOLUTE path
// on the host and baked into the emitted `require("<abs path>")` call, and
// recorded via ctx.onDep so the host can keep walking the graph. A bare
// specifier (e.g. 'fs', 'child_process', 'assert') is left as a literal
// require() call too, but since the sandbox's module map only ever contains
// entries for files this walk actually discovered plus the harness
// sentinel, any such call simply finds nothing and throws inside the
// sandbox -- there is no allowlist to maintain, absence is the block.
// ===========================================================================
function stripTypeScript(source, ctx) {
  const n = source.length;
  let i = 0;
  let out = '';
  const exportedNames = [];
  const exportedAliases = [];
  let reexportCounter = 0;
  const braceStack = [];
  let pendingClassBody = false;

  function isIdentStart(c) { return c !== undefined && /[A-Za-z_$]/.test(c); }
  function isIdentPart(c) { return c !== undefined && /[A-Za-z0-9_$]/.test(c); }
  function isWs(c) { return c === ' ' || c === '\t' || c === '\r' || c === '\n'; }

  function readIdentAt(pos) {
    let j = pos, s = '';
    while (j < n && isIdentPart(source[j])) { s += source[j]; j++; }
    return s;
  }
  function skipWsAt(pos) { let j = pos; while (j < n && isWs(source[j])) j++; return j; }
  function skipWs() {
    while (i < n) {
      const c = source[i];
      if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; }
      else if (c === '/' && source[i + 1] === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; }
      else if (isWs(c)) i++;
      else break;
    }
  }
  function copyString(quote) {
    let s = quote; i++;
    while (i < n && source[i] !== quote) {
      if (source[i] === '\\') { s += source[i] + (source[i + 1] || ''); i += 2; continue; }
      s += source[i]; i++;
    }
    s += quote; i++;
    return s;
  }
  function copyTemplate() {
    let s = '`'; i++;
    while (i < n && source[i] !== '`') {
      if (source[i] === '\\') { s += source[i] + (source[i + 1] || ''); i += 2; continue; }
      if (source[i] === '$' && source[i + 1] === '{') {
        s += '${'; i += 2;
        let depth = 1;
        while (i < n && depth > 0) {
          const c = source[i];
          if (c === '{') { depth++; s += c; i++; }
          else if (c === '}') { depth--; s += c; i++; }
          else if (c === '\'' || c === '"') { s += copyString(c); }
          else if (c === '`') { s += copyTemplate(); }
          else { s += c; i++; }
        }
        continue;
      }
      s += source[i]; i++;
    }
    s += '`'; i++;
    return s;
  }
  function skipTypeExpr(stopChars) {
    let depth = 0;
    while (i < n) {
      skipWs();
      const c = source[i];
      if (c === undefined) return;
      if (depth === 0 && stopChars.indexOf(c) !== -1) return;
      if (c === '\'' || c === '"') { copyString(c); continue; }
      if (c === '`') { copyTemplate(); continue; }
      if (c === '(' || c === '[' || c === '{' || c === '<') { depth++; i++; continue; }
      if (c === ')' || c === ']' || c === '}' || c === '>') { if (depth === 0) return; depth--; i++; continue; }
      if (c === '=' && source[i + 1] === '>') { i += 2; continue; }
      i++;
    }
  }
  function parseParamList() {
    out += '('; i++;
    while (true) {
      skipWs();
      if (i >= n) break;
      if (source[i] === ')') { out += ')'; i++; break; }
      if (source[i] === '.' && source[i + 1] === '.' && source[i + 2] === '.') { out += '...'; i += 3; skipWs(); }
      while (true) {
        const w = readIdentAt(i);
        if (w === 'public' || w === 'private' || w === 'protected' || w === 'readonly') { i += w.length; skipWs(); continue; }
        break;
      }
      const pname = readIdentAt(i);
      if (pname) { out += pname; i += pname.length; }
      else if (source[i] === '{' || source[i] === '[') {
        const openCh = source[i], closeCh = openCh === '{' ? '}' : ']';
        let depth = 0;
        do { const cc = source[i]; if (cc === openCh) depth++; else if (cc === closeCh) depth--; out += cc; i++; } while (i < n && depth > 0);
      }
      skipWs();
      if (source[i] === '?') { i++; skipWs(); }
      if (source[i] === ':') { i++; skipTypeExpr([',', ')', '=']); }
      skipWs();
      if (source[i] === '=') {
        out += ' ='; i++; skipWs();
        let depth = 0;
        while (i < n) {
          const cc = source[i];
          if (depth === 0 && (cc === ',' || cc === ')')) break;
          if (cc === '\'' || cc === '"') { out += copyString(cc); continue; }
          if (cc === '`') { out += copyTemplate(); continue; }
          if (cc === '(' || cc === '[' || cc === '{') depth++;
          if (cc === ')' || cc === ']' || cc === '}') depth--;
          out += cc; i++;
        }
      }
      skipWs();
      if (source[i] === ',') { out += ', '; i++; continue; }
      if (source[i] === ')') { out += ')'; i++; break; }
      break;
    }
  }
  function dropReturnType() {
    skipWs();
    if (source[i] !== ':') return;
    i++; skipWs();
    while (source[i] === '{') {
      let depth = 0;
      do {
        const cc = source[i];
        if (cc === '\'' || cc === '"') { copyString(cc); continue; }
        if (cc === '`') { copyTemplate(); continue; }
        if (cc === '{') depth++; else if (cc === '}') depth--;
        i++;
      } while (i < n && depth > 0);
      skipWs();
      if (source[i] === '|' || source[i] === '&') { i++; skipWs(); continue; }
      break;
    }
    skipTypeExpr(['{', '=', ';']);
  }
  function looksLikeArrowParams(pos) {
    let k = pos + 1, depth = 1;
    while (k < n && depth > 0) {
      const c = source[k];
      if (c === '\'' || c === '"') { k++; while (k < n && source[k] !== c) { if (source[k] === '\\') k++; k++; } k++; continue; }
      if (c === '`') { k++; while (k < n && source[k] !== '`') { if (source[k] === '\\') k++; k++; } k++; continue; }
      if (c === '(') depth++; else if (c === ')') depth--;
      k++;
    }
    let m = k;
    while (m < n && isWs(source[m])) m++;
    if (source[m] === '=' && source[m + 1] === '>') return true;
    if (source[m] === ':') {
      let depth2 = 0;
      while (m < n) {
        const c = source[m];
        if (c === '(' || c === '[' || c === '{' || c === '<') depth2++;
        else if (c === ')' || c === ']' || c === '}' || c === '>') depth2--;
        else if (depth2 <= 0 && c === '=' && source[m + 1] === '>') return true;
        else if (depth2 <= 0 && (c === ';' || c === ',' || c === '\n')) return false;
        m++;
      }
    }
    return false;
  }
  function checkTrailingAs() {
    let k = i;
    while (source[k] === ' ' || source[k] === '\t') k++;
    if (source.slice(k, k + 2) === 'as' && !isIdentPart(source[k + 2])) { i = k + 2; skipTypeExpr([',', ')', ']', '}', ';', ':']); return; }
    if (source.slice(k, k + 9) === 'satisfies' && !isIdentPart(source[k + 9])) { i = k + 9; skipTypeExpr([',', ')', ']', '}', ';', ':']); }
  }
  function parseNameList(startBrace) {
    let k = startBrace + 1, depth = 1, raw = '';
    while (k < n && depth > 0) {
      const cc = source[k];
      if (cc === '{') { depth++; raw += cc; k++; continue; }
      if (cc === '}') { depth--; k++; if (depth === 0) break; raw += cc; continue; }
      raw += cc; k++;
    }
    const parts = raw.split(',');
    const items = [];
    for (let x = 0; x < parts.length; x++) {
      let s = parts[x].trim();
      if (!s) continue;
      if (/^type\s/.test(s)) continue;
      const asSplit = s.split(/\s+as\s+/);
      if (asSplit.length === 2) items.push({ local: asSplit[0].trim(), exported: asSplit[1].trim() });
      else items.push({ local: s, exported: s });
    }
    return { items: items, end: k };
  }
  function skipStatementFrom(pos) {
    let k = pos;
    while (k < n && source[k] !== ';' && source[k] !== '\n') {
      if (source[k] === '\'' || source[k] === '"') { const q = source[k]; k++; while (k < n && source[k] !== q) { if (source[k] === '\\') k++; k++; } }
      k++;
    }
    if (source[k] === ';') k++;
    return k;
  }
  function tryConsumeInterface(isExport) {
    const save = i;
    let p = i; if (isExport) p += 'export'.length;
    let q = skipWsAt(p);
    if (source.slice(q, q + 9) !== 'interface' || isIdentPart(source[q + 9])) { i = save; return false; }
    q += 9;
    const qq = skipWsAt(q);
    if (!isIdentStart(source[qq])) { i = save; return false; }
    let depth = 0, started = false, k = q;
    while (k < n) {
      const c = source[k];
      if (c === '{') { depth++; started = true; k++; continue; }
      if (c === '}') { depth--; k++; if (started && depth === 0) break; continue; }
      k++;
    }
    i = k;
    return true;
  }
  function tryConsumeTypeAlias(isExport) {
    const save = i;
    let p = i; if (isExport) p += 'export'.length;
    let q = skipWsAt(p);
    if (source.slice(q, q + 4) !== 'type' || isIdentPart(source[q + 4])) { i = save; return false; }
    const qq = skipWsAt(q + 4);
    if (!isIdentStart(source[qq])) { i = save; return false; }
    i = q + 4;
    skipTypeExpr(['=']);
    if (source[i] === '=') { i++; skipTypeExpr([';']); if (source[i] === ';') i++; }
    return true;
  }
  function tryConsumeEnum(isExport) {
    const save = i;
    let p = i; if (isExport) p += 'export'.length;
    let q = skipWsAt(p);
    if (source.slice(q, q + 5) === 'const') q = skipWsAt(q + 5);
    if (source.slice(q, q + 4) !== 'enum' || isIdentPart(source[q + 4])) { i = save; return false; }
    q = skipWsAt(q + 4);
    const name = readIdentAt(q);
    if (!name) { i = save; return false; }
    q = skipWsAt(q + name.length);
    if (source[q] !== '{') { i = save; return false; }
    let k = q + 1, depth = 1, body = '';
    while (k < n && depth > 0) {
      const cc = source[k];
      if (cc === '{') { depth++; body += cc; k++; continue; }
      if (cc === '}') { depth--; k++; if (depth === 0) break; body += cc; continue; }
      body += cc; k++;
    }
    const members = []; let buf = '', d2 = 0;
    for (let x = 0; x < body.length; x++) {
      const cc = body[x];
      if (cc === '(' || cc === '[' || cc === '{') d2++;
      if (cc === ')' || cc === ']' || cc === '}') d2--;
      if (cc === ',' && d2 === 0) { members.push(buf); buf = ''; continue; }
      buf += cc;
    }
    if (buf.trim()) members.push(buf);
    let auto = 0;
    let body2 = 'const ' + name + ' = (function () { const __E = {};';
    for (let x = 0; x < members.length; x++) {
      const raw = members[x].replace(/\/\/[^\n]*/g, '').trim();
      if (!raw) continue;
      const eq = raw.indexOf('=');
      if (eq === -1) {
        const mn = raw.trim();
        body2 += '__E[' + $stringify(mn) + '] = ' + auto + '; __E[' + auto + '] = ' + $stringify(mn) + ';';
        auto++;
      } else {
        const mn = raw.slice(0, eq).trim(), val = raw.slice(eq + 1).trim();
        body2 += '__E[' + $stringify(mn) + '] = ' + val + ';';
        const asNum = Number(val);
        if (val !== '' && !isNaN(asNum) && /^-?[0-9.]+$/.test(val)) { body2 += '__E[' + val + '] = ' + $stringify(mn) + ';'; auto = asNum + 1; }
      }
    }
    body2 += 'return __E; })();';
    out += body2;
    if (isExport) exportedNames.push(name);
    i = k;
    return true;
  }

  function reqCall(spec) {
    // Try relative resolution, tsconfig path aliases, and real node_modules
    // -- in that order -- for EVERY specifier, not just relative ones. A
    // bare package that genuinely exists in the checked-out repository
    // resolves like any other discovered file; one that doesn't simply
    // isn't found, and the sandbox's own require() reports that at runtime,
    // exactly as a real missing dependency would.
    const abs = ctx.resolve(spec);
    if (abs) { ctx.onDep(abs); return 'require(' + $stringify(abs) + ')'; }
    return 'require(' + $stringify(spec) + ')';
  }

  function tryConsumeImport() {
    const save = i;
    i += 'import'.length;
    skipWs();
    const w = readIdentAt(i);
    if (w === 'type') {
      const after = skipWsAt(i + 4);
      if (source[after] === '{' || isIdentStart(source[after]) || source[after] === '*') { i = skipStatementFrom(i); return true; }
    }
    if (source[i] === '\'' || source[i] === '"') {
      const spec = copyString(source[i]).slice(1, -1);
      skipWs(); if (source[i] === ';') i++;
      out += reqCall(spec) + ';';
      return true;
    }
    if (source[i] === '{') {
      const parsed = parseNameList(i);
      let m = skipWsAt(parsed.end);
      if (source.slice(m, m + 4) === 'from') {
        m = skipWsAt(m + 4);
        i = m;
        const specQuoted = copyString(source[i]);
        const spec = specQuoted.slice(1, -1);
        skipWs(); if (source[i] === ';') i++;
        const pieces = parsed.items.map(it2 => it2.local === it2.exported ? it2.local : (it2.local + ': ' + it2.exported));
        out += pieces.length ? ('const { ' + pieces.join(', ') + ' } = ' + reqCall(spec) + ';') : (reqCall(spec) + ';');
        return true;
      }
      i = save; return false;
    }
    if (source[i] === '*') {
      i++; skipWs();
      if (source.slice(i, i + 2) === 'as') {
        i += 2; skipWs();
        const ns = readIdentAt(i); i += ns.length;
        skipWs();
        if (source.slice(i, i + 4) === 'from') {
          i += 4; skipWs();
          const spec = copyString(source[i]).slice(1, -1);
          skipWs(); if (source[i] === ';') i++;
          out += 'const ' + ns + ' = ' + reqCall(spec) + ';';
          return true;
        }
      }
      i = save; return false;
    }
    if (isIdentStart(source[i])) {
      const nm = readIdentAt(i); i += nm.length;
      skipWs();
      let extra = null;
      if (source[i] === ',') {
        i++; skipWs();
        if (source[i] === '{') { const parsed = parseNameList(i); i = parsed.end; extra = parsed.items; skipWs(); }
      }
      if (source.slice(i, i + 4) === 'from') {
        i += 4; skipWs();
        const spec = copyString(source[i]).slice(1, -1);
        skipWs(); if (source[i] === ';') i++;
        const v = '__imp' + (reexportCounter++);
        out += 'const ' + v + ' = ' + reqCall(spec) + ';';
        out += 'const ' + nm + ' = (' + v + ' && ' + v + '.__esModule) ? ' + v + '.default : (' + v + '.default !== undefined ? ' + v + '.default : ' + v + ');';
        if (extra) for (const e of extra) out += 'const ' + e.exported + ' = ' + v + '[' + $stringify(e.local) + '];';
        return true;
      }
      i = save; return false;
    }
    i = save; return false;
  }

  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') { i += 2; while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '\'' || c === '"') { out += copyString(c); checkTrailingAs(); continue; }
    if (c === '`') { out += copyTemplate(); checkTrailingAs(); continue; }
    if (c === '{') { braceStack.push(pendingClassBody ? 'class' : 'other'); pendingClassBody = false; out += c; i++; continue; }
    if (c === '}') { braceStack.pop(); out += c; i++; continue; }
    if (c === '(' && looksLikeArrowParams(i)) { parseParamList(); dropReturnType(); continue; }

    if (isIdentStart(c)) {
      const word = readIdentAt(i);
      const wordEnd = i + word.length;
      const precededByDot = out.replace(/[ \t]+$/, '').endsWith('.');
      const inClassBody = braceStack.length > 0 && braceStack[braceStack.length - 1] === 'class';

      if (!precededByDot && (word === 'as' || word === 'satisfies')) {
        const prev = out.replace(/\s+$/, '');
        const lastCh = prev.charAt(prev.length - 1);
        if (lastCh && (isIdentPart(lastCh) || lastCh === ')' || lastCh === ']' || lastCh === '}' || lastCh === '\'' || lastCh === '"' || lastCh === '`')) {
          i = wordEnd; skipTypeExpr([',', ')', ']', '}', ';', ':', '=']); continue;
        }
      }

      if (!precededByDot && word === 'import') {
        const nx = skipWsAt(wordEnd);
        if (source[nx] !== '(' && source[nx] !== '.') { if (tryConsumeImport()) continue; }
      }

      if (!precededByDot && word === 'export') {
        let j = skipWsAt(wordEnd);
        if (source[j] === '*') {
          let k = skipWsAt(j + 1);
          if (source.slice(k, k + 2) === 'as' && !isIdentPart(source[k + 2])) {
            k = skipWsAt(k + 2);
            const ns = readIdentAt(k); k = skipWsAt(k + ns.length);
            if (source.slice(k, k + 4) === 'from') {
              i = skipWsAt(k + 4);
              const spec = copyString(source[i]).slice(1, -1);
              skipWs(); if (source[i] === ';') i++;
              out += 'exports[' + $stringify(ns) + '] = ' + reqCall(spec) + ';';
              continue;
            }
          }
          if (source.slice(k, k + 4) === 'from') {
            i = skipWsAt(k + 4);
            const spec = copyString(source[i]).slice(1, -1);
            skipWs(); if (source[i] === ';') i++;
            out += 'Object.assign(exports, ' + reqCall(spec) + ');';
            continue;
          }
        }
        const kw0 = readIdentAt(j);
        if (kw0 === 'type') {
          const afterType = skipWsAt(j + 4);
          if (source[afterType] === '{') { const parsed = parseNameList(afterType); i = skipStatementFrom(parsed.end); continue; }
          if (tryConsumeTypeAlias(true)) continue;
        }
        if (kw0 === 'interface' && tryConsumeInterface(true)) continue;
        if ((kw0 === 'enum' || kw0 === 'const') && tryConsumeEnum(true)) continue;
        if (source[j] === '{') {
          const parsed = parseNameList(j);
          let m = skipWsAt(parsed.end);
          if (source.slice(m, m + 4) === 'from') {
            i = skipWsAt(m + 4);
            const spec = copyString(source[i]).slice(1, -1);
            skipWs(); if (source[i] === ';') i++;
            const v = '__reexport' + (reexportCounter++);
            out += 'const ' + v + ' = ' + reqCall(spec) + ';';
            for (const e of parsed.items) out += 'exports[' + $stringify(e.exported) + '] = ' + v + '[' + $stringify(e.local) + '];';
            continue;
          }
          for (const e of parsed.items) {
            if (e.local === e.exported) exportedNames.push(e.local); else exportedAliases.push(e);
          }
          i = parsed.end; skipWs(); if (source[i] === ';') i++;
          continue;
        }
        if (kw0 === 'default') { out += 'exports.default = '; i = skipWsAt(j + 'default'.length); continue; }
        if (kw0 === 'const' || kw0 === 'let' || kw0 === 'var' || kw0 === 'function' || kw0 === 'class' || kw0 === 'async' || kw0 === 'abstract') {
          let k = skipWsAt(j + kw0.length);
          if (kw0 === 'async' || kw0 === 'abstract') { const w2 = readIdentAt(k); if (w2 === 'function' || w2 === 'class') k = skipWsAt(k + w2.length); }
          if (source[k] === '*') k = skipWsAt(k + 1);
          const nm = readIdentAt(k);
          if (nm) exportedNames.push(nm);
          i = j; continue;
        }
        i = wordEnd; continue;
      }

      if (!precededByDot && word === 'interface' && tryConsumeInterface(false)) continue;
      if (!precededByDot && word === 'type' && tryConsumeTypeAlias(false)) continue;
      if (!precededByDot && word === 'enum' && tryConsumeEnum(false)) continue;

      if (inClassBody && !precededByDot &&
          (word === 'private' || word === 'public' || word === 'protected' ||
           word === 'readonly' || word === 'abstract' || word === 'declare' || word === 'override')) {
        i = skipWsAt(wordEnd); continue;
      }

      if (!precededByDot && word === 'class') {
        out += word; i = wordEnd; skipWs(); out += ' ';
        const cname = readIdentAt(i); out += cname; i += cname.length;
        skipWs();
        if (source[i] === '<') skipTypeExpr(['{', 'e', 'i']);
        skipWs();
        if (source.slice(i, i + 7) === 'extends') {
          out += ' extends '; i = skipWsAt(i + 7);
          const base = readIdentAt(i); out += base; i += base.length;
          skipWs(); if (source[i] === '<') skipTypeExpr(['{']);
        }
        skipWs();
        if (source.slice(i, i + 10) === 'implements') { i += 10; skipTypeExpr(['{']); }
        pendingClassBody = true;
        continue;
      }

      if (!precededByDot && word === 'function') {
        out += word; i = wordEnd; skipWs(); out += ' ';
        if (source[i] === '*') { out += '*'; i++; skipWs(); }
        const fname = readIdentAt(i); out += fname; i += fname.length;
        skipWs();
        if (source[i] === '<') skipTypeExpr(['(']);
        if (source[i] === '(') { parseParamList(); dropReturnType(); }
        continue;
      }

      if (!precededByDot && (word === 'const' || word === 'let' || word === 'var')) {
        out += word; i = wordEnd; skipWs(); out += ' ';
        if (source[i] === '{' || source[i] === '[') continue;
        const vname = readIdentAt(i); out += vname; i += vname.length;
        skipWs();
        if (source[i] === '!') i++;
        if (source[i] === ':') { i++; skipTypeExpr(['=', ';', ',']); }
        out += ' ';
        continue;
      }

      if (inClassBody && !precededByDot) {
        out += word; i = wordEnd;
        const look = skipWsAt(i);
        if (source[look] === '<') { i = look; skipTypeExpr(['(']); }
        if (source[i] === '(' || source[skipWsAt(i)] === '(') { i = skipWsAt(i); parseParamList(); dropReturnType(); continue; }
        skipWs();
        if (source[i] === '?' || source[i] === '!') { i++; skipWs(); }
        if (source[i] === ':') { i++; skipTypeExpr(['=', ';', '}']); }
        out += ' ';
        continue;
      }

      out += word; i = wordEnd; checkTrailingAs(); continue;
    }

    if (c === '!') {
      const prevNonWs = out.replace(/\s+$/, '');
      const lastChar = prevNonWs[prevNonWs.length - 1];
      const nextChar = source[i + 1];
      if ((lastChar === ')' || lastChar === ']' || isIdentPart(lastChar)) && nextChar !== '=') { i++; continue; }
      out += c; i++; continue;
    }
    out += c; i++;
  }

  if (exportedNames.length) {
    const seen = {}; const uniq = [];
    for (const nm of exportedNames) if (!seen[nm]) { seen[nm] = 1; uniq.push(nm); }
    out += '\nObject.assign(module.exports, { ' + uniq.join(', ') + ' });\n';
  }
  for (const a of exportedAliases) out += 'exports[' + $stringify(a.exported) + '] = ' + a.local + ';\n';
  return out;
}

// ===========================================================================
// Host-side graph walk: read + transform every file reachable from the test
// file, entirely before any of it executes. Produces a flat map of
// absolute-path -> transformed CommonJS source, all keyed exactly the way
// the emitted require(...) calls reference them.
// ===========================================================================
function buildSourceMap(entryAbsPath) {
  const sources = {};
  const stack = [entryAbsPath];
  const seen = new Set();
  let usedRuntimeStripper = false, usedFallbackStripper = false;

  while (stack.length) {
    const absPath = stack.pop();
    const real = fs.realpathSync(absPath);
    if (seen.has(real)) continue;
    seen.add(real);

    const raw = $readFileSync(real, 'utf8');
    const erased = eraseTypes(raw);
    if (erased !== null) usedRuntimeStripper = true; else usedFallbackStripper = true;
    const dir = $dirname(real);
    const deps = [];
    const code = stripTypeScript(erased !== null ? erased : raw, {
      resolve: (spec) => resolveSpecifier(dir, spec),
      onDep: (abs) => deps.push(abs)
    });
    sources[real] = code;
    for (const d of deps) stack.push(d);
  }

  let strategy;
  if (usedRuntimeStripper && usedFallbackStripper) strategy = 'runtime-typescript-stripper+fallback';
  else if (usedRuntimeStripper) strategy = 'runtime-typescript-stripper';
  else strategy = 'self-contained-stripper';
  return { sources, strategy, entryKey: fs.realpathSync(entryAbsPath) };
}

// ===========================================================================
// The VM-realm bootstrap: harness (describe/it/expect), a require() that
// only resolves against the pre-built source map, and result serialization.
// Every identifier here is realm-local -- nothing referencing the outer
// (host) scope is ever spliced in except as JSON-encoded string data.
// ===========================================================================
const SANDBOX_BOOTSTRAP = String(function __spatialSandboxBootstrap(__SOURCES__, __ENTRY__, __HARNESS_KEY__) {
  // Primordials captured BEFORE any submitted code runs. This realm is
  // isolated from the real Node process, but the harness below still runs
  // in the SAME realm as the code under test, which means that code can
  // reassign this realm's own Object.keys / Array.prototype.push /
  // JSON.stringify / etc. Capturing bound references now, and using only
  // these throughout, means such a reassignment can corrupt nothing the
  // harness relies on -- exactly the same discipline used against the real
  // process, just applied a second time inside this realm too.
  var $objectKeys = Object.keys;
  var $isArray = Array.isArray;
  var $objToString = Function.prototype.call.bind(Object.prototype.toString);
  var $hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  var $arrayPush = Function.prototype.call.bind(Array.prototype.push);
  var $String = String;
  var $isFinite = Number.isFinite !== undefined ? Number.isFinite : $isFiniteFallback;
  function $isFiniteFallback(x) { return typeof x === 'number' && x === x && x !== Infinity && x !== -Infinity; }
  var $jsonStringify = JSON.stringify;
  var $Function = Function;

  var __cache = {};
  var __records = [];
  var __current = null;

  function __enc(v, d) {
    if (d > 8) return { t: 'deep' };
    if (v === null) return { t: 'null' };
    if (v === undefined) return { t: 'undef' };
    var ty = typeof v;
    if (ty === 'number') {
      if (v !== v) return { t: 'num', s: 'NaN' };
      if (v === Infinity) return { t: 'num', s: 'Inf' };
      if (v === -Infinity) return { t: 'num', s: '-Inf' };
      return { t: 'num', v: v };
    }
    if (ty === 'string') return { t: 'str', v: v };
    if (ty === 'boolean') return { t: 'bool', v: v };
    if (ty === 'bigint') return { t: 'big', v: $String(v) };
    if (ty === 'symbol') return { t: 'sym', v: $String(v) };
    if (ty === 'function') return { t: 'fn' };
    var tag = $objToString(v);
    if (tag === '[object RegExp]') { try { return { t: 're', s: $String(v.source), f: $String(v.flags) }; } catch (e) { return { t: 're', s: '', f: '' }; } }
    if (tag === '[object Date]') { try { return { t: 'date', v: v.getTime() }; } catch (e) { return { t: 'date', v: 0 }; } }
    if ($isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) $arrayPush(arr, __enc(v[i], d + 1));
      return { t: 'arr', v: arr };
    }
    var ks;
    try { ks = $objectKeys(v); } catch (e) { return { t: 'x' }; }
    var o = {};
    for (var j = 0; j < ks.length; j++) { try { o[ks[j]] = __enc(v[ks[j]], d + 1); } catch (e) { o[ks[j]] = { t: 'x' }; } }
    return { t: 'obj', v: o };
  }

  function describe(_name, fn) { fn(); }
  function it(name, fn) {
    var rec = { name: $String(name), ops: [] };
    __current = rec;
    try { fn(); } catch (e) { rec.error = (e && e.message) ? $String(e.message) : $String(e); }
    __current = null;
    $arrayPush(__records, rec);
  }
  function recordOp(o) { if (__current) $arrayPush(__current.ops, o); }
  function expect(actual) {
    return {
      toBe: function (expected) {
        var same = false; try { same = actual === expected; } catch (e) { same = false; }
        recordOp({ k: 'toBe', a: __enc(actual, 0), e: __enc(expected, 0), same: same });
      },
      toEqual: function (expected) { recordOp({ k: 'toEqual', a: __enc(actual, 0), e: __enc(expected, 0) }); },
      toStrictEqual: function (expected) { recordOp({ k: 'toEqual', a: __enc(actual, 0), e: __enc(expected, 0) }); },
      toBeDefined: function () { recordOp({ k: 'toBeDefined', a: __enc(actual, 0) }); },
      toBeUndefined: function () { recordOp({ k: 'toBeUndefined', a: __enc(actual, 0) }); },
      toBeCloseTo: function (expected, precision) { recordOp({ k: 'toBeCloseTo', a: __enc(actual, 0), e: __enc(expected, 0), p: precision === undefined ? 2 : precision }); },
      toContain: function (item) { recordOp({ k: 'toContain', a: __enc(actual, 0), e: __enc(item, 0) }); },
      toHaveLength: function (len) {
        var observed; try { observed = actual == null ? undefined : actual.length; } catch (e) { observed = undefined; }
        recordOp({ k: 'toBe', a: __enc(observed, 0), e: __enc(len, 0), same: observed === len });
      },
      toBeTruthy: function () { recordOp({ k: 'toBe', a: __enc(!!actual, 0), e: __enc(true, 0), same: (!!actual) === true }); },
      toBeFalsy: function () { recordOp({ k: 'toBe', a: __enc(!!actual, 0), e: __enc(false, 0), same: (!!actual) === false }); },
      toThrowError: function (matcher) {
        var threw = false, msg = '';
        try { actual(); } catch (e) { threw = true; msg = (e && e.message) ? $String(e.message) : $String(e); }
        recordOp({ k: 'toThrowError', threw: threw, msg: msg, e: __enc(matcher, 0) });
      },
      toThrow: function (matcher) {
        var threw = false, msg = '';
        try { actual(); } catch (e) { threw = true; msg = (e && e.message) ? $String(e.message) : $String(e); }
        recordOp({ k: 'toThrowError', threw: threw, msg: msg, e: __enc(matcher, 0) });
      }
    };
  }
  var __harness = { describe: describe, it: it, test: it, expect: expect, beforeEach: function () {}, afterEach: function () {} };

  // Only the entry test file may ever resolve the harness sentinel. Every
  // module it (transitively) requires -- i.e. the implementation under test
  // -- gets a require() that flatly refuses it, so nothing but the test file
  // itself can ever call it()/expect() to register or influence a result.
  function makeRequire(callerKey) {
    return function (key) {
      if (key === __HARNESS_KEY__) {
        if (callerKey !== __ENTRY__) {
          throw new Error('the test framework is not available to modules under test');
        }
        return __harness;
      }
      if ($hasOwn(__cache, key)) return __cache[key].exports;
      if (!$hasOwn(__SOURCES__, key)) {
        throw new Error('module not available in sandbox: ' + key);
      }
      var mod = { exports: {} };
      __cache[key] = mod;
      var fn = new $Function('require', 'module', 'exports', __SOURCES__[key]);
      fn(makeRequire(key), mod, mod.exports);
      return mod.exports;
    };
  }

  var __outcome = { ok: true, error: null };
  try { makeRequire(__ENTRY__)(__ENTRY__); } catch (e) { __outcome.ok = false; __outcome.error = (e && e.message) ? $String(e.message) : $String(e); }
  // Report through the frozen cross-realm function set up by runInSandbox
  // BEFORE any submitted code ran (see below), never through a plain
  // globalThis data property -- a data property assigned only at the very
  // end can still be shadowed earlier by an accessor that submitted code
  // installs at import time, letting it intercept or fabricate this payload.
  // __reportResult__ is non-configurable and non-writable, so it cannot be
  // redefined or reassigned; calling it hands the value directly to a
  // closure variable in the trusted outer realm that submitted code never
  // has a reference to, in or out of the sandbox.
  globalThis.__reportResult__($jsonStringify({ records: __records, outcome: __outcome }));
});;

function u2028Safe(s) {
  return s.replace(new RegExp(String.fromCharCode(8232), 'g'), '\u2028')
           .replace(new RegExp(String.fromCharCode(8233), 'g'), '\u2029');
}

function runInSandbox(sourceMap) {
  // Rewrite the harness-specifier require() calls to use the sentinel key,
  // for every discovered module (including the entry test file itself).
  const HARNESS_ALIASES = ['vitest', 'vitest/globals', 'jest', '@jest/globals'];
  const patchedSources = {};
  for (const key of Object.keys(sourceMap.sources)) {
    let code = sourceMap.sources[key];
    for (const alias of HARNESS_ALIASES) {
      code = code.split('require(' + $stringify(alias) + ')').join('require(' + $stringify(HARNESS_KEY) + ')');
    }
    patchedSources[key] = code;
  }

  const bootstrapCall =
    '(' + SANDBOX_BOOTSTRAP + ')(' +
    u2028Safe($stringify(patchedSources)) + ', ' +
    u2028Safe($stringify(sourceMap.entryKey)) + ', ' +
    u2028Safe($stringify(HARNESS_KEY)) +
    ');';

  const context = vm.createContext(Object.create(null));

  // Result channel: a real function belonging to THIS (trusted) realm,
  // attached to the sandbox's global object as non-configurable and
  // non-writable BEFORE script.runInContext ever runs a single line of
  // submitted code. Submitted code can call it (that's the whole point --
  // the harness itself calls it too, from inside the sandbox) but it cannot
  // redefine, delete, or reassign it: Object.defineProperty/delete/`=` all
  // fail against a non-configurable, non-writable property, silently in
  // sloppy mode and by throwing in strict mode -- never by succeeding. The
  // value it receives is written straight into a closure variable out here,
  // which nothing inside the sandbox can read back or intercept -- unlike
  // the old globalThis.__SPATIAL_RESULT__ data property, which could be
  // shadowed by an attacker-installed getter/setter pair at import time,
  // before the harness's own (data-property) assignment to it ever ran.
  let __capturedResult;
  let __captured = false;
  Object.defineProperty(context, '__reportResult__', {
    value: function (payload) { __capturedResult = payload; __captured = true; },
    writable: false,
    enumerable: false,
    configurable: false
  });

  const script = new vm.Script(bootstrapCall, { filename: 'spatial-sandbox.js' });
  script.runInContext(context, { timeout: 20000 });

  const resultStr = __captured ? __capturedResult : undefined;
  if (typeof resultStr !== 'string') {
    return { records: [], outcome: { ok: false, error: 'sandbox produced no result' } };
  }
  return JSON.parse(resultStr);
}

// ---------------------------------------------------------------------------
function finish(strategy, note, records) {
  try {
    $writeFileSync(OUT_PATH, $stringify({ file: TEST_FILE, strategy: strategy, note: note || null, records: records }));
  } catch (e) {
    try { process.stderr.write('failed writing records: ' + errMessage(e) + '\n'); } catch (_) {}
  }
}

(function main() {
  if (!TEST_FILE || !$existsSync(TEST_FILE)) { finish('none', 'test file not found', []); return; }
  let strategy = 'none', note = null, records = [];
  try {
    const sourceMap = buildSourceMap(TEST_FILE);
    strategy = sourceMap.strategy;
    const result = runInSandbox(sourceMap);
    records = result.records || [];
    if (result.outcome && !result.outcome.ok) note = 'suite load failed: ' + result.outcome.error;
  } catch (e) {
    note = 'sandbox setup failed: ' + errMessage(e);
  }
  process.stdout.write('[runner] ' + TEST_FILE + ' transform=' + strategy + ' tests_recorded=' + records.length + (note ? (' (' + note + ')') : '') + '\n');
  finish(strategy, note, records);
  try { if (typeof process.reallyExit === 'function') process.reallyExit(0); } catch (_) {}
})();
SANDBOXEOF

node - << 'NODEOF' >> "$RUN_LOG" 2>&1
'use strict';
// ===========================================================================
// GRADING PROCESS (parent)
//
// This process NEVER loads, imports, or evaluates any submitted code. It
// spawns one isolated child per test file; each child executes that file and
// reports only the values it observed. All pass/fail decisions and both CTRF
// reports are computed here, in a process the submitted implementation cannot
// reach, so no import-time patching inside the implementation can influence a
// recorded status.
//
// A test counts as passed only when its child reported no thrown error, at
// least one recorded expectation, and every recorded expectation holds when
// re-evaluated here. Anything else -- including a child that crashes or is
// never able to load the module -- leaves the test failed or absent, and the
// grader treats an absent required test as a failure.
// ===========================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TESTS_DIR = '/app/frontend/tests';
const VERIFIER_DIR = '/logs/verifier';
const CHILD_RUNNER = process.env.SPATIAL_CHILD_RUNNER;

// The baseline suite is independent of the feature under test; the feature
// suites exercise the public entry point the instruction names.
const P2P_FILES = ['existing-regression.test.ts'];
const F2P_FILES = ['clash-detection.test.ts', 'clash-clearance-matrix.test.ts', 'clash-clustering.test.ts', 'clash-analytics.test.ts'];

// ---------------------------------------------------------------------------
// Re-evaluation of recorded expectations (structural, on encoded values).
// ---------------------------------------------------------------------------
function isPrim(x) {
  return x && (x.t === 'num' || x.t === 'str' || x.t === 'bool' || x.t === 'null' ||
               x.t === 'undef' || x.t === 'big' || x.t === 'sym');
}

function eqEnc(a, b) {
  if (!a || !b) return false;
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'num':
      if (a.s !== undefined || b.s !== undefined) return a.s === b.s;
      return a.v === b.v;
    case 'str': case 'bool': case 'big': case 'sym':
      return a.v === b.v;
    case 'null': case 'undef': case 'fn': case 'deep': case 'x':
      return true;
    case 're':
      return a.s === b.s && a.f === b.f;
    case 'date':
      return a.v === b.v;
    case 'arr': {
      if (a.v.length !== b.v.length) return false;
      for (let i = 0; i < a.v.length; i++) if (!eqEnc(a.v[i], b.v[i])) return false;
      return true;
    }
    case 'obj': {
      const ka = Object.keys(a.v).sort();
      const kb = Object.keys(b.v).sort();
      if (ka.length !== kb.length) return false;
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return false;
      for (let i = 0; i < ka.length; i++) if (!eqEnc(a.v[ka[i]], b.v[ka[i]])) return false;
      return true;
    }
    default:
      return false;
  }
}

function numOf(x) {
  if (!x || x.t !== 'num') return null;
  if (x.s === 'NaN') return NaN;
  if (x.s === 'Inf') return Infinity;
  if (x.s === '-Inf') return -Infinity;
  return x.v;
}

function evalOp(op) {
  switch (op.k) {
    case 'toBe':
      if (isPrim(op.a) && isPrim(op.e)) return eqEnc(op.a, op.e);
      return op.same === true && eqEnc(op.a, op.e);
    case 'toEqual':
      return eqEnc(op.a, op.e);
    case 'toBeDefined':
      return !!op.a && op.a.t !== 'undef';
    case 'toBeUndefined':
      return !!op.a && op.a.t === 'undef';
    case 'toBeCloseTo': {
      const av = numOf(op.a), ev = numOf(op.e);
      if (av === null || ev === null) return false;
      if (!Number.isFinite(av) || !Number.isFinite(ev)) return av === ev;
      const p = typeof op.p === 'number' ? op.p : 2;
      return Math.abs(av - ev) < Math.pow(10, -p) / 2;
    }
    case 'toContain': {
      if (op.a && op.a.t === 'str' && op.e && op.e.t === 'str') {
        return op.a.v.indexOf(op.e.v) !== -1;
      }
      if (op.a && op.a.t === 'arr') {
        for (let i = 0; i < op.a.v.length; i++) if (eqEnc(op.a.v[i], op.e)) return true;
        return false;
      }
      return false;
    }
    case 'toThrowError': {
      if (op.threw !== true) return false;
      const m = op.e;
      if (!m || m.t === 'undef' || m.t === 'null') return true;
      if (m.t === 're') {
        try { return new RegExp(m.s, m.f).test(String(op.msg)); } catch (e) { return false; }
      }
      if (m.t === 'str') return String(op.msg).indexOf(m.v) !== -1;
      return true;
    }
    default:
      return false;
  }
}

function judge(record) {
  if (record.error) return { status: 'failed', reason: 'threw: ' + record.error };
  if (!Array.isArray(record.ops) || record.ops.length === 0) {
    return { status: 'failed', reason: 'no expectations were recorded' };
  }
  for (let i = 0; i < record.ops.length; i++) {
    if (!evalOp(record.ops[i])) {
      return { status: 'failed', reason: 'expectation #' + (i + 1) + ' (' + record.ops[i].k + ') did not hold' };
    }
  }
  return { status: 'passed', reason: null };
}

// ---------------------------------------------------------------------------
// Child execution: one isolated process per test file.
// ---------------------------------------------------------------------------
let tmpSeq = 0;
function runTestFile(fileName) {
  const absFile = path.join(TESTS_DIR, fileName);
  const outPath = path.join(os.tmpdir(), 'spatial_records_' + (tmpSeq++) + '.json');
  // Some runtimes need type stripping requested explicitly; try the plain
  // invocation first and only retry with the flag if nothing was recorded.
  const attempts = [[], ['--experimental-strip-types']];
  let payload = null;

  for (let a = 0; a < attempts.length; a++) {
    try { fs.unlinkSync(outPath); } catch (e) { /* not present */ }
    const args = attempts[a].concat([CHILD_RUNNER, absFile, outPath]);
    const res = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (e) {
      parsed = null;
    }
    if (parsed && Array.isArray(parsed.records) && parsed.records.length > 0) {
      payload = parsed;
      break;
    }
    payload = parsed;
  }

  if (!payload || !Array.isArray(payload.records)) {
    console.error('[grade] ' + fileName + ': child produced no usable records; its tests are absent and therefore fail.');
    return [];
  }
  console.log('[grade] ' + fileName + ': loaded via ' + payload.strategy + ', ' + payload.records.length + ' test(s) recorded.');

  const results = [];
  for (let i = 0; i < payload.records.length; i++) {
    const rec = payload.records[i];
    const verdict = judge(rec);
    if (verdict.status === 'failed') {
      console.error('FAIL: ' + rec.name + ' -- ' + verdict.reason);
    }
    results.push({ name: String(rec.name), status: verdict.status, duration: 1 });
  }
  return results;
}

// A name reported more than once collapses to its worst status, so an extra
// passing entry can never mask a failing one of the same name.
function mergeWorstFirst(tests) {
  const order = [];
  const byName = new Map();
  for (const t of tests) {
    if (!byName.has(t.name)) {
      byName.set(t.name, { name: t.name, status: t.status, duration: t.duration });
      order.push(t.name);
    } else if (t.status === 'failed') {
      byName.get(t.name).status = 'failed';
    }
  }
  return order.map(n => byName.get(n));
}

function ctrf(rawTests) {
  const tests = mergeWorstFirst(rawTests);
  const passed = tests.filter(t => t.status === 'passed').length;
  const failed = tests.filter(t => t.status === 'failed').length;
  return {
    results: {
      tool: { name: 'jest-ctrf-json-reporter' },
      summary: {
        tests: tests.length, passed: passed, failed: failed,
        pending: 0, skipped: 0, other: 0,
        start: Date.now() - 1000, stop: Date.now()
      },
      tests: tests
    }
  };
}

// ---------------------------------------------------------------------------
// Real TypeScript type-checking of the public API contract.
//
// Everything above only checks RUNTIME behavior -- it erases types before
// execution, same as the language's own erasable-syntax semantics, so it
// cannot see whether the promised exported interfaces (SpatialElement,
// ClashResult, ClashRecord, AxisAlignedBoundingBox, ClashOptions,
// ClearanceInfo, ClearanceMatrixResult, ...) genuinely exist with the
// documented shapes. This step does: it writes a small conformance file
// into the submitted spatial directory that imports the public API and
// constructs/reads values exactly as instruction.md documents, then asks
// the real TypeScript compiler (not this project's bespoke runtime
// stripper) whether that file type-checks. A submission that renamed,
// dropped, or reshaped an exported type fails to compile here even if its
// runtime behavior happens to satisfy the F2P assertions.
//
// Deliberately loose on the OUTPUT side (fields are read back as their
// primitive category -- string/number/boolean/array -- not the reference's
// exact literal unions), so an implementation that widens a type (e.g.
// `severity: string` instead of the narrower union) is not penalized for
// being less restrictive than the reference. Strict on the INPUT side
// (constructing values using literals straight from the instruction), so a
// type that's missing a documented field or excludes a documented literal
// genuinely fails to compile.
const SPATIAL_DIR = path.join(TESTS_DIR, '..', 'src', 'spatial');
const TYPECHECK_TEST_NAME = 'TypeScript Public API: exported types satisfy the documented contract';

// Only three types are ever imported BY NAME here: `SpatialElement`,
// `ClashResult`, and `ClashRecord`. Those are the only ones instruction.md
// actually capitalizes and names as types -- everything else the
// instruction documents (the bounding box shape, the options parameter,
// calculateClearance's return, buildClearanceMatrix's return) is described
// inline as a field list, never given a formal type name. So this file
// verifies THOSE shapes structurally, through TypeScript's own inference on
// the real function call sites (return values, inline argument object
// literals) -- never requiring the implementation to export a type called
// `AxisAlignedBoundingBox`, `ClashOptions`, `ClearanceInfo`, or
// `ClearanceMatrixResult`, since the instruction never promised those
// specific names. An implementation naming its internal types anything it
// likes, or not naming them at all, still passes as long as the public
// FUNCTIONS accept and return the documented shapes.
const CONFORMANCE_SOURCE = [
  "import {",
  "  createAxisAlignedBoundingBox,",
  "  detectClashes,",
  "  calculateClearance,",
  "  buildClearanceMatrix,",
  "  groupClashes,",
  "  exportClashReport,",
  "  findClashClusters,",
  "  suggestResolution,",
  "  worstCluster,",
  "  rankClusters,",
  "  createClashSession,",
  "  createClashJournal,",
  "  analyzeHotspots",
  "} from './index';",
  "import type { SpatialElement, ClashResult, ClashRecord } from './index';",
  "",
  "// AxisAlignedBoundingBox shape -- checked structurally via the actual",
  "// return value of createAxisAlignedBoundingBox, never a named import.",
  "const box = createAxisAlignedBoundingBox([0, 0, 0], [1, 1, 1]);",
  "const _min: readonly number[] = box.min;",
  "const _max: readonly number[] = box.max;",
  "const _size: readonly number[] = box.size;",
  "const _center: readonly number[] = box.center;",
  "",
  "const element: SpatialElement = {",
  "  id: 'e1',",
  "  name: 'Element',",
  "  discipline: 'structural',",
  "  boundingBox: box,",
  "  properties: { note: 'ok' }",
  "};",
  "const element2: SpatialElement = {",
  "  id: 'e2', name: 'Element2', discipline: 'mechanical', boundingBox: box",
  "};",
  "",
  "// options shape -- passed inline so TypeScript checks the literal",
  "// directly against whatever type detectClashes' second parameter",
  "// actually has, never a named `ClashOptions` import.",
  "const result: ClashResult = detectClashes([element, element2], {",
  "  tolerance: 1,",
  "  minSeverity: 'high',",
  "  includeTouching: true,",
  "  filterDisciplines: ['structural', 'mechanical', 'electrical', 'plumbing', 'architectural', 'generic']",
  "});",
  "const _total: number = result.summary.total;",
  "const _hard: number = result.summary.hard;",
  "const _clearance: number = result.summary.clearance;",
  "const _processed: number = result.summary.processedElements;",
  "",
  "const record: ClashRecord = result.clashes[0];",
  "const _id: string = record.id;",
  "const _elementA: SpatialElement = record.elementA;",
  "const _elementB: SpatialElement = record.elementB;",
  "const _elementAName: string = record.elementA.name;",
  "const _elementADiscipline: string = record.elementA.discipline;",
  "const _elementABoxMin: readonly number[] = record.elementA.boundingBox.min;",
  "const _type: string = record.type;",
  "const _severity: string = record.severity;",
  "const _distance: number = record.distance;",
  "// penetrationDepth/intersectionBox are documented as optional ClashRecord",
  "// fields -- reading them with their real optional types (not `any`) fails",
  "// typecheck if a solution drops either field from the exported type.",
  "const _penetrationDepth: number | undefined = record.penetrationDepth;",
  "const _intersectionBox: { min: readonly number[]; max: readonly number[]; size: readonly number[]; center: readonly number[] } | undefined = record.intersectionBox;",
  "if (_intersectionBox) {",
  "  const _ibMin: readonly number[] = _intersectionBox.min;",
  "  const _ibMax: readonly number[] = _intersectionBox.max;",
  "}",
  "",
  "// ClearanceInfo shape -- checked structurally via calculateClearance's",
  "// actual return value, never a named import.",
  "const clearance = calculateClearance(element, element2, 1);",
  "const _cd: number = clearance.distance;",
  "const _hc: boolean = clearance.hasConflict;",
  "const _pA: readonly number[] = clearance.closestPoints.pointA;",
  "const _pB: readonly number[] = clearance.closestPoints.pointB;",
  "",
  "// ClearanceMatrixResult shape -- checked structurally via",
  "// buildClearanceMatrix's actual return value, never a named import.",
  "const matrix = buildClearanceMatrix([element, element2], 1, 10);",
  "const _ids: readonly string[] = matrix.elementIds;",
  "const _mat: readonly (readonly number[])[] = matrix.matrix;",
  "const _viol = matrix.violations[0];",
  "if (_viol) {",
  "  const _vA: string = _viol.elementA;",
  "  const _vB: string = _viol.elementB;",
  "  const _vD: number = _viol.distance;",
  "  const _vR: number = _viol.requiredClearance;",
  "}",
  "",
  "const grouped: Record<string, ClashRecord[]> = groupClashes(result.clashes, 'element');",
  "const jsonReport: string = exportClashReport(result, 'json');",
  "const textReport: string = exportClashReport(result, 'summary_text');",
  "",
  "// ClashCluster shape -- checked structurally via findClashClusters'",
  "// actual return value, never a named import.",
  "const clusters = findClashClusters(result.clashes);",
  "const _cluster = clusters[0];",
  "if (_cluster) {",
  "  const _clusterIds: readonly string[] = _cluster.elementIds;",
  "  const _clusterCount: number = _cluster.clashCount;",
  "}",
  "",
  "// ClashResolution shape -- checked structurally via suggestResolution's",
  "// actual return value, never a named import.",
  "const resolution = suggestResolution(record);",
  "const _axis: number = resolution.axis;",
  "const _direction: number = resolution.direction;",
  "const _resDistance: number = resolution.distance;",
  "",
  "// worstCluster reuses the ClashCluster shape, checked structurally above;",
  "// this just confirms the function itself is exported and nullable.",
  "const worst = worstCluster(result.clashes);",
  "if (worst) {",
  "  const _worstIds: readonly string[] = worst.elementIds;",
  "  const _worstCount: number = worst.clashCount;",
  "}",
  "",
  "// rankClusters returns the same ClashCluster shape, checked structurally",
  "// above; this confirms it is exported and returns an array.",
  "const ranked: readonly { elementIds: readonly string[]; clashCount: number }[] = rankClusters(result.clashes);",
  "",
  "// ClashSession shape -- checked structurally through the real session's",
  "// own methods, never a named import.",
  "const session = createClashSession({ tolerance: 1 });",
  "session.add(element).add(element2);",
  "session.remove('e2');",
  "const _sessionResult: ClashResult = session.results();",
  "const _sessionDelta = session.delta();",
  "const _deltaAdded: readonly string[] = _sessionDelta.added;",
  "const _deltaRemoved: readonly string[] = _sessionDelta.removed;",
  "",
  "// ClashJournal/Hotspot shapes -- checked structurally through the real",
  "// journal's own methods and analyzeHotspots' actual return value, never",
  "// through named ClashJournal/ClashSnapshot/Hotspot type imports.",
  "const journal = createClashJournal();",
  "journal.record(result).record(result, 5);",
  "const _history = journal.history();",
  "const _snapshot = _history[0];",
  "if (_snapshot) {",
  "  const _snapTs: number = _snapshot.timestamp;",
  "  const _snapResult: ClashResult = _snapshot.result;",
  "}",
  "const _since: readonly { timestamp: number; result: ClashResult }[] = journal.since(0);",
  "const hotspots = analyzeHotspots(journal, { minOccurrences: 1, limit: 5 });",
  "const _hotspot = hotspots[0];",
  "if (_hotspot) {",
  "  const _hsId: string = _hotspot.elementId;",
  "  const _hsOccurrences: number = _hotspot.occurrences;",
  "  const _hsWorst: string = _hotspot.worstSeverity;",
  "  const _hsTrend: 'worsening' | 'improving' | 'stable' = _hotspot.trend;",
  "}",
  ""
].join('\n');

// Locate a real `typescript` package without assuming a specific install
// method: a local dependency, the compiler already loaded into this
// process, or -- since it's only installed globally on this image, never
// downloaded here -- via `npm root -g`, which reports wherever npm
// actually put global packages for whatever prefix/config is active.
function locateTypescript() {
  // SECURITY: this process writes the trusted CTRF reports, so it must never
  // execute anything the submitted diff could have planted. A bare
  // require('typescript') walks up node_modules from this script's own
  // cwd -- which test.sh sets to /app, the agent's own checkout -- so a
  // submission committing its own node_modules/typescript/index.js would be
  // require()'d here, unsandboxed, before the real reports are written. Every
  // lookup below is instead resolved via an EXPLICIT paths list that only
  // ever names locations outside the agent's repository tree (an env var the
  // committed diff cannot set, or fixed system paths a git diff cannot reach
  // inside /app), so the default cwd-relative walk-up is never consulted.
  const attempts = [];
  const trustedRoots = [];
  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) {
      if (p) trustedRoots.push(p);
    }
  }
  try {
    const { execSync } = require('child_process');
    const globalRoot = execSync('npm root -g', { encoding: 'utf8', timeout: 15000 }).trim();
    if (globalRoot) trustedRoots.push(globalRoot);
  } catch (e) { attempts.push('npm root -g: ' + e.message); }
  trustedRoots.push(
    '/usr/lib/node_modules', '/usr/local/lib/node_modules',
    '/usr/local/lib/node_modules/npm/node_modules'
  );
  for (const root of trustedRoots) {
    try {
      const resolved = require.resolve('typescript', { paths: [root] });
      return require(resolved);
    } catch (e) { attempts.push(root + ': ' + e.message); }
  }
  console.error('[typecheck] typescript not reachable via any trusted root:\n  ' + attempts.join('\n  '));
  return null;
}

function runTypeConformanceCheck() {
  const ts = locateTypescript();
  if (!ts || typeof ts.createProgram !== 'function') {
    return { name: TYPECHECK_TEST_NAME, status: 'failed', duration: 1 };
  }
  const conformancePath = path.join(SPATIAL_DIR, '__type_conformance_check__.ts');
  try {
    fs.writeFileSync(conformancePath, CONFORMANCE_SOURCE);
    const program = ts.createProgram([conformancePath], {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10 || ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
      strict: false,
      noEmit: true
    });
    const sourceFile = program.getSourceFile(conformancePath);
    const diagnostics = []
      .concat(program.getSyntacticDiagnostics(sourceFile))
      .concat(program.getSemanticDiagnostics(sourceFile));
    if (diagnostics.length > 0) {
      const formatted = ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCurrentDirectory: () => SPATIAL_DIR,
        getCanonicalFileName: (f) => f,
        getNewLine: () => '\n'
      });
      console.error('[typecheck] ' + diagnostics.length + ' diagnostic(s) against the public API contract:\n' + formatted);
      return { name: TYPECHECK_TEST_NAME, status: 'failed', duration: 1 };
    }
    console.log('[typecheck] public API types satisfy the documented contract (0 diagnostics).');
    return { name: TYPECHECK_TEST_NAME, status: 'passed', duration: 1 };
  } catch (e) {
    console.error('[typecheck] conformance check crashed: ' + errMessageLocal(e));
    return { name: TYPECHECK_TEST_NAME, status: 'failed', duration: 1 };
  } finally {
    try { fs.unlinkSync(conformancePath); } catch (e) { /* best effort cleanup */ }
  }
}
function errMessageLocal(e) { try { return e && e.message ? String(e.message) : String(e); } catch (_) { return 'unknown error'; } }

// ---------------------------------------------------------------------------
try { fs.mkdirSync(VERIFIER_DIR, { recursive: true }); } catch (e) { /* exists */ }

// Baseline suite -> base_ctrf.json (the pass-to-pass regression selection).
let baseTests = [];
for (const f of P2P_FILES) baseTests = baseTests.concat(runTestFile(f));
fs.writeFileSync(path.join(VERIFIER_DIR, 'base_ctrf.json'), JSON.stringify(ctrf(baseTests), null, 2));

// Feature suites -> combined into new_ctrf.json alongside the baseline.
let featureTests = [];
for (const f of F2P_FILES) featureTests = featureTests.concat(runTestFile(f));
featureTests.push(runTypeConformanceCheck());
const allTests = baseTests.concat(featureTests);
fs.writeFileSync(path.join(VERIFIER_DIR, 'new_ctrf.json'), JSON.stringify(ctrf(allTests), null, 2));

console.log('Evaluator finished: Total=' + allTests.length +
  ' P2P=' + baseTests.length + '/' + baseTests.filter(t => t.status === 'passed').length + ' passed' +
  ' F2P=' + featureTests.length + '/' + featureTests.filter(t => t.status === 'passed').length + ' passed');
NODEOF
set -e
# >>> END RUN TESTS <<<

# Surface raw suite output into stdout (the harness captures it) so failures
# stay debuggable even when a framework report omits the reason.
_seen=""
for _rl in "$RUN_LOG" /logs/verifier/*_run.log /logs/verifier/*-run.log /logs/verifier/*.log /logs/verifier/*.out; do
  [ -f "$_rl" ] && [ -s "$_rl" ] || continue
  case " $_seen " in *" $_rl "*) continue ;; esac
  case "${_rl##*/}" in *convert*.log|ctrf*.log|junit*.log) continue ;; esac
  _seen="$_seen $_rl"
  echo "===== raw suite output: ${_rl##*/} ====="
  cat "$_rl"
done 2>/dev/null
echo "===== grade ====="

python3 /tests/grader.py grade
log "reward.json=$(cat /logs/verifier/reward.json 2>/dev/null)"

# Uniform top level: keep only the canonical artifacts in /logs/verifier and
# move every framework-native report/log under reports/.
mkdir -p /logs/verifier/reports 2>/dev/null
for _f in /logs/verifier/*; do
  case "${_f##*/}" in
    reward.json|reward.txt|ctrf.json|run.log|test-stdout.txt|reports) continue ;;
  esac
  [ -f "$_f" ] && mv -f "$_f" /logs/verifier/reports/ 2>/dev/null
done
