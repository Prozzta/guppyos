'use strict';

/** Pure PTY-input evidence helpers.  `redact` is injected by the runner so this module never
 * imports product state or gains a second redaction policy. */
function createPtyInputTools(redact) {
  const CTRL_NAMES = { 0x1b: 'ESC', 0x0d: 'CR', 0x0a: 'LF', 0x09: 'TAB', 0x08: 'BS', 0x7f: 'DEL', 0x00: 'NUL' };
  function classifyPtyInput(data, capPerRun = 80, capTotal = 400) {
    const s = String(data || '');
    const out = [];
    let run = '';
    let kept = 0;
    const flush = () => {
      if (!run) return;
      const room = Math.max(0, capTotal - kept);
      const text = redact(run).slice(0, Math.min(capPerRun, room));
      kept += text.length;
      out.push({ text, chars: run.length, ...(text.length < run.length ? { capped: true } : {}) });
      run = '';
    };
    for (const ch of s) {
      const c = ch.codePointAt(0);
      if (c < 0x20 || c === 0x7f) {
        flush();
        const name = CTRL_NAMES[c] || (c >= 1 && c <= 26 ? `Ctrl-${String.fromCharCode(64 + c)}` : `0x${c.toString(16).padStart(2, '0')}`);
        const last = out[out.length - 1];
        if (last && last.ctrl === name) last.n++; else out.push({ ctrl: name, n: 1 });
      } else run += ch;
    }
    flush();
    return out;
  }
  function ptyInputEvidence(q, pidToId) {
    return (q && q.rows ? q.rows : []).map((r) => ({
      at: new Date(r.at).toISOString(), ptyId: r.ptyId || (pidToId && pidToId[r.pid]) || null, pid: r.pid, bytes: Buffer.byteLength(String(r.data || '')), len: r.len,
      source: r.source, origin: r.origin || null, classes: classifyPtyInput(r.data), ...(r.len > String(r.data || '').length ? { truncated: true } : {})
    }));
  }
  return { CTRL_NAMES, classifyPtyInput, ptyInputEvidence };
}

module.exports = { createPtyInputTools };
