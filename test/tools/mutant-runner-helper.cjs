'use strict';

// A finally block cannot run after taskkill/SIGKILL.  Keep the original bytes on
// disk before each edit so the next mutant-runner invocation repairs an interrupted
// run before it reads a baseline or writes another mutant.
const fs = require('node:fs');
const path = require('node:path');

const journalPath = (root) => path.join(root, '.mutant-runner-recovery.json');

function checked(root, file) {
  const rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !rel.startsWith(`src${path.sep}`)) {
    throw new Error(`refusing mutant recovery path outside src: ${file}`);
  }
  return path.resolve(file);
}

function readJournal(root) {
  const journal = journalPath(root);
  if (!fs.existsSync(journal)) return [];
  const records = JSON.parse(fs.readFileSync(journal, 'utf8'));
  if (!Array.isArray(records)) throw new Error(`invalid mutant recovery journal: ${journal}`);
  return records.map((record) => ({
    file: checked(root, record.file),
    original: Buffer.from(record.original, 'base64').toString('utf8')
  }));
}

function writeJournal(root, records) {
  const journal = journalPath(root);
  if (!records.length) {
    fs.rmSync(journal, { force: true });
    return;
  }
  const temp = `${journal}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(records.map(({ file, original }) => ({
    file, original: Buffer.from(original, 'utf8').toString('base64')
  }))), 'utf8');
  fs.renameSync(temp, journal);
}

function recover(root) {
  const records = readJournal(root);
  for (const record of records) fs.writeFileSync(record.file, record.original, 'utf8');
  if (records.length) writeJournal(root, []);
  return records.length;
}

function mutateFile(root, file, original, mutated) {
  const abs = checked(root, file);
  const records = readJournal(root);
  if (records.some((record) => record.file === abs)) throw new Error(`already mutating ${abs}`);
  writeJournal(root, [...records, { file: abs, original }]);
  fs.writeFileSync(abs, mutated, 'utf8');
  const pause = Number(process.env.MUTANT_RUNNER_PAUSE_AFTER_MUTATE_MS || 0);
  if (pause > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause);
}

function restoreFile(root, file, original) {
  const abs = checked(root, file);
  fs.writeFileSync(abs, original, 'utf8');
  writeJournal(root, readJournal(root).filter((record) => record.file !== abs));
}

module.exports = { recover, mutateFile, restoreFile, journalPath };
