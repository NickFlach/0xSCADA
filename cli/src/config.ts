import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface Config {
  apiUrl: string;
  timeout: number;
  colorOutput: boolean;
  jsonOutput: boolean;
}

const CONFIG_FILE_NAME = "0xscada.config.json";
const DEFAULT_CONFIG: Config = {
  apiUrl: "http://localhost:5000",
  timeout: 30000,
  colorOutput: true,
  jsonOutput: false,
};

function findConfigFile(): string | null {
  // Check current directory
  const cwdConfig = path.join(process.cwd(), CONFIG_FILE_NAME);
  if (fs.existsSync(cwdConfig)) {
    return cwdConfig;
  }

  // Check home directory
  const homeConfig = path.join(
    process.env.HOME || process.env.USERPROFILE || "",
    `.${CONFIG_FILE_NAME}`
  );
  if (fs.existsSync(homeConfig)) {
    return homeConfig;
  }

  // Check project root (parent of cli directory)
  const projectConfig = path.resolve(__dirname, "../../..", CONFIG_FILE_NAME);
  if (fs.existsSync(projectConfig)) {
    return projectConfig;
  }

  return null;
}

export function loadConfig(): Config {
  const config = { ...DEFAULT_CONFIG };

  // Load from config file if exists
  const configFile = findConfigFile();
  if (configFile) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configFile, "utf-8"));
      Object.assign(config, fileConfig);
    } catch (error) {
      // Ignore invalid config file
    }
  }

  // Environment variables override file config
  if (process.env.OXSCADA_API_URL) {
    config.apiUrl = process.env.OXSCADA_API_URL;
  }
  if (process.env.OXSCADA_TIMEOUT) {
    config.timeout = parseInt(process.env.OXSCADA_TIMEOUT, 10);
  }
  if (process.env.NO_COLOR || process.env.OXSCADA_NO_COLOR) {
    config.colorOutput = false;
  }

  return config;
}

export function saveConfig(updates: Partial<Config>): void {
  const configPath = path.join(process.cwd(), CONFIG_FILE_NAME);
  let currentConfig: Partial<Config> = {};

  // Read directly instead of testing existence first. The `existsSync` guard
  // answered a question about a moment that had already passed by the time the
  // read ran, and bought nothing: the catch below already covers the file being
  // absent, exactly as it covers the file being invalid. Both mean the same
  // thing here — start from an empty config.
  try {
    currentConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    // Missing or invalid: start fresh.
  }

  const newConfig = { ...currentConfig, ...updates };
  fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2));
}

export function getConfigPath(): string | null {
  return findConfigFile();
}

export function getAllConfigPaths(): string[] {
  const paths: string[] = [];
  
  paths.push(path.join(process.cwd(), CONFIG_FILE_NAME));
  paths.push(
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      `.${CONFIG_FILE_NAME}`
    )
  );
  
  return paths;
}
