import { createHash } from 'node:crypto';

/** Spec section 8.14. A constant, not a random namespace. */
export const FIELDOPS_KNOWLEDGE_NS = '3c9f1a52-7d0e-4b8a-9f61-0c2e5d7b4a90';

const PHYSICS_RUN_NAME = 'knowledge-seeds/physics-movement/run.json';
const RESPONDER_RUN_NAME = 'knowledge-seeds/responder-units';

/** UUIDv5 (RFC 9562): SHA-1 of namespace bytes plus the name, version and variant bits set. */
export function uuidv5(namespace: string, name: string): string {
  const ns = parseUuid(namespace);
  const hash = createHash('sha1')
    .update(Buffer.concat([ns, Buffer.from(name, 'utf8')]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  return formatUuid(bytes);
}

export function derivedPhysicsRunId(): string {
  return uuidv5(FIELDOPS_KNOWLEDGE_NS, PHYSICS_RUN_NAME);
}

export function derivedResponderRunId(): string {
  return uuidv5(FIELDOPS_KNOWLEDGE_NS, RESPONDER_RUN_NAME);
}

export function seedRunId(researchRunId: string, library: string): string {
  return uuidv5(FIELDOPS_KNOWLEDGE_NS, `${researchRunId}:${library}`);
}

function parseUuid(value: string): Buffer {
  const hex = value.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`not a UUID: ${value}`);
  return Buffer.from(hex, 'hex');
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
