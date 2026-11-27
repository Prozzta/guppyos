'use strict';
/**
 * B1-MARKER-LEAK-CHECK-SUBSTRING-MATCH-108: the residue check of the LIVE Bash join cell (B1,
 * test/perf/heavy-cpu-live-bash-b1.perf.cjs). The real marker folder is shared by every Guppy and
 * every test run of this Windows user, so B1 may judge only markers that are ITS OWN. The old check
 * flagged a file when its name or body merely CONTAINED a bare pid (a 4-6 digit string) or the cell
 * id. A foreign live marker guppy-heavy-job-120004-134394070585547747.marker went red on a suite:
 * an 18-digit creation-time tail holds a short pid as a substring often enough. The run also could
 * not say which token matched, so the red could not be classified.
 *
 * A marker the helper writes (resources/heavyjob/guppy-heavyjob.cs, CapMarker / join) is named
 * guppy-heavy-job-<pid>-<creation time>.marker and its body is the job name Local\guppy-heavy-<id>.
 * Here a token matches only a whole field:
 *   - a pid matches the <pid> field of a marker name exactly (never the creation-time field),
 *     unless the body is a well-formed foreign job name (a reused pid, not a leak);
 *   - the cell id matches a body's job id exactly, or as the leading part of id-<suffix> (every
 *     job B1 creates is named `${id}-...`, and hcpu-b1-1234 is not a prefix of hcpu-b1-12345-...);
 *   - a file or body of any other shape (not written by this helper) matches only on bounded
 *     tokens: a pid with no digit on either side, the id with no letter/digit before it and no
 *     digit after it. A JSON body is matched field by field the same way.
 * A real escape (B1's own marker written to the real folder: its body names a B1 job) stays red.
 * Every hit says the token, where it matched and the whole forbidden list.
 */
const MARKER_NAME = /^guppy-heavy-job-(\d+)-(\d+)\.marker$/;
const JOB_PREFIX = 'Local\\guppy-heavy-';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function jobIdHit(jobId, id) {
  return jobId === id || jobId.startsWith(`${id}-`);
}

// A string of unknown shape: bounded tokens only.
function textHits(text, id, pids, where) {
  const hits = [];
  if (new RegExp(`(?:^|[^A-Za-z0-9])${esc(id)}(?![0-9])`).test(text)) hits.push({ token: id, where });
  for (const pid of pids) if (new RegExp(`(?<![0-9])${esc(pid)}(?![0-9])`).test(text)) hits.push({ token: pid, where });
  return hits;
}

function valueHits(value, id, pids, where) {
  if (typeof value === 'number') return pids.includes(String(value)) ? [{ token: String(value), where }] : [];
  if (typeof value === 'string') {
    if (value.startsWith(JOB_PREFIX)) return jobIdHit(value.slice(JOB_PREFIX.length), id) ? [{ token: id, where: `${where} (job name)` }] : [];
    if (/^[0-9]+$/.test(value)) return pids.includes(value) ? [{ token: value, where }] : [];
    return jobIdHit(value, id) ? [{ token: id, where }] : textHits(value, id, pids, where);
  }
  if (value && typeof value === 'object') {
    const hits = [];
    for (const [k, v] of Object.entries(value)) hits.push(...valueHits(v, id, pids, `${where}.${k}`));
    return hits;
  }
  return [];
}

function bodyHits(body, id, pids) {
  const text = String(body).trim();
  if (text.startsWith(JOB_PREFIX)) {
    return jobIdHit(text.slice(JOB_PREFIX.length), id) ? [{ token: id, where: 'body (job name)' }] : [];
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed !== undefined && typeof parsed === 'object' && parsed !== null) return valueHits(parsed, id, pids, 'body JSON');
  return textHits(text, id, pids, 'body');
}

// Pid reuse (Jim MUST 1): every B1 shell has exited before the scan and Windows reuses pids, so a
// foreign shell can own a marker named with a B1 pid. Its body is then a well-formed FOREIGN job
// name, and the marker is not ours. An empty, torn or other-shaped body keeps the pid-field red.
function foreignJobBody(body, id) {
  const text = String(body).trim();
  return text.startsWith(JOB_PREFIX) && !jobIdHit(text.slice(JOB_PREFIX.length), id);
}

function nameHits(file, body, id, pids) {
  const m = MARKER_NAME.exec(file);
  if (m) return pids.includes(m[1]) && !foreignJobBody(body, id) ? [{ token: m[1], where: 'file name (pid field)' }] : [];
  return textHits(file, id, pids, 'file name (not a marker name)');
}

/**
 * entries: [{ file, body }] from the real marker folder. marks: { id, names, pids } (names are
 * printed only: every B1 job name is `${id}-...`). Returns one { file, token, where } per hit.
 */
function markerLeaks(entries, marks) {
  const id = String(marks.id);
  const pids = (marks.pids || []).filter((p) => p !== undefined && p !== null && p !== '').map(String);
  const leaks = [];
  for (const { file, body } of entries) {
    for (const h of [...nameHits(file, body, id, pids),...bodyHits(body, id, pids)]) leaks.push({ file, ...h });
  }
  return leaks;
}

module.exports = { markerLeaks, MARKER_NAME, JOB_PREFIX };
