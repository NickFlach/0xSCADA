/**
 * Services Types Index
 * 
 * Consolidates all service-related types for better organization.
 * Each service has its own file but common patterns are extracted.
 * 
 * Dependencies: ../core/common.ts, ../core/industrial.ts
 */

export * from './adapters';
// './ml' removed with server/services/ml (#605). The module it described was a
// simulation harness whose "predictions" were PRNG draws; the types had no
// other consumer, so they are gone rather than left as a shape for anything to
// re-fill. Reintroduce a model/prediction vocabulary alongside a real inference
// backend, not before it.
export * from './blockchain';
export * from './compliance';
export * from './geometry';
export * from './ubiquity';
export * from './cache';

// Re-export commonly used service patterns
export * from './common';