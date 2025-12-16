import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

async function main() {
  console.log("Deploying IndustrialRegistry contract...");

  const IndustrialRegistry = await ethers.getContractFactory("IndustrialRegistry");
  const registry = await IndustrialRegistry.deploy();

  await registry.waitForDeployment();

  const address = await registry.getAddress();
  console.log(`IndustrialRegistry deployed to: ${address}`);

  const deploymentInfo = {
    address,
    deployer: (await ethers.getSigners())[0].address,
    deployedAt: new Date().toISOString(),
  };

  const deploymentPath = path.join(process.cwd(), "deployment.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Deployment info saved to ${deploymentPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
