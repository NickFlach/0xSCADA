/**
 * Tests for [12.7] Configuration Management
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, dumpConfig, diffConfig, resetConfig, AppConfigSchema } from '../config-manager';

describe('ConfigManager', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetConfig();
    // Save env
    for (const key of ['NODE_ENV', 'PORT', 'DB_HOST', 'JWT_SECRET', 'LOG_LEVEL']) {
      savedEnv[key] = process.env[key];
    }
  });

  afterEach(() => {
    // Restore env
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    resetConfig();
  });

  test('loads default config with no env vars', () => {
    const config = loadConfig();
    expect(config.env).toBe('development');
    expect(config.port).toBe(3000);
    expect(config.database.host).toBe('localhost');
  });

  test('overrides from env vars', () => {
    process.env.PORT = '8080';
    process.env.DB_HOST = 'db.example.com';
    process.env.LOG_LEVEL = 'debug';
    
    const config = loadConfig();
    expect(config.port).toBe(8080);
    expect(config.database.host).toBe('db.example.com');
    expect(config.logging.level).toBe('debug');
  });

  test('overrides from parameter', () => {
    const config = loadConfig({ port: 9999 });
    expect(config.port).toBe(9999);
  });

  test('validates config and rejects invalid values', () => {
    expect(() => loadConfig({ port: -1 })).toThrow();
  });

  test('dumpConfig redacts sensitive fields', () => {
    const config = loadConfig({ auth: { jwtSecret: 'my-super-secret-key-here' } });
    const dump = dumpConfig(config);
    expect(dump.auth.jwtSecret).toBe('***');
  });

  test('dumpConfig preserves non-sensitive fields', () => {
    const config = loadConfig({ port: 4000 });
    const dump = dumpConfig(config);
    expect(dump.port).toBe(4000);
  });

  test('diffConfig detects changes', () => {
    const a = loadConfig({ port: 3000 });
    resetConfig();
    const b = loadConfig({ port: 4000 });
    const diff = diffConfig(a, b);
    expect(diff.find(d => d.path === 'port')).toBeTruthy();
  });

  test('diffConfig redacts sensitive field values', () => {
    const a = loadConfig({ auth: { jwtSecret: 'aaaaaaaaaaaaaaaa' } });
    resetConfig();
    const b = loadConfig({ auth: { jwtSecret: 'bbbbbbbbbbbbbbbb' } });
    const diff = diffConfig(a, b);
    const jwtDiff = diff.find(d => d.path === 'auth.jwtSecret');
    expect(jwtDiff?.from).toBe('***');
    expect(jwtDiff?.to).toBe('***');
  });

  test('schema handles CORS_ORIGINS as comma-separated', () => {
    process.env.CORS_ORIGINS = 'http://a.com,http://b.com';
    const config = loadConfig();
    expect(config.cors.origins).toEqual(['http://a.com', 'http://b.com']);
  });

  test('schema validates with all defaults', () => {
    const result = AppConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});
