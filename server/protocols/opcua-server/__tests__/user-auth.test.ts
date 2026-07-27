/**
 * Tests for OPC-UA UserName/Password authentication (#461).
 *
 * Pure logic: password verification + the authenticate flow against an injected
 * user lookup. No database or node-opcua required.
 */
import { describe, test, expect } from "vitest";
import { createHash, scryptSync } from "crypto";
import {
  verifyPassword,
  authenticateUser,
  createUserManager,
  type AuthUserRecord,
} from "../user-auth";

/** Helpers to build stored hashes in the documented formats. */
function scryptHash(plaintext: string, saltHex: string): string {
  const derived = scryptSync(plaintext, Buffer.from(saltHex, "hex"), 32);
  return `scrypt$${saltHex}$${derived.toString("hex")}`;
}
function sha256Hash(plaintext: string, saltHex: string): string {
  const derived = createHash("sha256")
    .update(Buffer.from(saltHex, "hex"))
    .update(plaintext, "utf8")
    .digest("hex");
  return `sha256$${saltHex}$${derived}`;
}

const SALT = "0011223344556677";

describe("verifyPassword", () => {
  test("accepts a correct scrypt password", () => {
    const stored = scryptHash("hunter2", SALT);
    expect(verifyPassword("hunter2", stored)).toBe(true);
  });

  test("rejects a wrong scrypt password", () => {
    const stored = scryptHash("hunter2", SALT);
    expect(verifyPassword("wrong", stored)).toBe(false);
  });

  test("accepts a correct salted sha256 password", () => {
    const stored = sha256Hash("s3cret", SALT);
    expect(verifyPassword("s3cret", stored)).toBe(true);
    expect(verifyPassword("nope", stored)).toBe(false);
  });

  test("refuses unsupported formats (e.g. bcrypt) — never a false accept", () => {
    expect(verifyPassword("x", "$2b$10$abcdefghijklmnopqrstuv")).toBe(false);
  });

  test("rejects empty stored hash", () => {
    expect(verifyPassword("x", "")).toBe(false);
  });
});

describe("authenticateUser", () => {
  const user: AuthUserRecord = {
    id: "user-1",
    username: "operator",
    passwordHash: scryptHash("hunter2", SALT),
    isActive: true,
  };
  const lookup = async (u: string) => (u === user.username ? user : null);

  test("authorizes a valid active user", async () => {
    const res = await authenticateUser(lookup, "operator", "hunter2");
    expect(res).toEqual({ authorized: true, userId: "user-1" });
  });

  test("rejects unknown user", async () => {
    const res = await authenticateUser(lookup, "ghost", "x");
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe("unknown-user");
  });

  test("rejects inactive user", async () => {
    const inactiveLookup = async () => ({ ...user, isActive: false });
    const res = await authenticateUser(inactiveLookup, "operator", "hunter2");
    expect(res.authorized).toBe(false);
    expect(res.reason).toBe("inactive-user");
  });

  test("rejects user with no password set", async () => {
    const noPw = async () => ({ ...user, passwordHash: null });
    const res = await authenticateUser(noPw, "operator", "hunter2");
    expect(res.reason).toBe("no-password-set");
  });

  test("rejects bad password", async () => {
    const res = await authenticateUser(lookup, "operator", "wrong");
    expect(res.reason).toBe("bad-password");
  });

  test("rejects missing credentials", async () => {
    expect((await authenticateUser(lookup, "", "x")).reason).toBe(
      "missing-credentials",
    );
    expect((await authenticateUser(lookup, "operator", "")).reason).toBe(
      "missing-credentials",
    );
  });
});

describe("createUserManager", () => {
  const user: AuthUserRecord = {
    id: "u",
    username: "u",
    passwordHash: scryptHash("pw", SALT),
    isActive: true,
  };
  const lookup = async (n: string) => (n === "u" ? user : null);

  /**
   * node-opcua invokes `isValidUserAsync(username, password, callback)` and
   * wraps it in its own Promise. A promise-returning implementation would leave
   * that wrapper pending forever, so the callback contract is asserted directly.
   */
  function callIsValidUser(
    manager: ReturnType<typeof createUserManager>,
    username: string,
    password: string,
  ): Promise<{ err: Error | null; authorized?: boolean }> {
    return new Promise((resolve) => {
      const result = manager.isValidUserAsync(
        username,
        password,
        (err, authorized) => resolve({ err, authorized }),
      );
      expect(result).toBeUndefined();
    });
  }

  test("invokes the node-opcua callback with the authentication outcome", async () => {
    const manager = createUserManager(lookup);
    await expect(callIsValidUser(manager, "u", "pw")).resolves.toEqual({
      err: null,
      authorized: true,
    });
    await expect(callIsValidUser(manager, "u", "bad")).resolves.toEqual({
      err: null,
      authorized: false,
    });
    await expect(callIsValidUser(manager, "x", "pw")).resolves.toEqual({
      err: null,
      authorized: false,
    });
  });

  test("denies the session when the user lookup itself fails", async () => {
    const failing = createUserManager(async () => {
      throw new Error("database unavailable");
    });
    await expect(callIsValidUser(failing, "u", "pw")).resolves.toEqual({
      err: null,
      authorized: false,
    });
  });

  test("exposes the richer authenticate() result alongside the callback API", async () => {
    const manager = createUserManager(lookup);
    await expect(manager.authenticate("u", "pw")).resolves.toEqual({
      authorized: true,
      userId: "u",
    });
  });
});
