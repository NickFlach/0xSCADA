import { RecipeAuditService, RecipeStatus } from '../recipe-audit';
import { AuditLogger } from '../audit-logger';

describe('RecipeAuditService', () => {
  let service: RecipeAuditService;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    auditLogger = new AuditLogger('test-key');
    service = new RecipeAuditService(auditLogger);
  });

  it('should create a recipe', () => {
    const recipe = service.createRecipe({
      recipeId: 'r1',
      name: 'Batch Process A',
      description: 'Standard batch process',
      parameters: [{ name: 'temperature', value: 72, unit: '°C' }],
      createdBy: 'user1',
      username: 'engineer1',
    });

    expect(recipe.version).toBe(1);
    expect(recipe.status).toBe(RecipeStatus.DRAFT);
    expect(recipe.contentHash).toBeDefined();
  });

  it('should update a recipe with versioning', () => {
    service.createRecipe({
      recipeId: 'r1', name: 'Recipe', description: 'Desc',
      parameters: [{ name: 'temp', value: 72 }],
      createdBy: 'u1', username: 'eng1',
    });

    const updated = service.updateRecipe({
      recipeId: 'r1',
      parameters: [{ name: 'temp', value: 75 }],
      changedBy: 'u1', username: 'eng1',
      changeReason: 'Optimized temperature',
    });

    expect(updated.version).toBe(2);
    const history = service.getVersionHistory('r1');
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe(RecipeStatus.SUPERSEDED);
  });

  it('should track parameter changes', () => {
    service.createRecipe({
      recipeId: 'r1', name: 'Recipe', description: 'Desc',
      parameters: [{ name: 'temp', value: 72 }, { name: 'pressure', value: 100 }],
      createdBy: 'u1', username: 'eng1',
    });

    service.updateRecipe({
      recipeId: 'r1',
      parameters: [{ name: 'temp', value: 75 }, { name: 'pressure', value: 100 }],
      changedBy: 'u1', username: 'eng1',
      changeReason: 'Adjusted temp',
    });

    const changes = service.getChangeHistory('r1');
    expect(changes).toHaveLength(1);
    expect(changes[0].parameterChanges).toHaveLength(1);
    expect(changes[0].parameterChanges[0].parameterName).toBe('temp');
  });

  it('should enforce separation of duties for approvals', () => {
    service.createRecipe({
      recipeId: 'r1', name: 'Recipe', description: 'Desc',
      parameters: [], createdBy: 'u1', username: 'eng1',
    });

    expect(() => {
      service.approveRecipe({ recipeId: 'r1', version: 1, approvedBy: 'u1', username: 'eng1', fullName: 'Engineer One' });
    }).toThrow('separation of duties');
  });

  it('should approve a recipe by a different user', () => {
    service.createRecipe({
      recipeId: 'r1', name: 'Recipe', description: 'Desc',
      parameters: [], createdBy: 'u1', username: 'eng1',
    });

    const approved = service.approveRecipe({ recipeId: 'r1', version: 1, approvedBy: 'u2', username: 'mgr1', fullName: 'Manager One' });
    expect(approved.status).toBe(RecipeStatus.APPROVED);
    expect(approved.approvedBy).toBe('u2');
  });
});
