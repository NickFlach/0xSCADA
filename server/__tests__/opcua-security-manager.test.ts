/**
 * OPC-UA Security and Certificate Management Tests
 *
 * Issue #11 child: 6.1.5 - OPC-UA Security and Certificate Management
 *
 * TDD tests for certificate generation, store management,
 * security policy selection, and user authentication helpers.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

// Mock at module level
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(() => "-----BEGIN CERTIFICATE-----\nMOCKCERT\n-----END CERTIFICATE-----"),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  unlinkSync: vi.fn(),
}));

vi.mock("node:crypto", async () => {
  const fakeKey = "-----BEGIN PRIVATE KEY-----\nMOCKKEY\n-----END PRIVATE KEY-----";
  return {
    generateKeyPairSync: vi.fn(() => ({
      publicKey: "mock-public-key",
      privateKey: fakeKey,
    })),
    createHash: vi.fn(() => ({
      update: vi.fn().mockReturnThis(),
      digest: vi.fn(() => "abcdef1234567890"),
    })),
    X509Certificate: vi.fn().mockImplementation((pem: string) => ({
      subject: "CN=OPC-UA Client",
      issuer: "CN=OPC-UA Client",
      validFrom: new Date(Date.now() - 86400000).toISOString(),
      validTo: new Date(Date.now() + 365 * 86400000).toISOString(),
      fingerprint256: "AB:CD:EF:12:34:56:78:90",
      serialNumber: "01",
      raw: Buffer.from("mock-raw-cert"),
      toString: () => pem,
      checkPrivateKey: vi.fn(() => true),
    })),
    randomUUID: vi.fn(() => "test-uuid-1234"),
  };
});

import {
  SecurityPolicy,
  MessageSecurityMode,
  UserTokenType,
  OpcUaSecurityManager,
} from "../gateway/opcua-security-manager";

const mockedFs = vi.mocked(fs);
const mockedCrypto = vi.mocked(crypto);

// =============================================================================
// SECURITY POLICY ENUM TESTS
// =============================================================================

describe("SecurityPolicy", () => {
  it("should define None policy", () => {
    expect(SecurityPolicy.None).toBe("http://opcfoundation.org/UA/SecurityPolicy#None");
  });

  it("should define Basic256 policy", () => {
    expect(SecurityPolicy.Basic256).toBe("http://opcfoundation.org/UA/SecurityPolicy#Basic256");
  });

  it("should define Basic256Sha256 policy", () => {
    expect(SecurityPolicy.Basic256Sha256).toBe(
      "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256"
    );
  });
});

// =============================================================================
// MESSAGE SECURITY MODE ENUM TESTS
// =============================================================================

describe("MessageSecurityMode", () => {
  it("should define None mode", () => {
    expect(MessageSecurityMode.None).toBe("None");
  });

  it("should define Sign mode", () => {
    expect(MessageSecurityMode.Sign).toBe("Sign");
  });

  it("should define SignAndEncrypt mode", () => {
    expect(MessageSecurityMode.SignAndEncrypt).toBe("SignAndEncrypt");
  });
});

// =============================================================================
// USER TOKEN TYPE ENUM TESTS
// =============================================================================

describe("UserTokenType", () => {
  it("should define Anonymous type", () => {
    expect(UserTokenType.Anonymous).toBe("Anonymous");
  });

  it("should define UserName type", () => {
    expect(UserTokenType.UserName).toBe("UserName");
  });

  it("should define Certificate type", () => {
    expect(UserTokenType.Certificate).toBe("Certificate");
  });
});

// =============================================================================
// SECURITY MANAGER
// =============================================================================

describe("OpcUaSecurityManager", () => {
  let manager: OpcUaSecurityManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new OpcUaSecurityManager({
      certStorePath: "/tmp/test-certs",
      applicationName: "Test OPC-UA Client",
      applicationUri: "urn:test:opcua:client",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("should create manager with default config", () => {
      const mgr = new OpcUaSecurityManager();
      expect(mgr).toBeDefined();
    });

    it("should create manager with custom config", () => {
      expect(manager).toBeDefined();
    });

    it("should initialize certificate store directory", () => {
      expect(mockedFs.mkdirSync).toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // CERTIFICATE GENERATION
  // ===========================================================================

  describe("generateSelfSignedCertificate", () => {
    it("should generate a self-signed certificate", async () => {
      const result = await manager.generateSelfSignedCertificate();
      expect(result).toBeDefined();
      expect(result.certificate).toContain("-----BEGIN CERTIFICATE-----");
      expect(result.privateKey).toContain("-----BEGIN PRIVATE KEY-----");
    });

    it("should accept custom validity days", async () => {
      const result = await manager.generateSelfSignedCertificate({ validityDays: 730 });
      expect(result).toBeDefined();
      expect(result.certificate).toBeDefined();
    });

    it("should accept custom key size", async () => {
      await manager.generateSelfSignedCertificate({ keySize: 4096 });
      expect(mockedCrypto.generateKeyPairSync).toHaveBeenCalledWith(
        "rsa",
        expect.objectContaining({ modulusLength: 4096 })
      );
    });

    it("should save certificate to store", async () => {
      await manager.generateSelfSignedCertificate();
      expect(mockedFs.writeFileSync).toHaveBeenCalled();
    });

    it("should return certificate info with fingerprint", async () => {
      const result = await manager.generateSelfSignedCertificate();
      expect(result.fingerprint).toBeDefined();
      expect(typeof result.fingerprint).toBe("string");
    });
  });

  // ===========================================================================
  // CERTIFICATE STORE MANAGEMENT
  // ===========================================================================

  describe("Certificate Store", () => {
    describe("saveCertificate", () => {
      it("should save a certificate to the trusted store", () => {
        const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
        manager.saveCertificate(pem, "trusted");
        expect(mockedFs.writeFileSync).toHaveBeenCalled();
      });

      it("should save a certificate to the rejected store", () => {
        const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
        manager.saveCertificate(pem, "rejected");
        expect(mockedFs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe("loadCertificate", () => {
      it("should load a certificate by fingerprint", () => {
        mockedFs.existsSync.mockReturnValueOnce(true);
        const cert = manager.loadCertificate("abcdef1234");
        expect(cert).toBeDefined();
      });

      it("should return null for missing certificate", () => {
        mockedFs.existsSync.mockReturnValue(false);
        const cert = manager.loadCertificate("nonexistent");
        expect(cert).toBeNull();
      });
    });

    describe("trustCertificate", () => {
      it("should move certificate to trusted store", () => {
        const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
        manager.trustCertificate(pem);
        expect(mockedFs.writeFileSync).toHaveBeenCalled();
      });
    });

    describe("revokeCertificate", () => {
      it("should move certificate to rejected store", () => {
        const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
        manager.revokeCertificate(pem);
        expect(mockedFs.writeFileSync).toHaveBeenCalled();
      });

      it("should remove from trusted store if present", () => {
        mockedFs.existsSync.mockReturnValue(true);
        const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----";
        manager.revokeCertificate(pem);
        expect(mockedFs.unlinkSync).toHaveBeenCalled();
      });
    });

    describe("listCertificates", () => {
      it("should list trusted certificates", () => {
        mockedFs.readdirSync.mockReturnValueOnce(["cert1.pem", "cert2.pem"] as any);
        mockedFs.existsSync.mockReturnValue(true);
        const certs = manager.listCertificates("trusted");
        expect(certs).toHaveLength(2);
      });

      it("should list rejected certificates", () => {
        mockedFs.readdirSync.mockReturnValueOnce(["bad.pem"] as any);
        mockedFs.existsSync.mockReturnValue(true);
        const certs = manager.listCertificates("rejected");
        expect(certs).toHaveLength(1);
      });

      it("should return empty array for empty store", () => {
        mockedFs.readdirSync.mockReturnValueOnce([] as any);
        const certs = manager.listCertificates("trusted");
        expect(certs).toHaveLength(0);
      });
    });
  });

  // ===========================================================================
  // SECURITY POLICY SELECTION
  // ===========================================================================

  describe("Security Policy Selection", () => {
    it("should validate None policy", () => {
      expect(manager.isValidSecurityPolicy(SecurityPolicy.None)).toBe(true);
    });

    it("should validate Basic256 policy", () => {
      expect(manager.isValidSecurityPolicy(SecurityPolicy.Basic256)).toBe(true);
    });

    it("should validate Basic256Sha256 policy", () => {
      expect(manager.isValidSecurityPolicy(SecurityPolicy.Basic256Sha256)).toBe(true);
    });

    it("should reject invalid policy", () => {
      expect(manager.isValidSecurityPolicy("http://invalid/policy" as any)).toBe(false);
    });

    it("should get recommended policy", () => {
      const policy = manager.getRecommendedSecurityPolicy();
      expect(policy).toBe(SecurityPolicy.Basic256Sha256);
    });
  });

  // ===========================================================================
  // MESSAGE SECURITY MODE CONFIGURATION
  // ===========================================================================

  describe("Message Security Mode Configuration", () => {
    it("should validate compatible policy and mode combinations", () => {
      expect(
        manager.isCompatiblePolicyMode(SecurityPolicy.None, MessageSecurityMode.None)
      ).toBe(true);
      expect(
        manager.isCompatiblePolicyMode(SecurityPolicy.Basic256Sha256, MessageSecurityMode.SignAndEncrypt)
      ).toBe(true);
      expect(
        manager.isCompatiblePolicyMode(SecurityPolicy.Basic256, MessageSecurityMode.Sign)
      ).toBe(true);
    });

    it("should reject incompatible policy and mode combinations", () => {
      expect(
        manager.isCompatiblePolicyMode(SecurityPolicy.None, MessageSecurityMode.Sign)
      ).toBe(false);
      expect(
        manager.isCompatiblePolicyMode(SecurityPolicy.Basic256Sha256, MessageSecurityMode.None)
      ).toBe(false);
    });

    it("should recommend security mode for a policy", () => {
      expect(manager.getRecommendedSecurityMode(SecurityPolicy.None)).toBe(
        MessageSecurityMode.None
      );
      expect(manager.getRecommendedSecurityMode(SecurityPolicy.Basic256Sha256)).toBe(
        MessageSecurityMode.SignAndEncrypt
      );
    });
  });

  // ===========================================================================
  // CERTIFICATE VALIDATION
  // ===========================================================================

  describe("Certificate Validation", () => {
    it("should validate a well-formed certificate", () => {
      const pem = "-----BEGIN CERTIFICATE-----\nMOCKCERT\n-----END CERTIFICATE-----";
      const result = manager.validateCertificate(pem);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject malformed PEM", () => {
      const result = manager.validateCertificate("not-a-certificate");
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should check certificate expiry", () => {
      const pem = "-----BEGIN CERTIFICATE-----\nMOCKCERT\n-----END CERTIFICATE-----";
      const result = manager.validateCertificate(pem);
      expect(result).toHaveProperty("valid");
      expect(result).toHaveProperty("notBefore");
      expect(result).toHaveProperty("notAfter");
    });

    it("should check if certificate is trusted", () => {
      mockedFs.existsSync.mockReturnValue(true);
      const pem = "-----BEGIN CERTIFICATE-----\nMOCKCERT\n-----END CERTIFICATE-----";
      const isTrusted = manager.isCertificateTrusted(pem);
      expect(typeof isTrusted).toBe("boolean");
    });
  });

  // ===========================================================================
  // USER AUTHENTICATION HELPERS
  // ===========================================================================

  describe("User Authentication", () => {
    describe("createAnonymousIdentity", () => {
      it("should create anonymous user identity", () => {
        const identity = manager.createAnonymousIdentity();
        expect(identity.type).toBe(UserTokenType.Anonymous);
      });
    });

    describe("createUserNameIdentity", () => {
      it("should create username/password identity", () => {
        const identity = manager.createUserNameIdentity("admin", "password123");
        expect(identity.type).toBe(UserTokenType.UserName);
        expect(identity.userName).toBe("admin");
        expect(identity.password).toBe("password123");
      });

      it("should reject empty username", () => {
        expect(() => manager.createUserNameIdentity("", "pass")).toThrow();
      });
    });

    describe("createCertificateIdentity", () => {
      it("should create certificate-based identity", () => {
        const cert = "-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----";
        const key = "-----BEGIN PRIVATE KEY-----\nMOCK\n-----END PRIVATE KEY-----";
        const identity = manager.createCertificateIdentity(cert, key);
        expect(identity.type).toBe(UserTokenType.Certificate);
        expect(identity.certificatePem).toBe(cert);
        expect(identity.privateKeyPem).toBe(key);
      });
    });
  });

  // ===========================================================================
  // SECURITY CONFIG BUILDER
  // ===========================================================================

  describe("Security Config Builder", () => {
    it("should build security config for no security", () => {
      const config = manager.buildSecurityConfig({
        securityPolicy: SecurityPolicy.None,
        securityMode: MessageSecurityMode.None,
      });
      expect(config.securityPolicy).toBe(SecurityPolicy.None);
      expect(config.securityMode).toBe(MessageSecurityMode.None);
      expect(config.certificatePem).toBeUndefined();
    });

    it("should build security config with certificates", async () => {
      const certResult = await manager.generateSelfSignedCertificate();
      const config = manager.buildSecurityConfig({
        securityPolicy: SecurityPolicy.Basic256Sha256,
        securityMode: MessageSecurityMode.SignAndEncrypt,
        certificatePem: certResult.certificate,
        privateKeyPem: certResult.privateKey,
      });
      expect(config.securityPolicy).toBe(SecurityPolicy.Basic256Sha256);
      expect(config.securityMode).toBe(MessageSecurityMode.SignAndEncrypt);
      expect(config.certificatePem).toBeDefined();
      expect(config.privateKeyPem).toBeDefined();
    });

    it("should throw for incompatible policy/mode in config", () => {
      expect(() =>
        manager.buildSecurityConfig({
          securityPolicy: SecurityPolicy.None,
          securityMode: MessageSecurityMode.SignAndEncrypt,
        })
      ).toThrow();
    });

    it("should require certificates for non-None security", () => {
      expect(() =>
        manager.buildSecurityConfig({
          securityPolicy: SecurityPolicy.Basic256Sha256,
          securityMode: MessageSecurityMode.SignAndEncrypt,
        })
      ).toThrow();
    });

    it("should include user identity in config", () => {
      const config = manager.buildSecurityConfig({
        securityPolicy: SecurityPolicy.None,
        securityMode: MessageSecurityMode.None,
        userIdentity: manager.createAnonymousIdentity(),
      });
      expect(config.userIdentity).toBeDefined();
      expect(config.userIdentity!.type).toBe(UserTokenType.Anonymous);
    });
  });

  // ===========================================================================
  // CLIENT CERTIFICATE MANAGEMENT
  // ===========================================================================

  describe("Client Certificate", () => {
    it("should get or generate client certificate", async () => {
      const cert = await manager.getClientCertificate();
      expect(cert).toBeDefined();
      expect(cert.certificate).toContain("-----BEGIN CERTIFICATE-----");
    });

    it("should reuse existing client certificate", async () => {
      mockedFs.existsSync.mockImplementation((path: any) => {
        if (String(path).includes("client")) return true;
        return false;
      });
      const cert = await manager.getClientCertificate();
      expect(cert).toBeDefined();
    });
  });

  // ===========================================================================
  // FINGERPRINT COMPUTATION
  // ===========================================================================

  describe("Certificate Fingerprint", () => {
    it("should compute SHA-256 fingerprint of a PEM", () => {
      const pem = "-----BEGIN CERTIFICATE-----\nMOCKCERT\n-----END CERTIFICATE-----";
      const fp = manager.computeFingerprint(pem);
      expect(typeof fp).toBe("string");
      expect(fp.length).toBeGreaterThan(0);
    });

    it("should produce consistent fingerprints", () => {
      const pem = "-----BEGIN CERTIFICATE-----\nMOCKCERT\n-----END CERTIFICATE-----";
      const fp1 = manager.computeFingerprint(pem);
      const fp2 = manager.computeFingerprint(pem);
      expect(fp1).toBe(fp2);
    });
  });
});
