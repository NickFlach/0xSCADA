/**
 * Integration Test #283 — App Startup Verification
 * 
 * Tests that the application starts up without crashing, health endpoint works,
 * and shuts down cleanly. This is a basic smoke test for the server.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';

const sleep = promisify(setTimeout);

describe('App Startup Integration', () => {
  let serverProcess: ChildProcess;
  let baseUrl: string;
  let serverOutput = '';
  const testPort = 5555; // Different from default to avoid conflicts
  
  beforeAll(async () => {
    baseUrl = `http://127.0.0.1:${testPort}`;
    
    // Start the TypeScript entrypoint directly so NODE_ENV remains "test" and
    // the smoke test behaves the same on Windows and Linux. Use an isolated
    // SQLite database: this test verifies process startup and HTTP probes, not
    // the separately tested Postgres integration.
    serverProcess = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: testPort.toString(),
        FORCE_POSTGRES: 'false',
        SQLITE_DATABASE_PATH: ':memory:',
        SIMULATOR_ENABLED: 'false',
        ENABLE_FLUX_INTEGRATION: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout?.on('data', (chunk) => {
      serverOutput += chunk.toString();
    });
    serverProcess.stderr?.on('data', (chunk) => {
      serverOutput += chunk.toString();
    });
    
    // Wait for the liveness endpoint. Readiness is asserted separately once
    // initialization has completed.
    let attempts = 0;
    const maxAttempts = 30; // 30 seconds max
    
    while (attempts < maxAttempts) {
      if (serverProcess.exitCode !== null) {
        throw new Error(
          `Server exited during startup with code ${serverProcess.exitCode}\n${serverOutput.slice(-4000)}`,
        );
      }
      try {
        const response = await fetch(`${baseUrl}/api/healthz`);
        if (response.ok) {
          break;
        }
      } catch {
        // Server not ready yet
      }
      
      attempts++;
      await sleep(1000);
    }
    
    if (attempts >= maxAttempts) {
      throw new Error(
        `Server failed to start within 30 seconds\n${serverOutput.slice(-4000)}`,
      );
    }
  }, 35000); // Allow 35 seconds for full startup

  afterAll(async () => {
    // Clean shutdown of server process
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
      
      // Give it 5 seconds to shut down gracefully
      await sleep(5000);
      
      if (!serverProcess.killed) {
        serverProcess.kill('SIGKILL');
      }
    }
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
    expect(['healthy', 'degraded']).toContain(data.status);
    expect(data.healthy).toBe(true);
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
