'use strict';
/**
 * TEST-EXECPATH-ENV-108: a static check that no test or tool spawns process.execPath with an env
 * that may lack ELECTRON_RUN_AS_NODE (under the Electron leg such a child is a REAL Electron app).
 *
 * The env of each such spawn must be VISIBLY one of:
 *  - absent (the child inherits process.env, key included), in a file that never strips the key
 *    from process.env itself;
 *  - process.env, or a nodeEnv(...) call (tools/node-env.cjs);
 *  - an object literal (or Object.assign) whose LAST word on the key is a non-empty string or a safe
 *    spread: a later spread of something that may carry the key (a parameter, an unknown object)
 *    voids an earlier safe one, and so does a computed key that may be ELECTRON_RUN_AS_NODE;
 *  - a same-file local or function whose value/returns are one of these and which never deletes or
 *    blanks the key (delete x.KEY / x['KEY'] / x[KEY], x.KEY = '' or undefined, Object.assign(x,
 *    { KEY: undefined }), a delete or write loop over a list that names it, a rest destructure that
 *    pulls it out).
 * The options must be an inline object, or a same-file local object that is never mutated in a way
 * that could replace the env (o.env = ..., Object.assign(o, ...), delete o.env.KEY); a spread after
 * env may replace it. Anything else (an allowlist, a parameter, this.env, an imported builder) is a
 * finding: wrap it in nodeEnv(). The check is deliberately conservative: unknown is a finding.
 *
 * Spawns found:
 *  - spawn/spawnSync/execFile/execFileSync/spawnAsync whose command is process.execPath (also
 *    process['execPath']), a same-file alias of it (const X = process.execPath, const { execPath }
 *    = process, a chain of aliases), or a template / concatenation that contains one;
 *  - exec/execSync whose command string contains one of those;
 *  - every fork() (it runs process.execPath unless its options name another execPath);
 *  - a same-file helper called with one of those as an argument (the parameter used directly as a
 *    command, or inside a command string), or with an array literal whose first element is one
 *    (the parameter's [0] used as a command).
 * Files are read when they mention execPath or fork( at all (an alias need not spell process.execPath).
 * Not covered (and why safe): PtyManager spawns (command: process.execPath) go through buildPtyEnv,
 * which keeps the key (pinned in test/execpath-env-guard.test.cjs). Intentional electron.exe
 * launches spawn the electron binary by path, never process.execPath, so they are not matched.
 * Cross-file helpers (an imported function fed process.execPath) are not followed.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const KEY = 'ELECTRON_RUN_AS_NODE';
const CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'spawnAsync']);
const EXEC = new Set(['exec', 'execSync']);
const DIRS = ['test', 'tools', 'scripts'];

const calleeName = (c) => (ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '');
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const strip = (n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression?.(n) || ts.isNonNullExpression?.(n))) n = n.expression; return n; };
const isStr = (n) => !!n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n));
// The member name of x.name or x['name'] (null for a computed, non-literal member).
const member = (n) => (ts.isPropertyAccessExpression(n) ? n.name.text : ts.isElementAccessExpression(n) && isStr(strip(n.argumentExpression)) ? strip(n.argumentExpression).text : null);
const isProcess = (n) => { n = strip(n); return !!n && ts.isIdentifier(n) && n.text === 'process'; };
const isProcessMember = (name) => (n) => { n = strip(n); return !!n && (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && member(n) === name && isProcess(n.expression); };
const isProcessEnv = isProcessMember('env');
const isProcessExecPath = isProcessMember('execPath');
const isConcat = (n) => ts.isTemplateExpression(n) || (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken);

function analyzeSource(text, file = 'x.cjs') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const txt = (n, max = 60) => n.getText(sf).replace(/\s+/g, ' ').slice(0, max);
  // An access path in one spelling: process['env'] and process.env are the same target.
  const norm = (n) => strip(n).getText(sf).replace(/\s+/g, '').replace(/\[(['"`])([A-Za-z_$][\w$]*)\1\]/g, '.$2');
  const all = (n, f) => { f(n); ts.forEachChild(n, (c) => all(c, f)); };

  const fns = new Map();
  const keyConsts = new Set(['KEY']);
  all(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = strip(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) (fns.get(n.name.text) || fns.set(n.name.text, []).get(n.name.text)).push(init);
      if (isStr(init) && init.text === KEY) keyConsts.add(n.name.text);
    }
    if (ts.isFunctionDeclaration(n) && n.name) (fns.get(n.name.text) || fns.set(n.name.text, []).get(n.name.text)).push(n);
  });
  const isKeyRef = (n) => { n = strip(n); return !!n && ((isStr(n) && n.text === KEY) || (ts.isIdentifier(n) && keyConsts.has(n.text)) || (ts.isPropertyAccessExpression(n) && n.name.text === 'KEY')); };

  // Aliases of process.execPath, to a fixpoint (a chain of aliases, a destructure of process).
  const aliases = new Set();
  const isExec = (n) => {
    n = strip(n);
    if (!n) return false;
    if (isProcessExecPath(n) || (ts.isIdentifier(n) && aliases.has(n.text))) return true;
    if (ts.isConditionalExpression(n)) return isExec(n.whenTrue) || isExec(n.whenFalse);
    if (ts.isBinaryExpression(n) && (n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || n.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return isExec(n.left) || isExec(n.right);
    return false;
  };
  for (let grew = true; grew;) {
    grew = false;
    const add = (id) => { if (ts.isIdentifier(id) && !aliases.has(id.text)) { aliases.add(id.text); grew = true; } };
    all(sf, (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        if (ts.isIdentifier(n.name) && isExec(n.initializer)) add(n.name);
        if (ts.isObjectBindingPattern(n.name) && isProcess(n.initializer)) {
          for (const el of n.name.elements) { const pn = el.propertyName ? el.propertyName.getText(sf).replace(/['"]/g, '') : el.name.getText(sf); if (pn === 'execPath') add(el.name); }
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(strip(n.left)) && isExec(n.right)) add(strip(n.left));
    });
  }
  const containsExec = (n) => { let hit = false; if (n) all(n, (x) => { if (!hit && isExec(x)) hit = true; }); return hit; };
  // A command that runs process.execPath: the path itself, or a command string built with it.
  const cmdIsExec = (n) => { n = strip(n); return !!n && (isExec(n) || (isConcat(n) && containsExec(n))); };

  // Declarations of `name` visible from `at`: {kind, node, scope}
  function resolve(name, at) {
    for (let s = at; s; s = s.parent) {
      if (isFn(s)) {
        for (const p of s.parameters) {
          if (ts.isIdentifier(p.name) && p.name.text === name) return { kind: 'param', node: p, scope: s };
          if (!ts.isIdentifier(p.name) && p.name.getText(sf).includes(name)) return { kind: 'param', node: p, scope: s };
        }
      }
      if (ts.isBlock(s) || ts.isSourceFile(s) || ts.isCaseClause?.(s) || ts.isModuleBlock?.(s) || (isFn(s) && !ts.isBlock(s.body))) {
        const stmts = s.statements || [];
        for (const st of stmts) {
          if (!ts.isVariableStatement(st)) continue;
          for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name) return { kind: 'var', node: d, scope: s };
            if (ts.isObjectBindingPattern(d.name)) {
              for (const el of d.name.elements) if (ts.isIdentifier(el.name) && el.name.text === name) return { kind: 'bind', node: d, el, scope: s };
            }
          }
        }
      }
      if ((ts.isForOfStatement(s) || ts.isForInStatement(s) || ts.isForStatement(s)) && s.initializer && ts.isVariableDeclarationList(s.initializer)) {
        for (const d of s.initializer.declarations) if (ts.isIdentifier(d.name) && d.name.text === name) return { kind: 'loop', node: d, scope: s };
      }
    }
    return null;
  }

  const isObjectAssign = (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'assign' && c.expression.expression.getText(sf) === 'Object';
  const isReflectDelete = (c) => ts.isCallExpression(c) && ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'deleteProperty' && c.expression.expression.getText(sf) === 'Reflect';
  // The command of the spawn being checked (normalised text), or null (fork, exec strings).
  let curCmd = null;
  // 'eq' when cond is `<command> === process.execPath` (or ==), 'ne' for !== / !=, else null. Only the
  // arm taken when the command IS process.execPath matters; the other runs some other binary.
  const cmdGuard = (cond) => {
    const c = strip(cond);
    if (!curCmd || !c || !ts.isBinaryExpression(c)) return null;
    const k = c.operatorToken.kind;
    const eq = k === ts.SyntaxKind.EqualsEqualsEqualsToken || k === ts.SyntaxKind.EqualsEqualsToken;
    const ne = k === ts.SyntaxKind.ExclamationEqualsEqualsToken || k === ts.SyntaxKind.ExclamationEqualsToken;
    if (!eq && !ne) return null;
    const [l, r] = [strip(c.left), strip(c.right)];
    const other = isExec(l) && !isExec(r) ? r : isExec(r) && !isExec(l) ? l : null;
    if (!other || norm(other) !== curCmd) return null;
    return eq ? 'eq' : 'ne';
  };
  // The key of an object-literal member: its name, KEY for a computed key ref, '[computed]' otherwise.
  const propKey = (p) => {
    if (ts.isSpreadAssignment(p) || !p.name) return null;
    if (ts.isComputedPropertyName(p.name)) { const x = strip(p.name.expression); return isKeyRef(x) ? KEY : isStr(x) ? x.text : '[computed]'; }
    return p.name.getText(sf).replace(/^(['"])(.*)\1$/, '$2');
  };

  // Does `scope` delete or blank KEY on the target spelled `target` (e.g. 'env', 'o.env', 'process.env')?
  function strips(target, scope, depth = 0) {
    let hit = null;
    const mentionsKey = (n) => { let m = false; all(n, (x) => { if (isStr(x) && x.text === KEY) m = true; }); return m; };
    const loopNamesKey = (n) => { let loop = n; while (loop && loop !== scope && !(ts.isForOfStatement(loop) || ts.isForInStatement(loop) || ts.isForStatement(loop))) loop = loop.parent; return mentionsKey(loop && loop !== scope ? loop : scope); };
    // 'key' when e is target.KEY / target[KEY]; 'maybe' for target[k] with a non-literal k; else null.
    const keyAccess = (e) => {
      e = strip(e);
      if (!(ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) || norm(e.expression) !== target) return null;
      if (ts.isPropertyAccessExpression(e)) return e.name.text === KEY ? 'key' : null;
      const a = strip(e.argumentExpression);
      if (isKeyRef(a)) return 'key';
      return isStr(a) ? null : 'maybe';
    };
    all(scope, (n) => {
      if (hit) return;
      if (ts.isDeleteExpression(n)) {
        const k = keyAccess(n.expression);
        if (k === 'key' || (k === 'maybe' && loopNamesKey(n))) hit = n;
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const k = keyAccess(n.left);
        const r = strip(n.right);
        if (k === 'key' && !(isStr(r) && r.text)) hit = n;
        if (k === 'maybe' && loopNamesKey(n)) hit = n;
      }
      if (ts.isCallExpression(n) && isObjectAssign(n) && n.arguments.length && norm(n.arguments[0]) === target) {
        for (const s of n.arguments.slice(1)) if (overrideBad(s, depth + 1)) { hit = n; break; }
      }
      // Reflect.deleteProperty(target, KEY) is a delete; a non-literal key counts inside a loop naming KEY.
      if (ts.isCallExpression(n) && isReflectDelete(n) && n.arguments.length >= 2 && norm(n.arguments[0]) === target) {
        const a = strip(n.arguments[1]);
        if (isKeyRef(a) || (!isStr(a) && loopNamesKey(n))) hit = n;
      }
    });
    return hit;
  }

  const procStrip = () => { const s = procStripNode(); return s ? `process.env has ${KEY} deleted or blanked (line ${line(s)}), so an inherited env lacks it` : null; };
  let procMemo;
  const procStripNode = () => (procMemo === undefined ? (procMemo = strips('process.env', sf)) : procMemo);

  // Merge rule for an object built from parts in order: the LAST word on KEY must be safe.
  // parts: [{ spread: expr } | { key, value, node }]
  function mergeBad(parts, depth) {
    let ok = false; let why = null;
    for (const p of parts) {
      if (p.spread) {
        const r = envBad(p.spread, depth + 1);
        if (!r) { ok = true; continue; }
        if (ok) { const o = overrideBad(p.spread, depth + 1); if (o) return `a later spread may drop ${KEY}: ${o}`; }
        why = why || r;
        continue;
      }
      if (p.key === KEY) {
        const v = p.value ? strip(p.value) : null;
        if (v && isStr(v) && v.text) ok = true;
        else return `${KEY} set to ${v ? txt(v) : 'a non-literal'}`;
      } else if (p.key === '[computed]' && ok && !(p.value && isStr(strip(p.value)) && strip(p.value).text)) return `a computed key may be ${KEY}: ${txt(p.node)}`;
    }
    return ok ? null : why ? `spread: ${why}` : 'env is an object built without process.env or the key (an allowlist)';
  }
  const literalParts = (o) => o.properties.map((p) => (ts.isSpreadAssignment(p) ? { spread: p.expression } : { key: propKey(p), value: ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : null, node: p }));

  // null when expr cannot set KEY to empty/undefined when merged over a safe env, else a reason.
  function overrideBad(expr, depth = 0) {
    if (depth > 6) return 'too indirect to verify';
    const e = strip(expr);
    if (!e) return null;
    if (!envBad(e, depth + 1)) return null;
    if (ts.isConditionalExpression(e)) return overrideBad(e.whenTrue, depth + 1) || overrideBad(e.whenFalse, depth + 1);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return overrideBad(e.left, depth + 1) || overrideBad(e.right, depth + 1);
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) { const r = overrideBad(p.expression, depth + 1); if (r) return r; continue; }
        const k = propKey(p);
        const v = ts.isPropertyAssignment(p) ? strip(p.initializer) : null;
        const safeValue = !!(v && isStr(v) && v.text);
        if (k === '[computed]' && !safeValue) return `a computed key may be ${KEY}: ${txt(p)}`;
        if (k === KEY && !safeValue) return `${KEY} set to ${v ? txt(v) : 'a non-literal'}`;
      }
      return null;
    }
    if (ts.isIdentifier(e)) {
      const d = resolve(e.text, e);
      if (!d) return `${e.text} is not declared in this file and may carry ${KEY}`;
      if (d.kind !== 'var' || !d.node.initializer) return `${e.text} is a ${d.kind === 'param' ? 'parameter' : d.kind} and may carry ${KEY}`;
      const r = overrideBad(d.node.initializer, depth + 1); if (r) return `${e.text}: ${r}`;
      if (reassigned(e.text, d, depth)) return `${e.text} is reassigned`;
      const s = strips(e.text, d.scope, depth + 1); if (s) return `${e.text} has ${KEY} written (line ${line(s)})`;
      return null;
    }
    return `${txt(e)} may carry ${KEY}`;
  }

  function reassigned(name, d, depth) {
    let re = null;
    all(d.scope, (x) => {
      if (re || !ts.isBinaryExpression(x) || x.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
      const l = strip(x.left);
      if (ts.isIdentifier(l) && l.text === name && resolve(name, x)?.node === d.node) re = envBad(x.right, depth + 1) || null;
    });
    return re;
  }

  // null when env is safe, else a short reason.
  function envBad(expr, depth = 0) {
    if (depth > 6) return 'env too indirect to verify';
    const e = strip(expr);
    if (!e) return null;
    if (isProcessEnv(e)) return procStrip();
    if (ts.isConditionalExpression(e)) {
      const g = cmdGuard(e.condition);
      if (g === 'eq') return envBad(e.whenTrue, depth + 1);
      if (g === 'ne') return envBad(e.whenFalse, depth + 1);
      return envBad(e.whenTrue, depth + 1) || envBad(e.whenFalse, depth + 1);
    }
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return envBad(e.left, depth + 1) || envBad(e.right, depth + 1);
    if (ts.isCallExpression(e)) {
      const n = calleeName(e.expression);
      if (n === 'nodeEnv') return null;
      // Object.assign(target, ...sources): the merge rule over target then each source in order.
      if (isObjectAssign(e) && e.arguments.length) return mergeBad(e.arguments.map((a) => (ts.isObjectLiteralExpression(strip(a)) ? literalParts(strip(a)) : [{ spread: a }])).flat(), depth);
      const defs = ts.isIdentifier(e.expression) ? fns.get(n) : null;
      if (!defs) return `env is ${txt(e.expression)}(...), not nodeEnv()`;
      for (const f of defs) {
        if (!ts.isBlock(f.body)) { const r = envBad(f.body, depth + 1); if (r) return `${n}(): ${r}`; continue; }
        let r = null; let any = false;
        all(f.body, (x) => { if (r || !ts.isReturnStatement(x) || !x.expression) return; let p = x.parent; while (p && !isFn(p)) p = p.parent; if (p !== f) return; any = true; r = envBad(x.expression, depth + 1); });
        if (!any) return `${n}() returns no env`;
        if (r) return `${n}(): ${r}`;
      }
      return null;
    }
    if (ts.isObjectLiteralExpression(e)) return mergeBad(literalParts(e), depth);
    if (ts.isIdentifier(e)) {
      const d = resolve(e.text, e);
      if (!d) return `env ${e.text} is not declared in this file`;
      if (d.kind === 'param') return `env ${e.text} is a parameter`;
      if (d.kind === 'loop') return `env ${e.text} is a loop variable`;
      if (d.kind === 'bind') {
        if (!d.el.dotDotDotToken) return `env ${e.text} is destructured`;
        for (const el of d.node.name.elements) { const pn = el.propertyName ? el.propertyName.getText(sf).replace(/['"]/g, '') : el.name.getText(sf); if (pn === KEY) return `env ${e.text} is a rest destructure that pulls ${KEY} out`; }
        const r = envBad(d.node.initializer, depth + 1); if (r) return r;
      } else {
        if (!d.node.initializer) return `env ${e.text} has no initializer`;
        const r = envBad(d.node.initializer, depth + 1); if (r) return `env ${e.text}: ${r}`;
        const re = reassigned(e.text, d, depth);
        if (re) return `env ${e.text} is reassigned: ${re}`;
      }
      const s = strips(e.text, d.scope, depth + 1);
      if (s) return `env ${e.text} has ${KEY} deleted, blanked or overwritten (line ${line(s)})`;
      return null;
    }
    return `env is ${txt(e)}`;
  }

  // The options argument of a spawn-family call (null = none).
  function optionsOf(call, name) {
    const a = call.arguments;
    if (EXEC.has(name)) { const x = strip(a[1]); return x && !isFn(x) ? x : null; }
    for (let i = a.length - 1; i >= 1; i--) {
      const x = strip(a[i]);
      if (ts.isArrayLiteralExpression(x) || isFn(x)) continue;
      if (i === 1 && a.length === 2 && !ts.isObjectLiteralExpression(x) && name !== 'fork') return null; // spawn(cmd, args)
      if (i === 1 && a.length === 2 && name === 'fork' && !ts.isObjectLiteralExpression(x) && !ts.isIdentifier(x)) return null;
      return x;
    }
    return null;
  }

  // A same-file options object mutated after creation: null, or a reason.
  function optionsMutated(name, d, fork) {
    let hit = null;
    all(d.scope, (x) => {
      if (hit) return;
      if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = strip(x.left);
        if (ts.isIdentifier(l) && l.text === name && resolve(name, x)?.node === d.node) { const r = optsBad(x.right, fork); if (r) hit = `options ${name} reassigned: ${r}`; }
        if ((ts.isPropertyAccessExpression(l) || ts.isElementAccessExpression(l)) && norm(l.expression) === name && member(l) === 'env') { const r = envBad(x.right); if (r) hit = `options ${name}.env replaced (line ${line(x)}): ${r}`; }
        if (ts.isElementAccessExpression(l) && norm(l.expression) === name && member(l) === null) hit = `options ${name}[...] written (line ${line(x)}) may replace the env`;
      }
      if (ts.isCallExpression(x) && isObjectAssign(x) && x.arguments.length && norm(x.arguments[0]) === name) {
        for (const s of x.arguments.slice(1)) {
          const o = strip(s);
          if (!ts.isObjectLiteralExpression(o)) { hit = `Object.assign(${name}, ${txt(o, 30)}) may replace the env (line ${line(x)})`; break; }
          for (const p of o.properties) {
            if (ts.isSpreadAssignment(p)) { hit = `Object.assign(${name}, { ...${txt(p.expression, 30)} }) may replace the env (line ${line(x)})`; break; }
            if (propKey(p) === 'env') { const r = envBad(ts.isShorthandPropertyAssignment(p) ? p.name : p.initializer); if (r) { hit = `options ${name}.env replaced (line ${line(x)}): ${r}`; break; } }
          }
          if (hit) break;
        }
      }
    });
    if (hit) return hit;
    const s = strips(`${name}.env`, d.scope);
    return s ? `options ${name}.env has ${KEY} deleted or blanked (line ${line(s)})` : null;
  }

  function optsBad(o, fork) {
    o = strip(o);
    if (!o) return procStrip();
    if (ts.isObjectLiteralExpression(o)) {
      let env = null; let envAt = -1; let spreadAfter = false; let spread = false; let execPathProp = null;
      o.properties.forEach((p, i) => {
        if (ts.isSpreadAssignment(p)) { spread = true; if (envAt >= 0) spreadAfter = true; return; }
        const k = propKey(p);
        if (k === 'env') { env = p; envAt = i; spreadAfter = false; }
        if (k === 'execPath') execPathProp = p;
      });
      if (fork && execPathProp && ts.isPropertyAssignment(execPathProp) && !isExec(execPathProp.initializer)) return null; // fork of another binary
      if (!env) return spread ? 'options spread may carry an env' : procStrip();
      if (spreadAfter) return 'an options spread after env may replace it';
      return envBad(ts.isShorthandPropertyAssignment(env) ? env.name : env.initializer);
    }
    if (ts.isIdentifier(o)) {
      const d = resolve(o.text, o);
      if (d && d.kind === 'var' && d.node.initializer && ts.isObjectLiteralExpression(strip(d.node.initializer))) {
        return optionsMutated(o.text, d, fork) || optsBad(d.node.initializer, fork);
      }
    }
    return `options ${txt(o, 40)} hide the env`;
  }

  const findings = [];
  const seen = new Set();
  const report = (call, why, via) => { const k = `${call.pos}`; if (seen.has(k)) return; seen.add(k); findings.push({ file, line: line(call), why: via ? `${why} (via ${via})` : why }); };
  const isSpawnName = (name) => CALLS.has(name) || EXEC.has(name) || name === 'fork';
  // optsBad with curCmd set to this call's command, so a `command === process.execPath ? ...` guard applies.
  const checkOpts = (call, name) => {
    const cmd = name === 'fork' || EXEC.has(name) ? null : strip(call.arguments[0]);
    curCmd = cmd ? norm(cmd) : null;
    try { return optsBad(optionsOf(call, name), name === 'fork'); } finally { curCmd = null; }
  };
  const launches = (call, name) => (name === 'fork' ? true : EXEC.has(name) ? containsExec(call.arguments[0]) : cmdIsExec(call.arguments[0]));
  all(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n.expression);
    if (isSpawnName(name)) { if (launches(n, name)) { const r = checkOpts(n, name); if (r) report(n, r); } return; }
    if (!ts.isIdentifier(n.expression) || !fns.has(name)) return;
    n.arguments.forEach((arg, i) => {
      const a = strip(arg);
      const viaArray = ts.isArrayLiteralExpression(a) && a.elements.length && isExec(a.elements[0]);
      const direct = !viaArray && cmdIsExec(a);
      if (!viaArray && !direct) return;
      for (const f of fns.get(name)) {
        // A rest parameter (...a) at or before argument i: the command is a[i - restAt].
        const restAt = f.parameters.findIndex((q) => q.dotDotDotToken);
        const off = restAt >= 0 && i >= restAt ? i - restAt : -1;
        const p = off >= 0 ? f.parameters[restAt] : f.parameters[i];
        if (!p || !ts.isIdentifier(p.name)) continue;
        const P = p.name.text;
        const isP = (x) => { x = strip(x); return !!x && ts.isIdentifier(x) && x.text === P; };
        const idx = (x, k) => { x = strip(x); return !!x && ts.isElementAccessExpression(x) && strip(x.argumentExpression).getText(sf) === String(k) ? strip(x.expression) : null; };
        const isCmd = (x) => (off < 0 ? isP(x) : isP(idx(x, off)));
        const usesP = (c) => {
          c = strip(c);
          if (!c) return false;
          if (viaArray) return isCmd(idx(c, 0));
          if (isCmd(c)) return true;
          let hit = false; if (isConcat(c)) all(c, (y) => { if (!hit && isCmd(y)) hit = true; }); return hit;
        };
        all(f.body, (x) => {
          if (!ts.isCallExpression(x)) return;
          const xn = calleeName(x.expression);
          if (!isSpawnName(xn) || xn === 'fork' || !usesP(x.arguments[0])) return;
          const r = checkOpts(x, xn); if (r) report(x, r, `${name}() called at line ${line(n)}`);
        });
      }
    });
  });
  return findings;
}

function scan(root) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/\.(c?js|mjs)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of DIRS) if (fs.existsSync(path.join(root, d))) walk(path.join(root, d));
  const out = [];
  let checked = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // Not only the literal process.execPath: an alias (const { execPath } = process) or a fork() runs it too.
    if (!/execPath|\bfork\s*\(/.test(text)) continue;
    checked++;
    out.push(...analyzeSource(text, path.relative(root, f).replace(/\\/g, '/')));
  }
  return { findings: out, checked };
}

module.exports = { analyzeSource, scan, KEY };

if (require.main === module) {
  const r = scan(process.argv[2] || path.join(__dirname, '..', '..'));
  for (const f of r.findings) console.log(`${f.file}:${f.line}  ${f.why}`);
  console.log(`${r.findings.length} finding(s) in ${r.checked} file(s)`);
  process.exitCode = r.findings.length ? 1 : 0;
}
