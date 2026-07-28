import { createHash } from "node:crypto";

/**
 * JSON encoding with recursively sorted object keys. Distributed peers use this
 * before hashing so insertion order cannot change an integrity result.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) {
    return "null";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A stable unsigned 64-bit hash suitable for rings and rollout buckets. */
export function hash64(value: string): bigint {
  return BigInt(`0x${sha256Hex(value).slice(0, 16)}`);
}

/**
 * RFC-6962-style binary Merkle root. Leaves and branches are domain separated
 * so a leaf cannot be confused with an internal node.
 */
export function merkleRoot(values: readonly unknown[]): string {
  if (values.length === 0) {
    return sha256Hex(Buffer.from([0]));
  }

  let level = values.map((value) =>
    sha256Hex(Buffer.concat([Buffer.from([0]), Buffer.from(canonicalJson(value))])),
  );
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? left;
      next.push(
        sha256Hex(
          Buffer.concat([
            Buffer.from([1]),
            Buffer.from(left, "hex"),
            Buffer.from(right, "hex"),
          ]),
        ),
      );
    }
    level = next;
  }
  return level[0];
}
