# Ladder Logic AI Agent

The Ladder Logic Agent enables AI-driven code generation for Studio 5000 ladder logic within 0xSCADA. This module is inspired by and compatible with the LadderLogix application, providing programmatic generation of ladder logic rungs in neutral text format.

## Overview

The agent provides:
- **Instruction Library**: Complete set of Studio 5000 ladder logic instructions (XIC, XIO, OTE, TON, CTU, etc.)
- **Neutral Text Generation**: Generate valid Studio 5000 neutral text format
- **Rung Builder API**: Fluent API for programmatic rung construction
- **Batch Generation**: Template-based generation with CSV variable substitution
- **AI Context Generation**: Structured prompts for external AI integration

## Quick Start

### Generate Ladder Logic from a Control Module

```typescript
import { ladderLogicAgent } from "./server/blueprints";

// Define a control module type
const cmType = {
  name: "Motor_Starter",
  inputs: [
    { name: "Start_PB", dataType: "Bool", primary: true },
    { name: "Stop_PB", dataType: "Bool" },
    { name: "Overload", dataType: "Bool", isError: true },
  ],
  outputs: [
    { name: "Motor_Run", dataType: "Bool", primary: true },
  ],
  inOuts: [],
};

// Build context and generate logic
const context = ladderLogicAgent.buildContextFromCMType(cmType);
const result = ladderLogicAgent.generateControlModuleLogic(context);

console.log(result.neutralText);
// Output:
// XIC(Start_PB)OTE(Enabled);
// XIC(Overload)OTL(Fault);
// XIC(FaultReset)OTU(Fault);
// XIC(Enabled)XIO(Fault)OTE(InterlockOK);
// XIC(InterlockOK)OTE(Motor_Run);
```

### Build Rungs Programmatically

```typescript
import { rung, RungBuilder } from "./server/blueprints";

// Simple rung
const motorRung = rung(0)
  .xic("Start")
  .xio("Stop")
  .ote("Motor")
  .withComment("Motor start/stop logic")
  .toNeutralText();

// Rung with branch
const branchRung = rung(1)
  .branch(
    b => b.xic("Button1"),
    b => b.xic("Button2")
  )
  .ote("Lamp")
  .toNeutralText();

// Timer rung
const timerRung = rung(2)
  .xic("Enable")
  .ton("DelayTimer", "5000", "0")
  .toNeutralText();
```

### Batch Generation from Templates

```typescript
import { BatchRungGenerator } from "./server/blueprints";

const generator = new BatchRungGenerator();

// Load template with variables
generator.loadTemplate("XIC({Sensor})TON({Timer},1000,0)OTE({Output});");

// Generate from CSV
const csvContent = `Sensor,Timer,Output
Level_High,Delay_1,Pump_1
Level_Low,Delay_2,Pump_2
Pressure_High,Delay_3,Valve_1`;

const result = generator.generateAll(csvContent);
console.log(result.neutralText);
```

## Instruction Library

The agent includes all standard Studio 5000 instructions:

### Bit Instructions
| Mnemonic | Name | Type | Description |
|----------|------|------|-------------|
| XIC | Examine If Closed | Input | Normally Open Contact |
| XIO | Examine If Open | Input | Normally Closed Contact |
| OTE | Output Energize | Output | Standard Output Coil |
| OTL | Output Latch | Output | Latching Output |
| OTU | Output Unlatch | Output | Unlatching Output |
| ONS | One Shot | Input | Single Scan Pulse |
| OSR | One Shot Rising | Input | Rising Edge Pulse |
| OSF | One Shot Falling | Input | Falling Edge Pulse |

### Timer Instructions
| Mnemonic | Name | Parameters |
|----------|------|------------|
| TON | Timer On Delay | timer, preset, accum |
| TOF | Timer Off Delay | timer, preset, accum |
| RTO | Retentive Timer On | timer, preset, accum |

### Counter Instructions
| Mnemonic | Name | Parameters |
|----------|------|------------|
| CTU | Count Up | counter, preset, accum |
| CTD | Count Down | counter, preset, accum |
| RES | Reset | tag |

### Compare Instructions
| Mnemonic | Name | Parameters |
|----------|------|------------|
| EQU | Equal | source_a, source_b |
| NEQ | Not Equal | source_a, source_b |
| GRT | Greater Than | source_a, source_b |
| GEQ | Greater Than or Equal | source_a, source_b |
| LES | Less Than | source_a, source_b |
| LEQ | Less Than or Equal | source_a, source_b |
| LIM | Limit Test | low, test, high |

### Math Instructions
| Mnemonic | Name | Parameters |
|----------|------|------------|
| MOV | Move | source, dest |
| ADD | Add | source_a, source_b, dest |
| SUB | Subtract | source_a, source_b, dest |
| MUL | Multiply | source_a, source_b, dest |
| DIV | Divide | source_a, source_b, dest |
| NEG | Negate | source, dest |
| CLR | Clear | dest |
| CPT | Compute | dest, expression |

### Program Control
| Mnemonic | Name | Parameters |
|----------|------|------------|
| JSR | Jump to Subroutine | routine_name |
| RET | Return | (none) |
| JMP | Jump | label |
| LBL | Label | label |
| NOP | No Operation | (none) |
| AFI | Always False | (none) |

## Neutral Text Format

The neutral text format is Rockwell's standard for representing ladder logic as text:

```
// Simple rung
XIC(Start)XIO(Stop)OTE(Motor);

// Parallel branch using brackets
[XIC(Button1),XIC(Button2)]OTE(Lamp);

// Timer
XIC(Enable)TON(Timer1,5000,0);

// Counter
XIC(Trigger)CTU(Counter1,100,0);

// Complex branch
XIC(A)[XIC(B),XIC(C)]XIC(D)OTE(Y);
```

### Branch Formats

Two branch formats are supported:

**Bracket Style** (default):
```
[XIC(Path1),XIC(Path2)]OTE(Output);
```

**BST/NXB/BND Style**:
```
BST XIC(Path1) NXB XIC(Path2) BND OTE(Output);
```

## AI Integration

The agent can generate context for external AI systems:

```typescript
const context = ladderLogicAgent.buildContextFromCMType(cmType);
const aiPrompt = ladderLogicAgent.generateAIPromptContext(context);

// aiPrompt contains:
// - Source information
// - Available inputs/outputs with types
// - Linked modules (for phases)
// - Sequence definitions
// - Available instruction reference
```

## Phase Logic Generation

For ISA-88 batch phases:

```typescript
const phaseType = {
  name: "Fill_Phase",
  linkedModules: [
    { name: "InletValve", type: "CM_Valve" },
    { name: "LevelSensor", type: "CM_AI" },
  ],
  sequences: {
    Running: {
      name: "Running",
      steps: [
        { step: 1, actions: ["Open InletValve"], conditions: [{ condition: "Level > SP", target: 2 }] },
        { step: 2, actions: ["Close InletValve"], conditions: [{ condition: "Valve.Closed", target: 0 }] },
      ],
    },
  },
  // ... other properties
};

const context = ladderLogicAgent.buildContextFromPhaseType(phaseType);
const result = ladderLogicAgent.generatePhaseLogic(context);
```

## Validation

Rungs can be validated before use:

```typescript
import { validateRung, parseNeutralText } from "./server/blueprints";

const rung = parseNeutralText("XIC(Start)OTE(Motor);", 0);
const validation = validateRung(rung);

if (!validation.valid) {
  console.error("Validation errors:", validation.errors);
}
```

## Integration with Rockwell Adapter

The ladder logic agent integrates with the existing Rockwell adapter:

```typescript
import { generateAdvancedLadderLogic } from "./server/blueprints";

const result = await generateAdvancedLadderLogic(cmType, {
  includeComments: true,
  generateFaultHandling: true,
  generateInterlocks: true,
});

console.log(result.neutralText);
console.log(result.tags); // Required tags
```

## File Structure

```
server/blueprints/
├── ladder-logic-types.ts      # Instruction definitions and types
├── neutral-text-generator.ts  # Neutral text generation and parsing
├── ladder-logic-agent.ts      # AI agent for code generation
├── batch-rung-generator.ts    # Template-based batch generation
└── __tests__/
    └── ladder-logic-agent.test.ts  # Unit tests
```

## Compatibility

Generated neutral text is compatible with:
- Rockwell Studio 5000 Logix Designer
- LadderLogix application
- L5X import/export format

## Examples

See the test file `__tests__/ladder-logic-agent.test.ts` for comprehensive examples of all features.
