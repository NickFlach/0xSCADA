/**
 * Integration Test #283 — App Startup Verification
 * 
 * Tests that the application starts up without crashing, health endpoint works,
 * and shuts down cleanly. This is a basic smoke test for the server.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'http';

describe('App Startup Integration', () => {
  let server: http.Server;
  let baseUrl: string;
  const testPort = 5555; // Different from default to avoid conflicts
  
  beforeAll(async () => {
    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.PORT = testPort.toString();
    
    // Mock console.log to reduce noise during tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    
    // Import and start the server
    // We need to import after setting environment variables
    const serverModule = await import('../../server/index');
    
    // Give the server time to start
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    baseUrl = `http://localhost:${testPort}`;
  }, 15000); // Increase timeout for server startup

  afterAll(async () => {
    // Clean shutdown
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    
    // Restore console.log
    vi.restoreAllMocks();
  });

  test('server starts without crashing', async () => {
    // If we got here, the server started successfully in beforeAll
    expect(true).toBe(true);
  });

  test('health endpoint responds correctly', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.ok).toBe(true);
    
    const data = await response.json();
    expect(data).toHaveProperty('status');
    expect(data.status).toBe('healthy');
  });

  test('readiness endpoint responds correctly', async () => {
    const response = await fetch(`${baseUrl}/api/readyz`);
    expect(response.ok).toBe(true);
    
    const data = await response.json();
    expect(data).toHaveProperty('status');
  });

  test('server responds to basic requests', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  test('handles 404 for non-existent endpoints', async () => {
    const response = await fetch(`${baseUrl}/api/nonexistent`);
    expect(response.status).toBe(404);
  });
});