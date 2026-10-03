'use strict';
/**
 * CLAIM-LEDGER F5 as a C4 drill case (god d05408): THIS build's ledger store, under Electron as
 * Node in the sandbox hive. A Human rekey whose line tears for one agent records no new key id
 * (every ledger reads key-missing); the retry heals every agent with nothing acked lost and no
 * forgery alert. needModel: false (it counts no facts).
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const { ClaimStore } = drill.loadTs('src/main/claims/store.ts');
  const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = drill.loadTs('src/main/claims/keyProvider.ts');
  const record = new FileLedgerKeyRecord(path.join(drill.home, 'AppData', 'Roaming', 'Guppy', KEY_RECORD_FILE));
  const keys = new SandboxKeyProvider();
  const alerts = [];
  let t = Date.parse('2026-10-03T10:00:00Z');
  const now = () => new Date(t);
  const mk = (io) => new ClaimStore({ hiveRoot: drill.hive, keys, keyRecord: record, now, alert: (r) => alerts.push(r), ...(io ? { io } : {}) });
  const agents = ['andy', 'dwight', 'creed'];
  const acked = Object.fromEntries(agents.map((a) => [a, []]));
  let s = mk();
  for (let i = 0; i < 3; i++) for (const a of agents) {
    t += 1000;
    const r = await s.appendRecord(a, { t: 'claim', kind: 'fact', text: `${a} ${i}` }, 'endpoint');
    if (!r.ok) return { ok: false, reason: `seed append failed: ${r.error}` };
    acked[a].push(r.id);
  }
  s.close();
  const oldId = keys.load().keyId;
  keys.drop();
  let tore = 0;
  const io = {
    openSync: (p, f) => fs.openSync(p, f),
    writeSync: (fd, buf) => {
      const text = Buffer.from(buf).toString('utf8');
      if (!tore && text.includes('"ev":"rekey"') && text.includes('"agent":"dwight"')) { tore++; fs.writeSync(fd, buf.subarray(0, 40)); throw new Error('simulated crash mid rekey'); }
      return fs.writeSync(fd, buf);
    },
    fsyncSync: (fd) => fs.fsyncSync(fd), closeSync: (fd) => fs.closeSync(fd),
  };
  t += 60_000;
  s = mk(io);
  const first = await s.rekey(true);
  s.close();
  const recordKept = record.get(drill.hive) === oldId;
  s = mk();
  const midReasons = Object.fromEntries(agents.map((a) => [a, s.readLedger(a).chain.reason ?? 'ok']));
  s.close();
  t += 60_000;
  s = mk();
  const second = await s.rekey(true);
  s.close();
  s = mk();
  const after = {};
  let ackedPresent = true;
  for (const a of agents) {
    const r = s.readLedger(a);
    after[a] = r.chain === 'ok' ? 'ok' : r.chain.reason;
    const ids = new Set(r.records.map((x) => x.id));
    for (const id of acked[a]) if (!ids.has(id)) ackedPresent = false;
  }
  s.close();
  const forgeryAlerts = alerts.filter((x) => x.kind === 'claims-chain-broken').length;
  const ok = !first.ok && recordKept && Object.values(midReasons).every((x) => x === 'key-missing')
    && second.ok && Object.values(after).every((x) => x === 'ok') && ackedPresent && forgeryAlerts === 0 && record.get(drill.hive) === keys.load().keyId;
  return { ok, firstRefused: first.refused, recordKept, midReasons, secondOk: second.ok, after, ackedPresent, forgeryAlerts, ...(ok ? {} : { reason: 'F5 drill expectations not met' }) };
};
