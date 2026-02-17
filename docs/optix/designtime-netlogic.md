# Design-Time NetLogic — Code Generation Study

> Issue #17 — [Optix/Foundation] Study Design-Time NetLogic for code generation

## Overview

FT Optix **Design-Time NetLogic** runs inside the IDE during development — not at runtime. It automates repetitive configuration: generating tags, creating screen templates, building alarm structures from external data sources.

0xSCADA already has analogous code generation in its **blueprints system**. This document maps the patterns and identifies enhancement opportunities.

---

## Optix Design-Time Patterns

Design-Time NetLogic runs on-demand in the IDE. Common uses:

| Output | Description |
|---|---|
| Tags/Variables | OPC-UA nodes from spreadsheets/databases |
| Screens/Pages | HMI screens from templates + data |
| Alarm definitions | Alarm structures tied to process variables |
| Data loggers | Historian configuration for selected tags |
| Navigation | Menu structures, screen hierarchies |

---

## 0xSCADA's Existing Code Generation

The blueprint system at `server/blueprints/` already provides:

```
CSV Input → Parser → Validator → Code Generator → Storage + Blockchain Hash
```

### Existing Generators

| Generator | Location | Output |
|---|---|---|
| Siemens SCL | `server/blueprints/code-generator.ts` | Function Blocks |
| Siemens TIA XML | `server/blueprints/siemens-adapter.ts` | TIA Portal import |
| Rockwell AOI | `server/blueprints/code-generator.ts` | Add-On Instructions |
| Rockwell L5X | `server/blueprints/code-generator.ts` | Studio 5000 import |
| Ladder Logic | `server/blueprints/ladder-logic-agent.ts` | Neutral text + visual |
| Batch Rungs | `server/blueprints/batch-rung-generator.ts` | Templated expansion |

### API Endpoints

```
POST /api/blueprints/import              — Import CM/Unit/Phase from CSV
POST /api/generate/control-module/:id    — Generate vendor code for a CM type
POST /api/generate/phase/:id             — Generate vendor code for a phase
POST /api/generate/ladder-logic/*        — Ladder logic generation
POST /api/ladder-logic/batch             — Batch rung generation from template
POST /api/ladder-logic/ai-context/:id    — AI prompt context generation
```

---

## Pattern Mapping

### Pattern 1: CSV → Tag Generation

**Optix:** Design-Time NetLogic reads CSV, creates OPC-UA variables.

**0xSCADA:** Already implemented via `POST /api/blueprints/import`. Accepts CSV blueprint packages, creates CM types/instances, unit types/instances, phase types. Validates all references before committing.

### Pattern 2: Template → Screen Generation

**Optix:** Clones a screen template and binds variables for each instance.

**0xSCADA:** Uses React components as "templates" — rendering is configuration-driven:

```typescript
// Auto-generate UI configs from blueprints
function generatePanelConfigs(cmInstances: CMInstance[]): PanelConfig[] {
  return cmInstances
    .filter(cm => cm.cmTypeName === 'VSD_Motor')
    .map(cm => ({
      assetId: cm.name,
      opcuaPrefix: `ns=2;s=${cm.controllerId}.${cm.name}`,
      alarmLimits: cm.configuration?.alarmLimits,
    }));
}
```

### Pattern 3: Code Generation with Blockchain Anchoring

**0xSCADA unique feature** — every generated artifact gets a hash that can be blockchain-anchored:

```typescript
const code = generateSCLSource(fb);
const codeHash = codeGenerator.hashCode(code);
// POST /api/generated-code/:id/anchor → Ethereum L1
```

---

## Enhancement Opportunities

| Capability | Status | Notes |
|---|---|---|
| CSV → Tag import | ✅ Implemented | `POST /api/blueprints/import` |
| CM → Siemens SCL | ✅ Implemented | Multi-vendor support |
| CM → Rockwell L5X | ✅ Implemented | |
| Ladder Logic | ✅ Implemented | With AI context generation |
| Blockchain anchoring | ✅ Implemented | Unique to 0xSCADA |
| Screen/UI generation | 🟡 Opportunity | Extend blueprints → React configs |
| Bulk alarm generation | 🟡 Opportunity | CM engineering limits → alarm defs |
| CLI generation tool | 🟡 Opportunity | `0xscada generate --site --vendor` |
| OPC-UA tag validation | 🟡 Opportunity | Browse + validate node mapping |

0xSCADA's code generation already **exceeds** Optix Design-Time NetLogic in several areas (blockchain anchoring, multi-vendor, batch generation). Main gaps are UI config generation and live OPC-UA validation.
