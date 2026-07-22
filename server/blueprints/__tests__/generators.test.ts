/**
 * Golden-file regression tests for the restored vendor code generators (#479):
 * Siemens SCL + TIA-XML, Rockwell L5X/AOI, and the ladder neutral-text path.
 * These pin the structural output so the generators can't silently regress.
 */
import { describe, it, expect } from 'vitest';
import {
  cmTypeToFB,
  phaseTypeToFB,
  generateSCLSource,
  generateTIAXML,
  cmTypeToAOI,
  generateL5X,
  ladderLogicAgent,
  type ParsedCMType,
  type ParsedPhaseType,
} from '..';

/** A representative ISA-88 control module: a motorized valve. */
function valveCmType(): ParsedCMType {
  return {
    name: 'MotorValve',
    inputs: [
      { name: 'OpenCmd', dataType: 'BOOL', comment: 'Open command' },
      { name: 'CloseCmd', dataType: 'BOOL', comment: 'Close command' },
      { name: 'Setpoint', dataType: 'REAL', comment: 'Position setpoint' },
    ],
    outputs: [
      { name: 'Opened', dataType: 'BOOL', comment: 'Valve opened' },
      { name: 'Position', dataType: 'REAL', comment: 'Actual position' },
    ],
    inOuts: [
      { name: 'Config', dataType: 'INT', comment: 'Config word' },
    ],
  };
}

describe('Siemens SCL generation (#479)', () => {
  it('generates an SCL function block with typed inputs/outputs/in-outs', () => {
    const scl = generateSCLSource(cmTypeToFB(valveCmType()));
    expect(scl).toContain('FUNCTION_BLOCK');
    expect(scl).toContain('MotorValve');
    expect(scl).toContain('VAR_INPUT');
    expect(scl).toContain('VAR_OUTPUT');
    expect(scl).toContain('VAR_IN_OUT');
    // Inputs carry the vendor-translated types (BOOL/REAL map to Bool/Real).
    expect(scl).toMatch(/OpenCmd\s*:\s*Bool/);
    expect(scl).toMatch(/Setpoint\s*:\s*Real/);
    expect(scl).toContain('END_FUNCTION_BLOCK');
  });

  it('is deterministic for the same input', () => {
    const cm = valveCmType();
    expect(generateSCLSource(cmTypeToFB(cm))).toBe(generateSCLSource(cmTypeToFB(cm)));
  });
});

describe('Siemens TIA-XML generation (#479)', () => {
  it('generates well-formed TIA Portal XML with the block name and members', () => {
    const xml = generateTIAXML(cmTypeToFB(valveCmType()));
    expect(xml).toContain('<?xml');
    expect(xml).toContain('MotorValve');
    expect(xml).toContain('OpenCmd');
    expect(xml).toContain('Position');
    // Balanced angle brackets — no truncated tags.
    expect((xml.match(/</g) || []).length).toBe((xml.match(/>/g) || []).length);
  });
});

describe('Rockwell L5X/AOI generation (#479)', () => {
  it('maps a CM type to an AOI with parameters', () => {
    const aoi = cmTypeToAOI(valveCmType());
    expect(aoi.name).toBe('MotorValve');
    const paramNames = aoi.parameters.map(p => p.name);
    expect(paramNames).toContain('OpenCmd');
    expect(paramNames).toContain('Position');
  });

  it('generates L5X XML containing the AOI definition and parameters', () => {
    const l5x = generateL5X(cmTypeToAOI(valveCmType()));
    expect(l5x).toContain('<?xml');
    expect(l5x).toMatch(/AddOnInstructionDefinition/);
    expect(l5x).toContain('MotorValve');
    expect(l5x).toContain('OpenCmd');
    expect((l5x.match(/</g) || []).length).toBe((l5x.match(/>/g) || []).length);
  });
});

describe('Ladder neutral-text generation (#479)', () => {
  it('generates ladder logic with rungs and non-empty neutral text', () => {
    const ctx = ladderLogicAgent.buildContextFromCMType(valveCmType(), {
      includeComments: true, generateFaultHandling: true, generateInterlocks: true,
    });
    const result = ladderLogicAgent.generateControlModuleLogic(ctx);
    expect(result.success).toBe(true);
    expect(result.neutralText.length).toBeGreaterThan(0);
    expect(result.metadata.rungCount).toBeGreaterThan(0);
    expect(result.routines.length).toBeGreaterThan(0);
  });
});

describe('Siemens SCL from a phase type (#479)', () => {
  it('generates SCL for an ISA-88 phase', () => {
    const phase: ParsedPhaseType = {
      name: 'DoseAcid',
      linkedModules: [],
      inputs: [{ name: 'Start', dataType: 'BOOL' }],
      outputs: [{ name: 'Done', dataType: 'BOOL' }],
      inOuts: [],
      internalValues: [],
      hmiParameters: [],
      recipeParameters: [{ name: 'Amount', dataType: 'REAL' }],
      reportParameters: [],
      sequences: {},
    };
    const scl = generateSCLSource(phaseTypeToFB(phase));
    expect(scl).toContain('FUNCTION_BLOCK');
    expect(scl).toContain('DoseAcid');
    expect(scl).toContain('END_FUNCTION_BLOCK');
  });
});
