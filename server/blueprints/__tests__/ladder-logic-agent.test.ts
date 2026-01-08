/**
 * Ladder Logic Agent Tests
 * Tests for the LadderLogix-style code generation in 0xSCADA
 */

import { describe, it, expect } from "vitest";
import {
  INSTRUCTION_LIBRARY,
  getInstruction,
  getInstructionsByCategory,
  getInputInstructions,
  getOutputInstructions,
} from "../ladder-logic-types";
import {
  rung,
  RungBuilder,
  rungToNeutralText,
  parseNeutralText,
  validateRung,
  instructionToNeutralText,
  branchToNeutralText,
} from "../neutral-text-generator";
import {
  LadderLogicAgent,
  ladderLogicAgent,
} from "../ladder-logic-agent";
import {
  BatchRungGenerator,
  batchRungGenerator,
} from "../batch-rung-generator";
import type { ParsedCMType, ParsedPhaseType } from "../types";

describe("Ladder Logic Types", () => {
  it("should have all core instructions defined", () => {
    const coreInstructions = ["XIC", "XIO", "OTE", "OTL", "OTU", "TON", "TOF", "CTU", "CTD", "MOV", "ADD", "EQU"];
    
    for (const mnemonic of coreInstructions) {
      const instruction = getInstruction(mnemonic);
      expect(instruction).toBeDefined();
      expect(instruction?.mnemonic).toBe(mnemonic);
    }
  });

  it("should categorize instructions correctly", () => {
    const bitInstructions = getInstructionsByCategory("bit");
    expect(bitInstructions.length).toBeGreaterThan(0);
    expect(bitInstructions.every(i => i.category === "bit")).toBe(true);

    const timerInstructions = getInstructionsByCategory("timer");
    expect(timerInstructions.length).toBeGreaterThan(0);
    expect(timerInstructions.some(i => i.mnemonic === "TON")).toBe(true);
  });

  it("should separate input and output instructions", () => {
    const inputs = getInputInstructions();
    const outputs = getOutputInstructions();

    expect(inputs.every(i => i.type === "input")).toBe(true);
    expect(outputs.every(i => i.type === "output")).toBe(true);

    // XIC should be input, OTE should be output
    expect(inputs.some(i => i.mnemonic === "XIC")).toBe(true);
    expect(outputs.some(i => i.mnemonic === "OTE")).toBe(true);
  });
});

describe("Neutral Text Generator", () => {
  describe("RungBuilder", () => {
    it("should build a simple rung", () => {
      const testRung = rung(0)
        .xic("Start")
        .xio("Stop")
        .ote("Motor")
        .build();

      expect(testRung.number).toBe(0);
      expect(testRung.elements.length).toBe(3);
    });

    it("should generate correct neutral text", () => {
      const neutralText = rung(0)
        .xic("Start")
        .ote("Output")
        .toNeutralText();

      expect(neutralText).toContain("XIC(Start)");
      expect(neutralText).toContain("OTE(Output)");
      expect(neutralText).toContain(";");
    });

    it("should support timer instructions", () => {
      const neutralText = rung(0)
        .xic("Enable")
        .ton("Timer1", "1000", "0")
        .toNeutralText();

      expect(neutralText).toContain("TON(Timer1,1000,0)");
    });

    it("should support branches", () => {
      const testRung = rung(0)
        .branch(
          b => b.xic("Button1"),
          b => b.xic("Button2")
        )
        .ote("Lamp")
        .build();

      expect(testRung.elements.length).toBe(2);
      const neutralText = rungToNeutralText(testRung);
      expect(neutralText).toContain("[");
      expect(neutralText).toContain(",");
      expect(neutralText).toContain("]");
    });

    it("should support comments", () => {
      const neutralText = rung(0)
        .xic("Start")
        .ote("Motor")
        .withComment("Motor start logic")
        .toNeutralText();

      expect(neutralText).toContain("// Motor start logic");
    });
  });

  describe("parseNeutralText", () => {
    it("should parse simple rungs", () => {
      const parsed = parseNeutralText("XIC(Start)OTE(Motor);", 0);

      expect(parsed.elements.length).toBe(2);
      expect((parsed.elements[0] as any).mnemonic).toBe("XIC");
      expect((parsed.elements[1] as any).mnemonic).toBe("OTE");
    });

    it("should parse rungs with branches", () => {
      const parsed = parseNeutralText("[XIC(A),XIC(B)]OTE(Y);", 0);

      expect(parsed.elements.length).toBe(2);
      expect((parsed.elements[0] as any).type).toBe("branch");
    });

    it("should parse comments", () => {
      const parsed = parseNeutralText("XIC(Start)OTE(Motor); // Start motor", 0);

      expect(parsed.comment).toContain("Start motor");
    });
  });

  describe("validateRung", () => {
    it("should validate correct rungs", () => {
      const testRung = rung(0)
        .xic("Start")
        .ote("Motor")
        .build();

      const result = validateRung(testRung);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("should detect unknown instructions", () => {
      const testRung = {
        number: 0,
        elements: [{ mnemonic: "UNKNOWN", parameters: ["Tag"] }],
      };

      const result = validateRung(testRung);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("Unknown instruction"))).toBe(true);
    });
  });
});

describe("LadderLogicAgent", () => {
  const sampleCMType: ParsedCMType = {
    name: "TestValve",
    inputs: [
      { name: "Cmd_Open", dataType: "Bool", primary: true, comment: "Open command" },
      { name: "Cmd_Close", dataType: "Bool", comment: "Close command" },
      { name: "FB_Open", dataType: "Bool", comment: "Open feedback" },
      { name: "FB_Close", dataType: "Bool", comment: "Close feedback" },
      { name: "Fault_Overtravel", dataType: "Bool", isError: true, comment: "Overtravel fault" },
    ],
    outputs: [
      { name: "Out_Open", dataType: "Bool", primary: true, comment: "Open output" },
      { name: "Out_Close", dataType: "Bool", comment: "Close output" },
      { name: "Sts_Open", dataType: "Bool", comment: "Open status" },
      { name: "Sts_Fault", dataType: "Bool", comment: "Fault status" },
    ],
    inOuts: [],
  };

  it("should build context from CM type", () => {
    const context = ladderLogicAgent.buildContextFromCMType(sampleCMType);

    expect(context.sourceType).toBe("control_module");
    expect(context.sourceName).toBe("TestValve");
    expect(context.inputs.length).toBe(5);
    expect(context.outputs.length).toBe(4);
  });

  it("should generate control module logic", () => {
    const context = ladderLogicAgent.buildContextFromCMType(sampleCMType);
    const result = ladderLogicAgent.generateControlModuleLogic(context);

    expect(result.success).toBe(true);
    expect(result.routines.length).toBeGreaterThan(0);
    expect(result.neutralText.length).toBeGreaterThan(0);
    expect(result.metadata.rungCount).toBeGreaterThan(0);
  });

  it("should generate fault handling rungs", () => {
    const context = ladderLogicAgent.buildContextFromCMType(sampleCMType, {
      generateFaultHandling: true,
    });
    const result = ladderLogicAgent.generateControlModuleLogic(context);

    expect(result.neutralText).toContain("Fault");
  });

  it("should generate AI prompt context", () => {
    const context = ladderLogicAgent.buildContextFromCMType(sampleCMType);
    const prompt = ladderLogicAgent.generateAIPromptContext(context);

    expect(prompt).toContain("TestValve");
    expect(prompt).toContain("Available Inputs");
    expect(prompt).toContain("Available Outputs");
    expect(prompt).toContain("Available Instructions");
  });

  describe("Phase Logic Generation", () => {
    const samplePhaseType: ParsedPhaseType = {
      name: "TestPhase",
      description: "Test phase for unit testing",
      linkedModules: [
        { name: "Valve1", type: "CM_Valve" },
        { name: "Pump1", type: "CM_Pump" },
      ],
      inputs: [
        { name: "Enable", dataType: "Bool", comment: "Phase enable" },
      ],
      outputs: [
        { name: "Complete", dataType: "Bool", comment: "Phase complete" },
      ],
      inOuts: [],
      internalValues: [
        { name: "StepTimer", dataType: "Time", comment: "Step timing" },
      ],
      hmiParameters: [],
      recipeParameters: [],
      reportParameters: [],
      sequences: {
        Running: {
          name: "Running",
          steps: [
            { step: 1, actions: ["Open Valve1"], conditions: [{ condition: "Valve1.Open", target: 2 }] },
            { step: 2, actions: ["Start Pump1"], conditions: [{ condition: "Timer.DN", target: 3 }] },
            { step: 3, actions: ["Close Valve1"], conditions: [{ condition: "Valve1.Closed", target: 0 }] },
          ],
        },
      },
    };

    it("should build context from phase type", () => {
      const context = ladderLogicAgent.buildContextFromPhaseType(samplePhaseType);

      expect(context.sourceType).toBe("phase");
      expect(context.sourceName).toBe("TestPhase");
      expect(context.linkedModules.length).toBe(2);
      expect(context.sequences.length).toBe(1);
    });

    it("should generate phase logic", () => {
      const context = ladderLogicAgent.buildContextFromPhaseType(samplePhaseType);
      const result = ladderLogicAgent.generatePhaseLogic(context);

      expect(result.success).toBe(true);
      expect(result.routines.length).toBeGreaterThan(0);
    });
  });
});

describe("BatchRungGenerator", () => {
  it("should load and validate templates", () => {
    batchRungGenerator.loadTemplate("XIC({Input})OTE({Output});");
    const validation = batchRungGenerator.validateTemplate();

    expect(validation.valid).toBe(true);
    expect(validation.variables).toContain("Input");
    expect(validation.variables).toContain("Output");
  });

  it("should generate rungs from template", () => {
    const generator = new BatchRungGenerator();
    generator.loadTemplate("XIC({Sensor})OTE({Lamp});");

    const rung = generator.generateRung({ Sensor: "Sensor1", Lamp: "Lamp1" }, 0);

    expect(rung.elements.length).toBe(2);
    expect((rung.elements[0] as any).parameters[0]).toBe("Sensor1");
    expect((rung.elements[1] as any).parameters[0]).toBe("Lamp1");
  });

  it("should generate multiple rungs from CSV", () => {
    const generator = new BatchRungGenerator();
    generator.loadTemplate("XIC({Input})OTE({Output});");

    const csvContent = `Input,Output
Sensor1,Lamp1
Sensor2,Lamp2
Sensor3,Lamp3`;

    const result = generator.generateAll(csvContent);

    expect(result.success).toBe(true);
    expect(result.rungs.length).toBe(3);
    expect(result.neutralText).toContain("Sensor1");
    expect(result.neutralText).toContain("Sensor2");
    expect(result.neutralText).toContain("Sensor3");
  });

  it("should validate CSV against template", () => {
    const generator = new BatchRungGenerator();
    generator.loadTemplate("XIC({Input})OTE({Output});");

    const csvContent = `Input,Output
Sensor1,Lamp1`;

    const validation = generator.validateCSV(csvContent);

    expect(validation.valid).toBe(true);
    expect(validation.rowCount).toBe(1);
  });

  it("should detect missing CSV variables", () => {
    const generator = new BatchRungGenerator();
    generator.loadTemplate("XIC({Input})OTE({Output});");

    const csvContent = `Input
Sensor1`;

    const validation = generator.validateCSV(csvContent);

    expect(validation.valid).toBe(false);
    expect(validation.missingVariables).toContain("Output");
  });
});

describe("Integration: Full Code Generation Flow", () => {
  it("should generate complete ladder logic from CM type", async () => {
    const cmType: ParsedCMType = {
      name: "Motor_Starter",
      inputs: [
        { name: "Start_PB", dataType: "Bool", primary: true },
        { name: "Stop_PB", dataType: "Bool" },
        { name: "Overload", dataType: "Bool", isError: true },
      ],
      outputs: [
        { name: "Motor_Run", dataType: "Bool", primary: true },
        { name: "Running_Lamp", dataType: "Bool" },
      ],
      inOuts: [],
    };

    const context = ladderLogicAgent.buildContextFromCMType(cmType);
    const result = ladderLogicAgent.generateControlModuleLogic(context);

    expect(result.success).toBe(true);
    expect(result.neutralText).toContain("XIC");
    expect(result.neutralText).toContain("OTE");
    expect(result.tags.length).toBeGreaterThan(0);
  });
});
