/**
 * Logger module
 */
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: process.env.NODE_ENV === 'development' ? {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  } : undefined
});

/**
 * Escape control characters in a message before it becomes pino's `msg`.
 *
 * The helpers below take the message as a plain string, and ~63 call sites
 * interpolate runtime values into it — DNP3 function codes, scheduler
 * warnings, peer identifiers. In production pino JSON-encodes `msg`, so a
 * newline is escaped for free. In development `pino-pretty` renders `msg` RAW,
 * so a value carrying a newline forges a second log line, and one carrying an
 * ANSI escape repaints the lines already printed. An operator reading a console
 * during commissioning is exactly who that misleads.
 *
 * Escaping rather than stripping: the bytes a device actually sent are part of
 * the diagnosis, so they are made visible instead of deleted.
 *
 * Written as a character-code scan rather than a regex on purpose — a literal
 * control-character class in the source is invisible to review and easy to
 * corrupt in transit, which is the same class of problem this function exists
 * to solve.
 *
 * Structured fields are deliberately untouched: pino encodes those itself, and
 * they remain the right place to put an untrusted value.
 */
export function escapeLogMessage(message: string): string {
  // Total by construction. The declared type says `string`, but `logError` is
  // `(error: unknown, message?: string)` and six call sites pass it
  // message-first with an `as any` on the second argument — so an Error object
  // arrives here, `for…of` throws "message is not iterable", and the throw
  // escapes the CATCH BLOCK that was trying to report the original failure.
  // `FluxCommander.pollAll` died that way and took its ack POST with it.
  //
  // pino tolerated the swapped arguments before this escaping existed, which is
  // why the argument-order bug survived unnoticed. Restoring that tolerance is
  // the right call regardless of the call sites: on a control-plane surface a
  // logging helper must never be able to kill a polling loop, and it has no
  // business being the thing that decides a caller's fate.
  //
  // Non-strings are returned untouched rather than coerced — pino formats them
  // itself, and `String(err)` would flatten an Error to "Error: ..." and lose
  // the stack that makes it useful.
  if (typeof message !== 'string') {
    return message as unknown as string;
  }
  let escaped = '';
  for (const char of message) {
    const code = char.codePointAt(0) ?? 0;
    if (code > 31 && code !== 127) {
      escaped += char;
      continue;
    }
    switch (char) {
      case '\n': escaped += '\\n'; break;
      case '\r': escaped += '\\r'; break;
      case '\t': escaped += '\\t'; break;
      default: escaped += `\\u${code.toString(16).padStart(4, '0')}`;
    }
  }
  return escaped;
}

export const log = (message: string, ...args: any[]) => {
  logger.info(escapeLogMessage(message), ...args);
};

export const logError = (error: unknown, message?: string) => {
  logger.error(error, message === undefined ? undefined : escapeLogMessage(message));
};

export const logWarn = (message: string, ...args: any[]) => {
  logger.warn(escapeLogMessage(message), ...args);
};

export const logInfo = (message: string, ...args: any[]) => {
  logger.info(escapeLogMessage(message), ...args);
};

export const logDebug = (message: string, ...args: any[]) => {
  logger.debug(escapeLogMessage(message), ...args);
};

export default logger;
