/**
 * mTLS Certificate Manager
 * 
 * Issue #47 — Certificate generation, rotation, and validation
 * for inter-service mTLS communication in 0xSCADA.
 */

import crypto from 'crypto';
import type {
  MTLSConfig,
  CertificateInfo,
  CertificateStore,
  CertificateRotationPolicy,
  MTLSConnectionOptions,
} from '../../shared/types/mtls';

// =============================================================================
// CERTIFICATE MANAGER
// =============================================================================

export class MTLSManager {
  private store: CertificateStore;
  private rotationPolicy: CertificateRotationPolicy;
  private rotationTimer?: NodeJS.Timeout;

  constructor(private config: MTLSConfig) {
    this.store = {
      ca: [],
      services: new Map(),
    };
    this.rotationPolicy = config.rotationPolicy || {
      maxAgeDays: 90,
      renewBeforeDays: 14,
      autoRotate: true,
    };
  }

  // ===========================================================================
  // CA MANAGEMENT
  // ===========================================================================

  /**
   * Generate a self-signed CA certificate (for dev/testing).
   * In production, use an external CA or Vault PKI.
   */
  generateCA(commonName: string = '0xSCADA Internal CA'): CertificateInfo {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    const caInfo: CertificateInfo = {
      id: crypto.randomUUID(),
      commonName,
      serialNumber: crypto.randomBytes(16).toString('hex'),
      issuedAt: now,
      expiresAt,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      fingerprint: this.computeFingerprint(publicKey.export({ type: 'spki', format: 'pem' }) as string),
      isCA: true,
    };

    this.store.ca.push(caInfo);
    return caInfo;
  }

  // ===========================================================================
  // SERVICE CERTIFICATE MANAGEMENT
  // ===========================================================================

  /**
   * Issue a certificate for a service.
   */
  issueCertificate(serviceName: string, options?: { daysValid?: number }): CertificateInfo {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const daysValid = options?.daysValid || this.rotationPolicy.maxAgeDays;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + daysValid * 24 * 60 * 60 * 1000);

    const certInfo: CertificateInfo = {
      id: crypto.randomUUID(),
      commonName: `${serviceName}.0xscada.internal`,
      serialNumber: crypto.randomBytes(16).toString('hex'),
      issuedAt: now,
      expiresAt,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
      fingerprint: this.computeFingerprint(publicKey.export({ type: 'spki', format: 'pem' }) as string),
      isCA: false,
      serviceName,
    };

    this.store.services.set(serviceName, certInfo);
    console.log(`[mTLS] Issued certificate for ${serviceName} (expires ${expiresAt.toISOString()})`);
    return certInfo;
  }

  /**
   * Get the current certificate for a service.
   */
  getCertificate(serviceName: string): CertificateInfo | undefined {
    return this.store.services.get(serviceName);
  }

  /**
   * Revoke a service certificate.
   */
  revokeCertificate(serviceName: string): boolean {
    const existed = this.store.services.has(serviceName);
    this.store.services.delete(serviceName);
    if (existed) {
      console.log(`[mTLS] Revoked certificate for ${serviceName}`);
    }
    return existed;
  }

  // ===========================================================================
  // VALIDATION
  // ===========================================================================

  /**
   * Validate that a certificate is still valid (not expired, not revoked).
   */
  validateCertificate(serviceName: string): { valid: boolean; reason?: string } {
    const cert = this.store.services.get(serviceName);
    if (!cert) {
      return { valid: false, reason: 'Certificate not found' };
    }
    if (new Date() > cert.expiresAt) {
      return { valid: false, reason: 'Certificate expired' };
    }
    return { valid: true };
  }

  /**
   * Check which certificates are nearing expiry.
   */
  getCertificatesNearingExpiry(): CertificateInfo[] {
    const threshold = new Date(
      Date.now() + this.rotationPolicy.renewBeforeDays * 24 * 60 * 60 * 1000
    );
    const results: CertificateInfo[] = [];
    for (const cert of this.store.services.values()) {
      if (cert.expiresAt <= threshold) {
        results.push(cert);
      }
    }
    return results;
  }

  // ===========================================================================
  // ROTATION
  // ===========================================================================

  /**
   * Rotate a service certificate — issue new, replace old.
   */
  rotateCertificate(serviceName: string): CertificateInfo {
    console.log(`[mTLS] Rotating certificate for ${serviceName}`);
    return this.issueCertificate(serviceName);
  }

  /**
   * Start automatic rotation checking.
   */
  startAutoRotation(intervalMs: number = 60 * 60 * 1000): void {
    if (!this.rotationPolicy.autoRotate) return;

    this.rotationTimer = setInterval(() => {
      const expiring = this.getCertificatesNearingExpiry();
      for (const cert of expiring) {
        if (cert.serviceName) {
          this.rotateCertificate(cert.serviceName);
        }
      }
    }, intervalMs);

    console.log(`[mTLS] Auto-rotation started (check every ${intervalMs / 1000}s)`);
  }

  /**
   * Stop automatic rotation.
   */
  stopAutoRotation(): void {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }
  }

  // ===========================================================================
  // CONNECTION OPTIONS BUILDER
  // ===========================================================================

  /**
   * Build TLS options for a service-to-service connection.
   */
  getConnectionOptions(serviceName: string): MTLSConnectionOptions {
    const cert = this.store.services.get(serviceName);
    if (!cert) {
      throw new Error(`No certificate for service: ${serviceName}`);
    }

    const ca = this.store.ca[0];
    return {
      cert: cert.publicKeyPem,
      key: cert.privateKeyPem,
      ca: ca ? ca.publicKeyPem : undefined,
      rejectUnauthorized: this.config.rejectUnauthorized ?? true,
      requestCert: true,
    };
  }

  // ===========================================================================
  // UTILITIES
  // ===========================================================================

  private computeFingerprint(pem: string): string {
    return crypto.createHash('sha256').update(pem).digest('hex');
  }

  /**
   * List all managed services.
   */
  listServices(): string[] {
    return Array.from(this.store.services.keys());
  }

  /**
   * Get summary status.
   */
  getStatus(): {
    caCount: number;
    serviceCount: number;
    expiringCount: number;
    autoRotation: boolean;
  } {
    return {
      caCount: this.store.ca.length,
      serviceCount: this.store.services.size,
      expiringCount: this.getCertificatesNearingExpiry().length,
      autoRotation: !!this.rotationTimer,
    };
  }

  dispose(): void {
    this.stopAutoRotation();
  }
}
