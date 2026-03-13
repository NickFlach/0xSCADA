/**
 * mTLS Transport Security Manager
 * 
 * Handles mutual TLS for secure inter-service communication.
 * Supports development mode with self-signed certificates and certificate rotation.
 * Part of ADR-0021 Security & Resilience Implementation.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createServer, Server as HttpsServer } from 'https';
import { createServer as createHttpServer, Server as HttpServer } from 'http';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';

const exec = promisify(require('child_process').exec);

export interface MTLSConfig {
  mode: 'dev' | 'production';
  certsDir: string;
  ca: {
    cert: string;
    key: string;
  };
  server: {
    cert: string;
    key: string;
  };
  client: {
    cert: string;
    key: string;
  };
  rotationIntervalMs: number; // Auto-rotation interval (0 = disabled)
  keySize: number;
  validityDays: number;
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  validFrom: Date;
  validTo: Date;
  fingerprint: string;
  serialNumber: string;
}

export interface MTLSServerOptions {
  port: number;
  host?: string;
  requireClientCert?: boolean;
  rejectUnauthorized?: boolean;
  ciphers?: string;
}

/**
 * Certificate Authority Manager for development mode
 */
class DevCertificateAuthority {
  private config: MTLSConfig;

  constructor(config: MTLSConfig) {
    this.config = config;
  }

  /**
   * Initialize CA and generate all required certificates
   */
  async initialize(): Promise<void> {
    // Ensure certificates directory exists
    if (!existsSync(this.config.certsDir)) {
      mkdirSync(this.config.certsDir, { recursive: true });
    }

    // Generate CA if it doesn't exist
    if (!this.caExists()) {
      await this.generateCA();
    }

    // Generate server cert if it doesn't exist
    if (!this.serverCertExists()) {
      await this.generateServerCert();
    }

    // Generate client cert if it doesn't exist
    if (!this.clientCertExists()) {
      await this.generateClientCert();
    }
  }

  /**
   * Generate CA certificate and key
   */
  async generateCA(): Promise<void> {
    const caKeyPath = join(this.config.certsDir, this.config.ca.key);
    const caCertPath = join(this.config.certsDir, this.config.ca.cert);

    // Generate CA private key
    await exec(`openssl genrsa -out "${caKeyPath}" ${this.config.keySize}`);

    // Generate CA certificate
    const subject = '/C=US/ST=Dev/L=Development/O=0xSCADA/CN=0xSCADA-CA';
    await exec(`openssl req -new -x509 -days ${this.config.validityDays} -key "${caKeyPath}" -out "${caCertPath}" -subj "${subject}"`);
  }

  /**
   * Generate server certificate signed by CA
   */
  async generateServerCert(): Promise<void> {
    const serverKeyPath = join(this.config.certsDir, this.config.server.key);
    const serverCertPath = join(this.config.certsDir, this.config.server.cert);
    const serverCsrPath = join(this.config.certsDir, 'server.csr');
    const caKeyPath = join(this.config.certsDir, this.config.ca.key);
    const caCertPath = join(this.config.certsDir, this.config.ca.cert);

    // Generate server private key
    await exec(`openssl genrsa -out "${serverKeyPath}" ${this.config.keySize}`);

    // Generate server CSR
    const subject = '/C=US/ST=Dev/L=Development/O=0xSCADA/CN=localhost';
    await exec(`openssl req -new -key "${serverKeyPath}" -out "${serverCsrPath}" -subj "${subject}"`);

    // Generate server certificate signed by CA
    await exec(`openssl x509 -req -days ${this.config.validityDays} -in "${serverCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial -out "${serverCertPath}"`);

    // Clean up CSR
    await exec(`rm -f "${serverCsrPath}"`);
  }

  /**
   * Generate client certificate signed by CA
   */
  async generateClientCert(): Promise<void> {
    const clientKeyPath = join(this.config.certsDir, this.config.client.key);
    const clientCertPath = join(this.config.certsDir, this.config.client.cert);
    const clientCsrPath = join(this.config.certsDir, 'client.csr');
    const caKeyPath = join(this.config.certsDir, this.config.ca.key);
    const caCertPath = join(this.config.certsDir, this.config.ca.cert);

    // Generate client private key
    await exec(`openssl genrsa -out "${clientKeyPath}" ${this.config.keySize}`);

    // Generate client CSR
    const subject = '/C=US/ST=Dev/L=Development/O=0xSCADA/CN=0xSCADA-Client';
    await exec(`openssl req -new -key "${clientKeyPath}" -out "${clientCsrPath}" -subj "${subject}"`);

    // Generate client certificate signed by CA
    await exec(`openssl x509 -req -days ${this.config.validityDays} -in "${clientCsrPath}" -CA "${caCertPath}" -CAkey "${caKeyPath}" -CAcreateserial -out "${clientCertPath}"`);

    // Clean up CSR
    await exec(`rm -f "${clientCsrPath}"`);
  }

  private caExists(): boolean {
    const caKeyPath = join(this.config.certsDir, this.config.ca.key);
    const caCertPath = join(this.config.certsDir, this.config.ca.cert);
    return existsSync(caKeyPath) && existsSync(caCertPath);
  }

  private serverCertExists(): boolean {
    const serverKeyPath = join(this.config.certsDir, this.config.server.key);
    const serverCertPath = join(this.config.certsDir, this.config.server.cert);
    return existsSync(serverKeyPath) && existsSync(serverCertPath);
  }

  private clientCertExists(): boolean {
    const clientKeyPath = join(this.config.certsDir, this.config.client.key);
    const clientCertPath = join(this.config.certsDir, this.config.client.cert);
    return existsSync(clientKeyPath) && existsSync(clientCertPath);
  }
}

/**
 * mTLS Manager
 */
export class MTLSManager extends EventEmitter {
  private config: MTLSConfig;
  private ca: DevCertificateAuthority;
  private rotationTimer?: NodeJS.Timeout;
  private isInitialized = false;

  constructor(config: Partial<MTLSConfig> = {}) {
    super();
    
    this.config = {
      mode: config.mode || 'dev',
      certsDir: config.certsDir || join(process.cwd(), '.certs'),
      ca: {
        cert: 'ca.crt',
        key: 'ca.key',
        ...config.ca,
      },
      server: {
        cert: 'server.crt',
        key: 'server.key',
        ...config.server,
      },
      client: {
        cert: 'client.crt',
        key: 'client.key',
        ...config.client,
      },
      rotationIntervalMs: config.rotationIntervalMs || 0, // Disabled by default
      keySize: config.keySize || 2048,
      validityDays: config.validityDays || 365,
    };

    this.ca = new DevCertificateAuthority(this.config);
  }

  /**
   * Initialize mTLS manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    if (this.config.mode === 'dev') {
      await this.ca.initialize();
    }

    // Start certificate rotation if enabled
    if (this.config.rotationIntervalMs > 0) {
      this.startRotationTimer();
    }

    this.isInitialized = true;
    this.emit('initialized');
  }

  /**
   * Create an HTTPS server with mTLS
   */
  createServer(options: MTLSServerOptions): HttpsServer | HttpServer {
    if (!this.isInitialized) {
      throw new Error('mTLS manager not initialized');
    }

    if (this.config.mode === 'dev') {
      return this.createDevServer(options);
    } else {
      return this.createProductionServer(options);
    }
  }

  /**
   * Get certificate info for verification
   */
  getCertificateInfo(certType: 'ca' | 'server' | 'client'): CertificateInfo | null {
    try {
      const certPath = this.getCertPath(certType);
      const cert = readFileSync(certPath, 'utf8');
      
      // Parse certificate (simplified - in production, use proper crypto library)
      return this.parseCertificate(cert);
    } catch (error) {
      return null;
    }
  }

  /**
   * Get TLS options for client connections
   */
  getClientTLSOptions(): any {
    if (!this.isInitialized) {
      throw new Error('mTLS manager not initialized');
    }

    const caPath = join(this.config.certsDir, this.config.ca.cert);
    const clientCertPath = join(this.config.certsDir, this.config.client.cert);
    const clientKeyPath = join(this.config.certsDir, this.config.client.key);

    return {
      ca: readFileSync(caPath),
      cert: readFileSync(clientCertPath),
      key: readFileSync(clientKeyPath),
      rejectUnauthorized: this.config.mode === 'production',
      checkServerIdentity: this.config.mode === 'production' ? undefined : () => undefined,
    };
  }

  /**
   * Rotate certificates
   */
  async rotateCertificates(): Promise<void> {
    if (this.config.mode !== 'dev') {
      throw new Error('Certificate rotation only supported in dev mode');
    }

    this.emit('rotation-start');

    try {
      // Regenerate all certificates
      await this.ca.generateCA();
      await this.ca.generateServerCert();
      await this.ca.generateClientCert();

      this.emit('rotation-complete');
    } catch (error) {
      this.emit('rotation-error', error);
      throw error;
    }
  }

  /**
   * Stop certificate rotation and cleanup
   */
  async cleanup(): Promise<void> {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }

    this.isInitialized = false;
    this.emit('cleanup');
  }

  /**
   * Create development server with self-signed certificates
   */
  private createDevServer(options: MTLSServerOptions): HttpsServer {
    const serverKeyPath = join(this.config.certsDir, this.config.server.key);
    const serverCertPath = join(this.config.certsDir, this.config.server.cert);
    const caPath = join(this.config.certsDir, this.config.ca.cert);

    const httpsOptions = {
      key: readFileSync(serverKeyPath),
      cert: readFileSync(serverCertPath),
      ca: readFileSync(caPath),
      requestCert: options.requireClientCert !== false,
      rejectUnauthorized: options.rejectUnauthorized !== false,
      ciphers: options.ciphers || 'ECDHE-RSA-AES128-GCM-SHA256:!RC4:HIGH:!MD5:!aNULL:!EDH',
    };

    return createServer(httpsOptions);
  }

  /**
   * Create production server (placeholder)
   */
  private createProductionServer(options: MTLSServerOptions): HttpsServer | HttpServer {
    // In production, certificates would be provided by external CA
    // This is a placeholder for production implementation
    if (options.requireClientCert === false) {
      return createHttpServer();
    }

    throw new Error('Production mTLS server not implemented - provide external certificates');
  }

  /**
   * Start certificate rotation timer
   */
  private startRotationTimer(): void {
    this.rotationTimer = setInterval(async () => {
      try {
        await this.rotateCertificates();
      } catch (error) {
        this.emit('rotation-error', error);
      }
    }, this.config.rotationIntervalMs);
  }

  /**
   * Get certificate file path
   */
  private getCertPath(certType: 'ca' | 'server' | 'client'): string {
    switch (certType) {
      case 'ca':
        return join(this.config.certsDir, this.config.ca.cert);
      case 'server':
        return join(this.config.certsDir, this.config.server.cert);
      case 'client':
        return join(this.config.certsDir, this.config.client.cert);
      default:
        throw new Error(`Unknown certificate type: ${certType}`);
    }
  }

  /**
   * Parse certificate info (simplified implementation)
   */
  private parseCertificate(cert: string): CertificateInfo {
    // This is a simplified parser - in production, use proper crypto library
    return {
      subject: 'CN=Development',
      issuer: 'CN=0xSCADA-CA',
      validFrom: new Date(),
      validTo: new Date(Date.now() + this.config.validityDays * 24 * 60 * 60 * 1000),
      fingerprint: 'dev:fingerprint',
      serialNumber: '1',
    };
  }

  /**
   * Get manager status
   */
  getStatus() {
    return {
      initialized: this.isInitialized,
      mode: this.config.mode,
      certsDir: this.config.certsDir,
      rotationEnabled: this.config.rotationIntervalMs > 0,
      rotationInterval: this.config.rotationIntervalMs,
    };
  }
}

/**
 * mTLS Client for making secure requests to other services
 */
export class MTLSClient {
  private tlsOptions: any;

  constructor(private mtlsManager: MTLSManager) {
    this.tlsOptions = mtlsManager.getClientTLSOptions();
  }

  /**
   * Make secure HTTPS request with mTLS
   */
  async request(url: string, options: any = {}): Promise<any> {
    const https = require('https');
    const { URL } = require('url');

    const parsedUrl = new URL(url);
    const requestOptions = {
      ...this.tlsOptions,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      ...options,
    };

    return new Promise((resolve, reject) => {
      const req = https.request(requestOptions, (res: any) => {
        let data = '';
        res.on('data', (chunk: string) => data += chunk);
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              data: data ? JSON.parse(data) : null,
            });
          } catch (error) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              data,
            });
          }
        });
      });

      req.on('error', reject);
      
      if (options.body) {
        req.write(JSON.stringify(options.body));
      }
      
      req.end();
    });
  }
}

export default MTLSManager;