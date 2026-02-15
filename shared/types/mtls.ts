/**
 * mTLS Types
 * Issue #47 — Types for mutual TLS certificate management.
 */

export interface MTLSConfig {
  /** Whether to reject connections without valid client certs */
  rejectUnauthorized?: boolean;
  /** Certificate rotation policy */
  rotationPolicy?: CertificateRotationPolicy;
}

export interface CertificateInfo {
  id: string;
  commonName: string;
  serialNumber: string;
  issuedAt: Date;
  expiresAt: Date;
  publicKeyPem: string;
  privateKeyPem: string;
  fingerprint: string;
  isCA: boolean;
  serviceName?: string;
}

export interface CertificateStore {
  ca: CertificateInfo[];
  services: Map<string, CertificateInfo>;
}

export interface CertificateRotationPolicy {
  /** Max certificate age in days */
  maxAgeDays: number;
  /** Renew this many days before expiry */
  renewBeforeDays: number;
  /** Enable automatic rotation */
  autoRotate: boolean;
}

export interface MTLSConnectionOptions {
  cert: string;
  key: string;
  ca?: string;
  rejectUnauthorized: boolean;
  requestCert: boolean;
}
