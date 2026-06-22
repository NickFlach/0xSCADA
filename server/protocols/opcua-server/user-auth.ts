/**
 * OPC-UA Server Mode — User Authentication
 *
 * Validates UA UserName/Password identity tokens against the existing 0xSCADA
 * user store (`shared/schema.ts` -> `users`, accessed via the storage layer).
 *
 * The credential-verification *logic* (active-user check, constant-time hash
 * comparison, format detection) is pure and unit-testable. Looking the user up
 * is delegated to an injected {@link UserLookup} so this module does not import
 * the Drizzle storage layer directly and stays testable without a database.
 *
 * Implements the user-authentication acceptance criterion of #461:
 *   - anonymous (dev) + username/password against the existing user store.
 */

import { createHash, scryptSync, timingSafeEqual } from "crypto";

/** Minimal projection of a `users` row needed to authenticate. */
export interface AuthUserRecord {
  id: string;
  username: string;
  passwordHash: string | null;
  isActive: boolean;
}

/** Resolves a username to a stored user record (or null if absent). */
export type UserLookup = (username: string) => Promise<AuthUserRecord | null>;

export interface AuthResult {
  authorized: boolean;
  userId?: string;
  reason?: string;
}

/**
 * Verify a plaintext password against a stored hash.
 *
 * Supported stored formats (auto-detected by prefix):
 *   - `scrypt$<saltHex>$<hashHex>`  — Node scrypt, no external dependency.
 *   - `sha256$<saltHex>$<hashHex>`  — legacy salted SHA-256.
 *   - bcrypt (`$2a$` / `$2b$` / `$2y$`) — NOT verified here; see TODO.
 *
 * INTEGRATION(user-store): the canonical password-hashing scheme for #461 is
 * not yet fixed in this repo (the `users.passwordHash` column exists but no
 * shared verify helper does). When the auth service lands, replace
 * {@link verifyPassword} with a call into it. Until then this helper supports
 * the dependency-free scrypt/sha256 formats so the server is usable in dev.
 */
export function verifyPassword(plaintext: string, storedHash: string): boolean {
  if (!storedHash) return false;

  const parts = storedHash.split("$");

  if (parts[0] === "scrypt" && parts.length === 3) {
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, "hex");
    const derived = scryptSync(plaintext, Buffer.from(saltHex, "hex"), expected.length);
    return safeEqual(derived, expected);
  }

  if (parts[0] === "sha256" && parts.length === 3) {
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, "hex");
    const derived = createHash("sha256")
      .update(Buffer.from(saltHex, "hex"))
      .update(plaintext, "utf8")
      .digest();
    return safeEqual(derived, expected);
  }

  // bcrypt and other formats require their own libraries. We deliberately
  // refuse rather than silently allowing — never a false "authorized".
  // TODO(#461): integrate the shared password verifier (likely bcrypt) once
  // the auth service exposes one.
  return false;
}

/** Length-safe constant-time buffer comparison. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Build a UA username/password validation function bound to a user lookup.
 *
 * Returns an async predicate `(username, password) => boolean` matching the
 * shape `node-opcua` expects for `userManager.isValidUserAsync`. The richer
 * {@link AuthResult} variant is available via {@link authenticateUser} for
 * callers that want the reason / userId.
 */
export function createUserManager(lookup: UserLookup): {
  isValidUserAsync: (username: string, password: string) => Promise<boolean>;
  authenticate: (username: string, password: string) => Promise<AuthResult>;
} {
  const authenticate = (username: string, password: string) =>
    authenticateUser(lookup, username, password);

  return {
    authenticate,
    isValidUserAsync: async (username, password) =>
      (await authenticate(username, password)).authorized,
  };
}

/** Core authentication flow: look up, check active, verify password. */
export async function authenticateUser(
  lookup: UserLookup,
  username: string,
  password: string,
): Promise<AuthResult> {
  if (!username || !password) {
    return { authorized: false, reason: "missing-credentials" };
  }

  const user = await lookup(username);
  if (!user) {
    return { authorized: false, reason: "unknown-user" };
  }
  if (!user.isActive) {
    return { authorized: false, reason: "inactive-user" };
  }
  if (!user.passwordHash) {
    return { authorized: false, reason: "no-password-set" };
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return { authorized: false, reason: "bad-password" };
  }

  return { authorized: true, userId: user.id };
}
