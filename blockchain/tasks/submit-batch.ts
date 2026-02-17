/**
 * Hardhat Task: Submit Event Batch
 *
 * Issue #157 — Hardhat tasks for kernel module interaction
 *
 * Usage: npx hardhat submit-batch --contract <address> --root <merkleRoot> --count <eventCount>
 */

import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

task("submit-batch", "Submit an event batch to the EventAnchor contract")
  .addParam("contract", "EventAnchor contract address")
  .addParam("root", "Merkle root (bytes32 hex)")
  .addParam("count", "Number of events in the batch")
  .addOptionalParam("metadata", "Optional metadata string", "")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const [signer] = await hre.ethers.getSigners();

    console.log(`Submitting batch to ${args.contract}`);
    console.log(`Merkle root: ${args.root}`);
    console.log(`Event count: ${args.count}`);
    console.log(`Signer: ${signer.address}`);

    const EventAnchor = await hre.ethers.getContractAt("EventAnchor", args.contract);

    const tx = await EventAnchor.submitBatch(
      args.root,
      parseInt(args.count),
      hre.ethers.toUtf8Bytes(args.metadata)
    );

    console.log(`Transaction submitted: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Confirmed in block: ${receipt?.blockNumber}`);
    console.log(`Gas used: ${receipt?.gasUsed.toString()}`);

    // Parse events
    const events = receipt?.logs || [];
    for (const log of events) {
      try {
        const parsed = EventAnchor.interface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) {
          console.log(`Event: ${parsed.name}`, parsed.args);
        }
      } catch {
        // Skip unparseable logs
      }
    }

    return receipt;
  });
