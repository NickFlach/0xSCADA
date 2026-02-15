/**
 * API Baseline Tests — Issue #42
 * 
 * Unit tests for pagination middleware and alarm state logic.
 * These tests avoid importing modules that require database connections.
 */

import { describe, it, expect } from "vitest";
import {
  parsePagination,
  paginatedResponse,
  DEFAULT_PAGE,
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type PaginationParams,
} from "../middleware/pagination";

// =============================================================================
// Pagination Middleware Unit Tests
// =============================================================================

describe("parsePagination middleware", () => {
  function callMiddleware(query: Record<string, string>, defaultSort = "createdAt") {
    let result: any;
    const req = { query } as any;
    const res = {} as any;
    const next = () => { result = req.pagination; };
    parsePagination(defaultSort)(req, res, next);
    return result as PaginationParams;
  }

  it("uses defaults when no query params", () => {
    const p = callMiddleware({});
    expect(p.page).toBe(DEFAULT_PAGE);
    expect(p.limit).toBe(DEFAULT_LIMIT);
    expect(p.offset).toBe(0);
    expect(p.sortOrder).toBe("desc");
    expect(p.sortBy).toBe("createdAt");
    expect(p.filters).toEqual({});
  });

  it("parses page and limit", () => {
    const p = callMiddleware({ page: "3", limit: "10" });
    expect(p.page).toBe(3);
    expect(p.limit).toBe(10);
    expect(p.offset).toBe(20);
  });

  it("clamps limit to MAX_LIMIT", () => {
    const p = callMiddleware({ limit: "999" });
    expect(p.limit).toBe(MAX_LIMIT);
  });

  it("clamps page to minimum 1", () => {
    const p = callMiddleware({ page: "-5" });
    expect(p.page).toBe(1);
    expect(p.offset).toBe(0);
  });

  it("extracts filters from non-reserved params", () => {
    const p = callMiddleware({ page: "1", status: "OK", search: "pump" });
    expect(p.filters).toEqual({ status: "OK", search: "pump" });
  });

  it("parses sort_order=asc", () => {
    const p = callMiddleware({ sort_order: "asc" });
    expect(p.sortOrder).toBe("asc");
  });

  it("uses custom default sort field", () => {
    const p = callMiddleware({}, "name");
    expect(p.sortBy).toBe("name");
  });

  it("handles invalid page gracefully (NaN)", () => {
    const p = callMiddleware({ page: "abc" });
    expect(p.page).toBe(1);
  });
});

// =============================================================================
// paginatedResponse Tests
// =============================================================================

describe("paginatedResponse", () => {
  const params: PaginationParams = {
    page: 2,
    limit: 10,
    offset: 10,
    sortBy: "createdAt",
    sortOrder: "desc",
    filters: {},
  };

  it("builds correct pagination metadata", () => {
    const result = paginatedResponse([1, 2, 3], 25, params, "/api/test");
    expect(result.pagination.page).toBe(2);
    expect(result.pagination.total).toBe(25);
    expect(result.pagination.totalPages).toBe(3);
    expect(result.pagination.hasNext).toBe(true);
    expect(result.pagination.hasPrev).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });

  it("generates correct HATEOAS links", () => {
    const result = paginatedResponse([], 25, params, "/api/test");
    expect(result._links.self).toContain("page=2");
    expect(result._links.next).toContain("page=3");
    expect(result._links.prev).toContain("page=1");
    expect(result._links.first).toContain("page=1");
    expect(result._links.last).toContain("page=3");
  });

  it("null next on last page", () => {
    const lastPage = { ...params, page: 3 };
    const result = paginatedResponse([], 25, lastPage, "/api/test");
    expect(result._links.next).toBeNull();
    expect(result.pagination.hasNext).toBe(false);
  });

  it("null prev on first page", () => {
    const firstPage = { ...params, page: 1 };
    const result = paginatedResponse([], 25, firstPage, "/api/test");
    expect(result._links.prev).toBeNull();
    expect(result.pagination.hasPrev).toBe(false);
  });

  it("handles zero total", () => {
    const firstPage = { ...params, page: 1 };
    const result = paginatedResponse([], 0, firstPage, "/api/test");
    expect(result.pagination.totalPages).toBe(1);
    expect(result.pagination.hasNext).toBe(false);
  });

  it("preserves data types", () => {
    const items = [{ id: 1, name: "a" }, { id: 2, name: "b" }];
    const result = paginatedResponse(items, 2, { ...params, page: 1 }, "/api/x");
    expect(result.data).toEqual(items);
  });
});
