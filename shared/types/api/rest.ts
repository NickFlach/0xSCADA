/**
 * REST API Types
 * 
 * Standard REST API patterns and response types.
 */

import { EntityId, Timestamp, PaginatedResult } from '../core/common';

// ─── Standard Response Format ───────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: Timestamp;
  requestId?: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  field?: string; // For validation errors
}

// ─── Request/Response Patterns ──────────────────────────────────────────────

export interface CreateRequest<T = Record<string, unknown>> {
  data: T;
  metadata?: Record<string, unknown>;
}

export interface UpdateRequest<T = Record<string, unknown>> {
  id: EntityId;
  data: Partial<T>;
  metadata?: Record<string, unknown>;
}

export interface DeleteRequest {
  id: EntityId;
  force?: boolean;
  reason?: string;
}

export interface ListRequest {
  offset?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filter?: Record<string, unknown>;
  search?: string;
}

export interface BulkRequest<T = Record<string, unknown>> {
  operation: 'create' | 'update' | 'delete';
  items: T[];
  options?: {
    stopOnError?: boolean;
    validateOnly?: boolean;
  };
}

// ─── Common Response Types ──────────────────────────────────────────────────

export interface CreatedResponse {
  id: EntityId;
  createdAt: Timestamp;
}

export interface UpdatedResponse {
  id: EntityId;
  updatedAt: Timestamp;
  changes: Record<string, unknown>;
}

export interface DeletedResponse {
  id: EntityId;
  deletedAt: Timestamp;
}

export interface BulkResponse<T = unknown> {
  processed: number;
  errors: { index: number; error: ApiError }[];
  results: T[];
}

// ─── HTTP Status Mapping ────────────────────────────────────────────────────

export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  ACCEPTED: 202,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
} as const;

export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  UNAUTHORIZED_ACCESS: 'UNAUTHORIZED_ACCESS',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE'
} as const;