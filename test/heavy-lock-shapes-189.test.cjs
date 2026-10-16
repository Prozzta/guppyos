'use strict';
/**
 * HEAVY-LOCK-SHAPES-189: shapes the classifier read as light although they run a heavy job (or the
 * reverse). Each row was LIGHT (or heavy) at int-1.1.89 66411ad6 and is classified by what it runs now:
 *   1. `source x.sh` / `. x.sh`             5. `cmd /c x.bat`, `call x.cmd`, `x.bat`
 *   2. an extensionless `node run` / `./run`  6. `node --test missing.test.cjs` (unreadable: provisional)
 *   3. depth-2 `bash -c "bash -c '...'"`     7. `$TEMP` / `${HOME}` / `~` / `$env:TEMP` from the spawn env
 *   4. `powershell -File x.ps1`, `./x.ps1`    8. writers that change a heredoc-made file: curl -o,
 *   9. `node --check x` only parses x (light)    git checkout -- / restore, node -e writeFileSync, ln -sf, dd of=
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { classifyCommand } = loadTs('src/main/heavyJob.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const SUITE = 'node test/tools/run-tests.cjs';
const lightBody = (f, run) => `cat > ${f} <<'EOF'\necho hi\nEOF\n${run}`;

function fixture(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shapes-')).replace(/\\/g, '/');
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const w = (f, s) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), s); };
  w('s.sh', `${SUITE}\n`);
  w('light.sh', 'echo hi\n');
  w('run', "#!/usr/bin/env node\nrequire('child_process').spawnSync('node', ['test/tools/run-tests.cjs']);\n");
  w('lightrun', '#!/usr/bin/env node\nconsole.log(1);\n');
  w('tool', 'MZ\0\0\nnpm ci\n');   // a binary whose bytes happen to spell a heavy command
  w('s.ps1', `${SUITE}\n`);
  w('s.bat', `@echo off\r\n${SUITE}\r\n`);
  w('ok.test.cjs', "require('node:test')('x', () => {});\n");
  w('heavy.cjs', "require('child_process').spawnSync('node', ['test/tools/run-tests.cjs']);\n");
  w('loop.sh', 'bash loop.sh\n');
  // npm's cmd-shim text for a .bin entry (as in this repo's node_modules/.bin).
  const shim = (b) => `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\n\ncase \`uname\` in\n    *CYGWIN*|*MINGW*|*MSYS*)\n        if command -v cygpath > /dev/null 2>&1; then\n            basedir=\`cygpath -w "$basedir"\`\n        fi\n    ;;\nesac\n\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/../${b}/bin/${b}.js" "$@"\nelse \n  exec node  "$basedir/../${b}/bin/${b}.js" "$@"\nfi\n`;
  for (const b of ['vitest', 'electron-vite', 'eslint']) w(`node_modules/.bin/${b}`, shim(b));
  const ctx = { ...HookServer.heavyScriptCtx(d), env: { HOME: d, USERPROFILE: d, TEMP: d, TMP: d } };
  return { d, ctx };
}

const cls = (cmd, ctx) => { const c = classifyCommand(cmd, 0, ctx); return c.heavy ? (c.provisional ? 'provisional' : `heavy:${c.kind}`) : 'light'; };

// [shape, command, after] (before = the value at 66411ad6, in the comment)
const ROWS = [
  ['1 source', 'source s.sh', 'heavy:suite'],                                   // light
  ['1 dot', '. s.sh', 'heavy:suite'],                                           // light
  ['1 source light', 'source light.sh', 'light'],                               // light
  ['2 node run', 'node run', 'heavy:bench'],                                    // light
  ['2 ./run', './run', 'heavy:bench'],                                          // light
  ['2 ./lightrun', './lightrun', 'light'],                                      // light
  ['2 ./missing', './missing', 'provisional'],                                  // light
  ['2 a binary', './tool --x', 'light'],                                        // light
  ['2 /usr/bin/env', '/usr/bin/env FOO=1', 'light'],                            // light
  ['3 depth-2', `bash -c "bash -c 'bash s.sh'"`, 'heavy:suite'],                // light
  ['3 depth-2 npm ci', `bash -c "bash -c 'npm ci'"`, 'heavy:install'],          // light
  ['3 a script that runs itself ends', 'bash loop.sh', 'light'],                // light
  ['4 powershell -File', 'powershell -File s.ps1', 'heavy:suite'],              // light
  ['4 pwsh -f', 'pwsh -f s.ps1', 'heavy:suite'],                                // light
  ['4 ./s.ps1', './s.ps1', 'heavy:suite'],                                      // light
  ['4 powershell -File missing', 'powershell -File nope.ps1', 'provisional'],   // light
  ['5 cmd /c x.bat', 'cmd /c s.bat', 'heavy:suite'],                            // light
  ['5 call x.bat', 'call s.bat', 'heavy:suite'],                                // light
  ['5 x.bat', 's.bat', 'heavy:suite'],                                          // light
  ['6 node --test missing', 'node --test missing.test.cjs', 'provisional'],     // light
  ['6 node --test present', 'node --test ok.test.cjs', 'light'],                // light
  ['7 $TEMP', 'bash $TEMP/s.sh', 'heavy:suite'],                                // provisional
  ['7 ${HOME}', 'bash ${HOME}/s.sh', 'heavy:suite'],                            // provisional
  ['7 ~', 'bash ~/s.sh', 'heavy:suite'],                                        // provisional
  ['7 $env:TEMP', 'powershell -File $env:TEMP/s.ps1', 'heavy:suite'],           // light
  ['7 cd ~', 'cd ~ && bash s.sh', 'heavy:suite'],                               // provisional
  ['7 $TEMP light', 'bash $TEMP/light.sh', 'light'],                            // provisional
  ['7 an assignment wins over env', 'TEMP=/nowhere; bash $TEMP/s.sh', 'provisional'], // provisional
  ['8 curl -o', lightBody('r.sh', 'curl -o r.sh http://x/y; bash r.sh'), 'provisional'],              // light
  ['8 curl -sSLo', lightBody('r.sh', 'curl -sSLo r.sh http://x/y; bash r.sh'), 'provisional'],        // light
  ['8 curl --output=', lightBody('r.sh', 'curl --output=r.sh http://x/y; bash r.sh'), 'provisional'], // light
  ['8 git checkout --', lightBody('r.sh', 'git checkout HEAD -- r.sh; bash r.sh'), 'provisional'],     // light
  ['8 git restore', lightBody('r.sh', 'git restore --source HEAD r.sh; bash r.sh'), 'provisional'],   // light
  ['8 node -e writeFileSync', lightBody('r.sh', `node -e "require('fs').writeFileSync('r.sh', process.argv[1])" x; bash r.sh`), 'provisional'], // light
  ['8 node -e copyFileSync', lightBody('r.sh', `node -e "require('fs').copyFileSync('s.sh', 'r.sh')"; bash r.sh`), 'provisional'], // light
  ['8 ln -sf', lightBody('r.sh', 'ln -sf s.sh r.sh; bash r.sh'), 'provisional'],                      // light
  ['8 dd of=', lightBody('r.sh', 'dd if=s.sh of=r.sh; bash r.sh'), 'provisional'],                    // light
  ['8 control: no writer', lightBody('r.sh', 'bash r.sh'), 'light'],                                  // light
  ['8 control: git checkout a branch', lightBody('r.sh', 'git checkout main; bash r.sh'), 'light'],   // light
  ['8 control: curl to stdout', lightBody('r.sh', 'curl -s http://x/y; bash r.sh'), 'light'],         // light
  ['9 node --check', 'node --check heavy.cjs', 'light'],                        // heavy:bench
  ['9 node -c', 'node -c heavy.cjs', 'light'],                                  // heavy:bench
  ['9 control: node heavy.cjs', 'node heavy.cjs', 'heavy:bench'],               // heavy:bench
  // Names first: a .bin shim the lock cannot see through keeps its name's class.
  ['names: vitest shim', './node_modules/.bin/vitest run', 'heavy:suite'],      // heavy:suite
  ['names: electron-vite shim', './node_modules/.bin/electron-vite build', 'heavy:build'], // heavy:build
  ['names: eslint shim', 'node_modules/.bin/eslint src', 'light'],              // light
];

test('HEAVY-LOCK-SHAPES-189: every card shape is classified by what it runs (after; before in the comments)', (t) => {
  const { ctx } = fixture(t);
  const got = Object.fromEntries(ROWS.map(([name, cmd]) => [name, cls(cmd, ctx)]));
  assert.deepEqual(got, Object.fromEntries(ROWS.map(([name, , want]) => [name, want])));
});

test('HEAVY-LOCK-SHAPES-189: without an env, $TEMP and ~ paths stay unreadable (fail closed)', (t) => {
  const { ctx } = fixture(t);
  const { env, ...noEnv } = ctx;
  void env;
  for (const cmd of ['bash $TEMP/light.sh', 'bash ~/light.sh', 'cd ~ && bash light.sh']) assert.equal(cls(cmd, noEnv), 'provisional', cmd);
});

test('HEAVY-LOCK-SHAPES-189: heavyEnv takes the path variables only, HOME from USERPROFILE when absent', () => {
  assert.deepEqual(HookServer.heavyEnv({ USERPROFILE: 'C:\\Users\\u', TEMP: 'C:\\t', PATH: 'x', HIVE_ROOT: 'y' }), { USERPROFILE: 'C:\\Users\\u', TEMP: 'C:\\t', HOME: 'C:\\Users\\u' });
  assert.deepEqual(HookServer.heavyEnv({ HOME: '/h', USERPROFILE: 'C:\\u' }), { HOME: '/h', USERPROFILE: 'C:\\u' });
  const ctx = HookServer.heavyScriptCtx(null);
  assert.equal(typeof ctx.readScript, 'function');
  assert.equal(typeof ctx.env, 'object', 'the hook passes the env to the classifier');
});
