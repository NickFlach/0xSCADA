/**
 * 0xSCADA Artifact Doctrine Middleware
 * 
 * VERITY Architecture - Doctrine Enforcement Layer
 * 
 * "Artifacts are truth. Any observation, signal, trace, proof, or learned state
 *  that materially affects decisions MUST be captured as an artifact."
 * 
 * This middleware enforces artifact creation triggers as mandated by the
 * Reality Artifact Manifesto. Artifacts are created when:
 * 
 * 1. External state is observed (sensor data, metrics, chain state, logs)
 * 2. Scenario/simulation is evaluated
 * 3. Proof is generated or verified
 * 4. Model is trained/updated/refined
 * 5. Decision affects safety, compliance, or money
 * 
 * Never overwrite evidence to satisfy intent.
 * If reality and instruction conflict, record reality first—then question instruction.
 */

import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import {
  type RealityArtifact,
  type ContentHash,
  type CreateArtifactInput,
  type ArtifactOrigin,
  type ArtifactScope,
  type ArtifactType,
  type OriginSystem,
  createArtifactInputSchema,
  artifactOriginSchema,
  artifactScopeSchema,
} from "@shared/artifact";
import { artifactStorage, type ArtifactStorageService } from "../services/artifact-storage";

// =============================================================================
// DOCTRINE TRIGGER TYPES
// =============================================================================

/**
 * DoctrineCategory - Categories that mandate artifact creation
 * From SWARM_PROMPT.md:
 * - EXTERNAL_STATE: External state observed (sensor data, metrics, chain state, logs)
 * - SCENARIO_EVAL: Scenario or simulation evaluated
 * - PROOF_OPERATION: Proof generated or verified
 * - MODEL_UPDATE: Model trained, updated, or refined
 * - CRITICAL_DECISION: Decision affects safety, compliance, or money
 */
export const DoctrineCategory = {
  EXTERNAL_STATE: "external_state",
  SCENARIO_EVAL: "scenario_eval",
  PROOF_OPERATION: "proof_operation",
  MODEL_UPDATE: "model_update",
  CRITICAL_DECISION: "critical_decision",
} as const;

export type DoctrineCategory = (typeof DoctrineCategory)[keyof typeof DoctrineCategory];

/**
 * DoctrineTrigger - Configuration for what triggers artifact creation
 */
export interface DoctrineTrigger {
  /** Category of the doctrine trigger */
  category: DoctrineCategory;
  
  /** Human-readable description of the trigger */
  description: string;
  
  /** Artifact type to create */
  artifactType: ArtifactType;
  
  /** Origin system */
  originSystem: OriginSystem;
  
  /** Whether this trigger is mandatory (failures are errors vs warnings) */
  mandatory: boolean;
  
  /** Custom validation function for the trigger context */
  validate?: (context: TriggerContext) => ValidationResult;
}

/**
 * TriggerContext - Context passed to trigger handlers
 */
export interface TriggerContext {
  /** The doctrine category that was triggered */
  category: DoctrineCategory;
  
  /** Trigger-specific data to be captured */
  data: unknown;
  
  /** Agent ID if applicable */
  agentId?: string;
  
  /** Site ID if applicable */
  siteId?: string;
  
  /** Asset ID if applicable */
  assetId?: string;
  
  /** Device ID if applicable */
  deviceId?: string;
  
  /** Custom tags */
  tags?: string[];
  
  /** Dependencies on other artifacts */
  dependencies?: ContentHash[];
  
  /** Human-readable summary */
  summary?: string;
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * ValidationResult - Result of trigger validation
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * DoctrineViolation - Represents a doctrine rule violation
 */
export interface DoctrineViolation {
  category: DoctrineCategory;
  message: string;
  timestamp: string;
  context?: unknown;
  severity: "error" | "warning";
}

/**
 * DoctrineAuditLog - Audit trail entry
 */
export interface DoctrineAuditLog {
  timestamp: string;
  category: DoctrineCategory;
  artifactId?: ContentHash;
  success: boolean;
  violations: DoctrineViolation[];
  context: TriggerContext;
}

// =============================================================================
// TRIGGER CONTEXT SCHEMA VALIDATION
// =============================================================================

const triggerContextSchema = z.object({
  category: z.enum([
    "external_state",
    "scenario_eval",
    "proof_operation",
    "model_update",
    "critical_decision",
  ]),
  data: z.unknown(),
  agentId: z.string().optional(),
  siteId: z.string().optional(),
  assetId: z.string().optional(),
  deviceId: z.string().optional(),
  tags: z.array(z.string()).optional(),
  dependencies: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  summary: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// =============================================================================
// CATEGORY-SPECIFIC VALIDATORS
// =============================================================================

/**
 * Validators for each doctrine category
 */
const categoryValidators: Record<DoctrineCategory, (ctx: TriggerContext) => ValidationResult> = {
  [DoctrineCategory.EXTERNAL_STATE]: (ctx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // External state must have source identification
    if (!ctx.deviceId && !ctx.siteId && !ctx.assetId) {
      warnings.push("External state observation should specify deviceId, siteId, or assetId");
    }
    
    // Data must be present
    if (ctx.data === undefined || ctx.data === null) {
      errors.push("External state observation must include data payload");
    }
    
    return { valid: errors.length === 0, errors, warnings };
  },
  
  [DoctrineCategory.SCENARIO_EVAL]: (ctx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Scenarios should have a summary
    if (!ctx.summary) {
      warnings.push("Scenario evaluation should include a summary");
    }
    
    // Data must be present
    if (ctx.data === undefined || ctx.data === null) {
      errors.push("Scenario evaluation must include result data");
    }
    
    return { valid: errors.length === 0, errors, warnings };
  },
  
  [DoctrineCategory.PROOF_OPERATION]: (ctx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Proofs must have data
    if (ctx.data === undefined || ctx.data === null) {
      errors.push("Proof operation must include proof data");
    }
    
    // Proofs should declare their type in metadata
    if (!ctx.metadata?.proofType) {
      warnings.push("Proof operation should specify proofType in metadata (e.g., 'zk', 'merkle', 'signature')");
    }
    
    return { valid: errors.length === 0, errors, warnings };
  },
  
  [DoctrineCategory.MODEL_UPDATE]: (ctx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Model updates must have agent ID
    if (!ctx.agentId) {
      errors.push("Model update must specify agentId");
    }
    
    // Data must be present
    if (ctx.data === undefined || ctx.data === null) {
      errors.push("Model update must include model state data");
    }
    
    // Should specify what kind of update
    if (!ctx.metadata?.updateType) {
      warnings.push("Model update should specify updateType in metadata (e.g., 'train', 'finetune', 'refine')");
    }
    
    return { valid: errors.length === 0, errors, warnings };
  },
  
  [DoctrineCategory.CRITICAL_DECISION]: (ctx) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    // Critical decisions MUST have full context
    if (!ctx.summary) {
      errors.push("Critical decision MUST include a summary");
    }
    
    // Must identify the scope of impact
    if (!ctx.metadata?.impactScope) {
      errors.push("Critical decision MUST specify impactScope in metadata (e.g., 'safety', 'compliance', 'financial')");
    }
    
    // Should have justification
    if (!ctx.metadata?.justification) {
      warnings.push("Critical decision should include justification in metadata");
    }
    
    // Data must be present
    if (ctx.data === undefined || ctx.data === null) {
      errors.push("Critical decision must include decision data");
    }
    
    return { valid: errors.length === 0, errors, warnings };
  },
};

// =============================================================================
// ARTIFACT DOCTRINE SERVICE
// =============================================================================

/**
 * ArtifactDoctrineService - Core service for enforcing doctrine rules
 */
export class ArtifactDoctrineService {
  private storage: ArtifactStorageService;
  private auditLog: DoctrineAuditLog[] = [];
  private violations: DoctrineViolation[] = [];
  private strictMode: boolean;
  private maxAuditLogSize: number;
  
  constructor(options: {
    storage?: ArtifactStorageService;
    strictMode?: boolean;
    maxAuditLogSize?: number;
  } = {}) {
    this.storage = options.storage ?? artifactStorage;
    this.strictMode = options.strictMode ?? true;
    this.maxAuditLogSize = options.maxAuditLogSize ?? 10000;
  }
  
  /**
   * Trigger artifact creation for a doctrine category
   * This is the main entry point for enforcing doctrine rules
   */
  async trigger(context: TriggerContext): Promise<RealityArtifact> {
    const timestamp = new Date().toISOString();
    const violations: DoctrineViolation[] = [];
    
    // Validate context schema
    const parseResult = triggerContextSchema.safeParse(context);
    if (!parseResult.success) {
      const errors = parseResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`);
      throw new DoctrineViolationError(
        `Invalid trigger context: ${errors.join(', ')}`,
        context.category,
        errors
      );
    }
    
    // Run category-specific validation
    const validator = categoryValidators[context.category];
    const validationResult = validator(context);
    
    // Record warnings
    for (const warning of validationResult.warnings) {
      violations.push({
        category: context.category,
        message: warning,
        timestamp,
        severity: "warning",
      });
    }
    
    // Handle errors
    if (!validationResult.valid) {
      for (const error of validationResult.errors) {
        violations.push({
          category: context.category,
          message: error,
          timestamp,
          context: context.data,
          severity: "error",
        });
      }
      
      if (this.strictMode) {
        this.recordViolations(violations);
        this.addAuditLog({
          timestamp,
          category: context.category,
          success: false,
          violations,
          context,
        });
        
        throw new DoctrineViolationError(
          `Doctrine violation in ${context.category}: ${validationResult.errors.join('; ')}`,
          context.category,
          validationResult.errors
        );
      }
    }
    
    // Build artifact origin
    const origin: ArtifactOrigin = {
      system: this.categoryToSystem(context.category),
      agent: context.agentId,
      device: context.deviceId,
    };
    
    // Build artifact scope
    const scope: ArtifactScope = {
      type: this.categoryToType(context.category),
      siteId: context.siteId,
      assetId: context.assetId,
      tags: context.tags,
      metadata: context.metadata,
    };
    
    // Serialize data for storage
    const content = this.serializeContent(context.data, context.metadata);
    
    // Create artifact input
    const input: CreateArtifactInput = {
      origin,
      scope,
      dependencies: context.dependencies,
      summary: context.summary ?? this.generateSummary(context),
      content,
      mimeType: "application/json",
    };
    
    // Store the artifact
    const artifact = await this.storage.store(input);
    
    // Record audit log
    this.addAuditLog({
      timestamp,
      category: context.category,
      artifactId: artifact.id,
      success: true,
      violations,
      context,
    });
    
    // Record any warnings as violations for tracking
    this.recordViolations(violations.filter(v => v.severity === "warning"));
    
    console.log(
      `[ArtifactDoctrine] Created artifact ${artifact.id.slice(0, 12)}... ` +
      `for ${context.category} (${violations.length} warnings)`
    );
    
    return artifact;
  }
  
  /**
   * Map doctrine category to origin system
   */
  private categoryToSystem(category: DoctrineCategory): OriginSystem {
    switch (category) {
      case DoctrineCategory.EXTERNAL_STATE:
        return "linux";
      case DoctrineCategory.PROOF_OPERATION:
        return "ethereum";
      case DoctrineCategory.SCENARIO_EVAL:
      case DoctrineCategory.MODEL_UPDATE:
      case DoctrineCategory.CRITICAL_DECISION:
        return "agentic-qe";
      default:
        return "linux";
    }
  }
  
  /**
   * Map doctrine category to artifact type
   */
  private categoryToType(category: DoctrineCategory): ArtifactType {
    switch (category) {
      case DoctrineCategory.EXTERNAL_STATE:
        return "sensor";
      case DoctrineCategory.SCENARIO_EVAL:
        return "twin";
      case DoctrineCategory.PROOF_OPERATION:
        return "proof";
      case DoctrineCategory.MODEL_UPDATE:
        return "model";
      case DoctrineCategory.CRITICAL_DECISION:
        return "decision";
      default:
        return "blob";
    }
  }
  
  /**
   * Serialize content for storage
   */
  private serializeContent(data: unknown, metadata?: Record<string, unknown>): string {
    const envelope = {
      _doctrineVersion: "1.0.0",
      _capturedAt: new Date().toISOString(),
      data,
      metadata,
    };
    return JSON.stringify(envelope, null, 2);
  }
  
  /**
   * Generate a summary from context
   */
  private generateSummary(context: TriggerContext): string {
    const parts: string[] = [
      `[${context.category.toUpperCase()}]`,
    ];
    
    if (context.agentId) parts.push(`Agent: ${context.agentId}`);
    if (context.siteId) parts.push(`Site: ${context.siteId}`);
    if (context.assetId) parts.push(`Asset: ${context.assetId}`);
    if (context.deviceId) parts.push(`Device: ${context.deviceId}`);
    
    return parts.join(" | ");
  }
  
  /**
   * Record violations for tracking
   */
  private recordViolations(violations: DoctrineViolation[]): void {
    this.violations.push(...violations);
    // Keep bounded
    if (this.violations.length > this.maxAuditLogSize * 10) {
      this.violations = this.violations.slice(-this.maxAuditLogSize);
    }
  }
  
  /**
   * Add entry to audit log
   */
  private addAuditLog(entry: DoctrineAuditLog): void {
    this.auditLog.push(entry);
    // Keep bounded
    if (this.auditLog.length > this.maxAuditLogSize) {
      this.auditLog = this.auditLog.slice(-this.maxAuditLogSize);
    }
  }
  
  /**
   * Get recent violations
   */
  getViolations(limit: number = 100): DoctrineViolation[] {
    return this.violations.slice(-limit);
  }
  
  /**
   * Get audit log entries
   */
  getAuditLog(limit: number = 100): DoctrineAuditLog[] {
    return this.auditLog.slice(-limit);
  }
  
  /**
   * Get statistics
   */
  getStats(): {
    totalTriggers: number;
    successfulTriggers: number;
    failedTriggers: number;
    totalViolations: number;
    errorViolations: number;
    warningViolations: number;
    byCategory: Record<DoctrineCategory, number>;
  } {
    const byCategory = {} as Record<DoctrineCategory, number>;
    let successfulTriggers = 0;
    let failedTriggers = 0;
    
    for (const entry of this.auditLog) {
      byCategory[entry.category] = (byCategory[entry.category] ?? 0) + 1;
      if (entry.success) {
        successfulTriggers++;
      } else {
        failedTriggers++;
      }
    }
    
    const errorViolations = this.violations.filter(v => v.severity === "error").length;
    const warningViolations = this.violations.filter(v => v.severity === "warning").length;
    
    return {
      totalTriggers: this.auditLog.length,
      successfulTriggers,
      failedTriggers,
      totalViolations: this.violations.length,
      errorViolations,
      warningViolations,
      byCategory,
    };
  }
  
  /**
   * Clear audit log (for testing)
   */
  clearAuditLog(): void {
    this.auditLog = [];
    this.violations = [];
  }
}

// =============================================================================
// DOCTRINE VIOLATION ERROR
// =============================================================================

/**
 * Custom error for doctrine violations
 */
export class DoctrineViolationError extends Error {
  public readonly category: DoctrineCategory;
  public readonly violations: string[];
  
  constructor(message: string, category: DoctrineCategory, violations: string[]) {
    super(message);
    this.name = "DoctrineViolationError";
    this.category = category;
    this.violations = violations;
  }
}

// =============================================================================
// DECORATORS
// =============================================================================

/**
 * Options for doctrine decorators
 */
export interface DoctrineDecoratorOptions {
  /** Doctrine category */
  category: DoctrineCategory;
  
  /** Override the auto-generated summary */
  summary?: string;
  
  /** Custom tags */
  tags?: string[];
  
  /** Extract context from arguments */
  contextExtractor?: (...args: unknown[]) => Partial<TriggerContext>;
  
  /** Whether to capture the result as artifact data */
  captureResult?: boolean;
  
  /** Whether to capture arguments as artifact data */
  captureArgs?: boolean;
  
  /** Dependency artifacts */
  dependencies?: ContentHash[];
  
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Global doctrine service instance
 */
let globalDoctrineService: ArtifactDoctrineService | null = null;

/**
 * Get or create the global doctrine service
 */
export function getDoctrineService(): ArtifactDoctrineService {
  if (!globalDoctrineService) {
    globalDoctrineService = new ArtifactDoctrineService();
  }
  return globalDoctrineService;
}

/**
 * Set the global doctrine service (for testing/configuration)
 */
export function setDoctrineService(service: ArtifactDoctrineService): void {
  globalDoctrineService = service;
}

/**
 * Method decorator that enforces doctrine artifact creation
 * 
 * Usage:
 * ```typescript
 * class SensorService {
 *   @enforceDoctrine({
 *     category: DoctrineCategory.EXTERNAL_STATE,
 *     captureResult: true,
 *     contextExtractor: (sensorId) => ({ deviceId: sensorId }),
 *   })
 *   async readSensor(sensorId: string): Promise<SensorReading> {
 *     // ... implementation
 *   }
 * }
 * ```
 */
export function enforceDoctrine(options: DoctrineDecoratorOptions) {
  return function <T extends (...args: any[]) => Promise<any>>(
    _target: any,
    propertyKey: string,
    descriptor: TypedPropertyDescriptor<T>
  ) {
    const originalMethod = descriptor.value!;
    
    descriptor.value = async function (this: any, ...args: any[]) {
      const service = getDoctrineService();
      
      // Extract context from arguments if extractor provided
      const extractedContext = options.contextExtractor
        ? options.contextExtractor(...args)
        : {};
      
      // Execute the original method
      const result = await originalMethod.apply(this, args);
      
      // Build artifact data
      let data: unknown;
      if (options.captureResult && options.captureArgs) {
        data = { args, result };
      } else if (options.captureResult) {
        data = result;
      } else if (options.captureArgs) {
        data = args;
      } else {
        data = { method: propertyKey, timestamp: new Date().toISOString() };
      }
      
      // Build trigger context
      const context: TriggerContext = {
        category: options.category,
        data,
        summary: options.summary ?? `${propertyKey} execution`,
        tags: options.tags,
        dependencies: options.dependencies,
        metadata: {
          ...options.metadata,
          method: propertyKey,
          className: this.constructor?.name,
        },
        ...extractedContext,
      };
      
      // Trigger artifact creation
      await service.trigger(context);
      
      return result;
    } as T;
    
    return descriptor;
  };
}

/**
 * Function wrapper for enforcing doctrine without decorators
 * 
 * Usage:
 * ```typescript
 * const wrappedFn = withDoctrine(
 *   myFunction,
 *   { category: DoctrineCategory.CRITICAL_DECISION, captureResult: true }
 * );
 * ```
 */
export function withDoctrine<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  options: DoctrineDecoratorOptions
): T {
  return async function (...args: any[]) {
    const service = getDoctrineService();
    
    // Extract context from arguments if extractor provided
    const extractedContext = options.contextExtractor
      ? options.contextExtractor(...args)
      : {};
    
    // Execute the original function
    const result = await fn(...args);
    
    // Build artifact data
    let data: unknown;
    if (options.captureResult && options.captureArgs) {
      data = { args, result };
    } else if (options.captureResult) {
      data = result;
    } else if (options.captureArgs) {
      data = args;
    } else {
      data = { function: fn.name, timestamp: new Date().toISOString() };
    }
    
    // Build trigger context
    const context: TriggerContext = {
      category: options.category,
      data,
      summary: options.summary ?? `${fn.name || 'anonymous'} execution`,
      tags: options.tags,
      dependencies: options.dependencies,
      metadata: {
        ...options.metadata,
        function: fn.name,
      },
      ...extractedContext,
    };
    
    // Trigger artifact creation
    await service.trigger(context);
    
    return result;
  } as T;
}

// =============================================================================
// EXPRESS MIDDLEWARE
// =============================================================================

/**
 * Express middleware options
 */
export interface DoctrineMiddlewareOptions {
  /** Which HTTP methods to track */
  methods?: string[];
  
  /** URL patterns to include (regex) */
  includePatterns?: RegExp[];
  
  /** URL patterns to exclude (regex) */
  excludePatterns?: RegExp[];
  
  /** Category for tracked requests */
  category?: DoctrineCategory;
  
  /** Extract context from request */
  contextFromRequest?: (req: Request) => Partial<TriggerContext>;
  
  /** Whether to capture request body */
  captureBody?: boolean;
  
  /** Whether to capture response */
  captureResponse?: boolean;
}

const DEFAULT_MIDDLEWARE_OPTIONS: Required<DoctrineMiddlewareOptions> = {
  methods: ["POST", "PUT", "PATCH", "DELETE"],
  includePatterns: [/^\/api\//],
  excludePatterns: [/^\/api\/health/, /^\/api\/metrics/],
  category: DoctrineCategory.EXTERNAL_STATE,
  contextFromRequest: () => ({}),
  captureBody: true,
  captureResponse: false,
};

/**
 * Express middleware for automatic doctrine enforcement
 * 
 * Captures state-changing API calls as artifacts
 */
export function doctrineMiddleware(
  options: DoctrineMiddlewareOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const opts = { ...DEFAULT_MIDDLEWARE_OPTIONS, ...options };
  const service = getDoctrineService();
  
  return (req: Request, res: Response, next: NextFunction) => {
    // Check if this request should be tracked
    if (!opts.methods.includes(req.method)) {
      return next();
    }
    
    // Check include patterns
    const matchesInclude = opts.includePatterns.some(p => p.test(req.path));
    if (!matchesInclude) {
      return next();
    }
    
    // Check exclude patterns
    const matchesExclude = opts.excludePatterns.some(p => p.test(req.path));
    if (matchesExclude) {
      return next();
    }
    
    // Capture original end to intercept response
    const originalEnd = res.end;
    let responseBody: unknown;
    
    if (opts.captureResponse) {
      const originalJson = res.json;
      res.json = function (body: any) {
        responseBody = body;
        return originalJson.call(this, body);
      };
    }
    
    // Override end to create artifact after response
    res.end = function (this: Response, ...args: any[]) {
      // Create artifact asynchronously (don't block response)
      setImmediate(async () => {
        try {
          const extractedContext = opts.contextFromRequest(req);
          
          const data: Record<string, unknown> = {
            method: req.method,
            path: req.path,
            query: req.query,
            statusCode: res.statusCode,
          };
          
          if (opts.captureBody && req.body) {
            data.body = req.body;
          }
          
          if (opts.captureResponse && responseBody) {
            data.response = responseBody;
          }
          
          const context: TriggerContext = {
            category: opts.category,
            data,
            summary: `${req.method} ${req.path} → ${res.statusCode}`,
            tags: ["http", req.method.toLowerCase()],
            metadata: {
              userAgent: req.get("user-agent"),
              ip: req.ip,
              contentType: req.get("content-type"),
            },
            ...extractedContext,
          };
          
          await service.trigger(context);
        } catch (error) {
          console.error("[ArtifactDoctrine] Middleware error:", error);
        }
      });
      
      return originalEnd.apply(this, args as any);
    } as typeof res.end;
    
    next();
  };
}

// =============================================================================
// INTEGRATION HOOKS
// =============================================================================

/**
 * Integration hook for sensor/external state observations
 */
export async function recordExternalState(
  data: unknown,
  options: {
    deviceId?: string;
    siteId?: string;
    assetId?: string;
    summary?: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<RealityArtifact> {
  const service = getDoctrineService();
  return service.trigger({
    category: DoctrineCategory.EXTERNAL_STATE,
    data,
    ...options,
  });
}

/**
 * Integration hook for scenario/simulation evaluations
 */
export async function recordScenarioEval(
  scenarioId: string,
  result: unknown,
  options: {
    agentId?: string;
    siteId?: string;
    summary?: string;
    dependencies?: ContentHash[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<RealityArtifact> {
  const service = getDoctrineService();
  return service.trigger({
    category: DoctrineCategory.SCENARIO_EVAL,
    data: { scenarioId, result },
    summary: options.summary ?? `Scenario ${scenarioId} evaluation`,
    ...options,
    metadata: {
      ...options.metadata,
      scenarioId,
    },
  });
}

/**
 * Integration hook for proof operations
 */
export async function recordProofOperation(
  proofType: "generate" | "verify",
  proofData: unknown,
  options: {
    agentId?: string;
    summary?: string;
    dependencies?: ContentHash[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<RealityArtifact> {
  const service = getDoctrineService();
  return service.trigger({
    category: DoctrineCategory.PROOF_OPERATION,
    data: proofData,
    summary: options.summary ?? `Proof ${proofType} operation`,
    ...options,
    metadata: {
      ...options.metadata,
      proofType,
      operation: proofType,
    },
  });
}

/**
 * Integration hook for model updates
 */
export async function recordModelUpdate(
  agentId: string,
  updateType: "train" | "finetune" | "refine",
  modelState: unknown,
  options: {
    summary?: string;
    dependencies?: ContentHash[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  } = {}
): Promise<RealityArtifact> {
  const service = getDoctrineService();
  return service.trigger({
    category: DoctrineCategory.MODEL_UPDATE,
    data: modelState,
    agentId,
    summary: options.summary ?? `Model ${updateType} by agent ${agentId}`,
    ...options,
    metadata: {
      ...options.metadata,
      updateType,
    },
  });
}

/**
 * Integration hook for critical decisions
 */
export async function recordCriticalDecision(
  decision: unknown,
  impactScope: "safety" | "compliance" | "financial" | "operational",
  options: {
    agentId?: string;
    siteId?: string;
    assetId?: string;
    justification?: string;
    summary: string;
    dependencies?: ContentHash[];
    tags?: string[];
    metadata?: Record<string, unknown>;
  }
): Promise<RealityArtifact> {
  const service = getDoctrineService();
  return service.trigger({
    category: DoctrineCategory.CRITICAL_DECISION,
    data: decision,
    summary: options.summary,
    ...options,
    metadata: {
      ...options.metadata,
      impactScope,
      justification: options.justification,
    },
  });
}

// =============================================================================
// SINGLETON INSTANCE
// =============================================================================

export const artifactDoctrine = new ArtifactDoctrineService();

// =============================================================================
// EXPORTS
// =============================================================================

export type {
  DoctrineTrigger,
  TriggerContext,
  ValidationResult,
  DoctrineAuditLog,
};
