/**
 * OPC-UA Server Mode — User Authentication
 *
 * Validates UA UserName/Password identity tokens against the **existing**
 * 0xSCADA user store (`shared/schema.ts` -> `users`). There is deliberately no
 * parallel credential store here: `runtime.ts` supplies a {@link UserLookup}
 * backed by a Drizzle query on that table, and this module only decides whether
 * a looked-up record authorises the session.
 *
 * The credential-verification *logic* (active-user check, constant-time hash
 * comparison, format detection) is pure and unit-testable; the lookup is
 * injected so this module never imports the storage layer.
 *
 * Part of #461.
 */

import { createHash, scryptSync, timingSafeEqual } from "crypto";
import { logError } from "../../logger";

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
 *
 * Any other format (bcrypt `$2a$`/`$2b$`/`$2y$`, argon2, …) is **refused**: this
 * function returns `false` rather than guessing, so an unrecognised hash can
 * never produce a false accept.
 *
 * INTEGRATION(user-store): the canonical password-hashing scheme is not yet
 * fixed in this repository (the `users.passwordHash` column exists but no shared
 * verify helper does). When an auth service lands, replace the body of
 * {@link verifyPassword} with a call into it — the rest of this module and the
 * server wiring stay unchanged.
 */
export function verifyPassword(plaintext: string, storedHash: string): boolean {
  if (!storedHash) return false;

  const parts = storedHash.split("$");

  if (parts[0] === "scrypt" && parts.length === 3) {
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length === 0) return false;
    const derived = scryptSync(
      plaintext,
      Buffer.from(saltHex, "hex"),
      expected.length,
    );
    return safeEqual(derived, expected);
  }

  if (parts[0] === "sha256" && parts.length === 3) {
    const [, saltHex, hashHex] = parts;
    const expected = Buffer.from(hashHex, "hex");
    if (expected.length === 0) return false;
    const derived = createHash("sha256")
      .update(Buffer.from(saltHex, "hex"))
      .update(plaintext, "utf8")
      .digest();
    return safeEqual(derived, expected);
  }

  return false;
}

/** Length-safe constant-time buffer comparison. */
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The user-manager shape node-opcua expects.
 *
 * NOTE: despite the name, `isValidUserAsync` is **callback-style** in node-opcua
 * (`UAUserManager1.isValidUser` wraps it in a Promise itself). Returning a
 * promise instead — as the first cut of #461 did — leaves node-opcua's wrapper
 * promise pending forever and every UserName session hangs until it times out.
 */
export interface NodeOpcuaUserManager {
  isValidUserAsync(
    username: string,
    password: string,
    callback: (err: Error | null, isAuthorized?: boolean) => void,
  ): void;
}

/**
 * Build a node-opcua user manager bound to a user lookup.
 *
 * The richer {@link AuthResult} variant is available via {@link authenticate}
 * for callers that want the reason / userId (audit logging, tests).
 */
export function createUserManager(lookup: UserLookup): NodeOpcuaUserManager & {
  authenticate: (username: string, password: string) => Promise<AuthResult>;
} {
  const authenticate = (username: string, password: string) =>
    authenticateUser(lookup, username, password);

  return {
    authenticate,
    isValidUserAsync(username, password, callback) {
      authenticate(username, password).then(
        (result) => callback(null, result.authorized),
        (err: unknown) => {
          // A lookup failure (database down, query error) must deny the session,
          // not surface as an ambiguous error the library might treat loosely.
          logError(err, "[opcua-server] user lookup failed; denying session");
          callback(null, false);
        },
      );
    },
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
