/**
 * Mock configuration helpers for testing
 */

import { vi } from 'vitest';

/**
 * Default mock config values
 */
export const defaultMockConfig = {
  apiUrl: 'http://localhost:3000',
  timeout: 5000,
  defaultFormat: 'table' as const,
  colorEnabled: true,
};

/**
 * Create a mock config module
 */
export function createMockConfig(overrides = {}) {
  return {
    ...defaultMockConfig,
    ...overrides,
  };
}

/**
 * Mock environment variables
 */
export function mockEnv(env: Record<string, string>): () => void {
  const originalEnv = { ...process.env };
  
  Object.entries(env).forEach(([key, value]) => {
    process.env[key] = value;
  });
  
  return () => {
    // Restore original env
    Object.keys(env).forEach((key) => {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    });
  };
}

/**
 * Create isolated config for tests
 */
export function createTestConfig(overrides: Partial<typeof defaultMockConfig> = {}) {
  return {
    ...defaultMockConfig,
    ...overrides,
  };
}
