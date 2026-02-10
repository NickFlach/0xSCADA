/**
 * Centralized logger for 0xSCADA server
 * 
 * Provides structured logging with timestamps and source labels.
 * All server modules should use this instead of console.log/error/warn.
 */

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export function logError(message: string, error: unknown, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  const errorDetail = error instanceof Error ? error.message : String(error);
  console.error(`${formattedTime} [${source}] ${message}: ${errorDetail}`);
}

export function logWarn(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.warn(`${formattedTime} [${source}] ${message}`);
}
