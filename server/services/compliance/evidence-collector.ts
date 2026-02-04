/**
 * Evidence Collector for NERC CIP Compliance
 *
 * Automated and manual evidence collection from various
 * sources to support compliance assessments.
 */

import crypto from 'crypto';
import {
  EvidenceArtifact,
  EvidenceSource,
  EvidenceSourceType,
} from './types';
import { EVIDENCE_SOURCES, getEvidenceSourceById } from './cip-requirements';

/**
 * Evidence collection result
 */
interface CollectionResult {
  success: boolean;
  artifact?: EvidenceArtifact;
  error?: string;
}

/**
 * Evidence collector configuration
 */
interface CollectorConfig {
  dbQuery?: (sql: string) => Promise<unknown>;
  fileRead?: (path: string) => Promise<string>;
  httpFetch?: (url: string) => Promise<unknown>;
  retentionDays: number;
}

/**
 * Evidence Collector class
 *
 * Handles automated and manual evidence collection for
 * NERC CIP compliance assessments.
 */
export class EvidenceCollector {
  private config: CollectorConfig;
  private artifacts: Map<string, EvidenceArtifact[]> = new Map();

  constructor(config: CollectorConfig) {
    this.config = config;
  }

  /**
   * Collect evidence from a specific source
   */
  async collectEvidence(
    sourceId: string,
    controlId: string,
    options?: { force?: boolean; userId?: string }
  ): Promise<CollectionResult> {
    const source = getEvidenceSourceById(sourceId);
    if (!source) {
      return { success: false, error: `Evidence source not found: ${sourceId}` };
    }

    // Check if we have recent evidence
    if (!options?.force) {
      const existing = this.getRecentEvidence(sourceId, controlId);
      if (existing) {
        return { success: true, artifact: existing };
      }
    }

    try {
      const content = await this.fetchEvidenceContent(source);
      const artifact = this.createArtifact(source, controlId, content, options?.userId);
      this.storeArtifact(artifact);
      return { success: true, artifact };
    } catch (error) {
      return {
        success: false,
        error: `Failed to collect evidence: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Collect all evidence for a control
   */
  async collectAllEvidenceForControl(
    controlId: string,
    sourceIds: string[],
    options?: { force?: boolean; userId?: string }
  ): Promise<Map<string, CollectionResult>> {
    const results = new Map<string, CollectionResult>();

    await Promise.all(
      sourceIds.map(async (sourceId) => {
        const result = await this.collectEvidence(sourceId, controlId, options);
        results.set(sourceId, result);
      })
    );

    return results;
  }

  /**
   * Add manual evidence artifact
   */
  addManualEvidence(
    sourceId: string,
    controlId: string,
    content: string | object,
    userId: string,
    metadata?: Record<string, unknown>
  ): EvidenceArtifact {
    const source = getEvidenceSourceById(sourceId);
    if (!source) {
      throw new Error(`Evidence source not found: ${sourceId}`);
    }

    const artifact = this.createArtifact(source, controlId, content, userId, metadata);
    artifact.collector = 'manual';
    this.storeArtifact(artifact);
    return artifact;
  }

  /**
   * Get evidence artifacts for a control
   */
  getEvidenceForControl(controlId: string): EvidenceArtifact[] {
    return this.artifacts.get(controlId) || [];
  }

  /**
   * Get all evidence artifacts
   */
  getAllEvidence(): EvidenceArtifact[] {
    const all: EvidenceArtifact[] = [];
    this.artifacts.forEach((artifacts) => all.push(...artifacts));
    return all;
  }

  /**
   * Verify evidence artifact integrity
   */
  verifyEvidence(artifact: EvidenceArtifact): boolean {
    const computedHash = this.computeHash(artifact.content);
    return computedHash === artifact.hash;
  }

  /**
   * Clean up expired evidence
   */
  cleanupExpiredEvidence(): number {
    const now = new Date();
    let cleaned = 0;

    this.artifacts.forEach((artifacts, controlId) => {
      const valid = artifacts.filter((a) => {
        if (a.expiresAt && a.expiresAt < now) {
          cleaned++;
          return false;
        }
        return true;
      });
      this.artifacts.set(controlId, valid);
    });

    return cleaned;
  }

  /**
   * Get evidence collection status for all sources
   */
  getCollectionStatus(): Map<string, { lastCollected?: Date; count: number }> {
    const status = new Map<string, { lastCollected?: Date; count: number }>();

    EVIDENCE_SOURCES.forEach((source) => {
      const artifacts = this.getAllEvidence().filter((a) => a.sourceId === source.id);
      status.set(source.id, {
        lastCollected: artifacts.length > 0
          ? new Date(Math.max(...artifacts.map((a) => a.collectedAt.getTime())))
          : undefined,
        count: artifacts.length,
      });
    });

    return status;
  }

  /**
   * Schedule automated evidence collection
   */
  scheduleAutomatedCollection(
    controlId: string,
    sourceIds: string[],
    intervalMinutes: number,
    callback?: (results: Map<string, CollectionResult>) => void
  ): NodeJS.Timeout {
    return setInterval(async () => {
      const results = await this.collectAllEvidenceForControl(controlId, sourceIds);
      callback?.(results);
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Export evidence for audit
   */
  exportEvidence(
    controlIds?: string[],
    options?: { includeContent?: boolean; format?: 'json' | 'csv' }
  ): string {
    let artifacts = this.getAllEvidence();

    if (controlIds?.length) {
      artifacts = artifacts.filter((a) => controlIds.includes(a.controlId));
    }

    if (options?.format === 'csv') {
      return this.exportAsCsv(artifacts, options.includeContent);
    }

    return JSON.stringify(
      options?.includeContent
        ? artifacts
        : artifacts.map(({ content, ...rest }) => rest),
      null,
      2
    );
  }

  // Private methods

  private async fetchEvidenceContent(source: EvidenceSource): Promise<unknown> {
    switch (source.type) {
      case 'audit-log':
      case 'access-control':
      case 'asset-inventory':
      case 'patch-record':
      case 'training-record':
      case 'change-request':
        if (source.query && this.config.dbQuery) {
          return await this.config.dbQuery(source.query);
        }
        throw new Error(`Database query function not configured for ${source.type}`);

      case 'configuration':
      case 'policy-document':
      case 'network-diagram':
        if (source.location && this.config.fileRead) {
          return await this.config.fileRead(source.location);
        }
        throw new Error(`File read function not configured for ${source.type}`);

      case 'vulnerability-scan':
        if (source.location && this.config.fileRead) {
          return await this.config.fileRead(source.location);
        }
        throw new Error('Vulnerability scan file not accessible');

      case 'manual-attestation':
        throw new Error('Manual attestation requires manual evidence submission');

      default:
        throw new Error(`Unknown evidence source type: ${source.type}`);
    }
  }

  private createArtifact(
    source: EvidenceSource,
    controlId: string,
    content: unknown,
    userId?: string,
    metadata?: Record<string, unknown>
  ): EvidenceArtifact {
    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + this.config.retentionDays);

    return {
      id: crypto.randomUUID(),
      sourceId: source.id,
      controlId,
      collectedAt: now,
      expiresAt,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      hash: this.computeHash(content),
      collector: userId ? 'manual' : 'automated',
      collectorId: userId,
      metadata: metadata || {},
    };
  }

  private storeArtifact(artifact: EvidenceArtifact): void {
    const existing = this.artifacts.get(artifact.controlId) || [];
    existing.push(artifact);
    this.artifacts.set(artifact.controlId, existing);
  }

  private getRecentEvidence(
    sourceId: string,
    controlId: string
  ): EvidenceArtifact | undefined {
    const source = getEvidenceSourceById(sourceId);
    if (!source?.refreshInterval) return undefined;

    const artifacts = this.artifacts.get(controlId) || [];
    const cutoff = new Date();
    cutoff.setMinutes(cutoff.getMinutes() - source.refreshInterval);

    return artifacts.find(
      (a) => a.sourceId === sourceId && a.collectedAt > cutoff
    );
  }

  private computeHash(content: unknown): string {
    const str = typeof content === 'string' ? content : JSON.stringify(content);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  private exportAsCsv(artifacts: EvidenceArtifact[], includeContent?: boolean): string {
    const headers = [
      'id',
      'sourceId',
      'controlId',
      'collectedAt',
      'expiresAt',
      'collector',
      'collectorId',
      'hash',
      ...(includeContent ? ['content'] : []),
    ];

    const rows = artifacts.map((a) => [
      a.id,
      a.sourceId,
      a.controlId,
      a.collectedAt.toISOString(),
      a.expiresAt?.toISOString() || '',
      a.collector,
      a.collectorId || '',
      a.hash,
      ...(includeContent ? [JSON.stringify(a.content)] : []),
    ]);

    return [
      headers.join(','),
      ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
  }
}

/**
 * Create evidence collector with default configuration
 */
export function createEvidenceCollector(
  config?: Partial<CollectorConfig>
): EvidenceCollector {
  return new EvidenceCollector({
    retentionDays: 365, // NERC requires minimum 3 years for some evidence
    ...config,
  });
}
