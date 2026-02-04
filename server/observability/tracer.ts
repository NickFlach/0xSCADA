/**
 * OpenTelemetry Tracer Implementation
 *
 * Provides span creation, lifecycle management, and context propagation.
 * Can operate as a standalone implementation or integrate with OpenTelemetry SDK.
 *
 * @module server/observability/tracer
 */

import type {
  Span,
  SpanOptions,
  SpanAttributes,
  SpanAttributeValue,
  SpanStatus,
  SpanEvent,
  SpanLink,
  TraceContext,
  Tracer,
  TracerProvider,
  TelemetryConfig,
  SamplerConfig,
  SamplingResult,
  SamplingDecision,
} from './types.js';
import { SpanKind, SpanStatusCode, TraceFlags } from './types.js';
import {
  generateSpanId,
  generateTraceId,
  getCurrentContext,
  runWithSpan,
  isSampled,
} from './context.js';

// ============================================================================
// SPAN IMPLEMENTATION
// ============================================================================

/**
 * Internal span data structure
 */
interface SpanData {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  status: SpanStatus;
  attributes: SpanAttributes;
  events: SpanEvent[];
  links: SpanLink[];
  traceFlags: TraceFlags;
  traceState?: string;
}

/**
 * Concrete Span implementation
 */
class SpanImpl implements Span {
  private data: SpanData;
  private ended: boolean = false;
  private readonly onEnd: (span: SpanData) => void;

  constructor(
    name: string,
    traceId: string,
    spanId: string,
    kind: SpanKind,
    traceFlags: TraceFlags,
    onEnd: (span: SpanData) => void,
    options: {
      parentSpanId?: string;
      attributes?: SpanAttributes;
      links?: SpanLink[];
      startTime?: number;
      traceState?: string;
    } = {}
  ) {
    this.data = {
      name,
      traceId,
      spanId,
      parentSpanId: options.parentSpanId,
      kind,
      startTime: options.startTime ?? Date.now(),
      status: { code: SpanStatusCode.UNSET },
      attributes: { ...options.attributes },
      events: [],
      links: options.links ? [...options.links] : [],
      traceFlags,
      traceState: options.traceState,
    };
    this.onEnd = onEnd;
  }

  context(): TraceContext {
    return {
      traceId: this.data.traceId,
      spanId: this.data.spanId,
      traceFlags: this.data.traceFlags,
      traceState: this.data.traceState,
    };
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    if (!this.ended) {
      this.data.attributes[key] = value;
    }
    return this;
  }

  setAttributes(attributes: SpanAttributes): this {
    if (!this.ended) {
      Object.assign(this.data.attributes, attributes);
    }
    return this;
  }

  addEvent(name: string, attributes?: SpanAttributes, timestamp?: number): this {
    if (!this.ended) {
      this.data.events.push({
        name,
        timestamp: timestamp ?? Date.now(),
        attributes,
      });
    }
    return this;
  }

  addLink(link: SpanLink): this {
    if (!this.ended) {
      this.data.links.push(link);
    }
    return this;
  }

  setStatus(status: SpanStatus): this {
    if (!this.ended) {
      this.data.status = status;
    }
    return this;
  }

  updateName(name: string): this {
    if (!this.ended) {
      this.data.name = name;
    }
    return this;
  }

  recordException(exception: Error, time?: number): this {
    if (!this.ended) {
      const attributes: SpanAttributes = {
        'exception.type': exception.name,
        'exception.message': exception.message,
      };
      if (exception.stack) {
        attributes['exception.stacktrace'] = exception.stack;
      }
      this.addEvent('exception', attributes, time);
      this.setStatus({
        code: SpanStatusCode.ERROR,
        message: exception.message,
      });
    }
    return this;
  }

  end(endTime?: number): void {
    if (!this.ended) {
      this.data.endTime = endTime ?? Date.now();
      this.ended = true;
      this.onEnd(this.data);
    }
  }

  isRecording(): boolean {
    return !this.ended && isSampled(this.context());
  }

  /**
   * Get raw span data (for exporters)
   */
  getData(): Readonly<SpanData> {
    return this.data;
  }
}

/**
 * No-op span implementation for when tracing is disabled
 */
class NoopSpan implements Span {
  private readonly ctx: TraceContext;

  constructor(ctx?: TraceContext) {
    this.ctx = ctx ?? {
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: TraceFlags.NONE,
    };
  }

  context(): TraceContext {
    return this.ctx;
  }
  setAttribute(): this {
    return this;
  }
  setAttributes(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  setStatus(): this {
    return this;
  }
  updateName(): this {
    return this;
  }
  recordException(): this {
    return this;
  }
  end(): void {}
  isRecording(): boolean {
    return false;
  }
}

// ============================================================================
// SAMPLER IMPLEMENTATION
// ============================================================================

/**
 * Make sampling decision
 */
function makeSamplingDecision(
  config: SamplerConfig,
  traceId: string,
  parentContext?: TraceContext
): SamplingResult {
  switch (config.type) {
    case 'always_on':
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };

    case 'always_off':
      return { decision: SamplingDecision.NOT_RECORD };

    case 'ratio': {
      const ratio = config.ratio ?? 0.1;
      // Use trace ID to make deterministic sampling decision
      const hash = parseInt(traceId.substring(0, 8), 16);
      const threshold = Math.floor(ratio * 0xffffffff);
      return {
        decision: hash < threshold
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
      };
    }

    case 'parent_based': {
      if (parentContext) {
        // Follow parent's sampling decision
        return {
          decision: isSampled(parentContext)
            ? SamplingDecision.RECORD_AND_SAMPLED
            : SamplingDecision.NOT_RECORD,
        };
      }
      // Use root sampler for root spans
      const rootConfig = config.rootSampler ?? { type: 'always_on' as const };
      return makeSamplingDecision(rootConfig, traceId);
    }

    default:
      return { decision: SamplingDecision.RECORD_AND_SAMPLED };
  }
}

// ============================================================================
// TRACER IMPLEMENTATION
// ============================================================================

/**
 * Concrete Tracer implementation
 */
class TracerImpl implements Tracer {
  private readonly name: string;
  private readonly version: string;
  private readonly samplerConfig: SamplerConfig;
  private readonly onSpanEnd: (span: SpanData) => void;

  constructor(
    name: string,
    version: string,
    samplerConfig: SamplerConfig,
    onSpanEnd: (span: SpanData) => void
  ) {
    this.name = name;
    this.version = version;
    this.samplerConfig = samplerConfig;
    this.onSpanEnd = onSpanEnd;
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const parentContext = options.parent ?? getCurrentContext();
    const traceId = parentContext?.traceId ?? generateTraceId();

    // Make sampling decision
    const samplingResult = makeSamplingDecision(
      this.samplerConfig,
      traceId,
      parentContext ?? undefined
    );

    if (samplingResult.decision === SamplingDecision.NOT_RECORD) {
      return new NoopSpan({
        traceId,
        spanId: generateSpanId(),
        traceFlags: TraceFlags.NONE,
      });
    }

    const spanId = generateSpanId();
    const traceFlags = samplingResult.decision === SamplingDecision.RECORD_AND_SAMPLED
      ? TraceFlags.SAMPLED
      : TraceFlags.NONE;

    const span = new SpanImpl(
      name,
      traceId,
      spanId,
      options.kind ?? SpanKind.INTERNAL,
      traceFlags,
      this.onSpanEnd,
      {
        parentSpanId: parentContext?.spanId,
        attributes: {
          ...samplingResult.attributes,
          ...options.attributes,
          'otel.library.name': this.name,
          'otel.library.version': this.version,
        },
        links: options.links,
        startTime: options.startTime,
        traceState: parentContext?.traceState ?? samplingResult.traceState,
      }
    );

    return span;
  }

  startActiveSpan<T>(name: string, fnOrOptions: SpanOptions | ((span: Span) => T), maybeFn?: (span: Span) => T): T {
    let options: SpanOptions;
    let fn: (span: Span) => T;

    if (typeof fnOrOptions === 'function') {
      options = {};
      fn = fnOrOptions;
    } else {
      options = fnOrOptions;
      fn = maybeFn!;
    }

    const span = this.startSpan(name, options);
    const context = span.context();

    try {
      return runWithSpan(span, context, () => {
        try {
          const result = fn(span);
          // Handle async functions
          if (result instanceof Promise) {
            return result
              .then((value) => {
                span.end();
                return value;
              })
              .catch((error) => {
                span.recordException(error);
                span.end();
                throw error;
              }) as unknown as T;
          }
          span.end();
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.end();
          throw error;
        }
      });
    } catch (error) {
      throw error;
    }
  }
}

/**
 * No-op tracer for when tracing is disabled
 */
class NoopTracer implements Tracer {
  startSpan(): Span {
    return new NoopSpan();
  }

  startActiveSpan<T>(name: string, fnOrOptions: SpanOptions | ((span: Span) => T), maybeFn?: (span: Span) => T): T {
    const fn = typeof fnOrOptions === 'function' ? fnOrOptions : maybeFn!;
    return fn(new NoopSpan());
  }
}

// ============================================================================
// SPAN PROCESSOR
// ============================================================================

/**
 * Span processor interface
 */
export interface SpanProcessor {
  onStart(span: SpanData): void;
  onEnd(span: SpanData): void;
  shutdown(): Promise<void>;
  forceFlush(): Promise<void>;
}

/**
 * Batch span processor - batches spans for efficient export
 */
export class BatchSpanProcessor implements SpanProcessor {
  private readonly exporter: SpanExporter;
  private readonly maxExportBatchSize: number;
  private readonly maxQueueSize: number;
  private readonly scheduledDelayMillis: number;
  private readonly exportTimeoutMillis: number;

  private queue: SpanData[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isShutdown = false;

  constructor(
    exporter: SpanExporter,
    options: {
      maxExportBatchSize?: number;
      maxQueueSize?: number;
      scheduledDelayMillis?: number;
      exportTimeoutMillis?: number;
    } = {}
  ) {
    this.exporter = exporter;
    this.maxExportBatchSize = options.maxExportBatchSize ?? 512;
    this.maxQueueSize = options.maxQueueSize ?? 2048;
    this.scheduledDelayMillis = options.scheduledDelayMillis ?? 5000;
    this.exportTimeoutMillis = options.exportTimeoutMillis ?? 30000;
  }

  onStart(_span: SpanData): void {
    // No-op for batch processor
  }

  onEnd(span: SpanData): void {
    if (this.isShutdown) {
      return;
    }

    // Drop spans if queue is full
    if (this.queue.length >= this.maxQueueSize) {
      return;
    }

    this.queue.push(span);

    // Export immediately if batch size reached
    if (this.queue.length >= this.maxExportBatchSize) {
      this.exportBatch();
    } else if (!this.timer) {
      // Schedule export
      this.timer = setTimeout(() => {
        this.exportBatch();
      }, this.scheduledDelayMillis);
    }
  }

  private async exportBatch(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.maxExportBatchSize);

    try {
      await Promise.race([
        this.exporter.export(batch),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Export timeout')), this.exportTimeoutMillis)
        ),
      ]);
    } catch (error) {
      console.error('Failed to export spans:', error);
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await this.forceFlush();
    await this.exporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    while (this.queue.length > 0) {
      await this.exportBatch();
    }
  }
}

/**
 * Simple span processor - exports spans immediately
 */
export class SimpleSpanProcessor implements SpanProcessor {
  private readonly exporter: SpanExporter;

  constructor(exporter: SpanExporter) {
    this.exporter = exporter;
  }

  onStart(_span: SpanData): void {}

  onEnd(span: SpanData): void {
    this.exporter.export([span]).catch((error) => {
      console.error('Failed to export span:', error);
    });
  }

  async shutdown(): Promise<void> {
    await this.exporter.shutdown();
  }

  async forceFlush(): Promise<void> {
    // Simple processor exports immediately, nothing to flush
  }
}

// ============================================================================
// SPAN EXPORTER INTERFACE
// ============================================================================

/**
 * Span exporter interface
 */
export interface SpanExporter {
  export(spans: SpanData[]): Promise<void>;
  shutdown(): Promise<void>;
}

// ============================================================================
// TRACER PROVIDER IMPLEMENTATION
// ============================================================================

/**
 * Concrete TracerProvider implementation
 */
class TracerProviderImpl implements TracerProvider {
  private readonly tracers: Map<string, Tracer> = new Map();
  private readonly config: TelemetryConfig;
  private readonly processors: SpanProcessor[] = [];
  private isShutdown = false;

  constructor(config: TelemetryConfig) {
    this.config = config;
  }

  /**
   * Add a span processor
   */
  addSpanProcessor(processor: SpanProcessor): void {
    this.processors.push(processor);
  }

  getTracer(name: string, version: string = '1.0.0'): Tracer {
    if (!this.config.enabled || this.isShutdown) {
      return new NoopTracer();
    }

    const key = `${name}@${version}`;
    if (!this.tracers.has(key)) {
      const tracer = new TracerImpl(
        name,
        version,
        this.config.sampler,
        (span) => this.onSpanEnd(span)
      );
      this.tracers.set(key, tracer);
    }
    return this.tracers.get(key)!;
  }

  private onSpanEnd(span: SpanData): void {
    for (const processor of this.processors) {
      try {
        processor.onEnd(span);
      } catch (error) {
        console.error('Span processor error:', error);
      }
    }
  }

  async shutdown(): Promise<void> {
    this.isShutdown = true;
    await Promise.all(this.processors.map((p) => p.shutdown()));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((p) => p.forceFlush()));
  }
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create a tracer provider with the given configuration
 */
export function createTracerProvider(config: TelemetryConfig): TracerProviderImpl {
  return new TracerProviderImpl(config);
}

/**
 * Create a no-op tracer provider
 */
export function createNoopTracerProvider(): TracerProvider {
  return {
    getTracer: () => new NoopTracer(),
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Wrap an async function with tracing
 */
export function withTracing<T extends (...args: unknown[]) => Promise<unknown>>(
  tracer: Tracer,
  name: string,
  fn: T,
  options: SpanOptions = {}
): T {
  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return tracer.startActiveSpan(name, options, async (span) => {
      try {
        const result = await fn(...args);
        return result as ReturnType<T>;
      } catch (error) {
        span.recordException(error as Error);
        throw error;
      }
    });
  }) as T;
}

/**
 * Create a traced version of all methods on an object
 */
export function traceObject<T extends object>(
  tracer: Tracer,
  obj: T,
  prefix: string
): T {
  const traced: Partial<T> = {};

  for (const key of Object.keys(obj) as (keyof T)[]) {
    const value = obj[key];
    if (typeof value === 'function') {
      traced[key] = withTracing(
        tracer,
        `${prefix}.${String(key)}`,
        value.bind(obj) as (...args: unknown[]) => Promise<unknown>
      ) as T[keyof T];
    } else {
      traced[key] = value;
    }
  }

  return { ...obj, ...traced };
}

// Re-export SpanData type for exporters
export type { SpanData };
