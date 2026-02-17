/**
 * Hardhat Task: Query Contract State
 *
 * Issue #157 — Hardhat tasks for kernel module interaction
 *
 * Usage: npx hardhat query-state --contract <address>
 */

import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

task("query-state", "Query EventAnchor contract state")
  .addParam("contract", "EventAnchor contract address")
  .addOptionalParam("batchId", "Specific batch ID to query")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    const contract = await hre.ethers.getContractAt("EventAnchor", args.contract);

    console.log(`\n📋 EventAnchor State — ${args.contract}\n`);

    // Query global state
    try {
      const owner = await contract.owner();
      console.log(`Owner:         ${owner}`);
    } catch { /* optional method */ }

    try {
      const batchCount = await contract.batchCount();
      console.log(`Total batches: ${batchCount.toString()}`);
    } catch { /* optional method */ }

    try {
      const latestRoot = await contract.latestMerkleRoot();
      console.log(`Latest root:   ${latestRoot}`);
    } catch { /* optional method */ }

    try {
      const totalEvents = await contract.totalEventsAnchored();
      console.log(`Total events:  ${totalEvents.toString()}`);
    } catch { /* optional method */ }

    // Query specific batch
    if (args.batchId) {
      console.log(`\n📦 Batch #${args.batchId}:\n`);
      try {
        const batch = await contract.getBatch(parseInt(args.batchId));
        console.log(`  Merkle root:  ${batch.merkleRoot}`);
        console.log(`  Event count:  ${batch.eventCount.toString()}`);
        console.log(`  Submitter:    ${batch.submitter}`);
        console.log(`  Block number: ${batch.blockNumber.toString()}`);
        console.log(`  Timestamp:    ${new Date(Number(batch.timestamp) * 1000).toISOString()}`);
      } catch (err) {
        console.error(`  Failed to query batch: ${err}`);
      }
    }

    console.log("");
  });
