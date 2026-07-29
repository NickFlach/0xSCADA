import { Command } from "commander";
import ora from "ora";
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { resolveWithinDirectory, safeFileName } from "../lib/safe-path.js";
import { getApiClient } from "../api.js";
import {
  output,
  outputTable,
  outputSection,
  outputKeyValue,
  outputError,
  outputSuccess,
  setOutputOptions,
  colors,
} from "../output.js";

// Blueprint types
type BlueprintType = "cm-types" | "unit-types" | "phase-types" | "all";

interface BlueprintItem {
  id: string;
  name: string;
  description?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface CMType extends BlueprintItem {
  inputs: unknown[];
  outputs: unknown[];
  inOuts: unknown[];
  sourcePackage?: string;
}

interface UnitType extends BlueprintItem {
  variables?: unknown[];
}

interface PhaseType extends BlueprintItem {
  linkedModules?: unknown[];
  inputs?: unknown[];
  outputs?: unknown[];
  inOuts?: unknown[];
  internalValues?: unknown[];
  sequences?: Record<string, unknown>;
}

interface BlueprintPackage {
  cmTypePackage?: string;
  designSpec?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function registerBlueprintsCommand(program: Command): void {
  const blueprints = program
    .command("blueprints")
    .description("Manage industrial blueprints (control modules, units, phases)");

  // List blueprints
  blueprints
    .command("list")
    .description("List all blueprints or filter by type")
    .option("--type <type>", "Blueprint type: cm-types, unit-types, phase-types", "all")
    .option("--json", "Output as JSON")
    .option("--yaml", "Output as YAML")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json || options.yaml ? null : ora("Fetching blueprints...").start();
      const api = getApiClient();

      try {
        const blueprintType = options.type as BlueprintType;
        const results: Record<string, BlueprintItem[]> = {};

        // Fetch based on type filter
        if (blueprintType === "all" || blueprintType === "cm-types") {
          const cmResponse = await api.getCMTypes();
          if (cmResponse.success && cmResponse.data) {
            results["cm-types"] = cmResponse.data;
          }
        }

        if (blueprintType === "all" || blueprintType === "unit-types") {
          const unitResponse = await api.getUnitTypes();
          if (unitResponse.success && unitResponse.data) {
            results["unit-types"] = unitResponse.data;
          }
        }

        if (blueprintType === "all" || blueprintType === "phase-types") {
          const phaseResponse = await api.getPhaseTypes();
          if (phaseResponse.success && phaseResponse.data) {
            results["phase-types"] = phaseResponse.data;
          }
        }

        spinner?.stop();

        // Output as YAML
        if (options.yaml) {
          console.log(yaml.dump(results, { indent: 2 }));
          return;
        }

        // Output as JSON
        if (options.json) {
          output(results);
          return;
        }

        // Display tables for each type
        if (results["cm-types"] && results["cm-types"].length > 0) {
          outputSection("Control Module Types");
          outputTable(
            ["ID", "Name", "Inputs", "Outputs", "InOuts"],
            (results["cm-types"] as CMType[]).map((cm) => [
              cm.id,
              cm.name,
              String(cm.inputs?.length || 0),
              String(cm.outputs?.length || 0),
              String(cm.inOuts?.length || 0),
            ])
          );
          console.log(colors.dim(`Total: ${results["cm-types"].length} control module types\n`));
        } else if (blueprintType === "cm-types" || blueprintType === "all") {
          console.log(colors.dim("No control module types found.\n"));
        }

        if (results["unit-types"] && results["unit-types"].length > 0) {
          outputSection("Unit Types");
          outputTable(
            ["ID", "Name", "Description"],
            (results["unit-types"] as UnitType[]).map((unit) => [
              unit.id,
              unit.name,
              unit.description || "-",
            ])
          );
          console.log(colors.dim(`Total: ${results["unit-types"].length} unit types\n`));
        } else if (blueprintType === "unit-types" || blueprintType === "all") {
          console.log(colors.dim("No unit types found.\n"));
        }

        if (results["phase-types"] && results["phase-types"].length > 0) {
          outputSection("Phase Types");
          outputTable(
            ["ID", "Name", "Description", "Linked Modules"],
            (results["phase-types"] as PhaseType[]).map((phase) => [
              phase.id,
              phase.name,
              phase.description || "-",
              String(phase.linkedModules?.length || 0),
            ])
          );
          console.log(colors.dim(`Total: ${results["phase-types"].length} phase types\n`));
        } else if (blueprintType === "phase-types" || blueprintType === "all") {
          console.log(colors.dim("No phase types found.\n"));
        }
      } catch (error) {
        spinner?.fail("Failed to fetch blueprints");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Show blueprint details
  blueprints
    .command("show <id>")
    .description("Show details of a specific blueprint")
    .option("--type <type>", "Blueprint type: cm-types, unit-types, phase-types")
    .option("--format <format>", "Output format: json, yaml", "json")
    .option("--json", "Output as JSON (shorthand for --format json)")
    .option("--no-color", "Disable colorized output")
    .action(async (id: string, options) => {
      setOutputOptions({ json: options.json || options.format === "json", color: options.color });

      const spinner = options.json || options.format !== "table"
        ? null
        : ora("Fetching blueprint details...").start();
      const api = getApiClient();

      try {
        let blueprint: BlueprintItem | null = null;
        let blueprintType = options.type;

        // If type not specified, search all types
        if (!blueprintType) {
          // Try CM Types first
          const cmResponse = await api.getCMTypeByName(id);
          if (cmResponse.success && cmResponse.data) {
            blueprint = cmResponse.data;
            blueprintType = "cm-types";
          }

          // Try Unit Types if not found
          if (!blueprint) {
            const unitResponse = await api.getUnitTypes();
            if (unitResponse.success && unitResponse.data) {
              blueprint = unitResponse.data.find((u: BlueprintItem) => u.id === id || u.name === id) || null;
              if (blueprint) blueprintType = "unit-types";
            }
          }

          // Try Phase Types if not found
          if (!blueprint) {
            const phaseResponse = await api.getPhaseTypes();
            if (phaseResponse.success && phaseResponse.data) {
              blueprint = phaseResponse.data.find((p: BlueprintItem) => p.id === id || p.name === id) || null;
              if (blueprint) blueprintType = "phase-types";
            }
          }
        } else {
          // Fetch by specific type
          switch (blueprintType) {
            case "cm-types": {
              const cmResponse = await api.getCMTypeByName(id);
              if (cmResponse.success && cmResponse.data) {
                blueprint = cmResponse.data;
              }
              break;
            }
            case "unit-types": {
              const unitResponse = await api.getUnitTypes();
              if (unitResponse.success && unitResponse.data) {
                blueprint = unitResponse.data.find((u: BlueprintItem) => u.id === id || u.name === id) || null;
              }
              break;
            }
            case "phase-types": {
              const phaseResponse = await api.getPhaseTypes();
              if (phaseResponse.success && phaseResponse.data) {
                blueprint = phaseResponse.data.find((p: BlueprintItem) => p.id === id || p.name === id) || null;
              }
              break;
            }
          }
        }

        spinner?.stop();

        if (!blueprint) {
          outputError("Blueprint not found", `No blueprint found with ID or name: ${id}`);
          return;
        }

        // Output based on format
        if (options.format === "yaml") {
          console.log(yaml.dump(blueprint, { indent: 2 }));
          return;
        }

        if (options.json || options.format === "json") {
          output(blueprint);
          return;
        }

        // Default table output
        outputSection(`Blueprint Details (${blueprintType})`);
        outputKeyValue([
          { key: "ID", value: blueprint.id },
          { key: "Name", value: blueprint.name },
          { key: "Type", value: blueprintType },
          { key: "Description", value: blueprint.description || "-" },
        ]);

        console.log();
      } catch (error) {
        spinner?.fail("Failed to fetch blueprint");
        outputError(
          "Failed to connect to server",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Create blueprint from file
  blueprints
    .command("create")
    .description("Create a new blueprint from a YAML/JSON file")
    .requiredOption("--file <file>", "Path to blueprint definition file (YAML or JSON)")
    .option("--type <type>", "Blueprint type: cm-types, unit-types, phase-types")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Creating blueprint...").start();
      const api = getApiClient();

      try {
        // Read and parse file
        const filePath = path.resolve(options.file);
        if (!fs.existsSync(filePath)) {
          spinner?.fail("File not found");
          outputError("File not found", filePath);
          return;
        }

        const fileContent = fs.readFileSync(filePath, "utf-8");
        let blueprintData: unknown;

        if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
          blueprintData = yaml.load(fileContent);
        } else {
          blueprintData = JSON.parse(fileContent);
        }

        // Determine type if not specified
        let blueprintType = options.type;
        if (!blueprintType) {
          // Try to infer from data structure
          if (blueprintData && typeof blueprintData === "object") {
            const data = blueprintData as Record<string, unknown>;
            if ("inputs" in data && "outputs" in data) {
              blueprintType = "cm-types";
            } else if ("linkedModules" in data || "sequences" in data) {
              blueprintType = "phase-types";
            } else if ("variables" in data) {
              blueprintType = "unit-types";
            }
          }
        }

        if (!blueprintType) {
          spinner?.fail("Unable to determine blueprint type");
          outputError("Unable to determine blueprint type", "Please specify --type option");
          return;
        }

        // Create based on type
        let response;
        switch (blueprintType) {
          case "cm-types":
            response = await api.createCMType(blueprintData);
            break;
          case "unit-types":
            response = await api.createUnitType(blueprintData);
            break;
          case "phase-types":
            response = await api.createPhaseType(blueprintData);
            break;
          default:
            spinner?.fail("Invalid blueprint type");
            outputError("Invalid blueprint type", `Type must be one of: cm-types, unit-types, phase-types`);
            return;
        }

        spinner?.stop();

        if (!response.success || !response.data) {
          outputError("Failed to create blueprint", response.error);
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess(`Blueprint created: ${response.data.name || response.data.id}`);
        outputKeyValue([
          { key: "ID", value: response.data.id },
          { key: "Name", value: response.data.name },
          { key: "Type", value: blueprintType },
        ]);
      } catch (error) {
        spinner?.fail("Failed to create blueprint");
        outputError(
          "Failed to create blueprint",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Import blueprint package
  blueprints
    .command("import")
    .description("Import blueprints from a package file (YAML/JSON with cmTypePackage and designSpec)")
    .requiredOption("--file <file>", "Path to blueprint package file")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Importing blueprints...").start();
      const api = getApiClient();

      try {
        // Read and parse file
        const filePath = path.resolve(options.file);
        if (!fs.existsSync(filePath)) {
          spinner?.fail("File not found");
          outputError("File not found", filePath);
          return;
        }

        const fileContent = fs.readFileSync(filePath, "utf-8");
        let packageData: BlueprintPackage;

        if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
          packageData = yaml.load(fileContent) as BlueprintPackage;
        } else {
          packageData = JSON.parse(fileContent);
        }

        // Validate package structure
        if (!packageData.cmTypePackage || !packageData.designSpec) {
          spinner?.fail("Invalid package structure");
          outputError(
            "Invalid package structure",
            "Package must contain cmTypePackage and designSpec fields"
          );
          return;
        }

        // Import via API
        const response = await api.importBlueprints(packageData);

        spinner?.stop();

        if (!response.success) {
          outputError("Import failed", response.error);
          if (response.data?.errors) {
            console.log(colors.error("\nErrors:"));
            response.data.errors.forEach((err: string) => console.log(`  - ${err}`));
          }
          if (response.data?.warnings) {
            console.log(colors.warning("\nWarnings:"));
            response.data.warnings.forEach((warn: string) => console.log(`  - ${warn}`));
          }
          return;
        }

        if (options.json) {
          output(response.data);
          return;
        }

        outputSuccess("Blueprints imported successfully");
        if (response.data?.imported) {
          outputKeyValue([
            { key: "CM Types", value: String(response.data.imported.cmTypes || 0) },
            { key: "CM Instances", value: String(response.data.imported.cmInstances || 0) },
            { key: "Unit Types", value: String(response.data.imported.unitTypes || 0) },
            { key: "Unit Instances", value: String(response.data.imported.unitInstances || 0) },
            { key: "Phase Types", value: String(response.data.imported.phaseTypes || 0) },
          ]);
        }

        if (response.data?.warnings && response.data.warnings.length > 0) {
          console.log(colors.warning("\nWarnings:"));
          response.data.warnings.forEach((warn: string) => console.log(`  - ${warn}`));
        }
      } catch (error) {
        spinner?.fail("Failed to import blueprints");
        outputError(
          "Failed to import blueprints",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Export blueprint
  blueprints
    .command("export <id>")
    .description("Export a blueprint to a file")
    .option("--type <type>", "Blueprint type: cm-types, unit-types, phase-types")
    .option("--output <file>", "Output file path (default: <name>.yaml)")
    .option("--format <format>", "Output format: yaml, json", "yaml")
    .option("--no-color", "Disable colorized output")
    .action(async (id: string, options) => {
      setOutputOptions({ color: options.color });

      const spinner = ora("Exporting blueprint...").start();
      const api = getApiClient();

      try {
        let blueprint: BlueprintItem | null = null;
        let blueprintType = options.type;

        // Fetch blueprint (same logic as show command)
        if (!blueprintType) {
          const cmResponse = await api.getCMTypeByName(id);
          if (cmResponse.success && cmResponse.data) {
            blueprint = cmResponse.data;
            blueprintType = "cm-types";
          }

          if (!blueprint) {
            const unitResponse = await api.getUnitTypes();
            if (unitResponse.success && unitResponse.data) {
              blueprint = unitResponse.data.find((u: BlueprintItem) => u.id === id || u.name === id) || null;
              if (blueprint) blueprintType = "unit-types";
            }
          }

          if (!blueprint) {
            const phaseResponse = await api.getPhaseTypes();
            if (phaseResponse.success && phaseResponse.data) {
              blueprint = phaseResponse.data.find((p: BlueprintItem) => p.id === id || p.name === id) || null;
              if (blueprint) blueprintType = "phase-types";
            }
          }
        } else {
          switch (blueprintType) {
            case "cm-types": {
              const cmResponse = await api.getCMTypeByName(id);
              if (cmResponse.success && cmResponse.data) blueprint = cmResponse.data;
              break;
            }
            case "unit-types": {
              const unitResponse = await api.getUnitTypes();
              if (unitResponse.success && unitResponse.data) {
                blueprint = unitResponse.data.find((u: BlueprintItem) => u.id === id || u.name === id) || null;
              }
              break;
            }
            case "phase-types": {
              const phaseResponse = await api.getPhaseTypes();
              if (phaseResponse.success && phaseResponse.data) {
                blueprint = phaseResponse.data.find((p: BlueprintItem) => p.id === id || p.name === id) || null;
              }
              break;
            }
          }
        }

        if (!blueprint) {
          spinner?.fail("Blueprint not found");
          outputError("Blueprint not found", `No blueprint found with ID or name: ${id}`);
          return;
        }

        // Determine output file.
        //
        // `--output` is the operator's own choice and is honoured as given. The
        // DEFAULT is named after `blueprint.name`, which came from the server —
        // so it is reduced to a single inert segment first. `path.resolve` on a
        // raw `../../.ssh/authorized_keys` would otherwise leave the working
        // directory entirely.
        const ext = options.format === "json" ? ".json" : ".yaml";
        const outputPath = options.output
          ? path.resolve(options.output)
          : path.resolve(`${safeFileName(blueprint.name, "blueprint")}${ext}`);

        // Format and write
        let content: string;
        if (options.format === "json") {
          content = JSON.stringify(blueprint, null, 2);
        } else {
          content = yaml.dump(blueprint, { indent: 2 });
        }

        fs.writeFileSync(outputPath, content, "utf-8");

        spinner?.stop();
        outputSuccess(`Blueprint exported to: ${outputPath}`);
      } catch (error) {
        spinner?.fail("Failed to export blueprint");
        outputError(
          "Failed to export blueprint",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Export all blueprints
  blueprints
    .command("export-all")
    .description("Export all blueprints to a directory")
    .requiredOption("--output <dir>", "Output directory path")
    .option("--type <type>", "Blueprint type: cm-types, unit-types, phase-types, all", "all")
    .option("--format <format>", "Output format: yaml, json", "yaml")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ color: options.color });

      const spinner = ora("Exporting all blueprints...").start();
      const api = getApiClient();

      try {
        const outputDir = path.resolve(options.output);

        // Create directory if needed
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        const ext = options.format === "json" ? ".json" : ".yaml";
        const blueprintType = options.type as BlueprintType;
        let exportCount = 0;

        // Export CM Types
        if (blueprintType === "all" || blueprintType === "cm-types") {
          const cmResponse = await api.getCMTypes();
          if (cmResponse.success && cmResponse.data) {
            const cmDir = path.join(outputDir, "cm-types");
            if (!fs.existsSync(cmDir)) fs.mkdirSync(cmDir, { recursive: true });

            for (const cm of cmResponse.data) {
              const filePath = resolveWithinDirectory(cmDir, `${safeFileName(cm.name, "cm-type")}${ext}`);
              const content = options.format === "json"
                ? JSON.stringify(cm, null, 2)
                : yaml.dump(cm, { indent: 2 });
              fs.writeFileSync(filePath, content, "utf-8");
              exportCount++;
            }
          }
        }

        // Export Unit Types
        if (blueprintType === "all" || blueprintType === "unit-types") {
          const unitResponse = await api.getUnitTypes();
          if (unitResponse.success && unitResponse.data) {
            const unitDir = path.join(outputDir, "unit-types");
            if (!fs.existsSync(unitDir)) fs.mkdirSync(unitDir, { recursive: true });

            for (const unit of unitResponse.data) {
              const filePath = resolveWithinDirectory(unitDir, `${safeFileName(unit.name, "unit-type")}${ext}`);
              const content = options.format === "json"
                ? JSON.stringify(unit, null, 2)
                : yaml.dump(unit, { indent: 2 });
              fs.writeFileSync(filePath, content, "utf-8");
              exportCount++;
            }
          }
        }

        // Export Phase Types
        if (blueprintType === "all" || blueprintType === "phase-types") {
          const phaseResponse = await api.getPhaseTypes();
          if (phaseResponse.success && phaseResponse.data) {
            const phaseDir = path.join(outputDir, "phase-types");
            if (!fs.existsSync(phaseDir)) fs.mkdirSync(phaseDir, { recursive: true });

            for (const phase of phaseResponse.data) {
              const filePath = resolveWithinDirectory(phaseDir, `${safeFileName(phase.name, "phase-type")}${ext}`);
              const content = options.format === "json"
                ? JSON.stringify(phase, null, 2)
                : yaml.dump(phase, { indent: 2 });
              fs.writeFileSync(filePath, content, "utf-8");
              exportCount++;
            }
          }
        }

        spinner?.stop();
        outputSuccess(`Exported ${exportCount} blueprints to: ${outputDir}`);
      } catch (error) {
        spinner?.fail("Failed to export blueprints");
        outputError(
          "Failed to export blueprints",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });

  // Validate blueprint file
  blueprints
    .command("validate")
    .description("Validate a blueprint file without importing")
    .requiredOption("--file <file>", "Path to blueprint file (YAML or JSON)")
    .option("--type <type>", "Blueprint type: cm-types, unit-types, phase-types")
    .option("--json", "Output as JSON")
    .option("--no-color", "Disable colorized output")
    .action(async (options) => {
      setOutputOptions({ json: options.json, color: options.color });

      const spinner = options.json ? null : ora("Validating blueprint...").start();

      try {
        // Read and parse file
        const filePath = path.resolve(options.file);
        if (!fs.existsSync(filePath)) {
          spinner?.fail("File not found");
          outputError("File not found", filePath);
          return;
        }

        const fileContent = fs.readFileSync(filePath, "utf-8");
        let blueprintData: unknown;

        try {
          if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
            blueprintData = yaml.load(fileContent);
          } else {
            blueprintData = JSON.parse(fileContent);
          }
        } catch (parseError) {
          spinner?.fail("Parse error");
          outputError(
            "Failed to parse file",
            parseError instanceof Error ? parseError.message : "Invalid YAML/JSON"
          );
          return;
        }

        const result: ValidationResult = {
          valid: true,
          errors: [],
          warnings: [],
        };

        // Basic validation
        if (!blueprintData || typeof blueprintData !== "object") {
          result.valid = false;
          result.errors.push("Blueprint must be an object");
        } else {
          const data = blueprintData as Record<string, unknown>;

          // Check for name
          if (!data.name || typeof data.name !== "string") {
            result.valid = false;
            result.errors.push("Blueprint must have a 'name' field");
          }

          // Determine type and validate accordingly
          let blueprintType = options.type;
          if (!blueprintType) {
            if ("inputs" in data && "outputs" in data) {
              blueprintType = "cm-types";
            } else if ("linkedModules" in data || "sequences" in data) {
              blueprintType = "phase-types";
            } else if ("variables" in data) {
              blueprintType = "unit-types";
            } else {
              result.warnings.push("Unable to determine blueprint type - specify with --type");
            }
          }

          // Type-specific validation
          if (blueprintType === "cm-types") {
            if (!Array.isArray(data.inputs)) {
              result.warnings.push("CM Type should have 'inputs' array");
            }
            if (!Array.isArray(data.outputs)) {
              result.warnings.push("CM Type should have 'outputs' array");
            }
            if (!Array.isArray(data.inOuts)) {
              result.warnings.push("CM Type should have 'inOuts' array");
            }
          } else if (blueprintType === "phase-types") {
            if (!Array.isArray(data.linkedModules)) {
              result.warnings.push("Phase Type should have 'linkedModules' array");
            }
          } else if (blueprintType === "unit-types") {
            if (data.description === undefined) {
              result.warnings.push("Unit Type should have a 'description' field");
            }
          }
        }

        spinner?.stop();

        if (options.json) {
          output(result);
          return;
        }

        if (result.valid) {
          outputSuccess("Blueprint is valid");
        } else {
          outputError("Blueprint validation failed");
        }

        if (result.errors.length > 0) {
          console.log(colors.error("\nErrors:"));
          result.errors.forEach((err) => console.log(`  - ${err}`));
        }

        if (result.warnings.length > 0) {
          console.log(colors.warning("\nWarnings:"));
          result.warnings.forEach((warn) => console.log(`  - ${warn}`));
        }
      } catch (error) {
        spinner?.fail("Validation failed");
        outputError(
          "Validation failed",
          error instanceof Error ? error.message : "Unknown error"
        );
      }
    });
}
