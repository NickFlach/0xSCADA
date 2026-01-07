/**
 * 0xSCADA Cryptographic Infrastructure
 * 
 * PRD Requirements:
 * - Deterministic serialization (canonical JSON)
 * - Event signing (origin signature)
 * - Hash computation (SHA-256)
 * - Merkle tree construction
 * - Signature verification
 */

import { createHash, randomBytes } from "crypto";

// =============================================================================
// CANONICAL JSON SERIALIZATION (PRD: Deterministic serialization)
// =============================================================================

/**
 * Serialize an object to canonical JSON format.
 * This ensures deterministic serialization by:
 * 1. Sorting object keys alphabetically
 * 2. Removing undefined values
 * 3. Using consistent number formatting
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(obj, (key, value) => {
    if (value === undefined) {
      return undefined; // Will be omitted
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      // Sort object keys
      const sorted: Record<string, unknown> = {};
      const keys = Object.keys(value).sort();
      for (const k of keys) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

// =============================================================================
// HASHING (PRD: Hashable events)
// =============================================================================

/**
 * Compute SHA-256 hash of data
 */
export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Compute hash of an object using canonical serialization
 */
export function hashObject(obj: unknown): string {
  const canonical = canonicalize(obj);
  return sha256(canonical);
}

/**
 * Compute hash with 0x prefix for Ethereum compatibility
 */
export function hashObjectHex(obj: unknown): string {
  return "0x" + hashObject(obj);
}

// =============================================================================
// EVENT HASHING (PRD: Event hash computation)
// =============================================================================

export interface EventHashInput {
  eventType: string;
  siteId: string;
  assetId?: string;
  sourceTimestamp: string;
  originType: string;
  originId: string;
  payload: unknown;
}

/**
 * Compute the canonical hash of an event
 * This hash is what gets signed and anchored
 */
export function computeEventHash(event: EventHashInput): string {
  const hashInput = {
    eventType: event.eventType,
    siteId: event.siteId,
    assetId: event.assetId,
    sourceTimestamp: event.sourceTimestamp,
    originType: event.originType,
    originId: event.originId,
    payload: event.payload,
  };
  return hashObject(hashInput);
}

// =============================================================================
// MERKLE TREE (PRD: Merkle root creation for batch anchoring)
// =============================================================================

export interface MerkleTree {
  root: string;
  leaves: string[];
  layers: string[][];
}

/**
 * Build a Merkle tree from a list of hashes
 */
export function buildMerkleTree(hashes: string[]): MerkleTree {
  if (hashes.length === 0) {
    return { root: sha256(""), leaves: [], layers: [[]] };
  }

  // Pad to power of 2 if needed
  const leaves = [...hashes];
  while (leaves.length > 1 && (leaves.length & (leaves.length - 1)) !== 0) {
    leaves.push(leaves[leaves.length - 1]); // Duplicate last hash
  }

  const layers: string[][] = [leaves];
  let currentLayer = leaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      const left = currentLayer[i];
      const right = currentLayer[i + 1] || left;
      nextLayer.push(sha256(left + right));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return {
    root: currentLayer[0],
    leaves: hashes,
    layers,
  };
}

/**
 * Generate Merkle proof for a leaf at given index
 */
export function getMerkleProof(tree: MerkleTree, index: number): string[] {
  const proof: string[] = [];
  let idx = index;

  for (let i = 0; i < tree.layers.length - 1; i++) {
    const layer = tree.layers[i];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;

    if (siblingIdx < layer.length) {
      proof.push(layer[siblingIdx]);
    }

    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Verify a Merkle proof
 */
export function verifyMerkleProof(
  leaf: string,
  proof: string[],
  root: string,
  index: number
): boolean {
  let hash = leaf;
  let idx = index;

  for (const sibling of proof) {
    const isRight = idx % 2 === 1;
    hash = isRight ? sha256(sibling + hash) : sha256(hash + sibling);
    idx = Math.floor(idx / 2);
  }

  return hash === root;
}

// =============================================================================
// KEY GENERATION (For development/testing)
// =============================================================================

/**
 * Generate a random 32-byte hex key (for development)
 * In production, use proper key management
 */
export function generateRandomKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Generate a deterministic key from a seed (for testing)
 */
export function generateDeterministicKey(seed: string): string {
  return sha256(seed);
}

// =============================================================================
// SIMPLE SIGNING (HMAC-based for development)
// In production, use Ed25519 or secp256k1
// =============================================================================

import { createHmac } from "crypto";

/**
 * Sign data with a secret key using HMAC-SHA256
 * This is a simplified signing mechanism for development.
 * Production should use Ed25519 or secp256k1.
 */
export function signWithHmac(data: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(data).digest("hex");
}

/**
 * Verify HMAC signature
 */
export function verifyHmacSignature(
  data: string,
  signature: string,
  secretKey: string
): boolean {
  const expected = signWithHmac(data, secretKey);
  return signature === expected;
}

/**
 * Sign an event
 */
export function signEvent(event: EventHashInput, secretKey: string): string {
  const hash = computeEventHash(event);
  return signWithHmac(hash, secretKey);
}

/**
 * Verify an event signature
 */
export function verifyEventSignature(
  event: EventHashInput,
  signature: string,
  secretKey: string
): boolean {
  const hash = computeEventHash(event);
  return verifyHmacSignature(hash, signature, secretKey);
}

// =============================================================================
// ETHEREUM UTILITIES
// =============================================================================

/**
 * Convert a hash to bytes32 format for Ethereum
 */
export function toBytes32(hash: string): string {
  const cleanHash = hash.startsWith("0x") ? hash.slice(2) : hash;
  return "0x" + cleanHash.padStart(64, "0");
}

/**
 * Validate Ethereum address format
 */
export function isValidEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}
