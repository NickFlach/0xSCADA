/**
 * [12.7] Configuration Management
 * 
 * Zod-validated config with environment variable mapping, .env support,
 * environment-based profiles, secrets management, config dump/diff.
 * 
 * Closes #209
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// --- Schema ---

export const AppConfigSchema = z.object({
  env: z.enum(['development', 'production', 'test', 'staging']).default('development'),
  port: z.coerce.number().int().min(1).max(65535).default(3000),
  host: z.string().default('0.0.0.0'),

  database: z.object({
    url: z.string().optional(),
    host: z.string().default('localhost'),
    port: z.coerce.number().default(5432),
    name: z.string().default('oxscada'),
    user: z.string().default('oxscada'),
    password: z.string().default(''),
    ssl: z.boolean().default(false),
    poolSize: z.coerce.number().default(10),
  }).default({}),

  gateway: z.object({
    opcuaEndpoint: z.string().optional(),
    modbusHost: z.string().default('127.0.0.1'),
    modbusPort: z.coerce.number().default(502),
    scanRateMs: z.coerce.number().default(1000),
    enabled: z.boolean().default(true),
  }).default({}),

  pipeline: z.object({
    batchSize: z.coerce.number().default(100),
    batchIntervalMs: z.coerce.number().default(5000),
    maxQueueDepth: z.coerce.number().default(10000),
    enableBlockchainAnchor: z.boolean().default(true),
    enableHistorian: z.boolean().default(true),
  }).default({}),

  blockchain: z.object({
    rpcUrl: z.string().default('http://localhost:8545'),
    chainId: z.coerce.number().default(31337),
    contractAddress: z.string().optional(),
    privateKey: z.string().optional(),
  }).default({}),

  auth: z.object({
    jwtSecret: z.string().min(16).default('change-me-in-production-please'),
    jwtExpiresIn: z.string().default('24h'),
    enableApiKeys: z.boolean().default(false),
    enable2FA: z.boolean().default(false),
    sessionSecret: z.string().default('session-change-me'),
  }).default({}),

  rateLimit: z.object({
    windowMs: z.coerce.number().default(60000),
    maxRequests: z.coerce.number().default(100),
  }).default({}),

  cors: z.object({
    origins: z.array(z.string()).default(['http://localhost:3000', 'http://localhost:5173']),
  }).default({}),

  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    json: z.boolean().default(false),
  }).default({}),

  healthCheck: z.object({
    enabled: z.boolean().default(true),
    intervalMs: z.coerce.number().default(30000),
    cacheTtlMs: z.coerce.number().default(10000),
  }).default({}),

  secrets: z.object({
    /** Provider: env | file | vault */
    provider: z.enum(['env', 'file', 'vault']).default('env'),
    /** Path to secrets file (for file provider) */
    filePath: z.string().optional(),
    /** Vault URL (for vault provider) */
    vaultUrl: z.string().optional(),
    /** Vault token (for vault provider) */
    vaultToken: z.string().optional(),
  }).default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

// --- Environment Variable Mapping ---

const ENV_MAP: Record<string, string> = {
  NODE_ENV: 'env',
  PORT: 'port',
  HOST: 'host',
  DATABASE_URL: 'database.url',
  DB_HOST: 'database.host',
  DB_PORT: 'database.port',
  DB_NAME: 'database.name',
  DB_USER: 'database.user',
  DB_PASSWORD: 'database.password',
  DB_SSL: 'database.ssl',
  DB_POOL_SIZE: 'database.poolSize',
  OPCUA_ENDPOINT: 'gateway.opcuaEndpoint',
  MODBUS_HOST: 'gateway.modbusHost',
  MODBUS_PORT: 'gateway.modbusPort',
  GATEWAY_SCAN_RATE_MS: 'gateway.scanRateMs',
  GATEWAY_ENABLED: 'gateway.enabled',
  PIPELINE_BATCH_SIZE: 'pipeline.batchSize',
  PIPELINE_BATCH_INTERVAL_MS: 'pipeline.batchIntervalMs',
  PIPELINE_MAX_QUEUE: 'pipeline.maxQueueDepth',
  PIPELINE_ENABLE_ANCHOR: 'pipeline.enableBlockchainAnchor',
  PIPELINE_ENABLE_HISTORIAN: 'pipeline.enableHistorian',
  BLOCKCHAIN_RPC_URL: 'blockchain.rpcUrl',
  BLOCKCHAIN_CHAIN_ID: 'blockchain.chainId',
  BLOCKCHAIN_CONTRACT: 'blockchain.contractAddress',
  BLOCKCHAIN_PRIVATE_KEY: 'blockchain.privateKey',
  JWT_SECRET: 'auth.jwtSecret',
  JWT_EXPIRES_IN: 'auth.jwtExpiresIn',
  ENABLE_API_KEYS: 'auth.enableApiKeys',
  SESSION_SECRET: 'auth.sessionSecret',
  RATE_LIMIT_WINDOW_MS: 'rateLimit.windowMs',
  RATE_LIMIT_MAX: 'rateLimit.maxRequests',
  CORS_ORIGINS: 'cors.origins',
  LOG_LEVEL: 'logging.level',
  LOG_JSON: 'logging.json',
  HEALTH_CHECK_INTERVAL: 'healthCheck.intervalMs',
  SECRETS_PROVIDER: 'secrets.provider',
  SECRETS_FILE: 'secrets.filePath',
  VAULT_URL: 'secrets.vaultUrl',
  VAULT_TOKEN: 'secrets.vaultToken',
};

/** Fields that contain sensitive data — always redacted in dumps */
const SENSITIVE_FIELDS = new Set([
  'database.password',
  'blockchain.privateKey',
  'auth.jwtSecret',
  'auth.sessionSecret',
  'secrets.vaultToken',
]);

// --- Environment Profiles ---

const ENV_PROFILES: Record<string, Partial<Record<string, unknown>>> = {
  development: {
    'logging.level': 'debug',
    'logging.json': false,
    'rateLimit.maxRequests': 1000,
    'cors.origins': ['http://localhost:3000', 'http://localhost:5000', 'http://localhost:5173'],
  },
  test: {
    'logging.level': 'warn',
    'logging.json': false,
    'pipeline.enableBlockchainAnchor': false,
    'gateway.enabled': false,
    'healthCheck.enabled': false,
  },
  staging: {
    'logging.level': 'info',
    'logging.json': true,
    'rateLimit.maxRequests': 200,
  },
  production: {
    'logging.level': 'info',
    'logging.json': true,
    'rateLimit.maxRequests': 100,
  },
};

// --- Helpers ---

function setNested(obj: Record<string, any>, path: string, value: unknown): void {
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (FORBIDDEN_KEYS.has(key)) return; // Guard against prototype pollution
    if (!Object.prototype.hasOwnProperty.call(current, key) || !current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  const finalKey = parts[parts.length - 1];
  if (FORBIDDEN_KEYS.has(finalKey)) return; // Guard against prototype pollution
  current[finalKey] = value;
}

function getNested(obj: Record<string, any>, path: string): unknown {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function parseEnvValue(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Handle comma-separated arrays
  if (value.includes(',') && !value.startsWith('{')) {
    return value.split(',').map(s => s.trim());
  }
  return value;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else if (source[key] !== undefined) {
      result[key] = source[key];
    }
  }
  return result;
}

// --- Secrets Management ---

export interface SecretsProvider {
  get(key: string): Promise<string | undefined>;
  set?(key: string, value: string): Promise<void>;
}

class EnvSecretsProvider implements SecretsProvider {
  async get(key: string): Promise<string | undefined> {
    return process.env[key];
  }
}

class FileSecretsProvider implements SecretsProvider {
  private secrets: Record<string, string> = {};

  constructor(filePath: string) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.secrets = JSON.parse(content);
      } catch {
        console.error(`[config] Failed to load secrets from ${filePath}`);
      }
    }
  }

  async get(key: string): Promise<string | undefined> {
    return this.secrets[key];
  }
}

export function createSecretsProvider(config: AppConfig['secrets']): SecretsProvider {
  switch (config.provider) {
    case 'file':
      return new FileSecretsProvider(config.filePath || '.secrets.json');
    case 'vault':
      // Vault integration would go here
      console.warn('[config] Vault secrets provider not yet implemented, falling back to env');
      return new EnvSecretsProvider();
    default:
      return new EnvSecretsProvider();
  }
}

// --- Config Manager ---

export function loadConfig(overrides: Record<string, any> = {}): AppConfig {
  // Determine environment
  const env = process.env.NODE_ENV || 'development';

  // Load .env files in priority order
  const envFiles = [
    `.env.${env}.local`,
    `.env.${env}`,
    '.env.local',
    '.env',
  ];
  const basePath = process.env.CONFIG_BASE_PATH || process.cwd();
  for (const file of envFiles) {
    loadEnvFile(path.join(basePath, file));
  }

  // Build raw config from env vars
  const raw: Record<string, any> = {};
  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    const val = process.env[envKey];
    if (val !== undefined) setNested(raw, configPath, parseEnvValue(val));
  }

  // Apply environment profile defaults
  const profile = ENV_PROFILES[env];
  if (profile) {
    const profileObj: Record<string, any> = {};
    for (const [path, value] of Object.entries(profile)) {
      setNested(profileObj, path, value);
    }
    // Profile is lowest priority — env vars and overrides win
    const merged = deepMerge(profileObj, deepMerge(raw, overrides));
    return validateConfig(merged);
  }

  return validateConfig(deepMerge(raw, overrides));
}

function validateConfig(raw: Record<string, any>): AppConfig {
  const result = AppConfigSchema.safeParse(raw);
  if (!result.success) {
    const errors = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`);
    console.error('[config] Validation errors:\n' + errors.join('\n'));
    throw new Error(`Configuration validation failed: ${result.error.issues.length} errors`);
  }

  // Warn about insecure defaults in production
  const config = result.data;
  if (config.env === 'production') {
    if (config.auth.jwtSecret === 'change-me-in-production-please') {
      console.warn('[config] ⚠️  Using default JWT secret in production!');
    }
    if (config.auth.sessionSecret === 'session-change-me') {
      console.warn('[config] ⚠️  Using default session secret in production!');
    }
  }

  return config;
}

/** Dump config for debugging (redacts sensitive values) */
export function dumpConfig(config: AppConfig): Record<string, any> {
  const dump = JSON.parse(JSON.stringify(config));

  // Redact sensitive fields
  for (const field of SENSITIVE_FIELDS) {
    const val = getNested(dump, field);
    if (val && typeof val === 'string' && val.length > 0) {
      setNested(dump, field, '***');
    }
  }

  return dump;
}

/** Diff two configs, returning changed paths */
export function diffConfig(a: AppConfig, b: AppConfig): Array<{ path: string; from: unknown; to: unknown }> {
  const changes: Array<{ path: string; from: unknown; to: unknown }> = [];
  const aFlat = flattenObject(a);
  const bFlat = flattenObject(b);

  const allKeys = new Set([...Object.keys(aFlat), ...Object.keys(bFlat)]);
  for (const key of allKeys) {
    if (JSON.stringify(aFlat[key]) !== JSON.stringify(bFlat[key])) {
      changes.push({
        path: key,
        from: SENSITIVE_FIELDS.has(key) ? '***' : aFlat[key],
        to: SENSITIVE_FIELDS.has(key) ? '***' : bFlat[key],
      });
    }
  }

  return changes;
}

function flattenObject(obj: Record<string, any>, prefix = ''): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, path));
    } else {
      result[path] = value;
    }
  }
  return result;
}

// --- Singleton ---

let _config: AppConfig | null = null;
let _secretsProvider: SecretsProvider | null = null;

export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

export function getSecretsProvider(): SecretsProvider {
  if (!_secretsProvider) {
    const config = getConfig();
    _secretsProvider = createSecretsProvider(config.secrets);
  }
  return _secretsProvider;
}

export function resetConfig(): void {
  _config = null;
  _secretsProvider = null;
}

/** Reload config (e.g., after env change) and return diff */
export function reloadConfig(): { config: AppConfig; changes: Array<{ path: string; from: unknown; to: unknown }> } {
  const old = _config;
  _config = null;
  const newConfig = getConfig();
  const changes = old ? diffConfig(old, newConfig) : [];
  return { config: newConfig, changes };
}

export default { loadConfig, getConfig, dumpConfig, diffConfig, resetConfig, reloadConfig, getSecretsProvider };
