/**
 * [12.7] Configuration Management
 * 
 * Zod-validated config with environment variable mapping, .env support, config dump.
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
    url: z.string().url().optional(),
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
  PIPELINE_BATCH_SIZE: 'pipeline.batchSize',
  PIPELINE_BATCH_INTERVAL_MS: 'pipeline.batchIntervalMs',
  PIPELINE_MAX_QUEUE: 'pipeline.maxQueueDepth',
  BLOCKCHAIN_RPC_URL: 'blockchain.rpcUrl',
  BLOCKCHAIN_CHAIN_ID: 'blockchain.chainId',
  BLOCKCHAIN_CONTRACT: 'blockchain.contractAddress',
  BLOCKCHAIN_PRIVATE_KEY: 'blockchain.privateKey',
  JWT_SECRET: 'auth.jwtSecret',
  JWT_EXPIRES_IN: 'auth.jwtExpiresIn',
  RATE_LIMIT_WINDOW_MS: 'rateLimit.windowMs',
  RATE_LIMIT_MAX: 'rateLimit.maxRequests',
  LOG_LEVEL: 'logging.level',
  LOG_JSON: 'logging.json',
};

// --- Config Manager ---

function setNested(obj: Record<string, any>, path: string, value: string): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!current[parts[i]]) current[parts[i]] = {};
    current = current[parts[i]];
  }
  // Convert booleans
  if (value === 'true') current[parts[parts.length - 1]] = true;
  else if (value === 'false') current[parts[parts.length - 1]] = false;
  else current[parts[parts.length - 1]] = value;
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

export function loadConfig(overrides: Record<string, any> = {}): AppConfig {
  // Load .env file
  const envFile = process.env.ENV_FILE || path.join(process.cwd(), '.env');
  loadEnvFile(envFile);

  // Build raw config from env vars
  const raw: Record<string, any> = {};
  for (const [envKey, configPath] of Object.entries(ENV_MAP)) {
    const val = process.env[envKey];
    if (val !== undefined) setNested(raw, configPath, val);
  }

  // Merge with overrides
  const merged = deepMerge(raw, overrides);

  // Validate
  const result = AppConfigSchema.safeParse(merged);
  if (!result.success) {
    console.error('[config] Validation errors:');
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    }
    throw new Error(`Configuration validation failed: ${result.error.issues.length} errors`);
  }

  return result.data;
}

function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** Dump config for debugging (redacts secrets) */
export function dumpConfig(config: AppConfig): Record<string, any> {
  const dump = JSON.parse(JSON.stringify(config));
  // Redact sensitive values
  if (dump.database?.password) dump.database.password = '***';
  if (dump.blockchain?.privateKey) dump.blockchain.privateKey = '***';
  if (dump.auth?.jwtSecret) dump.auth.jwtSecret = '***';
  return dump;
}

// Singleton
let _config: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_config) _config = loadConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

export default { loadConfig, getConfig, dumpConfig, resetConfig };
