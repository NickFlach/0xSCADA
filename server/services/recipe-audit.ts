/**
 * CFR 21 Part 11-Compliant Recipe Auditing
 *
 * Recipe change tracking with electronic signatures and full audit trail.
 * Issues: #23, #40
 */

import { AuditLogger, AuditCategory, AuditEntry } from './audit-logger';

/** Recipe version status */
export enum RecipeStatus {
  DRAFT = 'DRAFT',
  PENDING_REVIEW = 'PENDING_REVIEW',
  APPROVED = 'APPROVED',
  ACTIVE = 'ACTIVE',
  SUPERSEDED = 'SUPERSEDED',
  RETIRED = 'RETIRED',
}

/** Recipe parameter definition */
export interface RecipeParameter {
  name: string;
  value: number | string | boolean;
  unit?: string;
  min?: number;
  max?: number;
  description?: string;
}

/** Recipe version */
export interface RecipeVersion {
  recipeId: string;
  version: number;
  name: string;
  description: string;
  parameters: RecipeParameter[];
  status: RecipeStatus;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  /** Change reason (required for modifications) */
  changeReason: string;
  /** Hash of the recipe content for integrity */
  contentHash: string;
}

/** Recipe change record */
export interface RecipeChange {
  recipeId: string;
  fromVersion: number;
  toVersion: number;
  changedBy: string;
  changedAt: string;
  changeReason: string;
  parameterChanges: ParameterChange[];
  auditEntryId: string;
}

/** Individual parameter change */
export interface ParameterChange {
  parameterName: string;
  previousValue: unknown;
  newValue: unknown;
  unit?: string;
}

import * as crypto from 'crypto';

/**
 * Recipe Audit Service
 *
 * Provides CFR 21 Part 11-compliant recipe management with:
 * - Version control with full history
 * - Electronic signatures for approvals
 * - Parameter-level change tracking
 * - Immutable audit trail
 */
export class RecipeAuditService {
  private recipes = new Map<string, RecipeVersion[]>();
  private changes: RecipeChange[] = [];

  constructor(private auditLogger: AuditLogger) {}

  /**
   * Create a new recipe.
   */
  createRecipe(params: {
    recipeId: string;
    name: string;
    description: string;
    parameters: RecipeParameter[];
    createdBy: string;
    username: string;
    changeReason?: string;
  }): RecipeVersion {
    const version: RecipeVersion = {
      recipeId: params.recipeId,
      version: 1,
      name: params.name,
      description: params.description,
      parameters: params.parameters,
      status: RecipeStatus.DRAFT,
      createdBy: params.createdBy,
      createdAt: new Date().toISOString(),
      changeReason: params.changeReason || 'Initial creation',
      contentHash: this.hashRecipeContent(params.parameters),
    };

    this.recipes.set(params.recipeId, [version]);

    this.auditLogger.log({
      category: AuditCategory.RECIPE_CHANGE,
      action: 'recipe.created',
      resourceType: 'recipe',
      resourceId: params.recipeId,
      userId: params.createdBy,
      username: params.username,
      newValue: version,
      signatureMeaning: 'Authored',
    });

    return version;
  }

  /**
   * Update a recipe, creating a new version.
   */
  updateRecipe(params: {
    recipeId: string;
    name?: string;
    description?: string;
    parameters: RecipeParameter[];
    changedBy: string;
    username: string;
    changeReason: string;
  }): RecipeVersion {
    const versions = this.recipes.get(params.recipeId);
    if (!versions || versions.length === 0) {
      throw new Error(`Recipe ${params.recipeId} not found`);
    }

    const current = versions[versions.length - 1];
    const paramChanges = this.diffParameters(current.parameters, params.parameters);

    const newVersion: RecipeVersion = {
      recipeId: params.recipeId,
      version: current.version + 1,
      name: params.name || current.name,
      description: params.description || current.description,
      parameters: params.parameters,
      status: RecipeStatus.DRAFT,
      createdBy: params.changedBy,
      createdAt: new Date().toISOString(),
      changeReason: params.changeReason,
      contentHash: this.hashRecipeContent(params.parameters),
    };

    // Mark previous as superseded
    current.status = RecipeStatus.SUPERSEDED;
    versions.push(newVersion);

    const auditEntry = this.auditLogger.log({
      category: AuditCategory.RECIPE_CHANGE,
      action: 'recipe.updated',
      resourceType: 'recipe',
      resourceId: params.recipeId,
      userId: params.changedBy,
      username: params.username,
      previousValue: current,
      newValue: newVersion,
      metadata: { parameterChanges: paramChanges, changeReason: params.changeReason },
      signatureMeaning: 'Authored',
    });

    this.changes.push({
      recipeId: params.recipeId,
      fromVersion: current.version,
      toVersion: newVersion.version,
      changedBy: params.changedBy,
      changedAt: newVersion.createdAt,
      changeReason: params.changeReason,
      parameterChanges: paramChanges,
      auditEntryId: auditEntry.id,
    });

    return newVersion;
  }

  /**
   * Approve a recipe version (requires electronic signature).
   */
  approveRecipe(params: {
    recipeId: string;
    version: number;
    approvedBy: string;
    username: string;
    fullName: string;
  }): RecipeVersion {
    const versions = this.recipes.get(params.recipeId);
    if (!versions) throw new Error(`Recipe ${params.recipeId} not found`);

    const recipe = versions.find((v) => v.version === params.version);
    if (!recipe) throw new Error(`Version ${params.version} not found`);

    if (recipe.createdBy === params.approvedBy) {
      throw new Error('Recipe creator cannot approve their own recipe (separation of duties)');
    }

    recipe.status = RecipeStatus.APPROVED;
    recipe.approvedBy = params.approvedBy;
    recipe.approvedAt = new Date().toISOString();

    this.auditLogger.log({
      category: AuditCategory.RECIPE_CHANGE,
      action: 'recipe.approved',
      resourceType: 'recipe',
      resourceId: params.recipeId,
      userId: params.approvedBy,
      username: params.username,
      fullName: params.fullName,
      newValue: { version: params.version, status: RecipeStatus.APPROVED },
      signatureMeaning: 'Approved',
    });

    return recipe;
  }

  /**
   * Get all versions of a recipe.
   */
  getVersionHistory(recipeId: string): RecipeVersion[] {
    return this.recipes.get(recipeId) || [];
  }

  /**
   * Get change history for a recipe.
   */
  getChangeHistory(recipeId: string): RecipeChange[] {
    return this.changes.filter((c) => c.recipeId === recipeId);
  }

  /**
   * Get the current (latest) version of a recipe.
   */
  getCurrentVersion(recipeId: string): RecipeVersion | undefined {
    const versions = this.recipes.get(recipeId);
    return versions?.[versions.length - 1];
  }

  /**
   * Diff two parameter sets to find changes.
   */
  private diffParameters(
    oldParams: RecipeParameter[],
    newParams: RecipeParameter[]
  ): ParameterChange[] {
    const changes: ParameterChange[] = [];
    const oldMap = new Map(oldParams.map((p) => [p.name, p]));
    const newMap = new Map(newParams.map((p) => [p.name, p]));

    for (const [name, newParam] of newMap) {
      const oldParam = oldMap.get(name);
      if (!oldParam) {
        changes.push({ parameterName: name, previousValue: null, newValue: newParam.value, unit: newParam.unit });
      } else if (JSON.stringify(oldParam.value) !== JSON.stringify(newParam.value)) {
        changes.push({ parameterName: name, previousValue: oldParam.value, newValue: newParam.value, unit: newParam.unit });
      }
    }

    for (const [name, oldParam] of oldMap) {
      if (!newMap.has(name)) {
        changes.push({ parameterName: name, previousValue: oldParam.value, newValue: null, unit: oldParam.unit });
      }
    }

    return changes;
  }

  /**
   * Hash recipe parameters for integrity verification.
   */
  private hashRecipeContent(parameters: RecipeParameter[]): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(parameters))
      .digest('hex');
  }
}
