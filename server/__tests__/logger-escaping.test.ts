/**
 * `server/logger.ts` message escaping (CodeQL js/log-injection #137-140).
 *
 * The five exported helpers take their message as a plain string, and around 63
 * call sites interpolate runtime values into it. Production pino JSON-encodes
 * `msg`, so a newline is escaped for free — but the development transport is
 * `pino-pretty`, which renders `msg` raw. That is the path where a device that
 * controls part of a message can forge a log line or repaint the console with
 * an ANSI escape.
 *
 * These cases pin the escaping AND that every helper actually applies it: the
 * hole reopens the moment one of them forwards a raw message.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

import logger, {
  escapeLogMessage,
  log,
  logDebug,
  logError,
  logInfo,
  logWarn,
} from '../logger';

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);
const DEL = String.fromCharCode(127);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('escapeLogMessage', () => {
  it('leaves ordinary text byte-for-byte alone', () => {
    const message = 'DNP3 SAv5: discarded function 0x81 (association waiting)';
    expect(escapeLogMessage(message)).toBe(message);
  });

  it('keeps non-ASCII text intact', () => {
    // Operators run this in more than one locale; escaping must not mangle it.
    expect(escapeLogMessage('Störung — 温度 ⚠')).toBe('Störung — 温度 ⚠');
  });

  it('escapes a forged second log line', () => {
    const forged = `real${'\n'}12:00:00 INFO all clear`;
    const escaped = escapeLogMessage(forged);
    expect(escaped).toBe('real\\n12:00:00 INFO all clear');
    expect(escaped).not.toContain('\n');
  });

  it('escapes carriage return, which overwrites the current console line', () => {
    expect(escapeLogMessage(`before${'\r'}after`)).toBe('before\\rafter');
  });

  it('escapes an ANSI control sequence', () => {
    const escaped = escapeLogMessage(`${ESC}[2J${ESC}[1;31mFAULT CLEARED`);
    expect(escaped).toBe('\\u001b[2J\\u001b[1;31mFAULT CLEARED');
    expect(escaped).not.toContain(ESC);
  });

  it('escapes NUL and DEL', () => {
    expect(escapeLogMessage(`a${NUL}b${DEL}c`)).toBe('a\\u0000b\\u007fc');
  });

  it('escapes tab', () => {
    expect(escapeLogMessage(`col1${'\t'}col2`)).toBe('col1\\tcol2');
  });

  it('is a no-op on an empty message', () => {
    expect(escapeLogMessage('')).toBe('');
  });
});

describe('every exported helper escapes before pino sees the message', () => {
  const HOSTILE = `tag${'\n'}FORGED${ESC}[0m`;
  const SAFE = 'tag\\nFORGED\\u001b[0m';

  it.each([
    ['log', log, 'info'],
    ['logInfo', logInfo, 'info'],
    ['logWarn', logWarn, 'warn'],
    ['logDebug', logDebug, 'debug'],
  ] as const)('%s', (_name, helper, level) => {
    const spy = vi.spyOn(logger, level).mockImplementation(() => {});
    helper(HOSTILE);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(SAFE);
  });

  it('logError escapes its optional message and passes the error through', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    logError(error, HOSTILE);
    expect(spy.mock.calls[0][0]).toBe(error);
    expect(spy.mock.calls[0][1]).toBe(SAFE);
  });

  it('logError keeps an absent message absent rather than logging "undefined"', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const error = new Error('boom');
    logError(error);
    expect(spy.mock.calls[0][1]).toBeUndefined();
  });

  it('still forwards pino format arguments', () => {
    // The helpers are variadic and callers rely on pino's %s substitution.
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    log('tag %s ok', 'value');
    expect(spy.mock.calls[0]).toEqual(['tag %s ok', 'value']);
  });
});
