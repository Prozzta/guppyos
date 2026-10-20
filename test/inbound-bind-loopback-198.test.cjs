'use strict';

/*
 * INBOUND-BIND-LOOPBACK-198: the public tunnel can reach a loopback listener;
 * opening 0.0.0.0 is an explicit LAN/router-forwarding choice, never the
 * default. Keep these pins textual so neither test starts a tunnel or binds a
 * fixed port.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const targets = [
  ['webhook', 'src/main/webhook.ts'],
  ['slack', 'src/main/slack.ts']
];
const hostChoice = "opts.bindAllInterfaces ? '0.0.0.0' : '127.0.0.1'";

for (const [name, file] of targets) {
  test(`${name}: default bind is loopback and all-interface bind is explicit`, () => {
    const source = read(file);
    assert.equal(source.split(hostChoice).length - 1, 1, `${name} must choose one explicit host`);
    assert.match(source, /server\.listen\(this\.port, this\.host, \(\) => \{/,
      `${name} must pass the selected host to listen()`);
  });
}

test('main passes the one explicit config opt-in to both inbound listeners', () => {
  const source = read('src/main/index.ts');
  const pin = 'bindAllInterfaces: cfg.inboundBindAllInterfaces === true,';
  assert.equal(source.split(pin).length - 1, 2, 'both webhook and Slack constructors receive the opt-in');
});

test('MUTANT CENSUS: every bind safety pin applies once and dies', () => {
  const mutants = [
    ['webhook default becomes public', 'src/main/webhook.ts', hostChoice,
      "opts.bindAllInterfaces ? '0.0.0.0' : '0.0.0.0'", /loopback/],
    ['slack default becomes public', 'src/main/slack.ts', hostChoice,
      "opts.bindAllInterfaces ? '0.0.0.0' : '0.0.0.0'", /loopback/],
    ['webhook ignores host', 'src/main/webhook.ts', 'server.listen(this.port, this.host, () => {',
      'server.listen(this.port, () => {', /selected host/],
    ['slack ignores host', 'src/main/slack.ts', 'server.listen(this.port, this.host, () => {',
      'server.listen(this.port, () => {', /selected host/]
  ];
  for (const [name, file, from, to, dies] of mutants) {
    const source = read(file);
    assert.equal(source.split(from).length - 1, 1, `${name}: target must match exactly once`);
    const altered = source.replace(from, to);
    assert.throws(() => {
      if (from === hostChoice) {
        assert.equal(altered.split(hostChoice).length - 1, 1, `${name}: default bind is loopback`);
      } else {
        assert.match(altered, /server\.listen\(this\.port, this\.host, \(\) => \{/, `${name}: selected host reaches listen()`);
      }
    }, (err) => dies.test(String(err?.message)), `${name}: SURVIVED`);
  }
});
