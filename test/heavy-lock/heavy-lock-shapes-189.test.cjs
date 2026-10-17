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
const loadTs = require('../load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { classifyCommand } = loadTs('src/main/heavyJob.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const SUITE = 'node test/tools/run-tests.cjs';
/** PowerShell's -EncodedCommand form of a command: base64 of its UTF-16LE bytes. */
const ENC = (s) => Buffer.from(s, 'utf16le').toString('base64');
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
  w('deep.sh', `bash -c "bash -c 'bash -c \\"npm test\\"'"\n`);
  // PowerShell 5.1's Out-File / `>` encoding: UTF-16LE with a BOM (and the BE and BOM-less forms).
  const u16 = (s, bom) => Buffer.concat([Buffer.from(bom), Buffer.from(s, 'utf16le')]);
  w('s16.ps1', u16('npm test\r\n', [0xff, 0xfe]));
  w('s16be.ps1', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('npm test\r\n', 'utf16le').swap16()]));
  w('s16nb.ps1', u16('npm test\r\n', []));
  w('l16.ps1', u16('Get-ChildItem\r\n', [0xff, 0xfe]));
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
  ['2 node <a name that does not read>', 'node eval 9333', 'light'],            // light (replay: `$E eval`, `"$T" --hide-layer Stuff`)
  ['2 a runner variable', 'T="/c/Program Files/Tiled/x.exe"; "$T" --hide-layer Stuff a.tmx', 'light'], // light
  ['2 a binary', './tool --x', 'light'],                                        // light
  ['2 /usr/bin/env', '/usr/bin/env FOO=1', 'light'],                            // light
  ['3 depth-2', `bash -c "bash -c 'bash s.sh'"`, 'heavy:suite'],                // light
  ['3 depth-2 npm ci', `bash -c "bash -c 'npm ci'"`, 'heavy:install'],          // light
  // Jim NIT 1: the depth cap is unknown, not light (it ends either way).
  ['3 a script that runs itself ends', 'bash loop.sh', 'provisional'],          // light
  ['3 a script nesting past the cap', 'bash deep.sh', 'provisional'],           // light
  ['3 depth-4 inline', `bash -c "bash -c 'bash -c \\"bash -c npm\\\\ test\\"'"`, 'provisional'], // light
  ['4 powershell -File', 'powershell -File s.ps1', 'heavy:suite'],              // light
  ['4 pwsh -f', 'pwsh -f s.ps1', 'heavy:suite'],                                // light
  ['4 ./s.ps1', './s.ps1', 'heavy:suite'],                                      // light
  ['4 powershell -File missing', 'powershell -File nope.ps1', 'provisional'],   // light
  ['5 cmd /c x.bat', 'cmd /c s.bat', 'heavy:suite'],                            // light
  ['5 call x.bat', 'call s.bat', 'heavy:suite'],                                // light
  ['5 x.bat', 's.bat', 'heavy:suite'],                                          // light
  ['6 node --test missing', 'node --test missing.test.cjs', 'provisional'],     // light
  ['6 node --test present', 'node --test ok.test.cjs', 'light'],                // light
  ['6 a loop of single files', 'for f in a b; do node --test test/$f.test.cjs; done', 'light'], // light
  ['6 a computed name', 'node --test test/$f.test.cjs', 'light'],              // light
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
  // Jim MUST 1 (light at 83ee9c23): launchers of the Start-Process class.
  ['M1 Start-Job block', 'Start-Job -ScriptBlock { npm test }', 'heavy:suite'],  // light
  ['M1 $job = Start-Job', '$job = Start-Job { npm test }', 'heavy:suite'],      // light
  ['M1 Invoke-Command', 'Invoke-Command -ScriptBlock { npm test }', 'heavy:suite'], // light
  ['M1 ForEach-Object', '1..1 | ForEach-Object { npm test }', 'heavy:suite'],   // light
  ['M1 % alias', '1..1 | % { npm ci }', 'heavy:install'],                       // light
  ['M1 sh group', '{ npm test; }', 'heavy:suite'],                              // light
  ['M1 Invoke-Expression', "Invoke-Expression 'npm test'", 'heavy:suite'],      // light
  ['M1 iex', "iex 'npm run build'", 'heavy:build'],                             // light
  ['M1 -EncodedCommand', `powershell -EncodedCommand ${ENC('npm test')}`, 'heavy:suite'], // light
  ['M1 -enc', `pwsh -enc ${ENC('npm ci')}`, 'heavy:install'],                  // light
  ['M1 -ec undecodable', 'powershell -ec not-base64!', 'provisional'],          // light
  ['M1 nohup', 'nohup npm test &', 'heavy:suite'],                              // light
  ['M1 time', 'time npm test', 'heavy:suite'],                                  // light
  ['M1 setsid', 'setsid -f npm test', 'heavy:suite'],                           // light
  ['M1 nice -n', 'nice -n 5 npm test', 'heavy:suite'],                          // heavy:suite
  ['M1 control: a filter block', "Get-ChildItem | Where-Object { $_.Name -match 'test' }", 'light'], // light
  ['M1 control: a property block', '1..3 | ForEach-Object { $_ * 2 }', 'light'], // light
  ['M1 control: iex light', "iex 'git status'", 'light'],                       // light
  ['M1 control: -enc light', `powershell -enc ${ENC('Get-ChildItem')}`, 'light'], // light
  // Jim MUST 2 (light at 83ee9c23): PowerShell 5.1 writes UTF-16LE; a NUL is not a binary in a named script.
  ['M2 -File UTF-16LE BOM', 'powershell -File s16.ps1', 'heavy:suite'],         // light
  ['M2 ./ UTF-16LE BOM', './s16.ps1', 'heavy:suite'],                           // light
  ['M2 UTF-16BE BOM', 'powershell -File s16be.ps1', 'heavy:suite'],             // light
  ['M2 UTF-16LE no BOM', 'powershell -File s16nb.ps1', 'heavy:suite'],          // light
  ['M2 control: UTF-16 light', 'powershell -File l16.ps1', 'light'],            // light
  // Jim's false-positive probe (msg 7ec187, shapes-probe-fp.cjs): light before, light after.
  // ('1..3 | ForEach-Object { $_ * 2 }' is the property-block control above.)
  ['FP a string that names a suite', '$c = "npm test"', 'light'],                 // light
  ['FP an env assignment', "$env:FOO='1'", 'light'],                              // light
  ['FP Select-String for a suite', "Select-String -Path x.log -Pattern 'npm test'", 'light'], // light
  ['FP call :label', 'call :label', 'light'],                                     // light
  ['FP git checkout --', 'git checkout -- src/a.ts', 'light'],                    // light
  ['FP curl -sSLo', 'curl -sSLo out.json https://example.com/a.json', 'light'],   // light
  ['FP where.exe', 'where.exe node', 'light'],                                    // light
  ['FP start-process code', 'start-process code', 'light'],                       // light
  ['FP echo a suite', 'echo npm test', 'light'],                                  // light
  ['FP grep for a suite', 'grep -rn "npm test" docs', 'light'],                   // light
  ['FP Start-Job light block', 'Start-Job -ScriptBlock { Get-Date }', 'light'],   // light
  ['FP Invoke-Expression light', "Invoke-Expression 'Get-Date'", 'light'],        // light
  ['FP time light', 'time git status', 'light'],                                  // light
  ['FP nohup light', 'nohup git fetch &', 'light'],                               // light
  // Jim delta SHOULD (4b3ed248): a script FILE run by a job cmdlet.
  ['D Start-Job -FilePath', 'Start-Job -FilePath s.ps1', 'heavy:suite'],          // light
  ['D Invoke-Command -FilePath', 'Invoke-Command -FilePath s.ps1', 'heavy:suite'], // light
  ['D icm -fi (a prefix)', 'icm -fi s.ps1', 'heavy:suite'],                       // light
  ['D Start-ThreadJob -FilePath UTF-16', 'Start-ThreadJob -FilePath s16.ps1', 'heavy:suite'], // light
  ['D Start-Job -LiteralPath', '$j = Start-Job -LiteralPath ./s.ps1', 'heavy:suite'], // light
  ['D -FilePath missing', 'Start-Job -FilePath nope.ps1', 'provisional'],         // light
  ['D control: -FilePath light', 'Start-Job -FilePath l16.ps1', 'light'],         // light
  ['D control: Out-File -FilePath writes', 'Get-Date | Out-File -FilePath s.ps1', 'light'], // light
  // Jim delta NIT: computed code for iex is unreadable.
  ['D iex (Get-Content)', 'iex (Get-Content s.ps1 -Raw)', 'provisional'],         // light
  ['D Invoke-Expression $code', 'Invoke-Expression $code', 'provisional'],        // light
  ['D control: iex a string with a variable', 'iex "Write-Host $x"', 'light'],    // light
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
