/**
 * Ubiquity Credentials Manager
 * Handles secure storage and retrieval of Ubiquity cloud credentials
 * Uses AES-256-GCM encryption for credentials at rest
 */

import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { db } from "../../db";
import { ubiquityCredentials } from "../../../shared/schema";
import { eq } from "drizzle-orm";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export interface UbiquityCredentialInput {
  name: string;
  username: string;
  password: string;
  apiKey?: string;
  createdBy: string;
  expiresAt?: Date;
}

export interface DecryptedCredentials {
  id: string;
  name: string;
  username: string;
  password: string;
  apiKey?: string;
  createdBy: string;
  lastUsedAt?: Date;
  expiresAt?: Date;
}

export class CredentialsManager {
  private encryptionKey: Buffer;
  private keyId: string;

  constructor() {
    // In production, this should come from a secure key management service (HSM, KMS)
    const keyEnv = process.env.UBIQUITY_ENCRYPTION_KEY;
    if (keyEnv) {
      this.encryptionKey = Buffer.from(keyEnv, "hex");
      if (this.encryptionKey.length !== KEY_LENGTH) {
        throw new Error("UBIQUITY_ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
      }
    } else {
      // Generate a key for development (WARNING: not persistent across restarts)
      console.warn("⚠️ UBIQUITY_ENCRYPTION_KEY not set, generating ephemeral key");
      this.encryptionKey = randomBytes(KEY_LENGTH);
    }
    this.keyId = "default-v1";
  }

  /**
   * Store credentials securely
   */
  async storeCredentials(input: UbiquityCredentialInput): Promise<string> {
    const encryptedUsername = this.encrypt(input.username);
    const encryptedPassword = this.encrypt(input.password);
    const encryptedApiKey = input.apiKey ? this.encrypt(input.apiKey) : null;

    const [result] = await db
      .insert(ubiquityCredentials)
      .values({
        name: input.name,
        encryptedUsername: encryptedUsername.ciphertext,
        encryptedPassword: encryptedPassword.ciphertext,
        encryptedApiKey: encryptedApiKey?.ciphertext,
        keyId: this.keyId,
        iv: `${encryptedUsername.iv}:${encryptedPassword.iv}${encryptedApiKey ? `:${encryptedApiKey.iv}` : ""}`,
        authTag: `${encryptedUsername.authTag}:${encryptedPassword.authTag}${encryptedApiKey ? `:${encryptedApiKey.authTag}` : ""}`,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt,
      })
      .returning({ id: ubiquityCredentials.id });

    return result.id;
  }

  /**
   * Retrieve and decrypt credentials
   */
  async getCredentials(credentialId: string): Promise<DecryptedCredentials | null> {
    const [credential] = await db
      .select()
      .from(ubiquityCredentials)
      .where(eq(ubiquityCredentials.id, credentialId))
      .limit(1);

    if (!credential) return null;

    // Check expiration
    if (credential.expiresAt && new Date(credential.expiresAt) < new Date()) {
      throw new Error("Credentials have expired");
    }

    // Parse IV and auth tags
    const ivParts = credential.iv.split(":");
    const authTagParts = credential.authTag.split(":");

    const username = this.decrypt(
      credential.encryptedUsername,
      ivParts[0],
      authTagParts[0]
    );

    const password = this.decrypt(
      credential.encryptedPassword,
      ivParts[1],
      authTagParts[1]
    );

    let apiKey: string | undefined;
    if (credential.encryptedApiKey && ivParts[2] && authTagParts[2]) {
      apiKey = this.decrypt(
        credential.encryptedApiKey,
        ivParts[2],
        authTagParts[2]
      );
    }

    // Update last used timestamp
    await db
      .update(ubiquityCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(ubiquityCredentials.id, credentialId));

    return {
      id: credential.id,
      name: credential.name,
      username,
      password,
      apiKey,
      createdBy: credential.createdBy,
      lastUsedAt: credential.lastUsedAt ?? undefined,
      expiresAt: credential.expiresAt ?? undefined,
    };
  }

  /**
   * Rotate credentials (update password/apiKey)
   */
  async rotateCredentials(
    credentialId: string,
    newPassword: string,
    newApiKey?: string
  ): Promise<void> {
    const encryptedPassword = this.encrypt(newPassword);
    const encryptedApiKey = newApiKey ? this.encrypt(newApiKey) : null;

    // Get existing credential to preserve other fields
    const [existing] = await db
      .select()
      .from(ubiquityCredentials)
      .where(eq(ubiquityCredentials.id, credentialId))
      .limit(1);

    if (!existing) {
      throw new Error(`Credential ${credentialId} not found`);
    }

    // Parse existing IVs and auth tags
    const existingIvParts = existing.iv.split(":");
    const existingAuthTagParts = existing.authTag.split(":");

    await db
      .update(ubiquityCredentials)
      .set({
        encryptedPassword: encryptedPassword.ciphertext,
        encryptedApiKey: encryptedApiKey?.ciphertext ?? existing.encryptedApiKey,
        iv: `${existingIvParts[0]}:${encryptedPassword.iv}${encryptedApiKey ? `:${encryptedApiKey.iv}` : existingIvParts[2] ? `:${existingIvParts[2]}` : ""}`,
        authTag: `${existingAuthTagParts[0]}:${encryptedPassword.authTag}${encryptedApiKey ? `:${encryptedApiKey.authTag}` : existingAuthTagParts[2] ? `:${existingAuthTagParts[2]}` : ""}`,
        updatedAt: new Date(),
      })
      .where(eq(ubiquityCredentials.id, credentialId));
  }

  /**
   * Delete credentials
   */
  async deleteCredentials(credentialId: string): Promise<boolean> {
    const result = await db
      .delete(ubiquityCredentials)
      .where(eq(ubiquityCredentials.id, credentialId))
      .returning({ id: ubiquityCredentials.id });

    return result.length > 0;
  }

  /**
   * List credentials (without decrypting sensitive data)
   */
  async listCredentials(): Promise<
    Array<{
      id: string;
      name: string;
      createdBy: string;
      lastUsedAt?: Date;
      expiresAt?: Date;
      createdAt: Date;
    }>
  > {
    const credentials = await db
      .select({
        id: ubiquityCredentials.id,
        name: ubiquityCredentials.name,
        createdBy: ubiquityCredentials.createdBy,
        lastUsedAt: ubiquityCredentials.lastUsedAt,
        expiresAt: ubiquityCredentials.expiresAt,
        createdAt: ubiquityCredentials.createdAt,
      })
      .from(ubiquityCredentials);

    return credentials.map((c) => ({
      ...c,
      lastUsedAt: c.lastUsedAt ?? undefined,
      expiresAt: c.expiresAt ?? undefined,
    }));
  }

  /**
   * Encrypt a string value
   */
  private encrypt(plaintext: string): { ciphertext: string; iv: string; authTag: string } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });

    let encrypted = cipher.update(plaintext, "utf8", "hex");
    encrypted += cipher.final("hex");

    return {
      ciphertext: encrypted,
      iv: iv.toString("hex"),
      authTag: cipher.getAuthTag().toString("hex"),
    };
  }

  /**
   * Decrypt a ciphertext
   */
  private decrypt(ciphertext: string, ivHex: string, authTagHex: string): string {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");

    const decipher = createDecipheriv(ALGORITHM, this.encryptionKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  }
}

// Singleton instance
let credentialsManagerInstance: CredentialsManager | null = null;

export function getCredentialsManager(): CredentialsManager {
  if (!credentialsManagerInstance) {
    credentialsManagerInstance = new CredentialsManager();
  }
  return credentialsManagerInstance;
}
