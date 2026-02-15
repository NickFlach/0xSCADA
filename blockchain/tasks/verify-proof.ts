/**
 * Hardhat Task: Verify Merkle Proof On-Chain
 *
 * Issue #157 — Hardhat tasks for kernel module interaction
 *
 * Usage: npx hardhat verify-proof --contract <address> --root <root> --leaf <leaf> --proof <siblings>
 */

import { task } from "hardhat/config";
import type { HardhatRuntimeEnvironment } from "hardhat/types";

task("verify-proof", "Verify a Merkle inclusion proof on-chain")
  .addParam("contract", "EventAnchor or ProofVerifier contract address")
  .addParam("root", "Merkle root (bytes32 hex)")
  .addParam("leaf", "Leaf hash (bytes32 hex)")
  .addParam("proof", "Comma-separated sibling hashes")
  .addParam("index", "Leaf index in the tree")
  .setAction(async (args, hre: HardhatRuntimeEnvironment) => {
    console.log(`Verifying proof against root: ${args.root}`);
    console.log(`Leaf: ${args.leaf}`);
    console.log(`Index: ${args.index}`);

    const siblings = args.proof.split(",").map((s: string) => s.trim());
    console.log(`Proof path (${siblings.length} siblings): ${siblings.join(", ")}`);

    const contract = await hre.ethers.getContractAt("EventAnchor", args.contract);

    try {
      const isValid = await contract.verifyProof(
        args.root,
        args.leaf,
        siblings,
        parseInt(args.index)
      );

      if (isValid) {
        console.log("✅ Proof is VALID — leaf is included in the Merkle root");
      } else {
        console.log("❌ Proof is INVALID — leaf is NOT included in the Merkle root");
      }

      return isValid;
    } catch (err) {
      console.error("Verification failed:", err);
      return false;
    }
  });
