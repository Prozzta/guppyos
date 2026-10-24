'use strict';
/**
 * CLAIMS-90 C0b (god 21:21, option B 21:46): the answerer may follow a claim's `history: memory.md#...`
 * pointer the way a live agent does, on the sandbox's T_s copy only:
 * - the Read tool on <hive>/agents/<id>/memory.md;
 * - a read-only Bash grep, cat, head, tail or `sed -n` whose only file arguments are such files,
 *   optionally piped into grep or head; no chain, redirect, substitution or write.
 * A live path (C:/Dunder/hive/...) is rewritten to the sandbox copy; the sandbox path, typed
 * directly or as $MUNDER_HIVE_ROOT, is kept. Anything else does not match and stays refused.
 */
const fs = require('node:fs');
const path = require('node:path');

const LIVE_MEMORY_MD = /^(?:c:|\/c)[\\/]+Dunder[\\/]+hive[\\/]+agents[\\/]+([A-Za-z0-9._-]+)[\\/]+memory\.md$/i;
const HIVE_VAR = /\$\{MUNDER_HIVE_ROOT\}|\$MUNDER_HIVE_ROOT(?![A-Za-z0-9_])/g;

/** { kind: 'live'|'sandbox', agent, target } when filePath is an agent's memory.md and the sandbox copy exists; else null. */
function memoryMdOf(filePath, sandboxHive) {
  if (typeof filePath !== 'string' || !sandboxHive || /(^|[\\/])\.\.([\\/]|$)/.test(filePath)) return null;
  const copy = (agent) => path.join(sandboxHive, 'agents', agent, 'memory.md');
  const live = LIVE_MEMORY_MD.exec(filePath);
  if (live && !/^\.+$/.test(live[1])) return fs.existsSync(copy(live[1])) ? { kind: 'live', agent: live[1], target: copy(live[1]) } : null;
  if (!path.isAbsolute(filePath) && !/^\/[a-zA-Z]\//.test(filePath)) return null;
  const abs = filePath.replace(/^\/([a-zA-Z])\//, '$1:/');
  const rel = path.relative(path.resolve(sandboxHive), path.resolve(abs)).split(path.sep);
  if (rel.length === 3 && rel[0] === 'agents' && rel[2] === 'memory.md' && /^[A-Za-z0-9._-]+$/.test(rel[1]) && !/^\.+$/.test(rel[1])) {
    return fs.existsSync(copy(rel[1])) ? { kind: 'sandbox', agent: rel[1], target: copy(rel[1]) } : null;
  }
  return null;
}

/**
 * Shell words of a command, split into pipe segments, or null when it holds anything beyond plain
 * words, quotes, $MUNDER_HIVE_ROOT and `|`: a chain, redirect, substitution, other variable, glob,
 * newline, or a comment other than a trailing `#full`. Each word keeps its source span for rewriting.
 */
function shellWords(command) {
  const segs = [[]];
  let w = null;
  const end = (i) => { if (w) { w.end = i; segs[segs.length - 1].push(w); w = null; } };
  const start = (i) => { if (!w) w = { text: '', start: i, hasVar: false }; };
  const dollar = (i) => {
    const m = /^(\$\{MUNDER_HIVE_ROOT\}|\$MUNDER_HIVE_ROOT(?![A-Za-z0-9_]))/.exec(command.slice(i));
    if (!m) return -1;
    w.text += m[1]; w.hasVar = true;
    return i + m[1].length;
  };
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (c === ' ' || c === '\t') { end(i); i++; continue; }
    if (c === '|') {
      if (command[i + 1] === '|') return null;
      end(i); segs.push([]); i++; continue;
    }
    if (c === '#' && !w) {
      if (/^#full\s*$/.test(command.slice(i))) break;
      return null;
    }
    if (/[;&<>()`\n\r*?[\]{}~!]/.test(c)) return null;
    start(i);
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      if (j < 0) return null;
      w.text += command.slice(i + 1, j); i = j + 1; continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= command.length) return null;
        const d = command[i];
        if (d === '"') { i++; break; }
        if (d === '`') return null;
        if (d === '$') { const n = dollar(i); if (n < 0) return null; i = n; continue; }
        if (d === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) { w.text += command[i + 1]; i += 2; continue; }
        w.text += d; i++;
      }
      continue;
    }
    if (c === '$') { const n = dollar(i); if (n < 0) return null; i = n; continue; }
    if (c === '\\') { if (i + 1 >= command.length) return null; w.text += command[i + 1]; i += 2; continue; }
    w.text += c; i++;
  }
  end(i);
  return segs.some((s) => !s.length) ? null : segs;
}

const NUM = /^[+-]?\d+$/;
const SED_ADDR = String.raw`(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/)`;
const SED_SCRIPT = new RegExp(`^(?:${SED_ADDR}(?:,(?:${SED_ADDR}|\\+\\d+))?)?\\s*[p=]$`);

/** Operand words of one segment, or null when an option is not in the read-only set. */
function operandsOf(cmd, words) {
  const out = [];
  let k = 0;
  let pattern = null;
  let script = null;
  let sedN = false;
  let opts = true;
  const next = () => words[++k];
  for (k = 0; k < words.length; k++) {
    const t = words[k].text;
    if (opts && t === '--') { opts = false; continue; }
    if (opts && t.startsWith('-') && t !== '-') {
      if (cmd === 'grep') {
        if (/^--(ignore-case|line-number|count|fixed-strings|extended-regexp|basic-regexp|perl-regexp|word-regexp|line-regexp|no-filename|with-filename|only-matching|invert-match|files-with-matches|no-messages|text)$/.test(t)) continue;
        if (/^--(color|colour)(=(never|always|auto))?$/.test(t)) continue;
        if (/^--(after-context|before-context|context|max-count)=\d+$/.test(t)) continue;
        if (/^--regexp=/.test(t)) { pattern = t; continue; }
        if (/^-[ABCm]$/.test(t)) { if (!NUM.test(next()?.text ?? '')) return null; continue; }
        if (t === '-e') { const p = next(); if (!p) return null; pattern = p; continue; }
        if (/^-[ivnchHloqswxEFGPaIzZ]+$/.test(t) || /^-[ivnchHloqswxEFGPaIzZ]*[ABCm]\d+$/.test(t)) continue;
        return null;
      }
      if (cmd === 'cat') { if (/^-[AbeEnstTuv]+$/.test(t)) continue; return null; }
      if (cmd === 'head' || cmd === 'tail') {
        if (/^-[nc]$/.test(t)) { if (!NUM.test(next()?.text ?? '')) return null; continue; }
        if (/^-[nc][+-]?\d+$/.test(t) || /^-\d+$/.test(t) || /^-[qv]$/.test(t) || /^--(lines|bytes)=[+-]?\d+$/.test(t)) continue;
        return null;
      }
      if (cmd === 'sed') {
        if (/^-[nEr]+$/.test(t)) { if (t.includes('n')) sedN = true; continue; }
        if (t === '--quiet' || t === '--silent') { sedN = true; continue; }
        if (t === '-e') { const s = next(); if (!s || script !== null) return null; script = s; continue; }
        return null;
      }
      return null;
    }
    if (cmd === 'grep' && pattern === null) { pattern = words[k]; continue; }
    if (cmd === 'sed' && script === null) { script = words[k]; continue; }
    out.push(words[k]);
  }
  if (cmd === 'grep' && pattern === null) return null;
  if (cmd === 'sed' && (!sedN || script === null || !SED_SCRIPT.test(script.text.trim()))) return null;
  return out;
}

const FIRST = new Set(['grep', 'cat', 'head', 'tail', 'sed']);
const PIPED = new Set(['grep', 'head']);

/**
 * When `command` is an allowed read of agents/<id>/memory.md:
 * { cmd, kind: 'rewritten'|'sandbox', agents, command } where `command` is what runs (live paths
 * replaced by the sandbox copy). Else null.
 */
function memoryMdCommand(command, sandboxHive) {
  if (typeof command !== 'string' || !sandboxHive) return null;
  const segs = shellWords(command.trim());
  if (!segs) return null;
  const hive = sandboxHive.replace(/\\/g, '/');
  const files = [];
  for (let s = 0; s < segs.length; s++) {
    const [name, ...rest] = segs[s];
    if (name.hasVar || !(s === 0 ? FIRST : PIPED).has(name.text)) return null;
    const ops = operandsOf(name.text, rest);
    if (!ops) return null;
    if (s === 0 ? !ops.length : ops.length) return null;
    if (s === 0) files.push(...ops);
  }
  const trimmed = command.trim();
  const lead = command.indexOf(trimmed);
  const found = [];
  for (const f of files) {
    const value = f.text.replace(HIVE_VAR, hive);
    const m = memoryMdOf(value, sandboxHive);
    if (!m) return null;
    found.push({ word: f, m });
  }
  let out = command;
  for (const { word, m } of [...found].reverse()) {
    if (m.kind === 'live') out = `${out.slice(0, lead + word.start)}'${m.target.replace(/\\/g, '/')}'${out.slice(lead + word.end)}`;
  }
  return {
    cmd: segs[0][0].text,
    kind: found.some((x) => x.m.kind === 'live') ? 'rewritten' : 'sandbox',
    agents: [...new Set(found.map((x) => x.m.agent))],
    command: out,
  };
}

module.exports = { memoryMdOf, memoryMdCommand, shellWords, LIVE_MEMORY_MD };
