/**
 * OpenAPI Specification Validator
 * 
 * Validates OpenAPI spec structure and detects breaking changes
 * for CI/CD integration.
 */

import type { OpenAPIV3 } from 'openapi-types';

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  path: string;
  message: string;
  severity: 'error';
}

export interface ValidationWarning {
  path: string;
  message: string;
  severity: 'warning';
}

export interface SpecDiff {
  breaking: BreakingChange[];
  nonBreaking: NonBreakingChange[];
}

export interface BreakingChange {
  type: 'removed' | 'changed';
  path: string;
  description: string;
}

export interface NonBreakingChange {
  type: 'added' | 'deprecated';
  path: string;
  description: string;
}

/**
 * Validate OpenAPI specification
 */
export function validateSpec(spec: OpenAPIV3.Document): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  // Validate required fields
  if (!spec.openapi) {
    errors.push({
      path: 'openapi',
      message: 'Missing required field: openapi version',
      severity: 'error',
    });
  } else if (!spec.openapi.startsWith('3.')) {
    errors.push({
      path: 'openapi',
      message: `Unsupported OpenAPI version: ${spec.openapi}. Expected 3.x.x`,
      severity: 'error',
    });
  }

  if (!spec.info) {
    errors.push({
      path: 'info',
      message: 'Missing required field: info',
      severity: 'error',
    });
  } else {
    if (!spec.info.title) {
      errors.push({
        path: 'info.title',
        message: 'Missing required field: info.title',
        severity: 'error',
      });
    }
    if (!spec.info.version) {
      errors.push({
        path: 'info.version',
        message: 'Missing required field: info.version',
        severity: 'error',
      });
    }
  }

  if (!spec.paths || Object.keys(spec.paths).length === 0) {
    warnings.push({
      path: 'paths',
      message: 'No paths defined in specification',
      severity: 'warning',
    });
  }

  // Validate paths
  if (spec.paths) {
    for (const [pathKey, pathItem] of Object.entries(spec.paths)) {
      if (!pathKey.startsWith('/')) {
        errors.push({
          path: `paths.${pathKey}`,
          message: `Path must start with /: ${pathKey}`,
          severity: 'error',
        });
      }

      if (pathItem) {
        validatePathItem(pathKey, pathItem as OpenAPIV3.PathItemObject, errors, warnings);
      }
    }
  }

  // Validate components
  if (spec.components) {
    validateComponents(spec.components, errors, warnings);
  }

  // Validate security schemes usage
  if (spec.security) {
    validateSecurityRequirements(spec.security, spec.components?.securitySchemes || {}, errors);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Validate a path item
 */
function validatePathItem(
  path: string,
  pathItem: OpenAPIV3.PathItemObject,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  const methods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'] as const;

  for (const method of methods) {
    const operation = pathItem[method] as OpenAPIV3.OperationObject | undefined;
    if (operation) {
      validateOperation(`${path}.${method}`, operation, errors, warnings);
    }
  }
}

/**
 * Validate an operation
 */
function validateOperation(
  path: string,
  operation: OpenAPIV3.OperationObject,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  // Check for operationId
  if (!operation.operationId) {
    warnings.push({
      path: `${path}.operationId`,
      message: 'Missing operationId (recommended for client generation)',
      severity: 'warning',
    });
  }

  // Check for responses
  if (!operation.responses || Object.keys(operation.responses).length === 0) {
    errors.push({
      path: `${path}.responses`,
      message: 'Operation must have at least one response',
      severity: 'error',
    });
  }

  // Check for description or summary
  if (!operation.summary && !operation.description) {
    warnings.push({
      path: `${path}`,
      message: 'Operation should have summary or description',
      severity: 'warning',
    });
  }

  // Validate parameters
  if (operation.parameters) {
    for (const [index, param] of operation.parameters.entries()) {
      if (!('$ref' in param)) {
        if (!param.name) {
          errors.push({
            path: `${path}.parameters[${index}].name`,
            message: 'Parameter must have a name',
            severity: 'error',
          });
        }
        if (!param.in) {
          errors.push({
            path: `${path}.parameters[${index}].in`,
            message: 'Parameter must specify location (in)',
            severity: 'error',
          });
        }
      }
    }
  }
}

/**
 * Validate components
 */
function validateComponents(
  components: OpenAPIV3.ComponentsObject,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  // Validate schemas
  if (components.schemas) {
    for (const [name, schema] of Object.entries(components.schemas)) {
      if (!isValidSchemaName(name)) {
        warnings.push({
          path: `components.schemas.${name}`,
          message: `Schema name should be PascalCase: ${name}`,
          severity: 'warning',
        });
      }

      if (!('$ref' in schema)) {
        validateSchema(`components.schemas.${name}`, schema, errors, warnings);
      }
    }
  }
}

/**
 * Validate a schema
 */
function validateSchema(
  path: string,
  schema: OpenAPIV3.SchemaObject,
  errors: ValidationError[],
  warnings: ValidationWarning[]
): void {
  // Check for type or $ref
  if (!schema.type && !('$ref' in schema) && !schema.allOf && !schema.oneOf && !schema.anyOf) {
    warnings.push({
      path,
      message: 'Schema should specify a type',
      severity: 'warning',
    });
  }

  // Validate object properties
  if (schema.type === 'object' && schema.properties) {
    for (const [propName, propSchema] of Object.entries(schema.properties)) {
      if (!('$ref' in propSchema)) {
        validateSchema(`${path}.${propName}`, propSchema as OpenAPIV3.SchemaObject, errors, warnings);
      }
    }
  }

  // Validate array items
  if (schema.type === 'array' && !schema.items) {
    errors.push({
      path: `${path}.items`,
      message: 'Array schema must specify items',
      severity: 'error',
    });
  }
}

/**
 * Validate security requirements reference valid schemes
 */
function validateSecurityRequirements(
  security: OpenAPIV3.SecurityRequirementObject[],
  schemes: Record<string, OpenAPIV3.SecuritySchemeObject | OpenAPIV3.ReferenceObject>,
  errors: ValidationError[]
): void {
  for (const [index, requirement] of security.entries()) {
    for (const schemeName of Object.keys(requirement)) {
      if (!schemes[schemeName]) {
        errors.push({
          path: `security[${index}].${schemeName}`,
          message: `Security scheme not defined: ${schemeName}`,
          severity: 'error',
        });
      }
    }
  }
}

/**
 * Check if schema name is valid (PascalCase)
 */
function isValidSchemaName(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name);
}

/**
 * Compare two OpenAPI specs and detect breaking changes
 */
export function diffSpecs(
  oldSpec: OpenAPIV3.Document,
  newSpec: OpenAPIV3.Document
): SpecDiff {
  const breaking: BreakingChange[] = [];
  const nonBreaking: NonBreakingChange[] = [];

  const oldPaths = new Set(Object.keys(oldSpec.paths || {}));
  const newPaths = new Set(Object.keys(newSpec.paths || {}));

  // Check for removed paths (breaking)
  for (const path of oldPaths) {
    if (!newPaths.has(path)) {
      breaking.push({
        type: 'removed',
        path,
        description: `Endpoint removed: ${path}`,
      });
    }
  }

  // Check for added paths (non-breaking)
  for (const path of newPaths) {
    if (!oldPaths.has(path)) {
      nonBreaking.push({
        type: 'added',
        path,
        description: `Endpoint added: ${path}`,
      });
    }
  }

  // Check for method changes on existing paths
  for (const path of oldPaths) {
    if (newPaths.has(path)) {
      const oldMethods = getPathMethods(oldSpec.paths![path] as OpenAPIV3.PathItemObject);
      const newMethods = getPathMethods(newSpec.paths![path] as OpenAPIV3.PathItemObject);

      for (const method of oldMethods) {
        if (!newMethods.has(method)) {
          breaking.push({
            type: 'removed',
            path: `${path}.${method}`,
            description: `Method removed: ${method.toUpperCase()} ${path}`,
          });
        }
      }

      for (const method of newMethods) {
        if (!oldMethods.has(method)) {
          nonBreaking.push({
            type: 'added',
            path: `${path}.${method}`,
            description: `Method added: ${method.toUpperCase()} ${path}`,
          });
        }
      }
    }
  }

  // Check for removed schemas (breaking)
  const oldSchemas = new Set(Object.keys(oldSpec.components?.schemas || {}));
  const newSchemas = new Set(Object.keys(newSpec.components?.schemas || {}));

  for (const schema of oldSchemas) {
    if (!newSchemas.has(schema)) {
      breaking.push({
        type: 'removed',
        path: `components.schemas.${schema}`,
        description: `Schema removed: ${schema}`,
      });
    }
  }

  return { breaking, nonBreaking };
}

/**
 * Get HTTP methods defined on a path item
 */
function getPathMethods(pathItem: OpenAPIV3.PathItemObject): Set<string> {
  const methods = new Set<string>();
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'trace'];

  for (const method of httpMethods) {
    if (pathItem[method as keyof OpenAPIV3.PathItemObject]) {
      methods.add(method);
    }
  }

  return methods;
}

export default { validateSpec, diffSpecs };
