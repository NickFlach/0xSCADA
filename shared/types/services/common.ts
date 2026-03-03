/**
 * Common Service Types
 * 
 * Shared patterns and interfaces used across all services.
 * Promotes consistency and reduces duplication.
 * 
 * Dependencies: ../core/common.ts
 */

import { 
  EntityId, 
  Timestamp, 
  HealthStatus, 
  ServiceStatus, 
  Metadata,
  OperationResult
} from '../core/common';

// ─── Service Lifecycle ──────────────────────────────────────────────────────

export type ServiceState = 'uninitialized' | 'initializing' | 'ready' | 'running' | 'stopping' | 'stopped' | 'error';

export interface ServiceBase {
  readonly id: EntityId;
  readonly name: string;
  readonly version: string;
  state: ServiceState;
  metadata?: Metadata;
}

export interface ServiceConfig {
  enabled: boolean;
  debug?: boolean;
  timeout?: number;
  retries?: number;
  interval?: number;
  batchSize?: number;
  [key: string]: unknown;
}

export interface InitializationResult {
  success: boolean;
  error?: string;
  duration: number;
  timestamp: Timestamp;
}

// ─── Service Management ─────────────────────────────────────────────────────

export interface IService {
  initialize(): Promise<InitializationResult>;
  start?(): Promise<void>;
  stop?(): Promise<void>;
  restart?(): Promise<void>;
  getStatus(): ServiceStatus;
  getHealth(): Promise<HealthStatus>;
  getMetrics(): Promise<ServiceMetrics>;
  getConfig(): ServiceConfig;
  updateConfig?(config: Partial<ServiceConfig>): Promise<void>;
}

export interface ServiceMetrics {
  uptime: number;
  requestCount: number;
  errorCount: number;
  averageResponseTime: number;
  lastActivity?: Timestamp;
  customMetrics?: Record<string, number>;
}

// ─── Event-Driven Services ──────────────────────────────────────────────────

export interface EventHandler<T = unknown> {
  (event: ServiceEvent<T>): Promise<void> | void;
}

export interface ServiceEvent<T = unknown> {
  id: EntityId;
  type: string;
  source: string;
  timestamp: Timestamp;
  data: T;
  correlationId?: string;
  metadata?: Metadata;
}

export interface EventEmittingService extends IService {
  on<T>(eventType: string, handler: EventHandler<T>): void;
  off<T>(eventType: string, handler: EventHandler<T>): void;
  emit<T>(eventType: string, data: T, metadata?: Metadata): void;
}

// ─── Async Operations ───────────────────────────────────────────────────────

export interface AsyncOperation<T = unknown> {
  id: EntityId;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  result?: T;
  error?: string;
  progress?: number; // 0-100
  startedAt: Timestamp;
  completedAt?: Timestamp;
  estimatedDuration?: number;
}

export interface BatchOperation<T = unknown> extends AsyncOperation<T[]> {
  batchSize: number;
  itemsProcessed: number;
  itemsTotal: number;
  failedItems: EntityId[];
}

// ─── Data Processing ────────────────────────────────────────────────────────

export interface DataProcessor<TInput, TOutput> {
  process(input: TInput): Promise<OperationResult<TOutput>>;
  processSync?(input: TInput): TOutput;
  validate?(input: TInput): boolean;
  transform?(input: TInput): TInput;
}

export interface BatchDataProcessor<TInput, TOutput> extends DataProcessor<TInput[], TOutput[]> {
  processBatch(inputs: TInput[], batchSize?: number): Promise<OperationResult<TOutput[]>>;
}

// ─── Cache & Storage ────────────────────────────────────────────────────────

export interface CacheEntry<T = unknown> {
  key: string;
  value: T;
  ttl?: number;
  createdAt: Timestamp;
  expiresAt?: Timestamp;
  accessCount?: number;
  lastAccessed?: Timestamp;
}

export interface StorageProvider<T = unknown> {
  get(key: string): Promise<T | null>;
  set(key: string, value: T, ttl?: number): Promise<void>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
  clear(): Promise<void>;
  keys(pattern?: string): Promise<string[]>;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationRule<T = unknown> {
  name: string;
  message: string;
  validate(value: T): boolean | Promise<boolean>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings?: string[];
}

export interface Validator<T = unknown> {
  rules: ValidationRule<T>[];
  validate(value: T): Promise<ValidationResult>;
  addRule(rule: ValidationRule<T>): void;
  removeRule(name: string): void;
}

// ─── Rate Limiting ──────────────────────────────────────────────────────────

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  keyGenerator?(req: unknown): string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: Timestamp;
  totalHits: number;
}

// ─── Circuit Breaker ────────────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  resetTimeout: number;
  monitoringPeriod: number;
  expectedErrors?: string[];
}

export interface CircuitBreakerStatus {
  state: CircuitState;
  failures: number;
  lastFailureTime?: Timestamp;
  nextAttempt?: Timestamp;
}

// ─── Retry Logic ────────────────────────────────────────────────────────────

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number;
  maxDelay?: number;
  backoffFactor?: number;
  jitter?: boolean;
  retryableErrors?: string[];
}

export interface RetryResult<T> {
  success: boolean;
  result?: T;
  error?: string;
  attempts: number;
  totalDuration: number;
}

// ─── Health Monitoring ──────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  required: boolean;
  check(): Promise<HealthStatus>;
}

export interface HealthMonitor {
  checks: HealthCheck[];
  addCheck(check: HealthCheck): void;
  removeCheck(name: string): void;
  runChecks(): Promise<Map<string, HealthStatus>>;
  getOverallHealth(): Promise<HealthStatus>;
}

// ─── Type Guards ────────────────────────────────────────────────────────────

export const isServiceState = (state: string): state is ServiceState => {
  const validStates: ServiceState[] = [
    'uninitialized', 'initializing', 'ready', 'running', 'stopping', 'stopped', 'error'
  ];
  return validStates.includes(state as ServiceState);
};

export const isAsyncOperation = (obj: unknown): obj is AsyncOperation => {
  return typeof obj === 'object' && obj !== null &&
         'id' in obj && 'type' in obj && 'status' in obj && 'startedAt' in obj;
};

export const isValidationResult = (obj: unknown): obj is ValidationResult => {
  return typeof obj === 'object' && obj !== null &&
         'valid' in obj && 'errors' in obj &&
         typeof (obj as any).valid === 'boolean' &&
         Array.isArray((obj as any).errors);
};