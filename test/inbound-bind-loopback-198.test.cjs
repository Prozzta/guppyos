'use strict';

/* INBOUND-BIND-LOOPBACK-198: bind only loopback unless the operator explicitly
 * opts into LAN/router forwarding. These use private listen() on port 0, never
 * start tunnelmole, and prove the address the OS actually accepted. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

async function boundAddress(ServerClass, options) {
  const instance = new ServerClass(options);
  await instance.listen();
  const address = instance.server.address();
  instance.stop();
  return address.address;
}

for (const [name, file, exportName, options] of [
  ['webhook', 'src/main/webhook.ts', 'WebhookServer', webhookOptions],
  ['slack', 'src/main/slack.ts', 'SlackWebhookServer', slackOptions]
]) {
  test(`${name}: default bind is loopback and all-interface bind is explicit`, async () => {
    const ServerClass = loadTs(file)[exportName];
    assert.equal(await boundAddress(ServerClass, options(undefined)), '127.0.0.1');
    assert.equal(await boundAddress(ServerClass, options(false)), '127.0.0.1');
    assert.equal(await boundAddress(ServerClass, options(true)), '0.0.0.0');
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
      assert.equal(await boundAddress(Mutant, options(undefined)), '127.0.0.1');
    }, /Expected values to be strictly equal/, `${name}: default-public mutant SURVIVED`);
  }
  const alteredConfig = read('src/main/config.ts').replace('inboundBindAllInterfaces: false', 'inboundBindAllInterfaces: true');
  assert.throws(() => assert.match(alteredConfig, /inboundBindAllInterfaces:\s*false/), /did not match/,
    'config default-public mutant SURVIVED');
});
