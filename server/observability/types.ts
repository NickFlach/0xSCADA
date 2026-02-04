/**
 * OpenTelemetry Distributed Tracing Types
 *
 * Type definitions for the observability framework.
 * Provides a clean interface for distributed tracing without
 * requiring direct OpenTelemetry SDK dependencies.
 *
 * @module server/observability/types
 */

// ============================================================================
// TRACE CONTEXT TYPES
// ============================================================================

/**
 * W3C Trace Context format for distributed trace propagation
 * @see https://www.w3.org/TR/trace-context/
 */
export interface TraceContext {
  /** Trace ID - 32 hex character string identifying the trace */
  traceId: string;
  /** Span ID - 16 hex character string identifying the span */
  spanId: string;
  /** Trace flags indicating sampling decision */
  traceFlags: TraceFlags;
  /** Optional trace state for vendor-specific data */
  traceState?: string;
}

/**
 * Trace flags as defined in W3C Trace Context
 */
export enum TraceFlags {
  /** No flags set */
  NONE = 0x00,
  /** Trace is sampled */
  SAMPLED = 0x01,
}

/**
 * Span kind indicates the relationship between spans
 */
export enum SpanKind {
  /** Internal operation within the service */
  INTERNAL = 0,
  /** Synchronous request to an external service */
  SERVER = 1,
  /** Client making an outbound request */
  CLIENT = 2,
  /** Asynchronous message producer */
  PRODUCER = 3,
  /** Asynchronous message consumer */
  CONSUMER = 4,
}

/**
 * Span status code
 */
export enum SpanStatusCode {
  /** Unset status */
  UNSET = 0,
  /** Success status */
  OK = 1,
  /** Error status */
  ERROR = 2,
}

// ============================================================================
// SPAN TYPES
// ============================================================================

/**
 * Span status information
 */
export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

/**
 * Attributes that can be attached to spans
 */
export interface SpanAttributes {
  [key: string]: SpanAttributeValue;
}

/**
 * Valid attribute value types
 */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | boolean[];

/**
 * Span event representing a point-in-time occurrence
 */
export interface SpanEvent {
  /** Event name */
  name: string;
  /** Event timestamp in milliseconds */
  timestamp: number;
  /** Event attributes */
  attributes?: SpanAttributes;
}

/**
 * Link to another span
 */
export interface SpanLink {
  /** Trace context of the linked span */
  context: TraceContext;
  /** Link attributes */
  attributes?: SpanAttributes;
}

/**
 * Options for creating a span
 */
export interface SpanOptions {
  /** Span kind (default: INTERNAL) */
  kind?: SpanKind;
  /** Initial attributes */
  attributes?: SpanAttributes;
  /** Links to other spans */
  links?: SpanLink[];
  /** Custom start time in milliseconds */
  startTime?: number;
  /** Parent context (if not using current context) */
  parent?: TraceContext;
}

/**
 * Interface for an active span
 */
export interface Span {
  /** Get the span's trace context */
  context(): TraceContext;

  /** Set a single attribute */
  setAttribute(key: string, value: SpanAttributeValue): this;

  /** Set multiple attributes */
  setAttributes(attributes: SpanAttributes): this;

  /** Add an event to the span */
  addEvent(name: string, attributes?: SpanAttributes, timestamp?: number): this;

  /** Add a link to another span */
  addLink(link: SpanLink): this;

  /** Set the span status */
  setStatus(status: SpanStatus): this;

  /** Update the span name */
  updateName(name: string): this;

  /** Record an exception */
  recordException(exception: Error, time?: number): this;

  /** End the span */
  end(endTime?: number): void;

  /** Check if span is recording */
  isRecording(): boolean;
}

// ============================================================================
// TRACER TYPES
// ============================================================================

/**
 * Tracer interface for creating spans
 */
export interface Tracer {
  /** Create and start a new span */
  startSpan(name: string, options?: SpanOptions): Span;

  /** Start a span that becomes the active span in context */
  startActiveSpan<T>(name: string, fn: (span: Span) => T): T;
  startActiveSpan<T>(name: string, options: SpanOptions, fn: (span: Span) => T): T;
}

/**
 * Tracer provider interface
 */
export interface TracerProvider {
  /** Get a tracer by name */
  getTracer(name: string, version?: string): Tracer;

  /** Shutdown the provider */
  shutdown(): Promise<void>;

  /** Force flush pending spans */
  forceFlush(): Promise<void>;
}

// ============================================================================
// EXPORTER TYPES
// ============================================================================

/**
 * Exporter configuration types
 */
export type ExporterType = 'otlp' | 'jaeger' | 'zipkin' | 'console' | 'none';

/**
 * OTLP exporter configuration
 */
export interface OTLPExporterConfig {
  type: 'otlp';
  /** OTLP endpoint URL */
  endpoint: string;
  /** Headers to include with requests */
  headers?: Record<string, string>;
  /** Compression type */
  compression?: 'gzip' | 'none';
  /** Timeout in milliseconds */
  timeout?: number;
}

/**
 * Jaeger exporter configuration
 */
export interface JaegerExporterConfig {
  type: 'jaeger';
  /** Agent host (default: localhost) */
  agentHost?: string;
  /** Agent port (default: 6831) */
  agentPort?: number;
  /** Collector endpoint (alternative to agent) */
  collectorEndpoint?: string;
  /** Username for collector authentication */
  username?: string;
  /** Password for collector authentication */
  password?: string;
}

/**
 * Console exporter configuration (for debugging)
 */
export interface ConsoleExporterConfig {
  type: 'console';
  /** Pretty print output */
  prettyPrint?: boolean;
}

/**
 * No-op exporter configuration
 */
export interface NoopExporterConfig {
  type: 'none';
}

/**
 * Union type for all exporter configurations
 */
export type ExporterConfig =
  | OTLPExporterConfig
  | JaegerExporterConfig
  | ConsoleExporterConfig
  | NoopExporterConfig;

// ============================================================================
// SAMPLER TYPES
// ============================================================================

/**
 * Sampling decision
 */
export enum SamplingDecision {
  /** Don't sample this span */
  NOT_RECORD = 0,
  /** Record but don't sample */
  RECORD = 1,
  /** Record and sample */
  RECORD_AND_SAMPLED = 2,
}

/**
 * Sampling result
 */
export interface SamplingResult {
  decision: SamplingDecision;
  attributes?: SpanAttributes;
  traceState?: string;
}

/**
 * Sampler configuration types
 */
export type SamplerType = 'always_on' | 'always_off' | 'ratio' | 'parent_based';

/**
 * Sampler configuration
 */
export interface SamplerConfig {
  type: SamplerType;
  /** Ratio for ratio-based sampling (0.0 to 1.0) */
  ratio?: number;
  /** Root sampler for parent-based sampling */
  rootSampler?: SamplerConfig;
}

// ============================================================================
// TELEMETRY CONFIGURATION
// ============================================================================

/**
 * Resource attributes identifying the service
 */
export interface ResourceAttributes {
  /** Service name */
  'service.name': string;
  /** Service version */
  'service.version'?: string;
  /** Service instance ID */
  'service.instance.id'?: string;
  /** Deployment environment */
  'deployment.environment'?: string;
  /** Additional attributes */
  [key: string]: string | number | boolean | undefined;
}

/**
 * Complete telemetry configuration
 */
export interface TelemetryConfig {
  /** Whether telemetry is enabled */
  enabled: boolean;
  /** Service resource attributes */
  resource: ResourceAttributes;
  /** Exporter configuration */
  exporter: ExporterConfig;
  /** Sampler configuration */
  sampler: SamplerConfig;
  /** Batch span processor configuration */
  batchConfig?: {
    /** Max batch size before export */
    maxExportBatchSize?: number;
    /** Max queue size */
    maxQueueSize?: number;
    /** Schedule delay in milliseconds */
    scheduledDelayMillis?: number;
    /** Export timeout in milliseconds */
    exportTimeoutMillis?: number;
  };
  /** Propagation formats to use */
  propagators?: ('w3c' | 'b3' | 'jaeger')[];
  /** Auto-instrumentation options */
  autoInstrumentation?: {
    http?: boolean;
    express?: boolean;
    database?: boolean;
  };
}

// ============================================================================
// SEMANTIC CONVENTIONS
// ============================================================================

/**
 * HTTP semantic conventions for span attributes
 */
export const HttpSemanticConventions = {
  // Request attributes
  HTTP_METHOD: 'http.method',
  HTTP_URL: 'http.url',
  HTTP_TARGET: 'http.target',
  HTTP_HOST: 'http.host',
  HTTP_SCHEME: 'http.scheme',
  HTTP_STATUS_CODE: 'http.status_code',
  HTTP_FLAVOR: 'http.flavor',
  HTTP_USER_AGENT: 'http.user_agent',
  HTTP_REQUEST_CONTENT_LENGTH: 'http.request_content_length',
  HTTP_RESPONSE_CONTENT_LENGTH: 'http.response_content_length',
  HTTP_ROUTE: 'http.route',

  // Network attributes
  NET_HOST_NAME: 'net.host.name',
  NET_HOST_PORT: 'net.host.port',
  NET_PEER_NAME: 'net.peer.name',
  NET_PEER_PORT: 'net.peer.port',
  NET_PEER_IP: 'net.peer.ip',
} as const;

/**
 * Database semantic conventions
 */
export const DbSemanticConventions = {
  DB_SYSTEM: 'db.system',
  DB_CONNECTION_STRING: 'db.connection_string',
  DB_USER: 'db.user',
  DB_NAME: 'db.name',
  DB_STATEMENT: 'db.statement',
  DB_OPERATION: 'db.operation',
  DB_SQL_TABLE: 'db.sql.table',
} as const;

/**
 * Messaging semantic conventions
 */
export const MessagingSemanticConventions = {
  MESSAGING_SYSTEM: 'messaging.system',
  MESSAGING_DESTINATION: 'messaging.destination',
  MESSAGING_DESTINATION_KIND: 'messaging.destination_kind',
  MESSAGING_MESSAGE_ID: 'messaging.message_id',
  MESSAGING_OPERATION: 'messaging.operation',
} as const;

/**
 * Custom SCADA semantic conventions
 */
export const ScadaSemanticConventions = {
  // Site attributes
  SCADA_SITE_ID: 'scada.site.id',
  SCADA_SITE_NAME: 'scada.site.name',

  // Asset attributes
  SCADA_ASSET_ID: 'scada.asset.id',
  SCADA_ASSET_TYPE: 'scada.asset.type',

  // Event attributes
  SCADA_EVENT_TYPE: 'scada.event.type',
  SCADA_EVENT_SEVERITY: 'scada.event.severity',

  // Blockchain attributes
  SCADA_BLOCKCHAIN_TX_HASH: 'scada.blockchain.tx_hash',
  SCADA_BLOCKCHAIN_BLOCK_NUMBER: 'scada.blockchain.block_number',
  SCADA_MERKLE_ROOT: 'scada.merkle.root',

  // Agent attributes
  SCADA_AGENT_ID: 'scada.agent.id',
  SCADA_AGENT_TYPE: 'scada.agent.type',
} as const;
