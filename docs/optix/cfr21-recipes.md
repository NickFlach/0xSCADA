# CFR 21 Part 11-Compliant Recipe Auditing

## Overview

0xSCADA implements CFR 21 Part 11-compliant recipe management with electronic signatures, immutable audit trails, and full version control. This ensures traceability for regulated industries (pharma, food & beverage, life sciences).

## Architecture

### Components

- **`server/services/recipe-audit.ts`** — Recipe versioning, change tracking, approval workflow
- **`server/services/audit-logger.ts`** — Immutable hash-chained audit log with electronic signatures
- **`server/services/config-tracker.ts`** — Configuration change tracking with before/after snapshots

### CFR 21 Part 11 Compliance Features

| Requirement | Implementation |
|---|---|
| Electronic signatures | HMAC-SHA256 signatures with user identity, timestamp, and meaning |
| Audit trail | Hash-chained append-only log (blockchain-style integrity) |
| Separation of duties | Creator cannot approve their own recipe |
| Change reason | Required for all recipe modifications |
| Version control | Immutable version history with parameter-level diffs |
| Timestamp integrity | ISO 8601 timestamps, hash-chained for tamper detection |

## Usage

### Creating a Recipe

```typescript
import { RecipeAuditService } from './server/services/recipe-audit';
import { AuditLogger } from './server/services/audit-logger';

const auditLogger = new AuditLogger(process.env.AUDIT_SIGNING_KEY!);
const recipeService = new RecipeAuditService(auditLogger);

const recipe = recipeService.createRecipe({
  recipeId: 'batch-001',
  name: 'Standard Batch Process',
  description: 'Production batch with temperature control',
  parameters: [
    { name: 'temperature', value: 72, unit: '°C', min: 60, max: 85 },
    { name: 'pressure', value: 101.3, unit: 'kPa' },
    { name: 'duration', value: 3600, unit: 's' },
  ],
  createdBy: 'user-123',
  username: 'j.smith',
});
```

### Updating a Recipe

```typescript
const updated = recipeService.updateRecipe({
  recipeId: 'batch-001',
  parameters: [
    { name: 'temperature', value: 75, unit: '°C', min: 60, max: 85 },
    { name: 'pressure', value: 101.3, unit: 'kPa' },
    { name: 'duration', value: 3600, unit: 's' },
  ],
  changedBy: 'user-123',
  username: 'j.smith',
  changeReason: 'Optimized temperature for improved yield',
});
```

### Approving a Recipe

```typescript
// Must be a different user than the creator
const approved = recipeService.approveRecipe({
  recipeId: 'batch-001',
  version: 2,
  approvedBy: 'user-456',
  username: 'm.jones',
  fullName: 'Mary Jones',
});
```

### Verifying Audit Chain Integrity

```typescript
const result = auditLogger.verifyChain();
if (!result.valid) {
  console.error(`Audit chain broken at entry ${result.brokenAt}`);
}
```

## Electronic Signatures

Each audit entry includes one or more electronic signatures containing:
- **User identity** (userId, username, fullName)
- **Timestamp** of the signature
- **Meaning** (Authored, Approved, Reviewed)
- **HMAC-SHA256** signature of the entry content

Signatures can be independently verified using the signing key.

## Configuration Change Tracking

The `ConfigTracker` extends recipe auditing to all configuration changes:

```typescript
import { ConfigTracker, ConfigScope } from './server/services/config-tracker';

const tracker = new ConfigTracker(auditLogger);

tracker.trackChange({
  scope: ConfigScope.GATEWAY,
  key: 'opcua.endpoint',
  newValue: 'opc.tcp://plc-01:4840',
  changedBy: 'user-123',
  username: 'j.smith',
  changeReason: 'Migrated to new PLC',
});
```
