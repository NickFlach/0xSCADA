/**
 * ASCII Ladder Diagram Renderer
 * Generates visual ASCII art representations of ladder logic
 * 
 * This module renders ladder logic rungs in a visual format that
 * resembles traditional ladder logic diagrams with power rails.
 */

import type {
  LadderInstruction,
  LadderBranch,
  LadderElement,
  LadderRung,
  LadderRoutine,
  InstructionDefinition,
} from "./ladder-logic-types";
import { getInstruction } from "./ladder-logic-types";

interface RenderOptions {
  wireLength?: number;
  minTagWidth?: number;
  showRungNumbers?: boolean;
  showComments?: boolean;
}

const DEFAULT_OPTIONS: RenderOptions = {
  wireLength: 4,
  minTagWidth: 8,
  showRungNumbers: true,
  showComments: true,
};

type RenderResult = string | string[];

/**
 * Ladder Diagram Renderer
 * Generates ASCII art representations of ladder logic
 */
export class LadderDiagramRenderer {
  private options: RenderOptions;

  constructor(options: RenderOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Render a single ladder element (instruction or branch)
   */
  renderElement(element: LadderElement): RenderResult {
    if ("type" in element && element.type === "branch") {
      return this.renderBranch(element as LadderBranch);
    }
    return this.renderInstruction(element as LadderInstruction);
  }

  /**
   * Render a single instruction
   */
  private renderInstruction(instruction: LadderInstruction): RenderResult {
    const def = getInstruction(instruction.mnemonic);
    
    if (!def) {
      return this.renderBoxInstruction(instruction);
    }

    switch (def.drawingType) {
      case "contact":
        return this.renderContact(instruction, def);
      case "coil":
        return this.renderCoil(instruction, def);
      case "box":
        return this.renderBoxInstruction(instruction);
      default:
        return this.renderBoxInstruction(instruction);
    }
  }

  /**
   * Render a contact (input) - [ Tag ] or [/Tag ]
   */
  private renderContact(instruction: LadderInstruction, _def: InstructionDefinition): string {
    const tagName = instruction.parameters[0] || instruction.mnemonic;
    const paddedTag = this.padTag(tagName);
    
    if (instruction.mnemonic === "XIO") {
      return `[/${paddedTag}]`;
    }
    return `[ ${paddedTag} ]`;
  }

  /**
   * Render a coil (output) - ( Tag )
   */
  private renderCoil(instruction: LadderInstruction, _def: InstructionDefinition): string {
    const tagName = instruction.parameters[0] || instruction.mnemonic;
    const paddedTag = this.padTag(tagName);
    
    if (instruction.mnemonic === "OTL") {
      return `(L${paddedTag} )`;
    }
    if (instruction.mnemonic === "OTU") {
      return `(U${paddedTag} )`;
    }
    return `( ${paddedTag} )`;
  }

  /**
   * Render a box instruction (timers, counters, compare, math)
   */
  private renderBoxInstruction(instruction: LadderInstruction): string[] {
    const def = getInstruction(instruction.mnemonic);
    const mnemonic = instruction.mnemonic.toUpperCase();
    const params = instruction.parameters;
    
    const boxWidth = Math.max(14, mnemonic.length + 6, ...params.map(p => p.length + 6));
    const topBottom = "+" + "-".repeat(boxWidth) + "+";
    
    const lines: string[] = [topBottom];
    lines.push("|" + this.centerText(mnemonic, boxWidth) + "|");
    
    if (params.length > 0) {
      lines.push("|" + this.centerText(params[0], boxWidth) + "|");
    }
    
    if (def?.category === "timer" || def?.category === "counter") {
      if (params.length >= 2) {
        lines.push("|" + this.centerText(`PRE: ${params[1]}`, boxWidth) + "|");
      }
    } else {
      for (let i = 1; i < params.length; i++) {
        lines.push("|" + this.centerText(params[i], boxWidth) + "|");
      }
    }
    
    lines.push(topBottom);
    return lines;
  }

  /**
   * Render a branch (OR logic with parallel paths)
   * Properly handles multi-line elements (timers, nested branches) by preserving all rows
   */
  private renderBranch(branch: LadderBranch): string[] {
    const wire = this.wire();
    
    // Render each path, preserving multi-line structure
    const pathRenderings: string[][] = [];
    
    for (const path of branch.paths) {
      // Render all elements in this path
      const elementRenders: RenderResult[] = path.map(elem => this.renderElement(elem));
      
      // Find max height for this path
      let pathHeight = 1;
      for (const render of elementRenders) {
        if (Array.isArray(render)) {
          pathHeight = Math.max(pathHeight, render.length);
        }
      }
      
      // Normalize all elements to same height and collect their widths
      const normalizedElements: string[][] = [];
      for (const render of elementRenders) {
        if (Array.isArray(render)) {
          const width = Math.max(...render.map(r => r.length));
          const normalized = render.map(r => r.padEnd(width));
          while (normalized.length < pathHeight) {
            normalized.push(" ".repeat(width));
          }
          normalizedElements.push(normalized);
        } else {
          const width = render.length;
          const normalized = [render];
          while (normalized.length < pathHeight) {
            normalized.push(" ".repeat(width));
          }
          normalizedElements.push(normalized);
        }
      }
      
      // Join elements horizontally for each row
      const pathLines: string[] = [];
      for (let row = 0; row < pathHeight; row++) {
        const rowParts = normalizedElements.map(elem => elem[row]);
        if (row === 0) {
          pathLines.push(rowParts.join(wire));
        } else {
          pathLines.push(rowParts.join(" ".repeat(wire.length)));
        }
      }
      
      pathRenderings.push(pathLines);
    }
    
    // Find max width across all paths for alignment
    let maxWidth = 0;
    for (const pathLines of pathRenderings) {
      for (const line of pathLines) {
        maxWidth = Math.max(maxWidth, line.length);
      }
    }
    
    // Pad all path lines to same width
    for (const pathLines of pathRenderings) {
      for (let i = 0; i < pathLines.length; i++) {
        pathLines[i] = pathLines[i].padEnd(maxWidth);
      }
    }
    
    // Build final branch output
    const result: string[] = [];
    const connector = "+";
    const vertical = "|";
    
    // First path
    for (let row = 0; row < pathRenderings[0].length; row++) {
      if (row === 0) {
        result.push(`${connector}${wire}${pathRenderings[0][row]}${wire}${connector}`);
      } else {
        result.push(`${vertical}${" ".repeat(wire.length)}${pathRenderings[0][row]}${" ".repeat(wire.length)}${vertical}`);
      }
    }
    
    // Additional paths with vertical separator
    for (let pathIdx = 1; pathIdx < pathRenderings.length; pathIdx++) {
      // Add vertical connector line
      result.push(`${vertical}${" ".repeat(wire.length)}${" ".repeat(maxWidth)}${" ".repeat(wire.length)}${vertical}`);
      
      // Add path content
      for (let row = 0; row < pathRenderings[pathIdx].length; row++) {
        if (row === 0) {
          result.push(`${connector}${wire}${pathRenderings[pathIdx][row]}${wire}${connector}`);
        } else {
          result.push(`${vertical}${" ".repeat(wire.length)}${pathRenderings[pathIdx][row]}${" ".repeat(wire.length)}${vertical}`);
        }
      }
    }
    
    return result;
  }

  /**
   * Render a single rung as ASCII art
   */
  renderRung(rung: LadderRung): string {
    const lines: string[] = [];
    
    if (this.options.showRungNumbers) {
      lines.push(`Rung ${rung.number}:`);
    }
    
    if (this.options.showComments && rung.comment) {
      const commentLines = rung.comment.split("\n");
      for (const line of commentLines) {
        lines.push(`// ${line}`);
      }
    }

    const mainLine = this.buildMainLine(rung.elements);
    
    if (Array.isArray(mainLine)) {
      for (const line of mainLine) {
        lines.push(line);
      }
    } else {
      lines.push(mainLine);
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Build the main horizontal line of a rung
   */
  private buildMainLine(elements: LadderElement[]): RenderResult {
    const renderedParts: RenderResult[] = [];
    let hasMultiLine = false;

    for (const element of elements) {
      const rendered = this.renderElement(element);
      if (Array.isArray(rendered)) {
        hasMultiLine = true;
      }
      renderedParts.push(rendered);
    }

    if (hasMultiLine) {
      return this.buildMultiLineRung(renderedParts);
    }

    const wire = this.wire();
    const content = (renderedParts as string[]).join(wire);
    return `|${wire}${content}${wire}|`;
  }

  /**
   * Build a multi-line rung (for branches and box instructions)
   * Ensures power rails are aligned on all rows
   */
  private buildMultiLineRung(parts: RenderResult[]): string[] {
    const wire = this.wire();
    const allLines: string[][] = [];
    let maxHeight = 1;

    for (const part of parts) {
      if (Array.isArray(part)) {
        allLines.push(part);
        maxHeight = Math.max(maxHeight, part.length);
      } else {
        allLines.push([part]);
      }
    }

    // Calculate max width for each column for proper alignment
    const columnWidths: number[] = allLines.map(lines => 
      Math.max(...lines.map(l => l.length))
    );

    // Pad all lines to consistent width within each column
    for (let col = 0; col < allLines.length; col++) {
      const width = columnWidths[col];
      while (allLines[col].length < maxHeight) {
        allLines[col].push(" ".repeat(width));
      }
      // Ensure all lines in column have same width
      allLines[col] = allLines[col].map(line => line.padEnd(width));
    }

    const result: string[] = [];
    for (let row = 0; row < maxHeight; row++) {
      let line = "";
      
      // Left power rail - always present
      if (row === 0) {
        line = `|${wire}`;
      } else {
        line = `|${" ".repeat(wire.length)}`;
      }
      
      // Add each column
      for (let col = 0; col < allLines.length; col++) {
        line += allLines[col][row];
        
        // Add wire between columns (only on first row for visual flow)
        if (col < allLines.length - 1) {
          if (row === 0) {
            line += wire;
          } else {
            line += " ".repeat(wire.length);
          }
        }
      }
      
      // Right power rail - always present for alignment
      if (row === 0) {
        line += `${wire}|`;
      } else {
        line += `${" ".repeat(wire.length)}|`;
      }
      
      result.push(line);
    }

    return result;
  }

  /**
   * Render an entire routine
   */
  renderRoutine(routine: LadderRoutine): string {
    const lines: string[] = [];
    
    lines.push("=".repeat(60));
    lines.push(`Routine: ${routine.name}`);
    lines.push(`Type: ${routine.type}`);
    lines.push("=".repeat(60));
    lines.push("");

    for (const rung of routine.rungs) {
      lines.push(this.renderRung(rung));
    }

    return lines.join("\n");
  }

  /**
   * Generate wire/connection string
   */
  private wire(): string {
    return "-".repeat(this.options.wireLength!);
  }

  /**
   * Pad a tag name to minimum width
   */
  private padTag(tagName: string): string {
    const minWidth = this.options.minTagWidth!;
    if (tagName.length >= minWidth) {
      return tagName;
    }
    return tagName.padEnd(minWidth);
  }

  /**
   * Center text within a given width
   */
  private centerText(text: string, width: number): string {
    if (text.length >= width) {
      return text.substring(0, width);
    }
    const leftPad = Math.floor((width - text.length) / 2);
    const rightPad = width - text.length - leftPad;
    return " ".repeat(leftPad) + text + " ".repeat(rightPad);
  }
}

/**
 * Render a single rung as an ASCII ladder diagram
 */
export function rungToLadderDiagram(rung: LadderRung, options?: RenderOptions): string {
  const renderer = new LadderDiagramRenderer(options);
  return renderer.renderRung(rung);
}

/**
 * Render an entire routine as an ASCII ladder diagram
 */
export function routineToLadderDiagram(routine: LadderRoutine, options?: RenderOptions): string {
  const renderer = new LadderDiagramRenderer(options);
  return renderer.renderRoutine(routine);
}

/**
 * Render a single element as ASCII
 */
export function elementToLadderDiagram(element: LadderElement, options?: RenderOptions): string {
  const renderer = new LadderDiagramRenderer(options);
  const result = renderer.renderElement(element);
  return Array.isArray(result) ? result.join("\n") : result;
}
