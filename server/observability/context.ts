/**
 * Trace Context Propagation
 *
 * Implements W3C Trace Context propagation for distributed tracing.
 * Supports both incoming and outgoing context propagation.
 *
 * @module server/observability/context
 */

import type { TraceContext, SpanAttributes } from './types.js';
import { TraceFlags } from './types.js';

// ============================================================================
// CONSTANTS
// ============================================================================

const TRACEPARENT_HEADER = 'traceparent';
const TRACESTATE_HEADER = 'tracestate';
const TRACEPARENT_VERSION = '00';

// Regex for W3C traceparent validation
const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

// B3 headers (for compatibility)
const B3_TRACE_ID = 'x-b3-traceid';
const B3_SPAN_ID = 'x-b3-spanid';
const B3_SAMPLED = 'x-b3-sampled';
const B3_PARENT_SPAN_ID = 'x-b3-parentspanid';
const B3_SINGLE_HEADER = 'b3';

// Jaeger headers (for compatibility)
const JAEGER_HEADER = 'uber-trace-id';

// ============================================================================
// ID GENERATION
// ============================================================================

/**
 * Generate a random trace ID (32 hex characters)
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a random span ID (16 hex characters)
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate a trace ID
 */
export function isValidTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/.test(traceId) && traceId !== '00000000000000000000000000000000';
}

/**
 * Validate a span ID
 */
export function isValidSpanId(spanId: string): boolean {
  return /^[0-9a-f]{16}$/.test(spanId) && spanId !== '0000000000000000';
}

// ============================================================================
// W3C TRACE CONTEXT PROPAGATION
// ============================================================================

/**
 * Parse W3C traceparent header
 */
export function parseTraceparent(header: string): TraceContext | null {
  const match = header.toLowerCase().match(TRACEPARENT_REGEX);

  if (!match) {
    return null;
  }

  const [, version, traceId, spanId, flags] = match;

  // Version 00 is the only supported version for now
  if (version === 'ff') {
    return null; // Invalid version
  }

  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: parseInt(flags, 16) as TraceFlags,
  };
}

/**
 * Format W3C traceparent header
 */
export function formatTraceparent(context: TraceContext): string {
  const flags = context.traceFlags.toString(16).padStart(2, '0');
  return `${TRACEPARENT_VERSION}-${context.traceId}-${context.spanId}-${flags}`;
}

/**
 * Parse W3C tracestate header
 */
export function parseTracestate(header: string): Map<string, string> {
  const state = new Map<string, string>();

  if (!header) {
    return state;
  }

  const members = header.split(',');
  for (const member of members) {
    const [key, value] = member.trim().split('=');
    if (key && value) {
      state.set(key.trim(), value.trim());
    }
  }

  return state;
}

/**
 * Format W3C tracestate header
 */
export function formatTracestate(state: Map<string, string>): string {
  const entries: string[] = [];
  for (const [key, value] of state) {
    entries.push(`${key}=${value}`);
  }
  return entries.join(',');
}

// ============================================================================
// B3 PROPAGATION (COMPATIBILITY)
// ============================================================================

/**
 * Parse B3 single header format
 * Format: {TraceId}-{SpanId}-{SamplingState}-{ParentSpanId}
 */
export function parseB3SingleHeader(header: string): TraceContext | null {
  const parts = header.split('-');

  if (parts.length < 2) {
    return null;
  }

  const traceId = parts[0].length === 16 ? parts[0].padStart(32, '0') : parts[0];
  const spanId = parts[1];
  const sampled = parts[2] === '1' || parts[2] === 'd';

  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
}

/**
 * Parse B3 multi-header format
 */
export function parseB3MultiHeader(headers: Record<string, string | undefined>): TraceContext | null {
  const traceIdRaw = headers[B3_TRACE_ID];
  const spanId = headers[B3_SPAN_ID];
  const sampled = headers[B3_SAMPLED];

  if (!traceIdRaw || !spanId) {
    return null;
  }

  const traceId = traceIdRaw.length === 16 ? traceIdRaw.padStart(32, '0') : traceIdRaw;

  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) {
    return null;
  }

  return {
    traceId,
    spanId,
    traceFlags: sampled === '1' ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
}

/**
 * Format B3 headers for outgoing request
 */
export function formatB3Headers(context: TraceContext): Record<string, string> {
  return {
    [B3_TRACE_ID]: context.traceId,
    [B3_SPAN_ID]: context.spanId,
    [B3_SAMPLED]: (context.traceFlags & TraceFlags.SAMPLED) !== 0 ? '1' : '0',
  };
}

// ============================================================================
// JAEGER PROPAGATION (COMPATIBILITY)
// ============================================================================

/**
 * Parse Jaeger uber-trace-id header
 * Format: {trace-id}:{span-id}:{parent-span-id}:{flags}
 */
export function parseJaegerHeader(header: string): TraceContext | null {
  const parts = header.split(':');

  if (parts.length !== 4) {
    return null;
  }

  const [traceIdRaw, spanIdRaw, , flagsRaw] = parts;

  // Jaeger trace IDs can be 16 or 32 hex chars
  const traceId = traceIdRaw.length === 16 ? traceIdRaw.padStart(32, '0') : traceIdRaw;
  const spanId = spanIdRaw.padStart(16, '0');

  if (!isValidTraceId(traceId) || !isValidSpanId(spanId)) {
    return null;
  }

  const flags = parseInt(flagsRaw, 16);
  const sampled = (flags & 0x01) !== 0;

  return {
    traceId,
    spanId,
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
}

/**
 * Format Jaeger header for outgoing request
 */
export function formatJaegerHeader(context: TraceContext, parentSpanId: string = '0'): string {
  const flags = (context.traceFlags & TraceFlags.SAMPLED) !== 0 ? '1' : '0';
  return `${context.traceId}:${context.spanId}:${parentSpanId}:${flags}`;
}

// ============================================================================
// UNIFIED CONTEXT EXTRACTION
// ============================================================================

export type PropagationFormat = 'w3c' | 'b3' | 'jaeger';

/**
 * Headers interface (compatible with HTTP IncomingMessage)
 */
export interface HeaderCarrier {
  [key: string]: string | string[] | undefined;
}

/**
 * Get header value (handles arrays)
 */
function getHeader(headers: HeaderCarrier, key: string): string | undefined {
  const value = headers[key.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

/**
 * Extract trace context from headers using multiple propagation formats
 */
export function extractContext(
  headers: HeaderCarrier,
  formats: PropagationFormat[] = ['w3c', 'b3', 'jaeger']
): TraceContext | null {
  for (const format of formats) {
    let context: TraceContext | null = null;

    switch (format) {
      case 'w3c': {
        const traceparent = getHeader(headers, TRACEPARENT_HEADER);
        if (traceparent) {
          context = parseTraceparent(traceparent);
          if (context) {
            const tracestate = getHeader(headers, TRACESTATE_HEADER);
            if (tracestate) {
              context.traceState = tracestate;
            }
          }
        }
        break;
      }
      case 'b3': {
        const b3Single = getHeader(headers, B3_SINGLE_HEADER);
        if (b3Single) {
          context = parseB3SingleHeader(b3Single);
        } else {
          context = parseB3MultiHeader({
            [B3_TRACE_ID]: getHeader(headers, B3_TRACE_ID),
            [B3_SPAN_ID]: getHeader(headers, B3_SPAN_ID),
            [B3_SAMPLED]: getHeader(headers, B3_SAMPLED),
          });
        }
        break;
      }
      case 'jaeger': {
        const jaegerHeader = getHeader(headers, JAEGER_HEADER);
        if (jaegerHeader) {
          context = parseJaegerHeader(jaegerHeader);
        }
        break;
      }
    }

    if (context) {
      return context;
    }
  }

  return null;
}

/**
 * Inject trace context into headers
 */
export function injectContext(
  context: TraceContext,
  headers: Record<string, string>,
  formats: PropagationFormat[] = ['w3c']
): Record<string, string> {
  const result = { ...headers };

  for (const format of formats) {
    switch (format) {
      case 'w3c':
        result[TRACEPARENT_HEADER] = formatTraceparent(context);
        if (context.traceState) {
          result[TRACESTATE_HEADER] = context.traceState;
        }
        break;
      case 'b3':
        Object.assign(result, formatB3Headers(context));
        break;
      case 'jaeger':
        result[JAEGER_HEADER] = formatJaegerHeader(context);
        break;
    }
  }

  return result;
}

// ============================================================================
// ASYNC CONTEXT MANAGEMENT
// ============================================================================

/**
 * Context storage using AsyncLocalStorage
 * Provides automatic context propagation across async boundaries
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface ContextStore {
  currentContext: TraceContext | null;
  currentSpan: unknown | null;
  baggage: Map<string, string>;
}

const contextStorage = new AsyncLocalStorage<ContextStore>();

/**
 * Get the current context store
 */
export function getContextStore(): ContextStore | undefined {
  return contextStorage.getStore();
}

/**
 * Get the current trace context
 */
export function getCurrentContext(): TraceContext | null {
  const store = contextStorage.getStore();
  return store?.currentContext || null;
}

/**
 * Get the current active span
 */
export function getCurrentSpan<T = unknown>(): T | null {
  const store = contextStorage.getStore();
  return (store?.currentSpan as T) || null;
}

/**
 * Run a function with a specific context
 */
export function runWithContext<T>(context: TraceContext | null, fn: () => T): T {
  const store: ContextStore = {
    currentContext: context,
    currentSpan: null,
    baggage: new Map(),
  };
  return contextStorage.run(store, fn);
}

/**
 * Run a function with a specific span as active
 */
export function runWithSpan<T>(span: unknown, context: TraceContext, fn: () => T): T {
  const existingStore = contextStorage.getStore();
  const store: ContextStore = {
    currentContext: context,
    currentSpan: span,
    baggage: existingStore?.baggage || new Map(),
  };
  return contextStorage.run(store, fn);
}

/**
 * Set baggage item in current context
 */
export function setBaggage(key: string, value: string): void {
  const store = contextStorage.getStore();
  if (store) {
    store.baggage.set(key, value);
  }
}

/**
 * Get baggage item from current context
 */
export function getBaggage(key: string): string | undefined {
  const store = contextStorage.getStore();
  return store?.baggage.get(key);
}

/**
 * Get all baggage items
 */
export function getAllBaggage(): Map<string, string> {
  const store = contextStorage.getStore();
  return new Map(store?.baggage || []);
}

// ============================================================================
// CONTEXT UTILITIES
// ============================================================================

/**
 * Create a new root trace context
 */
export function createRootContext(sampled: boolean = true): TraceContext {
  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
  };
}

/**
 * Create a child context from a parent
 */
export function createChildContext(parent: TraceContext, sampled?: boolean): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: generateSpanId(),
    traceFlags: sampled !== undefined
      ? (sampled ? TraceFlags.SAMPLED : TraceFlags.NONE)
      : parent.traceFlags,
    traceState: parent.traceState,
  };
}

/**
 * Check if a context is sampled
 */
export function isSampled(context: TraceContext): boolean {
  return (context.traceFlags & TraceFlags.SAMPLED) !== 0;
}

/**
 * Create trace context link for logging
 */
export function getTraceLink(context: TraceContext): string {
  return `trace_id=${context.traceId} span_id=${context.spanId}`;
}

/**
 * Create trace context attributes for structured logging
 */
export function getTraceAttributes(context: TraceContext): SpanAttributes {
  return {
    'trace.id': context.traceId,
    'span.id': context.spanId,
    'trace.sampled': isSampled(context),
  };
}
