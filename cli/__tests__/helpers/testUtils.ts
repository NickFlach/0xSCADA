/**
 * General test utilities
 */

import { vi } from 'vitest';

/**
 * Capture console output during tests
 */
export function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  
  const originalLog = console.log;
  const originalError = console.error;
  
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
    getOutput: () => logs.join('\n'),
    getErrors: () => errors.join('\n'),
  };
}

/**
 * Wait for async operations
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a deferred promise for testing async behavior
 */
export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  
  return { promise, resolve, reject };
}

/**
 * Silence console during a test
 */
export function silenceConsole() {
  const spy = {
    log: vi.spyOn(console, 'log').mockImplementation(() => {}),
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  };
  
  return {
    restore: () => {
      spy.log.mockRestore();
      spy.error.mockRestore();
      spy.warn.mockRestore();
    },
  };
}

/**
 * Assert that a function throws with a specific message
 */
export async function expectAsyncError(
  fn: () => Promise<unknown>,
  expectedMessage: string | RegExp
): Promise<void> {
  try {
    await fn();
    throw new Error('Expected function to throw');
  } catch (error) {
    if (error instanceof Error) {
      if (typeof expectedMessage === 'string') {
        if (!error.message.includes(expectedMessage)) {
          throw new Error(
            `Expected error message to include "${expectedMessage}", got "${error.message}"`
          );
        }
      } else {
        if (!expectedMessage.test(error.message)) {
          throw new Error(
            `Expected error message to match ${expectedMessage}, got "${error.message}"`
          );
        }
      }
    }
  }
}
