/**
 * CLAIM-LEDGER: canonical JSON, the one byte form every ledger hash, MAC and state file uses.
 * Object keys are sorted (by UTF-16 code unit), there is no whitespace, `undefined` members are
 * left out, and arrays keep their order. The same value always gives the same bytes (W1 chain,
 * W2 claims-state.json and its rebuild proof).
 */
import { createHash, createHmac } from 'node:crypto';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('canonicalJson: a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** mac = HMAC-SHA256(key, prev + canonical(record without mac)) (plan §2, F3). */
export function recordMac(key: Uint8Array, rec: Record<string, unknown>): string {
  const { mac: _mac, ...rest } = rec;
  void _mac;
  return createHmac('sha256', key).update(String(rest.prev ?? '')).update(canonicalJson(rest)).digest('hex');
}

/** The id under which a key is known (rekey keyId): the first 16 hex characters of sha256(key). */
export function keyIdOf(key: Uint8Array): string {
  return sha256Hex(key).slice(0, 16);
}
