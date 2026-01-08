/**
 * Ladder Logic Types and Instruction Definitions
 * Ported from LadderLogix for AI-driven code generation
 * 
 * These types enable the 0xSCADA coding agent to generate
 * valid Studio 5000 ladder logic in neutral text format.
 */

// Instruction categories matching Studio 5000
export type InstructionCategory = 
  | "bit"
  | "timer"
  | "counter"
  | "compare"
  | "math"
  | "move"
  | "program"
  | "file"
  | "communication"
  | "system";

// Instruction type (input vs output in ladder logic)
export type InstructionType = "input" | "output";

// Drawing types for visual representation
export type DrawingType = "contact" | "coil" | "box";

export interface InstructionParameter {
  name: string;
  dataType: string;
  description?: string;
  required?: boolean;
  defaultValue?: string;
}

export interface InstructionDefinition {
  mnemonic: string;
  name: string;
  category: InstructionCategory;
  type: InstructionType;
  description: string;
  parameters: InstructionParameter[];
  drawingType: DrawingType;
  width: number;
  height: number;
}

export interface LadderInstruction {
  mnemonic: string;
  parameters: string[];
  comment?: string;
}

export interface LadderBranch {
  type: "branch";
  paths: LadderElement[][];
}

export type LadderElement = LadderInstruction | LadderBranch;

export interface LadderRung {
  number: number;
  comment?: string;
  elements: LadderElement[];
}

export interface LadderRoutine {
  name: string;
  type: "Ladder" | "ST" | "FBD" | "SFC";
  rungs: LadderRung[];
}

export interface LadderProgram {
  name: string;
  routines: LadderRoutine[];
  tags: LadderTag[];
}

export interface LadderTag {
  name: string;
  dataType: string;
  scope: "controller" | "program";
  description?: string;
  initialValue?: string;
}

// Standard instruction library - core ladder logic instructions
export const INSTRUCTION_LIBRARY: Record<string, InstructionDefinition> = {
  // Bit Instructions
  XIC: {
    mnemonic: "XIC",
    name: "Examine If Closed",
    category: "bit",
    type: "input",
    description: "Normally Open Contact - True when bit is ON",
    parameters: [{ name: "tag", dataType: "BOOL", required: true }],
    drawingType: "contact",
    width: 80,
    height: 40,
  },
  XIO: {
    mnemonic: "XIO",
    name: "Examine If Open",
    category: "bit",
    type: "input",
    description: "Normally Closed Contact - True when bit is OFF",
    parameters: [{ name: "tag", dataType: "BOOL", required: true }],
    drawingType: "contact",
    width: 80,
    height: 40,
  },
  OTE: {
    mnemonic: "OTE",
    name: "Output Energize",
    category: "bit",
    type: "output",
    description: "Output Coil - Energizes when rung is true",
    parameters: [{ name: "tag", dataType: "BOOL", required: true }],
    drawingType: "coil",
    width: 80,
    height: 40,
  },
  OTL: {
    mnemonic: "OTL",
    name: "Output Latch",
    category: "bit",
    type: "output",
    description: "Latching Output - Stays ON until unlatched",
    parameters: [{ name: "tag", dataType: "BOOL", required: true }],
    drawingType: "coil",
    width: 80,
    height: 40,
  },
  OTU: {
    mnemonic: "OTU",
    name: "Output Unlatch",
    category: "bit",
    type: "output",
    description: "Unlatching Output - Resets latched output",
    parameters: [{ name: "tag", dataType: "BOOL", required: true }],
    drawingType: "coil",
    width: 80,
    height: 40,
  },
  ONS: {
    mnemonic: "ONS",
    name: "One Shot",
    category: "bit",
    type: "input",
    description: "One Shot - True for one scan when input transitions",
    parameters: [{ name: "tag", dataType: "BOOL", required: true }],
    drawingType: "contact",
    width: 80,
    height: 40,
  },
  OSR: {
    mnemonic: "OSR",
    name: "One Shot Rising",
    category: "bit",
    type: "input",
    description: "One Shot Rising - True for one scan on rising edge",
    parameters: [
      { name: "storage", dataType: "BOOL", required: true },
      { name: "output", dataType: "BOOL", required: true },
    ],
    drawingType: "box",
    width: 100,
    height: 60,
  },
  OSF: {
    mnemonic: "OSF",
    name: "One Shot Falling",
    category: "bit",
    type: "input",
    description: "One Shot Falling - True for one scan on falling edge",
    parameters: [
      { name: "storage", dataType: "BOOL", required: true },
      { name: "output", dataType: "BOOL", required: true },
    ],
    drawingType: "box",
    width: 100,
    height: 60,
  },

  // Timer Instructions
  TON: {
    mnemonic: "TON",
    name: "Timer On Delay",
    category: "timer",
    type: "output",
    description: "Timer On Delay - Delays turning on output",
    parameters: [
      { name: "timer", dataType: "TIMER", required: true },
      { name: "preset", dataType: "DINT", required: true },
      { name: "accum", dataType: "DINT", required: false, defaultValue: "0" },
    ],
    drawingType: "box",
    width: 140,
    height: 80,
  },
  TOF: {
    mnemonic: "TOF",
    name: "Timer Off Delay",
    category: "timer",
    type: "output",
    description: "Timer Off Delay - Delays turning off output",
    parameters: [
      { name: "timer", dataType: "TIMER", required: true },
      { name: "preset", dataType: "DINT", required: true },
      { name: "accum", dataType: "DINT", required: false, defaultValue: "0" },
    ],
    drawingType: "box",
    width: 140,
    height: 80,
  },
  RTO: {
    mnemonic: "RTO",
    name: "Retentive Timer On",
    category: "timer",
    type: "output",
    description: "Retentive Timer On - Accumulates time, retains value",
    parameters: [
      { name: "timer", dataType: "TIMER", required: true },
      { name: "preset", dataType: "DINT", required: true },
      { name: "accum", dataType: "DINT", required: false, defaultValue: "0" },
    ],
    drawingType: "box",
    width: 140,
    height: 80,
  },

  // Counter Instructions
  CTU: {
    mnemonic: "CTU",
    name: "Count Up",
    category: "counter",
    type: "output",
    description: "Count Up - Increments on false-to-true transition",
    parameters: [
      { name: "counter", dataType: "COUNTER", required: true },
      { name: "preset", dataType: "DINT", required: true },
      { name: "accum", dataType: "DINT", required: false, defaultValue: "0" },
    ],
    drawingType: "box",
    width: 140,
    height: 80,
  },
  CTD: {
    mnemonic: "CTD",
    name: "Count Down",
    category: "counter",
    type: "output",
    description: "Count Down - Decrements on false-to-true transition",
    parameters: [
      { name: "counter", dataType: "COUNTER", required: true },
      { name: "preset", dataType: "DINT", required: true },
      { name: "accum", dataType: "DINT", required: false, defaultValue: "0" },
    ],
    drawingType: "box",
    width: 140,
    height: 80,
  },
  RES: {
    mnemonic: "RES",
    name: "Reset",
    category: "counter",
    type: "output",
    description: "Reset - Resets timer or counter",
    parameters: [{ name: "tag", dataType: "TIMER|COUNTER", required: true }],
    drawingType: "coil",
    width: 80,
    height: 40,
  },

  // Compare Instructions
  EQU: {
    mnemonic: "EQU",
    name: "Equal",
    category: "compare",
    type: "input",
    description: "Equal - True when Source A equals Source B",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  NEQ: {
    mnemonic: "NEQ",
    name: "Not Equal",
    category: "compare",
    type: "input",
    description: "Not Equal - True when Source A does not equal Source B",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  GRT: {
    mnemonic: "GRT",
    name: "Greater Than",
    category: "compare",
    type: "input",
    description: "Greater Than - True when Source A > Source B",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  GEQ: {
    mnemonic: "GEQ",
    name: "Greater Than or Equal",
    category: "compare",
    type: "input",
    description: "Greater Than or Equal - True when Source A >= Source B",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  LES: {
    mnemonic: "LES",
    name: "Less Than",
    category: "compare",
    type: "input",
    description: "Less Than - True when Source A < Source B",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  LEQ: {
    mnemonic: "LEQ",
    name: "Less Than or Equal",
    category: "compare",
    type: "input",
    description: "Less Than or Equal - True when Source A <= Source B",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  LIM: {
    mnemonic: "LIM",
    name: "Limit Test",
    category: "compare",
    type: "input",
    description: "Limit Test - True when Test is between Low and High",
    parameters: [
      { name: "low_limit", dataType: "DINT|REAL", required: true },
      { name: "test", dataType: "DINT|REAL", required: true },
      { name: "high_limit", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },

  // Math Instructions
  MOV: {
    mnemonic: "MOV",
    name: "Move",
    category: "move",
    type: "output",
    description: "Move - Copies Source to Destination",
    parameters: [
      { name: "source", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  ADD: {
    mnemonic: "ADD",
    name: "Add",
    category: "math",
    type: "output",
    description: "Add - Adds Source A and Source B, stores in Dest",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },
  SUB: {
    mnemonic: "SUB",
    name: "Subtract",
    category: "math",
    type: "output",
    description: "Subtract - Subtracts Source B from Source A, stores in Dest",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },
  MUL: {
    mnemonic: "MUL",
    name: "Multiply",
    category: "math",
    type: "output",
    description: "Multiply - Multiplies Source A and Source B, stores in Dest",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },
  DIV: {
    mnemonic: "DIV",
    name: "Divide",
    category: "math",
    type: "output",
    description: "Divide - Divides Source A by Source B, stores in Dest",
    parameters: [
      { name: "source_a", dataType: "DINT|REAL", required: true },
      { name: "source_b", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },
  NEG: {
    mnemonic: "NEG",
    name: "Negate",
    category: "math",
    type: "output",
    description: "Negate - Changes sign of Source, stores in Dest",
    parameters: [
      { name: "source", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "DINT|REAL", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 70,
  },
  CLR: {
    mnemonic: "CLR",
    name: "Clear",
    category: "math",
    type: "output",
    description: "Clear - Sets Destination to zero",
    parameters: [{ name: "dest", dataType: "DINT|REAL", required: true }],
    drawingType: "box",
    width: 120,
    height: 50,
  },
  CPT: {
    mnemonic: "CPT",
    name: "Compute",
    category: "math",
    type: "output",
    description: "Compute - Evaluates expression, stores in Dest",
    parameters: [
      { name: "dest", dataType: "DINT|REAL", required: true },
      { name: "expression", dataType: "STRING", required: true },
    ],
    drawingType: "box",
    width: 140,
    height: 70,
  },

  // Program Control Instructions
  JSR: {
    mnemonic: "JSR",
    name: "Jump to Subroutine",
    category: "program",
    type: "output",
    description: "Jump to Subroutine - Calls another routine",
    parameters: [{ name: "routine_name", dataType: "STRING", required: true }],
    drawingType: "box",
    width: 120,
    height: 50,
  },
  RET: {
    mnemonic: "RET",
    name: "Return",
    category: "program",
    type: "output",
    description: "Return - Returns from subroutine",
    parameters: [],
    drawingType: "box",
    width: 80,
    height: 40,
  },
  JMP: {
    mnemonic: "JMP",
    name: "Jump",
    category: "program",
    type: "output",
    description: "Jump - Jumps to Label",
    parameters: [{ name: "label", dataType: "STRING", required: true }],
    drawingType: "box",
    width: 100,
    height: 50,
  },
  LBL: {
    mnemonic: "LBL",
    name: "Label",
    category: "program",
    type: "input",
    description: "Label - Target for Jump instruction",
    parameters: [{ name: "label", dataType: "STRING", required: true }],
    drawingType: "box",
    width: 100,
    height: 50,
  },
  AFI: {
    mnemonic: "AFI",
    name: "Always False",
    category: "bit",
    type: "input",
    description: "Always False Instruction - Always evaluates false",
    parameters: [],
    drawingType: "contact",
    width: 80,
    height: 40,
  },
  NOP: {
    mnemonic: "NOP",
    name: "No Operation",
    category: "program",
    type: "output",
    description: "No Operation - Does nothing",
    parameters: [],
    drawingType: "box",
    width: 80,
    height: 40,
  },

  // File/Array Instructions
  COP: {
    mnemonic: "COP",
    name: "Copy File",
    category: "file",
    type: "output",
    description: "Copy File - Copies array data",
    parameters: [
      { name: "source", dataType: "ARRAY", required: true },
      { name: "dest", dataType: "ARRAY", required: true },
      { name: "length", dataType: "DINT", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },
  FLL: {
    mnemonic: "FLL",
    name: "Fill File",
    category: "file",
    type: "output",
    description: "Fill File - Fills array with value",
    parameters: [
      { name: "source", dataType: "DINT|REAL", required: true },
      { name: "dest", dataType: "ARRAY", required: true },
      { name: "length", dataType: "DINT", required: true },
    ],
    drawingType: "box",
    width: 120,
    height: 90,
  },

  // Communication Instructions
  MSG: {
    mnemonic: "MSG",
    name: "Message",
    category: "communication",
    type: "output",
    description: "Message - Reads/writes data to another device",
    parameters: [{ name: "message_control", dataType: "MESSAGE", required: true }],
    drawingType: "box",
    width: 140,
    height: 60,
  },

  // System Instructions
  GSV: {
    mnemonic: "GSV",
    name: "Get System Value",
    category: "system",
    type: "output",
    description: "Get System Value - Retrieves system information",
    parameters: [
      { name: "class_name", dataType: "STRING", required: true },
      { name: "instance_name", dataType: "STRING", required: true },
      { name: "attribute_name", dataType: "STRING", required: true },
      { name: "dest", dataType: "ANY", required: true },
    ],
    drawingType: "box",
    width: 140,
    height: 100,
  },
  SSV: {
    mnemonic: "SSV",
    name: "Set System Value",
    category: "system",
    type: "output",
    description: "Set System Value - Sets system information",
    parameters: [
      { name: "class_name", dataType: "STRING", required: true },
      { name: "instance_name", dataType: "STRING", required: true },
      { name: "attribute_name", dataType: "STRING", required: true },
      { name: "source", dataType: "ANY", required: true },
    ],
    drawingType: "box",
    width: 140,
    height: 100,
  },
};

// Branch symbols for neutral text format
export const BRANCH_SYMBOLS = {
  BST: { name: "Branch Start", description: "Start of parallel branch" },
  NXB: { name: "Next Branch", description: "Next parallel branch path" },
  BND: { name: "Branch End", description: "End of parallel branch" },
};

// Helper function to get instruction by mnemonic
export function getInstruction(mnemonic: string): InstructionDefinition | undefined {
  return INSTRUCTION_LIBRARY[mnemonic.toUpperCase()];
}

// Helper function to get all instructions by category
export function getInstructionsByCategory(category: InstructionCategory): InstructionDefinition[] {
  return Object.values(INSTRUCTION_LIBRARY).filter(i => i.category === category);
}

// Helper function to get all input instructions
export function getInputInstructions(): InstructionDefinition[] {
  return Object.values(INSTRUCTION_LIBRARY).filter(i => i.type === "input");
}

// Helper function to get all output instructions
export function getOutputInstructions(): InstructionDefinition[] {
  return Object.values(INSTRUCTION_LIBRARY).filter(i => i.type === "output");
}
