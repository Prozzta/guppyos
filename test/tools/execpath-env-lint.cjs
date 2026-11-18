'use strict';
/**
 * TEST-EXECPATH-ENV-108: a static check that no test or tool spawns process.execPath with an env
 * that may lack ELECTRON_RUN_AS_NODE (under the Electron leg such a child is a REAL Electron app).
 *
 * The env of each such spawn must be VISIBLY one of:
 *  - absent (the child inherits process.env, key included);
 *  - process.env, or a nodeEnv(...) call (test/tools/node-env.cjs);
 *  - an object literal that sets ELECTRON_RUN_AS_NODE to a non-empty string, or spreads one of these;
 *  - a same-file local or function whose value/returns are one of these and which never deletes the
 *    key (delete x.ELECTRON_RUN_AS_NODE, or a delete loop over a list that names it, or a rest
 *    destructure that pulls it out).
 * Anything else (an allowlist, a parameter, this.env, an imported builder) is a finding: wrap it in
 * nodeEnv(). The check is deliberately conservative: unknown is a finding, not a pass.
 *
 * Spawns found: spawn/spawnSync/execFile/execFileSync/fork/spawnAsync whose command is
 * process.execPath or a same-file `const X = process.execPath` alias; and a same-file helper called
 * with an array literal whose first element is one of those, at each spawn inside it whose command
 * is <that parameter>[0].
 * Not covered (and why safe): PtyManager spawns (command: process.execPath) go through buildPtyEnv,
 * which keeps the key (pinned in test/execpath-env-guard.test.cjs). Intentional electron.exe
 * launches spawn the electron binary by path, never process.execPath, so they are not matched.
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const KEY = 'ELECTRON_RUN_AS_NODE';
const CALLS = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'spawnAsync']);
const DIRS = ['test', 'tools', 'scripts'];

const calleeName = (c) => (ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '');
const isProcessEnv = (n) => ts.isPropertyAccessExpression(n) && n.name.text === 'env' && ts.isIdentifier(n.expression) && n.expression.text === 'process';
const isProcessExecPath = (n) => !!n && ts.isPropertyAccessExpression(n) && n.name.text === 'execPath' && ts.isIdentifier(n.expression) && n.expression.text === 'process';
const isFn = (n) => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
const strip = (n) => { while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression?.(n) || ts.isNonNullExpression?.(n))) n = n.expression; return n; };

function analyzeSource(text, file = 'x.cjs') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const aliases = new Set();
  const fns = new Map();
  const all = (n, f) => { f(n); ts.forEachChild(n, (c) => all(c, f)); };
  all(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = strip(n.initializer);
      if (isProcessExecPath(init)) aliases.add(n.name.text);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) (fns.get(n.name.text) || fns.set(n.name.text, []).get(n.name.text)).push(init);
    }
    if (ts.isFunctionDeclaration(n) && n.name) (fns.get(n.name.text) || fns.set(n.name.text, []).get(n.name.text)).push(n);
  });
  const isExec = (n) => { n = strip(n); return isProcessExecPath(n) || (!!n && ts.isIdentifier(n) && aliases.has(n.text)); };

  // Declarations of `name` visible from `at`: [{kind, node, scope}]
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

  // Does `scope` delete KEY from `name` (or assign it something other than a non-empty string)?
  function strips(name, scope) {
    let hit = null;
    const mentionsKey = (n) => { let m = false; all(n, (x) => { if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text === KEY) m = true; }); return m; };
    all(scope, (n) => {
      if (hit) return;
      if (ts.isDeleteExpression(n)) {
        const e = strip(n.expression);
        const target = (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) && ts.isIdentifier(e.expression) && e.expression.text === name;
        if (!target) return;
        if (ts.isPropertyAccessExpression(e) && e.name.text === KEY) hit = n;
        else if (ts.isElementAccessExpression(e)) {
          const a = strip(e.argumentExpression);
          if (ts.isStringLiteral(a) && a.text === KEY) hit = n;
          else if (!ts.isStringLiteral(a)) {
            // delete name[k]: a finding when the enclosing loop (or the scope) names the key.
            let loop = n; while (loop && loop !== scope && !(ts.isForOfStatement(loop) || ts.isForInStatement(loop) || ts.isForStatement(loop))) loop = loop.parent;
            if (mentionsKey(loop && loop !== scope ? loop : scope)) hit = n;
          }
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = strip(n.left);
        if (ts.isPropertyAccessExpression(l) && l.name.text === KEY && ts.isIdentifier(l.expression) && l.expression.text === name) {
          const r = strip(n.right); if (!(ts.isStringLiteral(r) && r.text)) hit = n;
        }
      }
    });
    return hit;
  }

  // null when env is safe, else a short reason.
  function envBad(expr, depth = 0) {
    if (depth > 6) return 'env too indirect to verify';
    const e = strip(expr);
    if (!e) return null;
    if (isProcessEnv(e)) return null;
    if (ts.isConditionalExpression(e)) return envBad(e.whenTrue, depth + 1) || envBad(e.whenFalse, depth + 1);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) return envBad(e.left, depth + 1) || envBad(e.right, depth + 1);
    if (ts.isCallExpression(e)) {
      const n = calleeName(e.expression);
      if (n === 'nodeEnv') return null;
      // Object.assign(target, ...): adds keys to target; safe when target is (a source cannot delete).
      if (n === 'assign' && ts.isPropertyAccessExpression(e.expression) && e.expression.expression.getText(sf) === 'Object' && e.arguments.length) {
        for (const s of e.arguments.slice(1)) { const o = strip(s); if (ts.isObjectLiteralExpression(o) && o.properties.some((p) => p.name && p.name.getText(sf).replace(/['"]/g, '') === KEY)) return `Object.assign sets ${KEY}`; }
        return envBad(e.arguments[0], depth + 1);
      }
      const defs = ts.isIdentifier(e.expression) ? fns.get(n) : null;
      if (!defs) return `env is ${e.expression.getText(sf)}(...), not nodeEnv()`;
      for (const f of defs) {
        if (!ts.isBlock(f.body)) { const r = envBad(f.body, depth + 1); if (r) return `${n}(): ${r}`; continue; }
        let r = null; let any = false;
        all(f.body, (x) => { if (r || !ts.isReturnStatement(x) || !x.expression) return; let p = x.parent; while (p && !isFn(p)) p = p.parent; if (p !== f) return; any = true; r = envBad(x.expression, depth + 1); });
        if (!any) return `${n}() returns no env`;
        if (r) return `${n}(): ${r}`;
      }
      return null;
    }
    if (ts.isObjectLiteralExpression(e)) {
      let ok = false; let why = null;
      for (const p of e.properties) {
        const pn = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
        if (pn === KEY) {
          const v = ts.isPropertyAssignment(p) ? strip(p.initializer) : null;
          if (v && (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && v.text) ok = true;
          else return `${KEY} set to ${v ? v.getText(sf) : 'a non-literal'}`;
        }
        if (ts.isSpreadAssignment(p)) { const r = envBad(p.expression, depth + 1); if (!r) ok = true; else why = why || r; }
      }
      return ok ? null : why ? `spread: ${why}` : 'env is an object built without process.env or the key (an allowlist)';
    }
    if (ts.isIdentifier(e)) {
      const d = resolve(e.text, e);
      if (!d) return `env ${e.text} is not declared in this file`;
      if (d.kind === 'param') return `env ${e.text} is a parameter`;
      if (d.kind === 'loop') return `env ${e.text} is a loop variable`;
      if (d.kind === 'bind') {
        if (!d.el.dotDotDotToken) return `env ${e.text} is destructured`;
        for (const el of d.node.name.elements) { const pn = el.propertyName ? el.propertyName.getText(sf) : el.name.getText(sf); if (pn === KEY) return `env ${e.text} is a rest destructure that pulls ${KEY} out`; }
        const r = envBad(d.node.initializer, depth + 1); if (r) return r;
      } else {
        if (!d.node.initializer) return `env ${e.text} has no initializer`;
        const r = envBad(d.node.initializer, depth + 1); if (r) return `env ${e.text}: ${r}`;
        // later assignments of the whole binding
        let re = null;
        all(d.scope, (x) => {
          if (re || !ts.isBinaryExpression(x) || x.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
          const l = strip(x.left);
          if (ts.isIdentifier(l) && l.text === e.text && resolve(e.text, x)?.node === d.node) re = envBad(x.right, depth + 1);
        });
        if (re) return `env ${e.text} is reassigned: ${re}`;
      }
      const s = strips(e.text, d.scope);
      if (s) return `env ${e.text} has ${KEY} deleted (line ${line(s)})`;
      return null;
    }
    return `env is ${e.getText(sf).replace(/\s+/g, ' ').slice(0, 60)}`;
  }

  // The options argument of a spawn-family call (null = none).
  function optionsOf(call) {
    const a = call.arguments;
    for (let i = a.length - 1; i >= 1; i--) {
      const x = strip(a[i]);
      if (ts.isArrayLiteralExpression(x) || isFn(x)) continue;
      if (i === 1 && a.length === 2 && !ts.isObjectLiteralExpression(x)) return null; // spawn(cmd, args)
      return x;
    }
    return null;
  }
  function spawnBad(call) {
    const o = optionsOf(call);
    if (!o) return null;
    if (ts.isObjectLiteralExpression(o)) {
      let env = null; let spread = false;
      for (const p of o.properties) {
        if (ts.isSpreadAssignment(p)) spread = true;
        if ((ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === 'env') env = p;
      }
      if (!env) return spread ? 'options spread may carry an env' : null;
      return envBad(ts.isShorthandPropertyAssignment(env) ? env.name : env.initializer);
    }
    if (ts.isIdentifier(o)) {
      const d = resolve(o.text, o);
      if (d && d.kind === 'var' && d.node.initializer && ts.isObjectLiteralExpression(strip(d.node.initializer))) return spawnBad({ arguments: [call.arguments[0], strip(d.node.initializer)] });
    }
    return `options ${o.getText(sf).replace(/\s+/g, ' ').slice(0, 40)} hide the env`;
  }

  const findings = [];
  const seen = new Set();
  const report = (call, why, via) => { const k = `${call.pos}`; if (seen.has(k)) return; seen.add(k); findings.push({ file, line: line(call), why: via ? `${why} (via ${via})` : why }); };
  all(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const name = calleeName(n.expression);
    if (CALLS.has(name) && isExec(n.arguments[0])) { const r = spawnBad(n); if (r) report(n, r); return; }
    if (!ts.isIdentifier(n.expression) || !fns.has(name)) return;
    n.arguments.forEach((arg, i) => {
      const a = strip(arg);
      if (!ts.isArrayLiteralExpression(a) || !isExec(a.elements[0])) return;
      for (const f of fns.get(name)) {
        const p = f.parameters[i];
        if (!p || !ts.isIdentifier(p.name)) continue;
        all(f.body, (x) => {
          if (!ts.isCallExpression(x) || !CALLS.has(calleeName(x.expression))) return;
          const c = strip(x.arguments[0]);
          if (c && ts.isElementAccessExpression(c) && ts.isIdentifier(c.expression) && c.expression.text === p.name.text && strip(c.argumentExpression).getText(sf) === '0') {
            const r = spawnBad(x); if (r) report(x, r, `${name}() called at line ${line(n)}`);
          }
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
    if (!text.includes('process.execPath')) continue;
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
