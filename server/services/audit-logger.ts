/**
 * Immutable Audit Logger
 *
 * CFR 21 Part 11-style audit logging with electronic signatures,
 * timestamp integrity, and user attribution.
 * Issues: #39
 */

import * as crypto from 'crypto';

/** Audit event severity/category */
export enum AuditCategory {
  DATA_MODIFICATION = 'DATA_MODIFICATION',
  CONFIGURATION_CHANGE = 'CONFIGURATION_CHANGE',
  USER_ACTION = 'USER_ACTION',
  SECURITY_EVENT = 'SECURITY_EVENT',
  RECIPE_CHANGE = 'RECIPE_CHANGE',
  SYSTEM_EVENT = 'SYSTEM_EVENT',
  ACCESS_CONTROL = 'ACCESS_CONTROL',
}

/** Electronic signature for CFR 21 Part 11 compliance */
export interface ElectronicSignature {
  /** User who signed */
  userId: string;
  username: string;
  /** Full name of the signer */
  fullName: string;
  /** Timestamp of signature */
  timestamp: string;
  /** Meaning of the signature (e.g., "Approved", "Reviewed", "Authored") */
  meaning: string;
  /** HMAC signature of the audit entry content */
  signature: string;
}

/** Single immutable audit log entry */
export interface AuditEntry {
  /** Unique entry ID */
  id: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Category of the event */
  category: AuditCategory;
  /** Human-readable action description */
  action: string;
  /** Resource type (e.g., "recipe", "tag", "user") */
  resourceType: string;
  /** Resource identifier */
  resourceId: string;
  /** User who performed the action */
  userId: string;
  username: string;
  /** Previous value (for modifications) */
  previousValue?: unknown;
  /** New value (for modifications) */
  newValue?: unknown;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
  /** Electronic signature(s) */
  signatures: ElectronicSignature[];
  /** SHA-256 hash of this entry (for integrity verification) */
  entryHash: string;
  /** Hash of the previous entry (blockchain-style chain) */
  previousEntryHash: string;
}

/** Audit query filters */
export interface AuditQuery {
  startDate?: string;
  endDate?: string;
  userId?: string;
  category?: AuditCategory;
  resourceType?: string;
  resourceId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Compute a SHA-256 hash for an audit entry's content.
 */
function computeEntryHash(entry: Omit<AuditEntry, 'entryHash'>): string {
  const content = JSON.stringify({
    id: entry.id,
    timestamp: entry.timestamp,
    category: entry.category,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    userId: entry.userId,
    previousValue: entry.previousValue,
    newValue: entry.newValue,
    previousEntryHash: entry.previousEntryHash,
  });
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Create an electronic signature for an audit entry.
 */
export function createElectronicSignature(
  entry: { id: string; timestamp: string; action: string },
  signer: { userId: string; username: string; fullName: string },
  meaning: string,
  signingKey: string
): ElectronicSignature {
  const content = `${entry.id}:${entry.timestamp}:${entry.action}:${signer.userId}:${meaning}`;
  const signature = crypto
    .createHmac('sha256', signingKey)
    .update(content)
    .digest('hex');

  return {
    userId: signer.userId,
    username: signer.username,
    fullName: signer.fullName,
    timestamp: new Date().toISOString(),
    meaning,
    signature,
  };
}

/**
 * Verify an electronic signature.
 */
export function verifyElectronicSignature(
  entry: { id: string; timestamp: string; action: string },
  sig: ElectronicSignature,
  signingKey: string
): boolean {
  const content = `${entry.id}:${entry.timestamp}:${entry.action}:${sig.userId}:${sig.meaning}`;
  const expected = crypto
    .createHmac('sha256', signingKey)
    .update(content)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig.signature), Buffer.from(expected));
}

/**
 * Immutable Audit Logger
 *
 * Maintains a hash-chained, append-only audit log with electronic signatures.
 */
export class AuditLogger {
  private entries: AuditEntry[] = [];
  private lastHash = '0'.repeat(64); // Genesis hash
  private signingKey: string;

  constructor(signingKey: string) {
    this.signingKey = signingKey;
  }

  /**
   * Log a new audit entry.
   */
  log(params: {
    category: AuditCategory;
    action: string;
    resourceType: string;
    resourceId: string;
    userId: string;
    username: string;
    fullName?: string;
    previousValue?: unknown;
    newValue?: unknown;
    metadata?: Record<string, unknown>;
    signatureMeaning?: string;
  }): AuditEntry {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const signature = createElectronicSignature(
      { id, timestamp, action: params.action },
      {
        userId: params.userId,
        username: params.username,
        fullName: params.fullName || params.username,
      },
      params.signatureMeaning || 'Authored',
      this.signingKey
    );

    const partialEntry: Omit<AuditEntry, 'entryHash'> = {
      id,
      timestamp,
      category: params.category,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      userId: params.userId,
      username: params.username,
      previousValue: params.previousValue,
      newValue: params.newValue,
      metadata: params.metadata,
      signatures: [signature],
      previousEntryHash: this.lastHash,
    };

    const entryHash = computeEntryHash(partialEntry);
    const entry: AuditEntry = { ...partialEntry, entryHash };

    this.entries.push(entry);
    this.lastHash = entryHash;

    return entry;
  }

  /**
   * Add an additional signature to an existing entry (e.g., approval).
   */
  addSignature(
    entryId: string,
    signer: { userId: string; username: string; fullName: string },
    meaning: string
  ): ElectronicSignature | null {
    const entry = this.entries.find((e) => e.id === entryId);
    if (!entry) return null;

    const sig = createElectronicSignature(
      { id: entry.id, timestamp: entry.timestamp, action: entry.action },
      signer,
      meaning,
      this.signingKey
    );

    entry.signatures.push(sig);
    return sig;
  }

  /**
   * Verify the integrity of the entire audit chain.
   */
  verifyChain(): { valid: boolean; brokenAt?: number } {
    let previousHash = '0'.repeat(64);

    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];

      if (entry.previousEntryHash !== previousHash) {
        return { valid: false, brokenAt: i };
      }

      const { entryHash, ...rest } = entry;
      const computed = computeEntryHash(rest);
      if (computed !== entryHash) {
        return { valid: false, brokenAt: i };
      }

      previousHash = entryHash;
    }

    return { valid: true };
  }

  /**
   * Query audit entries with filters.
   */
  query(filters: AuditQuery = {}): AuditEntry[] {
    let results = [...this.entries];

    if (filters.startDate) {
      results = results.filter((e) => e.timestamp >= filters.startDate!);
    }
    if (filters.endDate) {
      results = results.filter((e) => e.timestamp <= filters.endDate!);
    }
    if (filters.userId) {
      results = results.filter((e) => e.userId === filters.userId);
    }
    if (filters.category) {
      results = results.filter((e) => e.category === filters.category);
    }
    if (filters.resourceType) {
      results = results.filter((e) => e.resourceType === filters.resourceType);
    }
    if (filters.resourceId) {
      results = results.filter((e) => e.resourceId === filters.resourceId);
    }

    const offset = filters.offset || 0;
    const limit = filters.limit || 100;
    return results.slice(offset, offset + limit);
  }

  /**
   * Get total entry count.
   */
  count(): number {
    return this.entries.length;
  }

  /**
   * Export all entries (for external storage/archival).
   */
  export(): AuditEntry[] {
    return [...this.entries];
  }
}
