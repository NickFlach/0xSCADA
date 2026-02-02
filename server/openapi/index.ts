/**
 * OpenAPI Documentation Module
 * 
 * Provides:
 * - OpenAPI 3.0 specification
 * - Swagger UI at /api/docs
 * - JSON/YAML spec export
 * - TypeScript client generation
 */

export { openApiSpec } from './openapi-spec.js';
export { registerSwaggerRoutes } from './swagger-ui.js';
export { validateSpec, diffSpecs } from './openapi-validator.js';
