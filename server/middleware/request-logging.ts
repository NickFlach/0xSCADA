import type { NextFunction, Request, RequestHandler, Response } from "express";
import { log } from "../logger";

export const SENSITIVE_RESPONSE_LOG_MARKER = "[sensitive response redacted]";
export const SENSITIVE_PATH_SEGMENT_MARKER = "[redacted]";

declare global {
  namespace Express {
    interface Locals {
      sensitiveResponse?: boolean;
    }
  }
}

export interface RequestLogDetails {
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  responseBody?: unknown;
  sensitiveResponse?: boolean;
}

/**
 * Key revocation identifies the credential in the route path. Preserve the
 * route shape for operations while ensuring the bearer secret never reaches
 * access logs.
 */
export function redactSensitiveRequestPath(path: string): string {
  return path.replace(
    /^(\/api\/v1\/gateway\/keys\/)[^/]+(?=\/?$)/iu,
    `$1${SENSITIVE_PATH_SEGMENT_MARKER}`,
  );
}

/** Build a deterministic log line without ever serializing marked secrets. */
export function formatRequestLog(details: RequestLogDetails): string {
  let line =
    `${details.method} ${details.path} ${details.statusCode} in ${details.durationMs}ms`;

  if (details.sensitiveResponse) {
    return `${line} :: ${SENSITIVE_RESPONSE_LOG_MARKER}`;
  }
  if (details.responseBody !== undefined) {
    line += ` :: ${JSON.stringify(details.responseBody)}`;
  }
  return line;
}

/**
 * Capture JSON responses for API request logging. Handlers that return a
 * one-time credential set `res.locals.sensitiveResponse` before responding.
 */
export function requestLoggingMiddleware(
  writeLog: (message: string, ...args: any[]) => void = log,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = Date.now();
    const path = req.path;
    let capturedJsonResponse: unknown;

    const originalJson = res.json;
    res.json = function captureJson(body, ...args) {
      capturedJsonResponse = body;
      return originalJson.apply(res, [body, ...args]);
    };

    res.on("finish", () => {
      if (!path.toLowerCase().startsWith("/api")) return;
      writeLog("HTTP request completed", {
        method: req.method,
        path: redactSensitiveRequestPath(path),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        responseBody: res.locals.sensitiveResponse === true
          ? SENSITIVE_RESPONSE_LOG_MARKER
          : capturedJsonResponse,
        sensitiveResponse: res.locals.sensitiveResponse === true,
      });
    });

    next();
  };
}
