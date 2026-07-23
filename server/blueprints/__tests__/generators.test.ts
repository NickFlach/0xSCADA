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
  translateToRockwell,
  importBlueprints,
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

describe('XML escaping — hostile names must not break markup (#509 review)', () => {
  /** A CM whose identifiers carry every XML metacharacter. */
  function hostileCmType(): ParsedCMType {
    return {
      name: 'Valve&<Co>"x\'',
      inputs: [{ name: 'In"/><Injected ', dataType: 'BOOL', comment: 'a]]>b & <c>' }],
      outputs: [{ name: 'Out&Out', dataType: 'BOOL' }],
      inOuts: [],
    };
  }

  it('TIA-XML escapes metacharacters in names and comments', () => {
    const xml = generateTIAXML(cmTypeToFB(hostileCmType()));
    // No raw injection: the attacker element must not appear as live markup.
    expect(xml).not.toContain('<Injected ');
    expect(xml).toContain('&lt;Injected');
    expect(xml).toContain('&amp;');
    // A raw ]]> would prematurely close the code CDATA — it must be split.
    expect(xml).not.toMatch(/[^\]]\]\]>(?!<\/StructuredText>|<!\[CDATA\[)/);
    // Brackets stay balanced despite the '<' and '>' in the names.
    expect((xml.match(/</g) || []).length).toBe((xml.match(/>/g) || []).length);
  });

  it('L5X escapes metacharacters in names and descriptions', () => {
    const l5x = generateL5X(cmTypeToAOI(hostileCmType()));
    // Attribute names are XML-escaped, so no injected element survives.
    expect(l5x).not.toContain('<Injected ');
    expect(l5x).toContain('&lt;Injected');
    expect(l5x).toContain('&amp;');
    // The ]]> in the description must be split so it can't close its CDATA.
    expect(l5x).toContain(']]]]><![CDATA[>');
    // (Bracket-balance is asserted by the non-hostile golden test; it does not
    // hold here because a description legitimately carries literal <…> inside
    // CDATA plus the intentional ]]>-split token.)
  });
});

describe('Rockwell type translation is case-insensitive (#509 review)', () => {
  it('maps uppercase canonical types to Studio 5000 atomics', () => {
    expect(translateToRockwell('WORD')).toBe('INT');
    expect(translateToRockwell('BYTE')).toBe('SINT');
    expect(translateToRockwell('DWORD')).toBe('DINT');
    expect(translateToRockwell('TIME')).toBe('TIMER');
    expect(translateToRockwell('BOOL')).toBe('BOOL');
  });
});

describe('importBlueprints tolerates partial packages (#509 review)', () => {
  it('accepts a cmTypePackage with no designSpec without throwing', () => {
    const result = importBlueprints({ cmTypePackage: [] } as any);
    expect(result.success).toBe(true);
    expect(result.cmTypes).toEqual([]);
  });

  it('accepts a designSpec missing sub-sections without throwing', () => {
    const result = importBlueprints({ designSpec: { unitTypes: [] } } as any);
    expect(result.success).toBe(true);
    expect(result.phaseTypes).toEqual([]);
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
