import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HardhatUserConfig } from "hardhat/config";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const config = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: path.join(projectRoot, "contracts"),
    tests: path.join(projectRoot, "contracts", "test"),
    cache: path.join(projectRoot, "cache"),
    artifacts: path.join(projectRoot, "artifacts"),
  },
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: 31337,
    },
  },
} satisfies HardhatUserConfig;

export default config;
