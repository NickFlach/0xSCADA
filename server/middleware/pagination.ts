/**
 * Reusable Pagination & Filtering Middleware
 * 
 * Issue #42: REST API Baseline (Read-Heavy)
 * 
 * Provides standardized pagination, sorting, and filtering
 * across all read-heavy API endpoints.
 */

import type { Request, Response, NextFunction } from "express";

// =============================================================================
// TYPES
// =============================================================================

export interface PaginationParams {
  page: number;
  limit: number;
  offset: number;
  sortBy: string;
  sortOrder: "asc" | "desc";
  filters: Record<string, string>;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  _links: {
    self: string;
    first: string;
    last: string;
    next: string | null;
    prev: string | null;
  };
}

// Extend Express Request
declare global {
  namespace Express {
    interface Request {
      pagination?: PaginationParams;
    }
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const DEFAULT_SORT_ORDER = "desc" as const;

// =============================================================================
// MIDDLEWARE
// =============================================================================

/**
 * Parse pagination, sorting, and filter query parameters.
 * 
 * Query params:
 *   - page (default: 1)
 *   - limit (default: 25, max: 100)
 *   - sort_by (default provided by caller)
 *   - sort_order (asc|desc, default: desc)
 *   - Any other query param is treated as a filter
 */
export function parsePagination(defaultSortBy = "createdAt") {
  return (req: Request, _res: Response, next: NextFunction) => {
    const page = Math.max(1, parseInt(req.query.page as string) || DEFAULT_PAGE);
    const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(req.query.limit as string) || DEFAULT_LIMIT));
    const offset = (page - 1) * limit;
    const sortBy = (req.query.sort_by as string) || defaultSortBy;
    const sortOrder = (req.query.sort_order as string)?.toLowerCase() === "asc" ? "asc" : DEFAULT_SORT_ORDER;

    // Collect filters (everything that isn't a pagination/sort param)
    const reserved = new Set(["page", "limit", "sort_by", "sort_order"]);
    const filters: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (!reserved.has(key) && typeof value === "string") {
        filters[key] = value;
      }
    }

    req.pagination = { page, limit, offset, sortBy, sortOrder, filters };
    next();
  };
}

/**
 * Build a paginated response envelope.
 */
export function paginatedResponse<T>(
  data: T[],
  total: number,
  params: PaginationParams,
  basePath: string
): PaginatedResponse<T> {
  const totalPages = Math.ceil(total / params.limit) || 1;
  const hasNext = params.page < totalPages;
  const hasPrev = params.page > 1;

  const buildUrl = (p: number) =>
    `${basePath}?page=${p}&limit=${params.limit}&sort_by=${params.sortBy}&sort_order=${params.sortOrder}`;

  return {
    data,
    pagination: {
      page: params.page,
      limit: params.limit,
      total,
      totalPages,
      hasNext,
      hasPrev,
    },
    _links: {
      self: buildUrl(params.page),
      first: buildUrl(1),
      last: buildUrl(totalPages),
      next: hasNext ? buildUrl(params.page + 1) : null,
      prev: hasPrev ? buildUrl(params.page - 1) : null,
    },
  };
}
