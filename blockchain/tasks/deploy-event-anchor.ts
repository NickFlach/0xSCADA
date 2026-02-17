/**
 * Hardhat Task: Deploy EventAnchor Contract
 *
 * Issue #157 — Hardhat tasks for kernel module interaction
 *
 * Usage: npx hardhat deploy-event-anchor --network <network>
 */

import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

task("deploy-event-anchor", "Deploy the EventAnchor contract")
  .addOptionalParam("owner", "Owner address (defaults to deployer)")
  .addOptionalParam("minBatchSize", "Minimum batch size", "1")
  .addOptionalParam("maxBatchSize", "Maximum batch size", "10000")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const [deployer] = await hre.ethers.getSigners();
    const owner = args.owner || deployer.address;

    console.log(`Deploying EventAnchor with deployer: ${deployer.address}`);
    console.log(`Owner: ${owner}`);
    console.log(`Batch size range: ${args.minBatchSize} - ${args.maxBatchSize}`);

    const EventAnchor = await hre.ethers.getContractFactory("EventAnchor");
    const contract = await EventAnchor.deploy(
      owner,
      parseInt(args.minBatchSize),
      parseInt(args.maxBatchSize)
    );

    await contract.waitForDeployment();
    const address = await contract.getAddress();

    console.log(`EventAnchor deployed to: ${address}`);
    console.log(`Transaction hash: ${contract.deploymentTransaction()?.hash}`);

    // Verify on block explorer if not local
    if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
      console.log("Waiting for block confirmations...");
      await contract.deploymentTransaction()?.wait(5);

      try {
        await hre.run("verify:verify", {
          address,
          constructorArguments: [owner, parseInt(args.minBatchSize), parseInt(args.maxBatchSize)],
        });
        console.log("Contract verified on block explorer");
      } catch (err) {
        console.warn("Verification failed:", err);
      }
    }

    return address;
  });
