import fs from "fs";
import path from "path";
import crypto from "crypto";
import os from "os";

/**
 * Secure storage module for credentials
 * Uses AES-256-GCM encryption for file-based storage
 * Falls back to environment variables when available
 */

const STORAGE_DIR = path.join(os.homedir(), ".0xscada");
const CREDENTIALS_FILE = "credentials.enc";
const WALLETS_FILE = "wallets.enc";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

// Derive encryption key from machine-specific data
function getDerivedKey(): Buffer {
  const machineId = `${os.hostname()}-${os.userInfo().username}-0xscada`;
  const salt = crypto.createHash("sha256").update(machineId).digest();
  return crypto.pbkdf2Sync(machineId, salt, 100000, KEY_LENGTH, "sha512");
}

function ensureStorageDir(): void {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
  }
}

function encrypt(data: string): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(data, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

function decrypt(encryptedData: string): string {
  const key = getDerivedKey();
  const parts = encryptedData.split(":");

  if (parts.length !== 3) {
    throw new Error("Invalid encrypted data format");
  }

  const iv = Buffer.from(parts[0], "hex");
  const authTag = Buffer.from(parts[1], "hex");
  const encrypted = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

// API Key Storage

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  scopes: string[];
  createdAt: string;
  lastUsed?: string;
}

export interface AuthCredentials {
  apiKey?: string;
  apiKeys: ApiKey[];
  isLoggedIn: boolean;
  loginTime?: string;
}

function getCredentialsPath(): string {
  return path.join(STORAGE_DIR, CREDENTIALS_FILE);
}

function loadCredentials(): AuthCredentials {
  // Check environment variable first
  const envApiKey = process.env.OXSCADA_API_KEY || process.env["0XSCADA_API_KEY"];

  const defaultCredentials: AuthCredentials = {
    apiKey: envApiKey,
    apiKeys: [],
    isLoggedIn: !!envApiKey,
  };

  const credPath = getCredentialsPath();
  if (!fs.existsSync(credPath)) {
    return defaultCredentials;
  }

  try {
    const encryptedData = fs.readFileSync(credPath, "utf8");
    const decrypted = decrypt(encryptedData);
    const stored = JSON.parse(decrypted) as AuthCredentials;

    // Environment variable takes precedence
    if (envApiKey) {
      stored.apiKey = envApiKey;
      stored.isLoggedIn = true;
    }

    return stored;
  } catch {
    return defaultCredentials;
  }
}

function saveCredentials(credentials: AuthCredentials): void {
  ensureStorageDir();
  const credPath = getCredentialsPath();
  const encrypted = encrypt(JSON.stringify(credentials));
  fs.writeFileSync(credPath, encrypted, { mode: 0o600 });
}

export function login(apiKey: string): void {
  const credentials = loadCredentials();
  credentials.apiKey = apiKey;
  credentials.isLoggedIn = true;
  credentials.loginTime = new Date().toISOString();
  saveCredentials(credentials);
}

export function logout(): void {
  const credentials = loadCredentials();
  credentials.apiKey = undefined;
  credentials.isLoggedIn = false;
  credentials.loginTime = undefined;
  saveCredentials(credentials);
}

export function getAuthStatus(): {
  isLoggedIn: boolean;
  hasEnvKey: boolean;
  loginTime?: string;
  apiKeyCount: number;
} {
  const credentials = loadCredentials();
  const envApiKey = process.env.OXSCADA_API_KEY || process.env["0XSCADA_API_KEY"];

  return {
    isLoggedIn: credentials.isLoggedIn,
    hasEnvKey: !!envApiKey,
    loginTime: credentials.loginTime,
    apiKeyCount: credentials.apiKeys.length,
  };
}

export function getCurrentApiKey(): string | undefined {
  const credentials = loadCredentials();
  return credentials.apiKey;
}

export function listApiKeys(): ApiKey[] {
  const credentials = loadCredentials();
  // Return keys without the actual key value for security
  return credentials.apiKeys.map((k) => ({
    ...k,
    key: `${k.key.substring(0, 8)}...${k.key.substring(k.key.length - 4)}`,
  }));
}

export function createApiKey(name: string, scopes: string[]): ApiKey {
  const credentials = loadCredentials();

  // Generate a new API key
  const keyId = crypto.randomBytes(8).toString("hex");
  const keyValue = `0xscada_${crypto.randomBytes(32).toString("hex")}`;

  const newKey: ApiKey = {
    id: keyId,
    name,
    key: keyValue,
    scopes,
    createdAt: new Date().toISOString(),
  };

  credentials.apiKeys.push(newKey);
  saveCredentials(credentials);

  return newKey;
}

export function revokeApiKey(keyId: string): boolean {
  const credentials = loadCredentials();
  const index = credentials.apiKeys.findIndex((k) => k.id === keyId);

  if (index === -1) {
    return false;
  }

  credentials.apiKeys.splice(index, 1);
  saveCredentials(credentials);
  return true;
}

export function rotateApiKey(keyId: string): ApiKey | null {
  const credentials = loadCredentials();
  const key = credentials.apiKeys.find((k) => k.id === keyId);

  if (!key) {
    return null;
  }

  // Generate new key value
  key.key = `0xscada_${crypto.randomBytes(32).toString("hex")}`;
  key.createdAt = new Date().toISOString();

  saveCredentials(credentials);
  return key;
}

// Wallet Storage

export interface WalletEntry {
  name: string;
  address: string;
  encryptedPrivateKey?: string;
  keyfilePath?: string;
  isDefault: boolean;
  createdAt: string;
}

export interface WalletStorage {
  wallets: WalletEntry[];
  defaultWallet?: string;
}

function getWalletsPath(): string {
  return path.join(STORAGE_DIR, WALLETS_FILE);
}

function loadWallets(): WalletStorage {
  const walletsPath = getWalletsPath();

  if (!fs.existsSync(walletsPath)) {
    return { wallets: [] };
  }

  try {
    const encryptedData = fs.readFileSync(walletsPath, "utf8");
    const decrypted = decrypt(encryptedData);
    return JSON.parse(decrypted) as WalletStorage;
  } catch {
    return { wallets: [] };
  }
}

function saveWallets(storage: WalletStorage): void {
  ensureStorageDir();
  const walletsPath = getWalletsPath();
  const encrypted = encrypt(JSON.stringify(storage));
  fs.writeFileSync(walletsPath, encrypted, { mode: 0o600 });
}

export function listWallets(): WalletEntry[] {
  const storage = loadWallets();
  // Return wallets without sensitive data
  return storage.wallets.map((w) => ({
    ...w,
    encryptedPrivateKey: w.encryptedPrivateKey ? "[encrypted]" : undefined,
  }));
}

export function addWallet(
  name: string,
  keyfilePath?: string,
  privateKey?: string
): WalletEntry {
  const storage = loadWallets();

  // Check for duplicate name
  if (storage.wallets.some((w) => w.name === name)) {
    throw new Error(`Wallet with name '${name}' already exists`);
  }

  let address = "";
  let encryptedPrivateKey: string | undefined;

  if (keyfilePath) {
    // Load address from keyfile
    if (!fs.existsSync(keyfilePath)) {
      throw new Error(`Keyfile not found: ${keyfilePath}`);
    }

    try {
      const keyfile = JSON.parse(fs.readFileSync(keyfilePath, "utf8"));
      address = keyfile.address || "";
      if (!address.startsWith("0x")) {
        address = `0x${address}`;
      }
    } catch {
      throw new Error("Invalid keyfile format");
    }
  } else if (privateKey) {
    // Encrypt and store private key
    encryptedPrivateKey = encrypt(privateKey);

    // Derive address from private key (simplified - in production use ethers.js)
    const hash = crypto.createHash("sha256").update(privateKey).digest("hex");
    address = `0x${hash.substring(0, 40)}`;
  } else {
    throw new Error("Either keyfilePath or privateKey must be provided");
  }

  const newWallet: WalletEntry = {
    name,
    address,
    encryptedPrivateKey,
    keyfilePath: keyfilePath ? path.resolve(keyfilePath) : undefined,
    isDefault: storage.wallets.length === 0,
    createdAt: new Date().toISOString(),
  };

  storage.wallets.push(newWallet);

  if (newWallet.isDefault) {
    storage.defaultWallet = name;
  }

  saveWallets(storage);
  return newWallet;
}

export function removeWallet(name: string): boolean {
  const storage = loadWallets();
  const index = storage.wallets.findIndex((w) => w.name === name);

  if (index === -1) {
    return false;
  }

  storage.wallets.splice(index, 1);

  // Update default if needed
  if (storage.defaultWallet === name) {
    storage.defaultWallet = storage.wallets[0]?.name;
    if (storage.wallets[0]) {
      storage.wallets[0].isDefault = true;
    }
  }

  saveWallets(storage);
  return true;
}

export function setDefaultWallet(name: string): boolean {
  const storage = loadWallets();
  const wallet = storage.wallets.find((w) => w.name === name);

  if (!wallet) {
    return false;
  }

  // Reset all wallets' default flag
  storage.wallets.forEach((w) => {
    w.isDefault = w.name === name;
  });

  storage.defaultWallet = name;
  saveWallets(storage);
  return true;
}

export function getWallet(name?: string): WalletEntry | undefined {
  const storage = loadWallets();

  if (name) {
    return storage.wallets.find((w) => w.name === name);
  }

  // Return default wallet
  return storage.wallets.find((w) => w.isDefault);
}

export function getWalletPrivateKey(name: string): string | undefined {
  const storage = loadWallets();
  const wallet = storage.wallets.find((w) => w.name === name);

  if (!wallet) {
    return undefined;
  }

  if (wallet.encryptedPrivateKey) {
    return decrypt(wallet.encryptedPrivateKey);
  }

  if (wallet.keyfilePath && fs.existsSync(wallet.keyfilePath)) {
    // Note: In production, this would need proper keyfile decryption
    // with password handling
    return undefined;
  }

  return undefined;
}

export function signMessage(walletName: string, message: string): string | null {
  const privateKey = getWalletPrivateKey(walletName);

  if (!privateKey) {
    return null;
  }

  // Simple HMAC signature for demonstration
  // In production, use proper Ethereum signing
  const signature = crypto
    .createHmac("sha256", privateKey)
    .update(message)
    .digest("hex");

  return `0x${signature}`;
}

// Storage paths for diagnostic purposes
export function getStoragePaths(): { credentialsPath: string; walletsPath: string } {
  return {
    credentialsPath: getCredentialsPath(),
    walletsPath: getWalletsPath(),
  };
}

export function clearAllData(): void {
  const credPath = getCredentialsPath();
  const walletsPath = getWalletsPath();

  if (fs.existsSync(credPath)) {
    fs.unlinkSync(credPath);
  }

  if (fs.existsSync(walletsPath)) {
    fs.unlinkSync(walletsPath);
  }
}
