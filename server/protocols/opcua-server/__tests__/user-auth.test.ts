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

  test("isValidUserAsync returns boolean matching authenticate", async () => {
    const mgr = createUserManager(lookup);
    expect(await mgr.isValidUserAsync("u", "pw")).toBe(true);
    expect(await mgr.isValidUserAsync("u", "bad")).toBe(false);
    expect(await mgr.isValidUserAsync("x", "pw")).toBe(false);
  });
});
