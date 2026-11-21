'use strict';
require('./tools/own-job.cjs');
const guard = require('./tools/listen-loopback-guard.cjs');

/* INBOUND-BIND-LOOPBACK-198: bind only loopback unless the operator explicitly
 * opts into LAN/router forwarding. These use private listen() on port 0 and never
 * start tunnelmole.
 *
 * TEST-ELECTRON-NONLOOPBACK-LISTEN-FIREWALL-108: no cell opens a public socket. The guard
 * (tools/listen-loopback-guard.cjs) records the host each server passes to the real
 * net listen(), and opens a 0.0.0.0 request on 127.0.0.1 instead. So the default is proven
 * twice (the host asked for, and the address the OS accepted), and the opt-in and the
 * default-public mutant are proven by the host asked for. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

function webhookOptions(bindAllInterfaces) {
  return {
    port: 0, bindAllInterfaces,
    endpoints: [{ id: 'test', name: 'Test', secret: 'secret', schema: '{}' }],
    onMessage: () => null, lookupStatus: () => null
  };
}
function slackOptions(bindAllInterfaces) {
  return { port: 0, bindAllInterfaces, signingSecret: 'secret', onMessage: () => {} };
}

/** One listen(): the host the server asked net for, and the address the OS gave the socket. */
async function bindOf(ServerClass, options) {
  let bound;
  const asked = await guard.asked(async () => {
    const instance = new ServerClass(options);
    await instance.listen();
    bound = instance.server.address().address;
    instance.stop();
  });
  assert.equal(asked.length, 1, 'one listen() is one TCP bind');
  return { asked: asked[0].host, bound };
}

for (const [name, file, exportName, options] of [
  ['webhook', 'src/main/webhook.ts', 'WebhookServer', webhookOptions],
  ['slack', 'src/main/slack.ts', 'SlackWebhookServer', slackOptions]
]) {
  test(`${name}: default bind is loopback and all-interface bind is explicit`, async () => {
    const ServerClass = loadTs(file)[exportName];
    assert.deepEqual(await bindOf(ServerClass, options(undefined)), { asked: '127.0.0.1', bound: '127.0.0.1' });
    assert.deepEqual(await bindOf(ServerClass, options(false)), { asked: '127.0.0.1', bound: '127.0.0.1' });
    assert.deepEqual(await bindOf(ServerClass, options(true)), { asked: '0.0.0.0', bound: '127.0.0.1' },
      'the opt-in asks for every interface; the guard opens it on loopback');
  });
}

test('config default keeps inbound listeners loopback-only', () => {
  assert.match(read('src/main/config.ts'), /inboundBindAllInterfaces:\s*false/);
});

test('main passes the one explicit config opt-in to both inbound listeners', () => {
  const source = read('src/main/index.ts');
  const pin = 'bindAllInterfaces: cfg.inboundBindAllInterfaces === true,';
  assert.equal(source.split(pin).length - 1, 2, 'both webhook and Slack constructors receive the opt-in');
  assert.match(source, /function rebindInboundServers\(/, 'a bind setting change recreates live listeners');
  assert.equal(source.split('rebindInboundServers(previousBindAllInterfaces);').length - 1, 2,
    'both inbound settings IPC routes rebind live listeners after an address change');
});

test('MUTANT CENSUS: default-public binds and default-public config die behaviorally', async () => {
  const hostChoice = "opts.bindAllInterfaces ? '0.0.0.0' : '127.0.0.1'";
  for (const [name, file, exportName, options] of [
    ['webhook', 'src/main/webhook.ts', 'WebhookServer', webhookOptions],
    ['slack', 'src/main/slack.ts', 'SlackWebhookServer', slackOptions]
  ]) {
    const source = read(file);
    assert.equal(source.split(hostChoice).length - 1, 1, `${name}: target must match exactly once`);
    const Mutant = loadTs.fromText(file, source.replace(hostChoice, "opts.bindAllInterfaces ? '0.0.0.0' : '0.0.0.0'"))[exportName];
    await assert.rejects(async () => {
      assert.equal((await bindOf(Mutant, options(undefined))).asked, '127.0.0.1');
    }, /Expected values to be strictly equal/, `${name}: default-public mutant SURVIVED`);
  }
  const alteredConfig = read('src/main/config.ts').replace('inboundBindAllInterfaces: false', 'inboundBindAllInterfaces: true');
  assert.throws(() => assert.match(alteredConfig, /inboundBindAllInterfaces:\s*false/), /did not match/,
    'config default-public mutant SURVIVED');
});

/* ---- TEST-ELECTRON-NONLOOPBACK-LISTEN-FIREWALL-108: the guard itself, and the census ---- */

const listening = (server, ...args) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(...args, () => resolve(server.address().address));
});

test('guard: outside asked(), a TCP bind that is not loopback is refused before a socket exists', () => {
  for (const args of [[0, '0.0.0.0'], [0, '::'], [0], [], [{ port: 0 }], [{ port: 0, host: '0.0.0.0' }], [0, 'localhost']]) {
    const server = net.createServer();
    assert.throws(() => server.listen(...args), { code: 'ERR_TEST_NONLOOPBACK_LISTEN' }, JSON.stringify(args));
    assert.equal(server.address(), null, `${JSON.stringify(args)}: nothing was bound`);
    assert.equal(server.listening, false);
  }
});

test('guard: loopback binds and pipes pass through; asked() records the host and opens loopback', async () => {
  const plain = net.createServer();
  assert.equal(await listening(plain, 0, '127.0.0.1'), '127.0.0.1');
  plain.close();
  const pipe = net.createServer();
  const name = process.platform === 'win32'
    ? `\\\\.\\pipe\\guppy-listen-guard-${process.pid}`
    : path.join(require('node:os').tmpdir(), `guppy-listen-guard-${process.pid}.sock`);
  await new Promise((resolve, reject) => { pipe.once('error', reject); pipe.listen(name, resolve); });
  pipe.close();

  for (const args of [[0, '0.0.0.0'], [{ port: 0, host: '0.0.0.0' }], [0]]) {
    const server = net.createServer();
    let bound;
    const asked = await guard.asked(async () => { bound = await listening(server, ...args); });
    server.close();
    assert.equal(asked.length, 1);
    assert.equal(asked[0].loopback, false);
    assert.equal(asked[0].host, typeof args[0] === 'object' ? args[0].host : args[1]);
    assert.equal(bound, '127.0.0.1', `${JSON.stringify(args)}: opened on loopback, never publicly`);
  }
  assert.throws(() => net.createServer().listen(0, '0.0.0.0'), { code: 'ERR_TEST_NONLOOPBACK_LISTEN' },
    'the guard refuses again once asked() has returned');
});

/** Every listen( call in test source: flag the ones that do not name a loopback host or a pipe. */
const PIPE_ARGS = new Set(['sock', 'pipe', 'name', 'conoutPipeName', 'process.argv[1]']);
function publicListens(source) {
  const found = [];
  for (const m of source.matchAll(/\.listen\(([^)]*)/g)) {
    const args = m[1].split(',').map((a) => a.trim());
    if (PIPE_ARGS.has(args[0])) continue;
    if (/^(['"`])(127\.0\.0\.1|::1)\1$/.test(args[1] || '')) continue;
    found.push(m[0]);
  }
  for (const m of source.matchAll(/(['"`])(0\.0\.0\.0|::)\1/g)) found.push(m[0]);
  return found;
}

test('CENSUS: no test passes 0.0.0.0, :: or no host to a real listen()', () => {
  // Only files that load the guard may hold such a call: there it is refused or opened on loopback.
  const GUARDED = ['test/inbound-bind-loopback-198.test.cjs'];
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(cjs|mjs|js|ts|tsx)$/.test(entry.name)) files.push(full);
    }
  };
  walk(__dirname);
  assert.ok(files.length > 800, `the walk saw the test tree (${files.length} files)`);
  const offenders = {};
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const found = publicListens(fs.readFileSync(full, 'utf8'));
    if (found.length && !GUARDED.includes(rel)) offenders[rel] = found;
  }
  assert.deepEqual(offenders, {}, 'a test listens beyond loopback, or in a shape this census cannot read');
  for (const rel of GUARDED) {
    const source = read(rel);
    assert.ok(publicListens(source).length > 0, `${rel}: still needs its place on the list`);
    assert.match(source.split('\n').slice(0, 5).join('\n'), /require\('\.\/tools\/listen-loopback-guard\.cjs'\)/,
      `${rel}: loads the guard before any test code`);
  }
});

test('MUTANT CENSUS: the listen census flags each public or unreadable shape', () => {
  for (const [line, flagged] of [
    ["server.listen(0, '127.0.0.1', r)", 0],
    ["server.listen(port, '::1', r)", 0],
    ['server.listen(sock, r)', 0],
    ["server.listen(0, '0.0.0.0', r)", 2],
    ["server.listen(0, '::', r)", 2],
    ['server.listen(0, r)', 1],
    ['server.listen(port)', 1],
    ['server.listen(port, host, r)', 1],
    ['server.listen({ port: 0 }, r)', 1],
    ['instance.listen()', 1],
    ["const host = '0.0.0.0';", 1],
    ['const host = "::";', 1]
  ]) assert.equal(publicListens(line).length, flagged, line);
});
