/**
 * Neutral Text Generator
 * Generates Studio 5000 ladder logic in neutral text format
 * 
 * This module enables programmatic generation of ladder logic rungs
 * that can be imported into Rockwell Studio 5000 or used with LadderLogix.
 */

import type {
  LadderInstruction,
  LadderBranch,
  LadderElement,
  LadderRung,
  LadderRoutine,
  LadderTag,
  InstructionDefinition,
} from "./ladder-logic-types";
import { INSTRUCTION_LIBRARY, getInstruction } from "./ladder-logic-types";

export interface NeutralTextOptions {
  includeComments?: boolean;
  includeRungNumbers?: boolean;
  bracketStyle?: "bracket" | "bst"; // [A,B] vs BST A NXB B BND
}

const DEFAULT_OPTIONS: NeutralTextOptions = {
  includeComments: true,
  includeRungNumbers: false,
  bracketStyle: "bracket",
};

/**
 * Generate neutral text for a single instruction
 */
export function instructionToNeutralText(instruction: LadderInstruction): string {
  const { mnemonic, parameters } = instruction;
  
  if (parameters.length === 0) {
    return `${mnemonic.toUpperCase()}()`;
  }
  
  return `${mnemonic.toUpperCase()}(${parameters.join(",")})`;
}

/**
 * Generate neutral text for a branch structure
 */
export function branchToNeutralText(
  branch: LadderBranch,
  options: NeutralTextOptions = DEFAULT_OPTIONS
): string {
  if (options.bracketStyle === "bst") {
    // BST...NXB...BND format
    const pathTexts = branch.paths.map(path => 
      path.map(elem => elementToNeutralText(elem, options)).join("")
    );
    return `BST ${pathTexts.join(" NXB ")} BND`;
  }
  
  // Bracket format [path1,path2]
  const pathTexts = branch.paths.map(path => 
    path.map(elem => elementToNeutralText(elem, options)).join("")
  );
  return `[${pathTexts.join(",")}]`;
}

/**
 * Generate neutral text for any ladder element
 */
export function elementToNeutralText(
  element: LadderElement,
  options: NeutralTextOptions = DEFAULT_OPTIONS
): string {
  if ("type" in element && element.type === "branch") {
    return branchToNeutralText(element as LadderBranch, options);
  }
  return instructionToNeutralText(element as LadderInstruction);
}

/**
 * Generate neutral text for a complete rung
 */
export function rungToNeutralText(
  rung: LadderRung,
  options: NeutralTextOptions = DEFAULT_OPTIONS
): string {
  const elementsText = rung.elements
    .map(elem => elementToNeutralText(elem, options))
    .join("");
  
  let result = `${elementsText};`;
  
  if (options.includeComments && rung.comment) {
    // Multi-line comments are supported
    const commentLines = rung.comment.split("\n");
    result += "\n" + commentLines.map(line => `// ${line}`).join("\n");
  }
  
  if (options.includeRungNumbers) {
    result = `// Rung ${rung.number}\n${result}`;
  }
  
  return result;
}

/**
 * Generate neutral text for an entire routine
 */
export function routineToNeutralText(
  routine: LadderRoutine,
  options: NeutralTextOptions = DEFAULT_OPTIONS
): string {
  const lines: string[] = [];
  
  lines.push(`// Routine: ${routine.name}`);
  lines.push(`// Type: ${routine.type}`);
  lines.push("");
  
  for (const rung of routine.rungs) {
    lines.push(rungToNeutralText(rung, options));
    lines.push("");
  }
  
  return lines.join("\n");
}

/**
 * Parse neutral text into a LadderRung structure
 * Simplified parser for basic neutral text format
 */
export function parseNeutralText(text: string, rungNumber: number = 0): LadderRung {
  const rung: LadderRung = {
    number: rungNumber,
    elements: [],
  };
  
  // Extract comment if present
  const commentMatch = text.match(/\/\/\s*(.*)$/m);
  if (commentMatch) {
    rung.comment = commentMatch[1];
    text = text.replace(/\/\/.*$/gm, "");
  }
  
  // Remove trailing semicolon
  text = text.replace(/;$/, "").trim();
  
  // Parse elements
  rung.elements = parseElements(text);
  
  return rung;
}

/**
 * Parse a sequence of elements from neutral text
 */
function parseElements(text: string): LadderElement[] {
  const elements: LadderElement[] = [];
  let remaining = text.trim();
  
  while (remaining.length > 0) {
    remaining = remaining.trim();
    
    // Check for bracket-style branch [...]
    if (remaining.startsWith("[")) {
      const { branch, rest } = parseBracketBranch(remaining);
      if (branch) {
        elements.push(branch);
        remaining = rest;
        continue;
      }
    }
    
    // Check for BST-style branch
    if (remaining.toUpperCase().startsWith("BST")) {
      const { branch, rest } = parseBSTBranch(remaining);
      if (branch) {
        elements.push(branch);
        remaining = rest;
        continue;
      }
    }
    
    // Parse instruction
    const { instruction, rest } = parseInstruction(remaining);
    if (instruction) {
      elements.push(instruction);
      remaining = rest;
      continue;
    }
    
    // Skip unknown character
    remaining = remaining.slice(1);
  }
  
  return elements;
}

/**
 * Parse a single instruction from text
 */
function parseInstruction(text: string): { instruction: LadderInstruction | null; rest: string } {
  const match = text.match(/^([A-Z_][A-Z0-9_]*)\s*\(([^)]*)\)/i);
  if (match) {
    const mnemonic = match[1].toUpperCase();
    const paramsStr = match[2];
    const parameters = paramsStr
      .split(",")
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    return {
      instruction: { mnemonic, parameters },
      rest: text.slice(match[0].length),
    };
  }
  
  // Handle instructions without parentheses (like NOP, AFI)
  const wordMatch = text.match(/^([A-Z_][A-Z0-9_]*)/i);
  if (wordMatch) {
    const mnemonic = wordMatch[1].toUpperCase();
    if (INSTRUCTION_LIBRARY[mnemonic]) {
      return {
        instruction: { mnemonic, parameters: [] },
        rest: text.slice(wordMatch[0].length),
      };
    }
  }
  
  return { instruction: null, rest: text };
}

/**
 * Parse bracket-style branch [path1,path2]
 */
function parseBracketBranch(text: string): { branch: LadderBranch | null; rest: string } {
  if (!text.startsWith("[")) {
    return { branch: null, rest: text };
  }
  
  // Find matching closing bracket
  let depth = 0;
  let endIdx = -1;
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "[") depth++;
    else if (text[i] === "]") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  
  if (endIdx === -1) {
    return { branch: null, rest: text };
  }
  
  const content = text.slice(1, endIdx);
  const paths = splitBranchPaths(content);
  
  const branch: LadderBranch = {
    type: "branch",
    paths: paths.map(path => parseElements(path)),
  };
  
  return {
    branch,
    rest: text.slice(endIdx + 1),
  };
}

/**
 * Parse BST-style branch BST...NXB...BND
 */
function parseBSTBranch(text: string): { branch: LadderBranch | null; rest: string } {
  if (!text.toUpperCase().startsWith("BST")) {
    return { branch: null, rest: text };
  }
  
  // Find matching BND
  let depth = 0;
  let endIdx = -1;
  let i = 0;
  
  while (i < text.length) {
    const upper = text.slice(i).toUpperCase();
    if (upper.startsWith("BST")) {
      depth++;
      i += 3;
    } else if (upper.startsWith("BND")) {
      depth--;
      if (depth === 0) {
        endIdx = i + 3;
        break;
      }
      i += 3;
    } else {
      i++;
    }
  }
  
  if (endIdx === -1) {
    return { branch: null, rest: text };
  }
  
  // Extract content between BST and BND
  let content = text.slice(3, endIdx - 3).trim();
  
  // Split by NXB at depth 0
  const paths: string[] = [];
  let currentPath = "";
  depth = 0;
  i = 0;
  
  while (i < content.length) {
    const upper = content.slice(i).toUpperCase();
    if (upper.startsWith("BST")) {
      depth++;
      currentPath += content.slice(i, i + 3);
      i += 3;
    } else if (upper.startsWith("BND")) {
      depth--;
      currentPath += content.slice(i, i + 3);
      i += 3;
    } else if (upper.startsWith("NXB") && depth === 0) {
      paths.push(currentPath.trim());
      currentPath = "";
      i += 3;
    } else {
      currentPath += content[i];
      i++;
    }
  }
  
  if (currentPath.trim()) {
    paths.push(currentPath.trim());
  }
  
  const branch: LadderBranch = {
    type: "branch",
    paths: paths.map(path => parseElements(path)),
  };
  
  return {
    branch,
    rest: text.slice(endIdx),
  };
}

/**
 * Split branch content by comma at top level
 */
function splitBranchPaths(content: string): string[] {
  const paths: string[] = [];
  let currentPath = "";
  let depth = 0;
  
  for (const char of content) {
    if (char === "[" || char === "(") {
      depth++;
      currentPath += char;
    } else if (char === "]" || char === ")") {
      depth--;
      currentPath += char;
    } else if (char === "," && depth === 0) {
      paths.push(currentPath.trim());
      currentPath = "";
    } else {
      currentPath += char;
    }
  }
  
  paths.push(currentPath.trim());
  return paths;
}

/**
 * Validate a rung structure
 */
export function validateRung(rung: LadderRung): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (rung.elements.length === 0) {
    errors.push("Rung has no elements");
    return { valid: false, errors };
  }
  
  // Check that rung ends with an output instruction
  const lastElement = rung.elements[rung.elements.length - 1];
  if (!("type" in lastElement)) {
    const instruction = lastElement as LadderInstruction;
    const def = getInstruction(instruction.mnemonic);
    if (def && def.type !== "output") {
      errors.push(`Rung should end with an output instruction, found ${instruction.mnemonic}`);
    }
  }
  
  // Validate each instruction
  for (const element of rung.elements) {
    validateElement(element, errors);
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Validate a ladder element
 */
function validateElement(element: LadderElement, errors: string[]): void {
  if ("type" in element && element.type === "branch") {
    const branch = element as LadderBranch;
    if (branch.paths.length < 2) {
      errors.push("Branch must have at least 2 paths");
    }
    for (const path of branch.paths) {
      for (const elem of path) {
        validateElement(elem, errors);
      }
    }
  } else {
    const instruction = element as LadderInstruction;
    const def = getInstruction(instruction.mnemonic);
    if (!def) {
      errors.push(`Unknown instruction: ${instruction.mnemonic}`);
    } else {
      // Check required parameters
      const requiredParams = def.parameters.filter(p => p.required !== false);
      if (instruction.parameters.length < requiredParams.length) {
        errors.push(
          `${instruction.mnemonic} requires ${requiredParams.length} parameters, got ${instruction.parameters.length}`
        );
      }
    }
  }
}

/**
 * Builder class for constructing rungs programmatically
 */
export class RungBuilder {
  private elements: LadderElement[] = [];
  private comment?: string;
  private rungNumber: number = 0;

  constructor(rungNumber: number = 0) {
    this.rungNumber = rungNumber;
  }

  /**
   * Add an instruction to the rung
   */
  instruction(mnemonic: string, ...parameters: string[]): RungBuilder {
    this.elements.push({ mnemonic: mnemonic.toUpperCase(), parameters });
    return this;
  }

  /**
   * Add a normally open contact (XIC)
   */
  xic(tag: string): RungBuilder {
    return this.instruction("XIC", tag);
  }

  /**
   * Add a normally closed contact (XIO)
   */
  xio(tag: string): RungBuilder {
    return this.instruction("XIO", tag);
  }

  /**
   * Add an output energize (OTE)
   */
  ote(tag: string): RungBuilder {
    return this.instruction("OTE", tag);
  }

  /**
   * Add an output latch (OTL)
   */
  otl(tag: string): RungBuilder {
    return this.instruction("OTL", tag);
  }

  /**
   * Add an output unlatch (OTU)
   */
  otu(tag: string): RungBuilder {
    return this.instruction("OTU", tag);
  }

  /**
   * Add a timer on delay (TON)
   */
  ton(timer: string, preset: string, accum: string = "0"): RungBuilder {
    return this.instruction("TON", timer, preset, accum);
  }

  /**
   * Add a count up (CTU)
   */
  ctu(counter: string, preset: string, accum: string = "0"): RungBuilder {
    return this.instruction("CTU", counter, preset, accum);
  }

  /**
   * Add a move instruction (MOV)
   */
  mov(source: string, dest: string): RungBuilder {
    return this.instruction("MOV", source, dest);
  }

  /**
   * Add a compare equal (EQU)
   */
  equ(sourceA: string, sourceB: string): RungBuilder {
    return this.instruction("EQU", sourceA, sourceB);
  }

  /**
   * Add a compare greater than (GRT)
   */
  grt(sourceA: string, sourceB: string): RungBuilder {
    return this.instruction("GRT", sourceA, sourceB);
  }

  /**
   * Add a compare less than (LES)
   */
  les(sourceA: string, sourceB: string): RungBuilder {
    return this.instruction("LES", sourceA, sourceB);
  }

  /**
   * Add a jump to subroutine (JSR)
   */
  jsr(routineName: string): RungBuilder {
    return this.instruction("JSR", routineName);
  }

  /**
   * Add a parallel branch
   */
  branch(...paths: ((builder: RungBuilder) => void)[]): RungBuilder {
    const branchPaths: LadderElement[][] = [];
    
    for (const pathFn of paths) {
      const pathBuilder = new RungBuilder();
      pathFn(pathBuilder);
      branchPaths.push(pathBuilder.elements);
    }
    
    this.elements.push({ type: "branch", paths: branchPaths });
    return this;
  }

  /**
   * Set the rung comment
   */
  withComment(comment: string): RungBuilder {
    this.comment = comment;
    return this;
  }

  /**
   * Build the rung
   */
  build(): LadderRung {
    return {
      number: this.rungNumber,
      comment: this.comment,
      elements: this.elements,
    };
  }

  /**
   * Build and convert to neutral text
   */
  toNeutralText(options?: NeutralTextOptions): string {
    return rungToNeutralText(this.build(), options);
  }
}

/**
 * Create a new rung builder
 */
export function rung(number: number = 0): RungBuilder {
  return new RungBuilder(number);
}
