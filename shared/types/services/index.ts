/**
 * Services Types Index
 * 
 * Consolidates all service-related types for better organization.
 * Each service has its own file but common patterns are extracted.
 * 
 * Dependencies: ../core/common.ts, ../core/industrial.ts
 */

export * from './adapters';
export * from './ml';
export * from './blockchain';
export * from './compliance';
export * from './geometry';
export * from './ubiquity';
export * from './cache';

// Re-export commonly used service patterns
export * from './common';